/**
 * RPC dispatcher: the single validated entry point for every domain operation.
 *
 * Shape of a handler:
 *   - validate the payload with a Zod schema (never trust the renderer),
 *   - check the permission for the action it performs,
 *   - call the repository, which owns all SQL and all business rules,
 *   - convert any thrown error into a typed ApiError with a code.
 *
 * Errors are never thrown across the bridge: the renderer receives a value it
 * can branch on and show to the user.
 */

import { randomUUID } from "node:crypto";
import { ZodError, type ZodTypeAny, z } from "zod";
import type { SqliteDatabase } from "../data/connection";
import type {
  ApiResult,
  AppSettingsSnapshot,
  RpcMethod,
  RpcRequestOf,
  RpcResponseOf,
} from "../shared/ipc";
import type { PermissionAction, PermissionModule } from "../shared/permissions";
import type {
  SaveDocumentRequest,
  SetupRequest,
  SaveUserRequest,
  UpdateProfileRequest,
  RecoverPasswordRequest,
  RegistrationAuthorisation,
  RegistrationCreateAccountRequest,
  RegistrationUpdateRequest,
} from "../shared/types";
import type {
  ExportDataset,
  JournalSource,
  JournalStatus,
  PaymentPostingKind,
} from "../shared/finance";
import type { PaymentMethod } from "../shared/types";
import * as schemas from "../shared/validation";
import { BrowserWindow, dialog } from "electron";
import {
  NotAuthenticatedError,
  PermissionError,
  type SessionStore,
  loadSessionUser,
} from "./session";
import type { AuditActor } from "./audit-writer";
import { SYSTEM_ACTOR, recordAudit } from "./audit-writer";
import { AvatarError, deleteAvatar, storeAvatar } from "./avatars";
import {
  reverseDocumentPosting,
  reverseExpensePosting,
  reversePaymentPosting,
  syncDocumentPosting,
  syncExpensePosting,
  syncPaymentPosting,
  type AccountingContext,
} from "./accounting/integration";
import * as auth from "./repositories/users";
import * as parties from "./repositories/parties";
import * as products from "./repositories/products";
import * as documents from "./repositories/documents";
import * as payments from "./repositories/payments";
import * as partners from "./repositories/partners";
import * as reports from "./repositories/reports";
import * as imsOperations from "./repositories/ims/operations";
import * as imsReference from "./repositories/ims/reference";
import * as imsAnalytics from "./repositories/ims/analytics";
import * as imsPos from "./repositories/ims/pos";
import {
  listBatches,
  listReservations,
  listSerials,
  replenishmentRows,
  stockOverview,
} from "./repositories/ims/queries";
import { releaseReservations } from "./repositories/ims/stock";
import { availableQuantity, reservedQuantity } from "./repositories/ims/stock";
import * as mmsBom from "./repositories/mms/bom";
import * as wms from "./repositories/wms/operations";
import * as wmsSchemas from "../shared/wms";
import * as wmsOutbound from "./repositories/wms/outbound";
import * as wmsCounting from "./repositories/wms/counting";
import { saveWmsSettings } from "./repositories/wms/config";
import { adoptReceipt } from "./repositories/wms/integration";
import { runWarehouseReport, safeWarehouseExportCell } from "./repositories/wms/reports";
import * as wmsControl from './repositories/wms/control';
import * as wmsAppointments from './repositories/wms/appointments';
import * as mmsRouting from "./repositories/mms/routing";
import * as mmsWorkCenters from "./repositories/mms/workCenters";
import * as mmsOrders from "./repositories/mms/manufacturingOrders";
import * as mmsWorkOrders from "./repositories/mms/workOrders";
import * as mmsMaterialIssues from "./repositories/mms/materialIssues";
import * as mmsFinishedReceipts from "./repositories/mms/finishedReceipts";
import * as mmsCosting from "./repositories/mms/costing";
import * as mmsConfig from "./repositories/mms/config";
import * as mmsAnalytics from "./repositories/mms/analytics";
import * as mmsMps from "./repositories/mms/mps";
import * as mmsMrp from "./repositories/mms/mrp";
import * as mmsQualityChecks from "./repositories/mms/qualityChecks";
import * as mmsScrap from "./repositories/mms/scrap";
import * as mmsRework from "./repositories/mms/rework";
import * as finance from "./finance-service";
import { fiscalYearOf, todayIso } from "../domain/dates";
import { peekStockNumber } from "./repositories/sequences";
import type { UpdateSettings } from "./settings";
import { getMachineId } from "./machine-id";
import {
  getLicenseStatus,
  isLicenseDisabled,
  loadAndVerifyLicense,
  saveLicense,
  verifyLicenseKey,
} from "./license";
import {
  getRegistrationStatus,
  readRegistrationDetails,
  RegistrationError,
  requireLicensedDevice,
} from "./registration";
import { recoverPassword } from "./password-recovery";

export interface RpcDeps {
  readonly log?: import("./logger").Logger;
  readonly db: SqliteDatabase;
  readonly session: SessionStore;
  readonly now: () => Date;
  loadSettings(): AppSettingsSnapshot;
  updateSettings(patch: UpdateSettings): AppSettingsSnapshot;
  /** Re-read settings after something wrote the store behind the service. */
  refreshSettings(): AppSettingsSnapshot;
  /** Where exported CSV files are written. */
  exportDir(): string;
  /** Where profile pictures are copied to when one is chosen. */
  avatarsDir(): string;
  /** Per-session token; requests without it is rejected. */
  readonly token: string;
  /** Dev-only: save session to file for persistence across restarts. */
  saveDevSession(userId: number, roleId: number | null): void;
  /** Dev-only: load session from file. Returns null if not found or packaged. */
  loadDevSession(): { userId: number; roleId: number | null } | null;
  /** Dev-only: check if session restoration is allowed. */
  canRestoreDevSession(): boolean;
  /** Dev-only: delete the saved session file. */
  clearDevSession(): void;
}

type SaveContext = {
  db: SqliteDatabase;
  actor: AuditActor;
  fiscalYearStartMonth: number;
  nowIso: string;
  nowDate: string;
  /** Fiscal year of a date, using the configured start month. */
  fiscalYearOf(date: string): number;
  allowNegativeStock: boolean;
  vatRate: number;
};

/**
 * The context the accounting engine needs.
 *
 * `createdBy` is the signed-in user's name, so a journal entry records who
 * posted it - the audit trail the accounting records need to be worth anything.
 */
function accountingContext(deps: RpcDeps, ctx: SaveContext): AccountingContext {
  const actor = ctx.actor;
  return {
    db: deps.db,
    nowIso: ctx.nowIso,
    nowDate: ctx.nowDate,
    createdBy: actor.name.length > 0 ? actor.name : undefined,
  };
}

function operationContext(deps: RpcDeps, ctx: SaveContext): imsOperations.OperationContext {
  return {
    db: deps.db,
    actor: ctx.actor,
    nowIso: ctx.nowIso,
    nowDate: ctx.nowDate,
    fiscalYearStartMonth: ctx.fiscalYearStartMonth,
    allowNegativeStock: ctx.allowNegativeStock,
    vatRate: ctx.vatRate,
  };
}

function posContext(deps: RpcDeps, ctx: SaveContext): imsPos.PosContext {
  return operationContext(deps, ctx);
}

class RpcError extends Error {
  public readonly code: string;
  public readonly field: string | undefined;

  public constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.field = field;
  }
}

function fail<T>(code: string, message: string, field?: string): ApiResult<T> {
  return {
    ok: false,
    error: field === undefined ? { code, message } : { code, message, field },
  };
}

/** Turn a thrown value into the error shape the renderer expects. */
function toApiError(error: unknown): ApiResult<never> {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first === undefined ? undefined : first.path.join(".");
    return fail(
      "VALIDATION",
      first?.message ?? "The information entered is not valid.",
      field === "" ? undefined : field,
    );
  }

  if (error instanceof PermissionError) {
    return fail("FORBIDDEN", error.message);
  }

  if (error instanceof NotAuthenticatedError) {
    return fail("UNAUTHENTICATED", error.message);
  }

  if (error instanceof RpcError) {
    return error.field === undefined
      ? fail(error.code, error.message)
      : fail(error.code, error.message, error.field);
  }

  if (error instanceof Error) {
    // Repository errors carry shop-facing wording already; anything else is
    // masked so an internal message never reaches the user.
    const known =
      error.name === "AuthError" ||
      error.name === "PasswordRecoveryError" ||
      error.name === "RegistrationError" ||
      error.name === "PartyError" ||
      error.name === "ProductError" ||
      error.name === "DocumentError" ||
      error.name === "PaymentError" ||
      error.name === "PartnerError" ||
      error.name === "AccountError" ||
      error.name === "ImsOperationError" ||
      error.name === "ImsStockError" ||
      error.name === "ImsReferenceError" ||
      error.name === "ImsPosError" ||
      error.name === "BomError" ||
      error.name === "RoutingError" ||
      error.name === "WorkCenterError" ||
      error.name === "MoError" ||
      error.name === "WorkOrderError" ||
      error.name === "MaterialIssueError" ||
      error.name === "FinishedReceiptError" ||
      error.name === "CostingError" ||
      error.name === "MmsConfigError" ||
      error.name === "PlanningError" ||
      error.name === "WmsError" ||
      error.name === "QualityCheckError" ||
      error.name === "ScrapError" ||
      error.name === "ReworkError" ||
      error.name === "RangeError" ||
      error.name === "TypeError";

    if (known) {
      // Some of these name the field they are about - a duplicate code, a
      // parent that would make a loop - and the renderer puts the message
      // under the right input when it is told which one.
      const named = error as Error & { readonly field?: unknown };
      const field = typeof named.field === "string" ? named.field : undefined;
      return fail(error.name.replace("Error", "").toUpperCase(), error.message, field);
    }
  }

  return fail("UNEXPECTED", "Something went wrong. See the log for details.");
}

/**
 * A handler receives the validated payload and returns the response.
 *
 * Handlers are typed as returning `unknown` rather than a specific DTO: the
 * dispatch table maps method names to schemas and permissions, and the shared
 * `RpcMethods` interface in `shared/ipc.ts` is what ties a method name to its
 * response type for callers.
 */
type Handler = (payload: unknown, deps: RpcDeps, ctx: SaveContext) => unknown;

interface MethodDefinition {
  readonly schema: ZodTypeAny;
  readonly handler: Handler;
  /** Permission required. Absent means the method is public (setup, login). */
  readonly permission?: { readonly module: PermissionModule; readonly action: PermissionAction };
  /** Methods reachable before login (setup flow, login itself). */
  readonly anonymous?: boolean;
}

const emptySchema: ZodTypeAny = z.object({});

export function createRpcMethods(): Record<string, MethodDefinition> {
  const definitions: Record<string, MethodDefinition> = {
    'wms.tasks.start':{schema:z.object({id:z.number().int().positive()}),permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>wms.startTask({db:d.db,actor:c.actor,nowIso:c.nowIso},(p as {id:number}).id)},
    'wms.docks.save':{schema:wmsSchemas.dockSchema,permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>wmsAppointments.saveDock({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never)},
    'wms.appointments.save':{schema:wmsSchemas.appointmentSchema,permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>wmsAppointments.saveAppointment({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never)},
    'wms.appointments.transition':{schema:z.object({id:z.number().int().positive(),revision:z.number().int().nonnegative(),status:z.enum(['arrived','unloading','completed','cancelled','noShow']),reason:z.string().max(500)}),permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>{const r=p as {id:number;revision:number;status:'arrived'|'unloading'|'completed'|'cancelled'|'noShow';reason:string};return wmsAppointments.transitionAppointment({db:d.db,actor:c.actor,nowIso:c.nowIso},r.id,r.revision,r.status,r.reason);}},
    "wms.returns.receive": {schema:wmsSchemas.returnSchema,permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>wmsControl.receiveReturn({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never)},
    "wms.returns.inspect": {schema:z.object({id:z.number().int().positive(),sellableMilli:z.number().int().nonnegative(),destinationBinId:z.number().int().positive(),reason:z.string().trim().min(1).max(500)}),permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>{const r=p as {id:number;sellableMilli:number;destinationBinId:number;reason:string};return wmsControl.inspectReturn({db:d.db,actor:c.actor,nowIso:c.nowIso},r.id,r.sellableMilli,r.destinationBinId,r.reason);}},
    "wms.replenishment.save": {schema:wmsSchemas.replenishmentSchema,permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>wmsControl.saveReplenishmentRule({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never)},
    "wms.replenishment.generate": {schema:z.object({id:z.number().int().positive()}),permission:{module:'warehouse',action:'edit'},handler:(p,d,c)=>wmsControl.generateReplenishment({db:d.db,actor:c.actor,nowIso:c.nowIso},(p as {id:number}).id)},
    "wms.settings.save": {
      schema:wmsSchemas.wmsSettingsSchema,permission:{module:'warehouse',action:'edit'},
      handler:(p,d,c)=>saveWmsSettings(d.db,c.actor,p as never,c.nowIso),
    },
    "wms.receipts.adopt": {
      schema:z.object({movementId:z.number().int().positive(),receivingBinId:z.number().int().positive()}),permission:{module:'warehouse',action:'edit'},
      handler:(p,d,c)=>{const r=p as {movementId:number;receivingBinId:number};return adoptReceipt({db:d.db,actor:c.actor,nowIso:c.nowIso},r.movementId,r.receivingBinId);},
    },
    "wms.report": {
      schema:wmsSchemas.reportSchema,permission:{module:'warehouse',action:'view'},
      handler:(p,d,c)=>runWarehouseReport(d.db,p as never,c.nowIso),
    },
    "wms.report.export": {
      schema:wmsSchemas.reportSchema,permission:{module:'warehouse',action:'export'},
      handler:(p,d,c)=>{const r=runWarehouseReport(d.db,p as never,c.nowIso);const file=reports.exportReportCsv(d.exportDir(),`warehouse-${c.nowIso.replace(/[:.]/g,'-')}.csv`,[
        ['Warehouse report',String((p as {report:string}).report)],['Generated by',c.actor.name],['Company',d.loadSettings().companyName],['Generated at',r.generatedAt],['Data cutoff',r.cutoff],['Filters',JSON.stringify(p)],['Row limit',r.limit],r.columns,...r.rows.map(row=>r.columns.map(key=>row[key]??'')),
      ].map(row=>row.map(safeWarehouseExportCell)));return {path:file};},
    },
    "wms.counts.record": {
      schema:wmsSchemas.countSchema,permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>wmsCounting.recordCount({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.counts.approve": {
      schema:z.object({id:z.number().int().positive()}),permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>wmsCounting.approveCount({db:d.db,actor:c.actor,nowIso:c.nowIso},(p as {id:number}).id),
    },
    "wms.dispatch.create": {
      schema:wmsSchemas.dispatchSchema,permission:{module:"warehouse",action:"create"},
      handler:(p,d,c)=>wmsOutbound.createDispatch({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.dispatch.release": {
      schema:z.object({id:z.number().int().positive(),packingBinId:z.number().int().positive()}),permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>{const r=p as {id:number;packingBinId:number};return wmsOutbound.releaseDispatch({db:d.db,actor:c.actor,nowIso:c.nowIso},r.id,r.packingBinId);},
    },
    "wms.picks.confirm": {
      schema:wmsSchemas.taskCompleteSchema,permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>wmsOutbound.confirmPick({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.cartons.pack": {
      schema:wmsSchemas.cartonSchema,permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>wmsOutbound.packCarton({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.cartons.scan": {
      schema:z.object({dispatchId:z.number().int().positive(),scan:z.string().trim().min(1).max(80),action:z.enum(['stage','load'])}),permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>{const r=p as {dispatchId:number;scan:string;action:'stage'|'load'};return wmsOutbound.scanCarton({db:d.db,actor:c.actor,nowIso:c.nowIso},r.dispatchId,r.scan,r.action);},
    },
    "wms.dispatch.handover": {
      schema:z.object({id:z.number().int().positive(),carrier:z.string().trim().min(1).max(200),vehicle:z.string().trim().min(1).max(100),acknowledgement:z.string().trim().min(1).max(200)}),permission:{module:"warehouse",action:"edit"},
      handler:(p,d,c)=>{const r=p as {id:number;carrier:string;vehicle:string;acknowledgement:string};return wmsOutbound.handover({db:d.db,actor:c.actor,nowIso:c.nowIso},r.id,r.carrier,r.vehicle,r.acknowledgement);},
    },
    "wms.snapshot": {
      schema: emptySchema, permission: { module: "warehouse", action: "view" },
      handler: (_p,d,c) => wms.snapshot(d.db,c.nowIso),
    },
    "wms.warehouses.save": {
      schema: wmsSchemas.warehouseSchema, permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => wms.saveWarehouse({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.bins.save": {
      schema: wmsSchemas.binSchema, permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => wms.saveBin({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.locations.map": {
      schema: z.object({warehouseId:z.number().int().positive(),locationId:z.number().int().positive(),code:z.string().min(1).max(100)}),
      permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => { const r=p as {warehouseId:number;locationId:number;code:string};return wms.mapLocation({db:d.db,actor:c.actor,nowIso:c.nowIso},r.warehouseId,r.locationId,r.code); },
    },
    "wms.inbound.create": {
      schema: wmsSchemas.inboundSchema, permission: { module: "warehouse", action: "create" },
      handler: (p,d,c) => wms.createInbound({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.inbound.arrive": {
      schema: z.object({id:z.number().int().positive()}), permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => wms.arriveInbound({db:d.db,actor:c.actor,nowIso:c.nowIso},(p as {id:number}).id),
    },
    "wms.receiving.post": {
      schema: wmsSchemas.receiptSchema, permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => wms.receive({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.moves.create": {
      schema: wmsSchemas.moveSchema, permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => wms.createMove({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.tasks.complete": {
      schema: wmsSchemas.taskCompleteSchema, permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => wms.completeTask({db:d.db,actor:c.actor,nowIso:c.nowIso},p as never),
    },
    "wms.tasks.assign": {
      schema: z.object({id:z.number().int().positive(),workerId:z.number().int().positive()}), permission: { module: "warehouse", action: "edit" },
      handler: (p,d,c) => {const r=p as {id:number;workerId:number};return wms.assignTask({db:d.db,actor:c.actor,nowIso:c.nowIso},r.id,r.workerId);},
    },
    /* ---------------------------------------------------------------- auth -- */

    "auth.setupStatus": {
      schema: schemas.setupStatusSchema,
      anonymous: true,
      handler: (_payload, deps) => ({
        isComplete: auth.isSetupComplete(deps.db),
        companyName: deps.loadSettings().companyName,
        machineId: "",
        appVersion: "",
      }),
    },

    "auth.setup": {
      schema: schemas.setupSchema,
      anonymous: true,
      handler: (payload, deps, ctx) => {
        const request = payload as SetupRequest;
        auth.runSetup({ db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso }, request);
        // Setup writes the company details straight to the settings store, so
        // the service's cached snapshot still holds the empty defaults. Without
        // this, every screen that reads settings afterwards - including the
        // profile page's business name - sees a blank company until something
        // else happens to refresh it.
        deps.refreshSettings();
        return {
          isComplete: true,
          companyName: request.companyName,
          machineId: "",
          appVersion: "",
        };
      },
    },

    "auth.login": {
      schema: schemas.loginSchema,
      anonymous: true,
      handler: (payload, deps) => {
        const request = payload as { username: string; password: string };
        // The avatars folder is passed so a user who has a picture has it in
        // the session from the moment they sign in, not only after something
        // later refreshes the session.
        const outcome = auth.login(
          deps.db,
          request.username,
          request.password,
          deps.now(),
          deps.avatarsDir(),
        );
        deps.session.set({ user: outcome.user });

        return { user: outcome.user, isSetupComplete: true };
      },
    },

    "auth.logout": {
      schema: emptySchema,
      handler: (_payload, deps) => {
        deps.session.set(null);
        return { ok: true as const };
      },
    },

    "auth.currentUser": {
      schema: schemas.setupStatusSchema,
      handler: (_payload, deps) => deps.session.currentOrNull()?.user ?? null,
    },

    "auth.saveDevSession": {
      schema: schemas.setupStatusSchema,
      anonymous: true,
      handler: (_payload, deps) => {
        const user = deps.session.currentOrNull()?.user;
        if (user) {
          deps.saveDevSession(user.id, user.roleId);
        }
        return { ok: true as const };
      },
    },

    "auth.loadDevSession": {
      schema: schemas.setupStatusSchema,
      anonymous: true,
      handler: (_payload, deps) => {
        if (!deps.canRestoreDevSession()) return null;
        const stored = deps.loadDevSession();
        if (!stored) return null;
        const user = loadSessionUser(deps.db, stored.userId, deps.avatarsDir());
        if (!user) return null;
        deps.session.set({ user });
        return user;
      },
    },

    "auth.clearDevSession": {
      schema: schemas.setupStatusSchema,
      anonymous: true,
      handler: (_payload, deps) => {
        deps.session.set(null);
        deps.clearDevSession();
        return { ok: true as const };
      },
    },

    "auth.changePassword": {
      schema: schemas.changePasswordSchema,
      handler: (payload, deps, ctx) => {
        const request = payload as { currentPassword: string; newPassword: string };
        const user = deps.session.current().user;
        auth.changePassword(
          deps.db,
          ctx.actor,
          user.id,
          request.currentPassword,
          request.newPassword,
          ctx.nowIso,
        );
        deps.session.reloadPermissions(user.id);
        return { ok: true as const };
      },
    },

    /*
     * Forgot-password recovery from the login screen.
     *
     * Anonymous because there is no session yet. The EyerCall codes are checked
     * in the main process; the renderer only sends the code the customer typed
     * and never receives the accepted values back.
     */
    "auth.recoverPassword": {
      schema: schemas.recoverPasswordSchema,
      anonymous: true,
      handler: (payload, deps, ctx) => {
        recoverPassword({ db: deps.db, nowIso: ctx.nowIso }, payload as RecoverPasswordRequest);
        return { ok: true as const };
      },
    },

    /* ------------------------------------------------------- registration -- */

    /*
     * Login-screen registration management.
     *
     * There is no session yet, so these are anonymous at the IPC layer. Each
     * one that reveals contact details or changes anything proves an existing
     * administrator password, then re-checks the machine-bound licence. A
     * renderer cannot name a user id, a machine id or a licence key here.
     */
    "registration.status": {
      schema: schemas.registrationStatusSchema,
      anonymous: true,
      handler: (_payload, deps) => getRegistrationStatus(deps.db),
    },

    "registration.details": {
      schema: schemas.registrationDetailsSchema,
      anonymous: true,
      handler: async (payload, deps) => {
        const request = payload as RegistrationAuthorisation;
        const license = await requireLicensedDevice();
        const owner = auth.primaryAdministrator(deps.db);

        if (owner === null) {
          throw new RegistrationError(
            "No administrator account is registered on this installation.",
          );
        }

        const administrator = auth.verifyAdministratorCredentials(
          deps.db,
          request.username,
          request.password,
          deps.now(),
        );
        if (administrator.id !== owner.id) {
          throw new RegistrationError(
            "Sign in with the registration owner's administrator account to edit these details.",
            "username",
          );
        }

        return readRegistrationDetails(owner, deps.loadSettings(), license);
      },
    },

    "registration.update": {
      schema: schemas.registrationUpdateSchema,
      anonymous: true,
      handler: async (payload, deps, ctx) => {
        const request = payload as RegistrationUpdateRequest;
        const license = await requireLicensedDevice();

        if (!auth.isSetupComplete(deps.db)) {
          throw new RegistrationError("Registration has not been set up on this installation yet.");
        }

        const owner = auth.primaryAdministrator(deps.db);
        if (owner === null) {
          throw new RegistrationError(
            "No administrator account is registered on this installation.",
          );
        }

        const administrator = auth.verifyAdministratorCredentials(
          deps.db,
          request.username,
          request.password,
          deps.now(),
        );
        if (administrator.id !== owner.id) {
          throw new RegistrationError(
            "Sign in with the registration owner's administrator account to edit these details.",
            "username",
          );
        }

        const actor: AuditActor = { id: owner.id, name: owner.displayName };

        try {
          // One transaction: company fields and the owner's own row either both
          // change or neither does. Business tables are never touched.
          deps.db.transaction(() => {
            deps.updateSettings({
              companyName: request.companyName,
              companyTrn: request.companyTrn,
              companyAddress: request.companyAddress,
              companyPhone: request.companyPhone,
              companyEmail: request.companyEmail,
            });

            auth.updateOwnProfile({ db: deps.db, actor, nowIso: ctx.nowIso }, owner.id, {
              displayName: request.ownerName,
              email: request.ownerEmail,
              phone: request.ownerPhone,
            });

            recordAudit(
              deps.db,
              actor,
              {
                module: "settings",
                action: "updateRegistration",
                entityType: "registration",
                entityId: owner.id,
                newValues: {
                  companyName: request.companyName,
                  companyTrn: request.companyTrn,
                  companyAddress: request.companyAddress,
                  companyPhone: request.companyPhone,
                  companyEmail: request.companyEmail,
                },
              },
              ctx.nowIso,
            );
          })();
        } finally {
          // The settings service caches its snapshot and updated it inside the
          // transaction. If the transaction rolled back, the cache would keep
          // the uncommitted values; re-read either way.
          deps.refreshSettings();
        }

        const updatedOwner = auth.primaryAdministrator(deps.db) ?? owner;
        return readRegistrationDetails(updatedOwner, deps.loadSettings(), license);
      },
    },

    "registration.createAccount": {
      schema: schemas.registrationCreateAccountSchema,
      anonymous: true,
      handler: async (payload, deps, ctx) => {
        const request = payload as RegistrationCreateAccountRequest;
        await requireLicensedDevice();

        if (!auth.isSetupComplete(deps.db)) {
          throw new RegistrationError("Registration has not been set up on this installation yet.");
        }

        const administrator = auth.verifyAdministratorCredentials(
          deps.db,
          request.authorizedUsername,
          request.authorizedPassword,
          deps.now(),
        );

        const actor: AuditActor = { id: administrator.id, name: administrator.displayName };

        // The new account shares this installation's existing database and
        // licence. Only a user row is added; no business data is copied,
        // detached or deleted, and the authorising account stays active.
        return auth.createRegistrationAccount({ db: deps.db, actor, nowIso: ctx.nowIso }, request);
      },
    },

    /* ------------------------------------------------------------ profile -- */

    /**
     * The profile page's read and write.
     *
     * Neither takes a user id. The target is always whoever the session belongs
     * to, which is what stops a renderer from editing somebody else's row even
     * if it is modified: there is no parameter to aim.
     */
    "profile.get": {
      schema: schemas.profileGetSchema,
      handler: (_payload, deps) => {
        const user = deps.session.current().user;
        return auth.readProfile(
          deps.db,
          user.id,
          deps.avatarsDir(),
          deps.loadSettings().companyName,
        );
      },
    },

    "profile.update": {
      schema: schemas.profileUpdateSchema,
      handler: (payload, deps, ctx) => {
        const user = deps.session.current().user;
        const request = payload as UpdateProfileRequest;

        const { previousAvatar } = auth.updateOwnProfile(
          { db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso },
          user.id,
          request,
        );

        // The picture that was replaced is now unreferenced, so it goes. Done
        // after the row is written: if the update fails, the user still has the
        // picture they had.
        const nextAvatar = auth.currentAvatarName(deps.db, user.id);
        if (previousAvatar !== null && previousAvatar !== nextAvatar) {
          deleteAvatar(deps.avatarsDir(), previousAvatar);
        }

        // The rail and the top bar both read the session copy, so refresh it
        // here or a renamed user would keep their old name until next sign-in.
        deps.session.reloadPermissions(user.id);
        return auth.readProfile(
          deps.db,
          user.id,
          deps.avatarsDir(),
          deps.loadSettings().companyName,
        );
      },
    },

    "profile.chooseAvatar": {
      schema: schemas.profileGetSchema,
      handler: async (_payload, deps) => {
        const user = deps.session.current().user;

        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (window === undefined) {
          throw new AvatarError("No window is available to show the picture picker.");
        }

        const result = await dialog.showOpenDialog(window, {
          title: "Choose a profile picture",
          properties: ["openFile"],
          filters: [
            { name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] },
            { name: "All files", extensions: ["*"] },
          ],
        });

        // Cancelling is not an error: the profile page simply keeps what it had.
        const chosen = result.canceled ? undefined : result.filePaths[0];
        if (chosen === undefined) return { name: auth.currentAvatarName(deps.db, user.id) ?? "" };

        const name = storeAvatar(
          deps.avatarsDir(),
          user.id,
          chosen,
          auth.currentAvatarName(deps.db, user.id),
        );
        deps.session.reloadPermissions(user.id);
        return { name };
      },
    },

    /* ------------------------------------------------------------ license -- */

    "license.check": {
      schema: schemas.licenseCheckSchema,
      anonymous: true,
      handler: async () => {
        // Development runs and the end-to-end suite set LICENCE_DISABLED: there
        // is no key to install there, and the activation screen would otherwise
        // stand between an automated test and the screen it is testing.
        if (isLicenseDisabled()) {
          return {
            ok: true,
            machineId: "",
            clientName: "Development",
            expiresAt: null,
            daysUntilExpiry: null,
            isExpiringSoon: false,
          };
        }

        const result = await loadAndVerifyLicense();
        return {
          ok: result.valid,
          machineId: await getMachineId(),
          clientName: result.payload?.clientName ?? "",
          expiresAt: result.payload?.expiresAt ?? null,
          daysUntilExpiry: result.daysUntilExpiry,
          isExpiringSoon: result.isExpiringSoon,
        };
      },
    },

    "license.activate": {
      schema: schemas.licenseActivateSchema,
      anonymous: true,
      // Every exit from this handler is a settled outcome. Activation is the
      // one call a shopkeeper makes on a machine that may be half-configured,
      // so nothing in it is allowed to escape as a raw rejection: each failure
      // is re-thrown as a typed RpcError, which `dispatchRpc` turns into the
      // `{ ok: false, error }` the renderer is guaranteed to receive.
      handler: async (payload) => {
        const request = payload as { key: string };

        let result: Awaited<ReturnType<typeof verifyLicenseKey>>;
        try {
          result = await verifyLicenseKey(request.key);
        } catch {
          // `verifyLicenseKey` does not throw, but it reads the machine ID,
          // which does shell out to the OS. A failure there is a verification
          // failure, not a crashed handler.
          throw new RpcError(
            "LICENSE",
            "This computer's ID could not be read, so the key cannot be checked. Restart the app and try again.",
            "key",
          );
        }

        if (!result.valid || result.payload === null) {
          // The reason is already written for a shopkeeper ("This key is for a
          // different computer"), so it is passed through as a typed failure
          // rather than masked into the generic "Something went wrong".
          throw new RpcError("LICENSE", result.error ?? "Invalid license key", "key");
        }

        try {
          saveLicense(request.key);
        } catch {
          // Writing the licence file is the one step that can fail for reasons
          // outside the key itself: a full disk, or a data folder that is not
          // writable. Without this the save would reject with a raw fs error
          // the renderer cannot interpret, and the button would sit on its
          // spinner looking like a hang.
          throw new RpcError(
            "LICENSE",
            "The licence could not be saved on this computer. Check that the app's data folder is writable, then try again.",
            "key",
          );
        }

        return {
          ok: true,
          machineId: await getMachineId(),
          clientName: result.payload.clientName,
          expiresAt: result.payload.expiresAt,
          daysUntilExpiry: result.daysUntilExpiry,
          isExpiringSoon: result.isExpiringSoon,
        };
      },
    },

    "license.status": {
      schema: schemas.licenseStatusSchema,
      handler: async () => {
        const status = await getLicenseStatus();
        if (!status) {
          throw new RpcError("LICENSE", "No license status available");
        }
        return {
          clientName: status.clientName,
          expiresAt: status.expiresAt,
          daysUntilExpiry: status.daysUntilExpiry,
          isExpiringSoon: status.isExpiringSoon,
          machineId: await getMachineId(),
        };
      },
    },

    /* ---------------------------------------------------------- dashboard -- */

    "dashboard.summary": {
      schema: schemas.dashboardSchema,
      permission: { module: "dashboard", action: "view" },
      handler: (payload, deps) => {
        const request = payload as {
          fromDate?: string;
          toDate?: string;
          previousFromDate?: string;
          previousToDate?: string;
          includeInventory?: boolean;
        };
        return reports.dashboardSummary(deps.db, request, deps.now());
      },
    },

    /* ------------------------------------------------------------ reports -- */

    "reports.profitAndLoss": {
      schema: schemas.pnlSchema,
      permission: { module: "reports", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { fromDate: string; toDate: string };
        return reports.profitAndLoss(deps.db, request.fromDate, request.toDate);
      },
    },

    "reports.partnerSplit": {
      schema: schemas.partnerSplitSchema,
      permission: { module: "reports", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { fromDate: string; toDate: string };
        const settings = deps.loadSettings();
        return reports.partnerSplit(
          deps.db,
          request.fromDate,
          request.toDate,
          partners.listPartners(deps.db),
          {
            donationRatePercent: settings.donationRatePercent,
          },
        );
      },
    },

    "reports.stockValuation": {
      schema: schemas.stockValuationSchema,
      permission: { module: "reports", action: "view" },
      handler: (_payload, deps) => ({
        rows: reports.stockValuation(deps.db, products.listProducts(deps.db, { onlyActive: true })),
      }),
    },

    "reports.documentRegister": {
      schema: schemas.documentRegisterSchema,
      permission: { module: "reports", action: "view" },
      handler: (payload, deps) => {
        const request = payload as {
          kind: "invoice" | "purchaseInvoice";
          fromDate: string;
          toDate: string;
          status?: "draft" | "issued" | "partPaid" | "paid" | "cancelled";
          partyId?: number;
          search?: string;
        };
        return reports.documentRegister(deps.db, request);
      },
    },

    "reports.export": {
      schema: schemas.exportSchema,
      permission: { module: "reports", action: "export" },
      handler: (payload, deps) => {
        const request = payload as {
          dataset: "profitAndLoss" | "partnerSplit" | "sales" | "stock";
          fromDate?: string;
          toDate?: string;
        };

        const from = request.fromDate ?? todayIso(deps.now()).slice(0, 8) + "01-01";
        const to = request.toDate ?? todayIso(deps.now());
        const stamp = `${from}_${to}`;

        let rows: readonly (readonly (string | number)[])[];
        let filename: string;

        if (request.dataset === "profitAndLoss") {
          const pnl = reports.profitAndLoss(deps.db, from, to);
          rows = [
            ["Profit and loss", `${from} to ${to}`],
            [],
            ["Revenue", toPkr(pnl.revenueFils)],
            ["Cost of goods", toPkr(pnl.costOfGoodsFils)],
            ["Gross profit", toPkr(pnl.grossProfitFils)],
            ["Gross margin %", pnl.grossMarginPercent],
            ["Operating expenses", toPkr(pnl.operatingExpensesFils)],
            ["Net profit", toPkr(pnl.netProfitFils)],
            [],
            ["Category", "Amount (PKR)"],
            ...pnl.expensesByCategory.map((row) => [row.category, toPkr(row.amountFils)] as const),
          ];
          filename = `profit-and-loss-${stamp}.csv`;
        } else if (request.dataset === "partnerSplit") {
          const settings = deps.loadSettings();
          const split = reports.partnerSplit(deps.db, from, to, partners.listPartners(deps.db), {
            donationRatePercent: settings.donationRatePercent,
          });
          rows = [
            ["Partner split", `${from} to ${to}`],
            [],
            ["Net profit", toPkr(split.netProfitFils)],
            [`Donation (${split.donationRatePercent}%)`, toPkr(split.donationFils)],
            ["Distributable", toPkr(split.distributableFils)],
            [],
            ["Partner", "Share %", "Amount (PKR)"],
            ...split.partners.map(
              (partner) => [partner.name, partner.sharePercent, toPkr(partner.amountFils)] as const,
            ),
          ];
          filename = `partner-split-${stamp}.csv`;
        } else if (request.dataset === "sales") {
          const sales = reports.salesReport(deps.db, from, to);
          rows = [
            [
              "Invoice",
              "Date",
              "Customer",
              "Net (PKR)",
              "VAT (PKR)",
              "Gross (PKR)",
              "Paid (PKR)",
              "Outstanding (PKR)",
              "Status",
            ],
            ...sales.map(
              (row) =>
                [
                  row.number,
                  row.issueDate,
                  row.partyName,
                  toPkr(row.netFils),
                  toPkr(row.vatFils),
                  toPkr(row.grossFils),
                  toPkr(row.paidFils),
                  toPkr(row.outstandingFils),
                  row.status,
                ] as const,
            ),
          ];
          filename = `sales-${stamp}.csv`;
        } else {
          const stock = reports.stockValuation(
            deps.db,
            products.listProducts(deps.db, { onlyActive: true }),
          );
          rows = [
            ["Code", "Item", "Category", "Quantity", "Average cost (PKR)", "Value (PKR)"],
            ...stock.map(
              (row) =>
                [
                  row.sku,
                  row.name,
                  row.category ?? "",
                  row.quantityMilli / 1000,
                  toPkr(row.averageCostFils),
                  toPkr(row.valueFils),
                ] as const,
            ),
          ];
          filename = `stock-${stamp}.csv`;
        }

        const path = reports.exportReportCsv(deps.exportDir(), filename, rows);

        recordAudit(
          deps.db,
          deps.session.currentOrNull() === null
            ? SYSTEM_ACTOR
            : toActor(deps.session.current().user),
          {
            module: "reports",
            action: "export",
            entityType: "dataset",
            entityId: request.dataset,
          },
          new Date().toISOString(),
        );
        return { path };
      },
    },

    /* ------------------------------------------------------------ parties -- */

    "parties.list": {
      schema: schemas.partyListSchema,
      permission: { module: "parties", action: "view" },
      handler: (payload, deps) => parties.listParties(deps.db, payload as never),
    },

    "parties.get": {
      schema: schemas.partyGetSchema,
      permission: { module: "parties", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return parties.getParty(deps.db, request.id);
      },
    },

    "parties.save": {
      schema: schemas.partySaveSchema,
      permission: { module: "parties", action: "create" },
      handler: (payload, deps, ctx) => {
        // Editing needs the edit permission, creating needs create. Both are
        // checked here rather than in the UI so a crafted request cannot
        // escalate by sending an id.
        const request = payload as { id?: number };
        deps.session.require("parties", request.id === undefined ? "create" : "edit");
        return parties.saveParty(deps.db, ctx.actor, request as never, ctx.nowIso);
      },
    },

    "parties.delete": {
      schema: schemas.partyDeleteSchema,
      permission: { module: "parties", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        parties.deleteParty(deps.db, ctx.actor, request.id, ctx.nowIso);
        return { ok: true as const };
      },
    },

    /* ----------------------------------------------------------- products -- */

    "products.list": {
      schema: schemas.productListSchema,
      permission: { module: "products", action: "view" },
      handler: (payload, deps) => products.listProducts(deps.db, payload as never),
    },

    "products.get": {
      schema: schemas.productGetSchema,
      permission: { module: "products", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return products.getProduct(deps.db, request.id);
      },
    },

    "products.save": {
      schema: schemas.productSaveSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number };
        deps.session.require("products", request.id === undefined ? "create" : "edit");
        return products.saveProduct(deps.db, ctx.actor, request as never, ctx.nowIso);
      },
    },

    "products.openStock": {
      schema: schemas.openStockSchema,
      permission: { module: "inventory", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as {
          productId: number;
          quantityMilli: number;
          unitCostFils: number;
          notes?: string;
        };
        return products.setOpeningStock(deps.db, ctx.actor, request, ctx.nowIso);
      },
    },

    "products.movements": {
      schema: schemas.stockMovementListSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => products.listMovements(deps.db, payload as never),
    },

    "products.delete": {
      schema: schemas.productDeleteSchema,
      permission: { module: "products", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        products.deleteProduct(deps.db, ctx.actor, request.id, ctx.nowIso);
        return { ok: true as const };
      },
    },

    /* --------------------------------------------------------------- IMS --- */

    "ims.reference": {
      schema: emptySchema,
      permission: { module: "products", action: "view" },
      handler: (_payload, deps) => imsReference.referenceData(deps.db),
    },

    "ims.dashboard": {
      schema: schemas.imsDashboardSchema,
      permission: { module: "dashboard", action: "view" },
      handler: (payload, deps) => imsAnalytics.dashboard(deps.db, payload as never),
    },

    "ims.report": {
      schema: schemas.imsReportSchema,
      permission: { module: "reports", action: "view" },
      handler: (payload, deps) => imsAnalytics.runReport(deps.db, payload as never),
    },

    "ims.reports.list": {
      schema: emptySchema,
      permission: { module: "reports", action: "view" },
      handler: () => imsAnalytics.reportTitles(),
    },

    "ims.config.get": {
      schema: emptySchema,
      permission: { module: "settings", action: "view" },
      handler: (_payload, deps) => imsReference.readConfig(deps.db),
    },

    "ims.config.update": {
      schema: schemas.imsConfigUpdateSchema,
      permission: { module: "settings", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.updateConfig(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "ims.locations.list": {
      schema: emptySchema,
      permission: { module: "inventory", action: "view" },
      handler: (_payload, deps) => imsReference.listLocations(deps.db),
    },

    "ims.locations.save": {
      schema: schemas.imsLocationSaveSchema,
      permission: { module: "settings", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.saveLocation(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "ims.brands.list": {
      schema: emptySchema,
      permission: { module: "products", action: "view" },
      handler: (_payload, deps) => imsReference.listBrands(deps.db),
    },

    "ims.brands.save": {
      schema: schemas.imsBrandSaveSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.saveBrand(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "ims.units.list": {
      schema: emptySchema,
      permission: { module: "products", action: "view" },
      handler: (_payload, deps) => imsReference.listUnits(deps.db),
    },

    "ims.units.save": {
      schema: schemas.imsUnitSaveSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.saveUnit(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "ims.categories.list": {
      schema: emptySchema,
      permission: { module: "products", action: "view" },
      handler: (_payload, deps) => imsReference.listCategories(deps.db),
    },

    "ims.categories.rename": {
      schema: schemas.imsCategoryRenameSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { from: string; to: string };
        return imsReference.renameCategory(deps.db, ctx.actor, request.from, request.to, ctx.nowIso);
      },
    },

    "ims.priceLists.list": {
      schema: emptySchema,
      permission: { module: "products", action: "view" },
      handler: (_payload, deps) => imsReference.listPriceLists(deps.db),
    },

    "ims.priceLists.save": {
      schema: schemas.imsPriceListSaveSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.savePriceList(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "ims.priceItems.list": {
      schema: schemas.imsPriceItemsListSchema,
      permission: { module: "products", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { priceListId: number };
        return imsReference.listPriceItems(deps.db, request.priceListId);
      },
    },

    "ims.priceItems.save": {
      schema: schemas.imsPriceItemSaveSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.savePriceItem(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "ims.priceItems.delete": {
      schema: schemas.imsPriceItemDeleteSchema,
      permission: { module: "products", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return imsReference.deletePriceItem(deps.db, ctx.actor, request.id, ctx.nowIso);
      },
    },

    "ims.price.resolve": {
      schema: schemas.imsResolvePriceSchema,
      permission: { module: "products", action: "view" },
      handler: (payload, deps) => imsReference.resolvePrice(deps.db, payload as never),
    },

    "ims.documents.list": {
      schema: schemas.imsListSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { kind?: string };
        if (request.kind !== undefined) {
          const module = request.kind.startsWith("purchase") || request.kind === "supplierReturn"
            ? "purchases"
            : request.kind.startsWith("sales")
              ? "sales"
              : "inventory";
          deps.session.require(module, "view");
        }
        return imsOperations.listOperations(deps.db, payload as never);
      },
    },

    "ims.documents.get": {
      schema: schemas.imsGetSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return imsOperations.getOperation(deps.db, request.id);
      },
    },

    "ims.documents.save": {
      schema: schemas.imsSaveSchema,
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number; kind: string };
        const module = request.kind.startsWith("purchase") || request.kind === "supplierReturn"
          ? "purchases"
          : request.kind.startsWith("sales")
            ? "sales"
            : "inventory";
        deps.session.require(module, request.id === undefined ? "create" : "edit");
        return imsOperations.saveOperation(operationContext(deps, ctx), payload as never);
      },
    },

    "ims.documents.transition": {
      schema: schemas.imsTransitionSchema,
      permission: { module: "inventory", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number; action: string; reason?: string | null; locationId?: number | null };
        return deps.db.transaction(() => {
          const saved = imsOperations.transitionOperation(
            operationContext(deps, ctx),
            request.id,
            request.action as never,
            request.reason ?? null,
            request.locationId ?? null,
          );
          if (saved.resultDocumentId !== null) {
            syncDocumentPosting(accountingContext(deps, ctx), documents.getDocument(deps.db, saved.resultDocumentId));
          }
          return saved;
        })();
      },
    },

    "ims.documents.convert": {
      schema: schemas.imsConvertSchema,
      permission: { module: "inventory", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number; targetKind: string; clientToken?: string | null };
        return deps.db.transaction(() => {
          const converted = imsOperations.convertOperation(
            operationContext(deps, ctx),
            request.id,
            request.targetKind as never,
            request.clientToken ?? null,
          );
          return converted;
        })();
      },
    },

    "ims.documents.receiveTransfer": {
      schema: schemas.imsReceiveTransferSchema,
      permission: { module: "inventory", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsOperations.receiveTransferOperation(operationContext(deps, ctx), payload as never),
    },

    "ims.stock.overview": {
      schema: schemas.imsStockOverviewSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => stockOverview(deps.db, payload as never),
    },

    "ims.stock.batches": {
      schema: schemas.imsStockListSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps, ctx) => {
        const request = payload as { search?: string; expiringDays?: number; limit?: number };
        return listBatches(deps.db, request, new Date(`${ctx.nowDate}T00:00:00Z`));
      },
    },

    "ims.stock.serials": {
      schema: schemas.imsStockListSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => listSerials(deps.db, payload as never),
    },

    "ims.stock.reservations": {
      schema: schemas.imsReservationListSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => listReservations(deps.db, payload as never),
    },

    "ims.stock.releaseReservation": {
      schema: schemas.imsReleaseReservationSchema,
      permission: { module: "inventory", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        const row = deps.db.prepare("SELECT source_kind, source_id FROM ims_reservations WHERE id = ?").get(request.id) as
          | { source_kind: string; source_id: number }
          | undefined;
        if (row === undefined) throw new imsOperations.ImsOperationError("That reservation was not found.");
        releaseReservations(deps.db, row.source_kind, row.source_id, "released", ctx.nowIso);
        recordAudit(
          deps.db,
          ctx.actor,
          { module: "inventory", action: "releaseReservation", entityType: "imsReservation", entityId: request.id },
          ctx.nowIso,
        );
        return { ok: true as const };
      },
    },

    "ims.products.detail": {
      schema: schemas.imsProductDetailSchema,
      permission: { module: "products", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return imsReference.productDetail(deps.db, request.id);
      },
    },

    "ims.products.variants": {
      schema: schemas.imsVariantListSchema,
      permission: { module: "products", action: "view" },
      handler: (payload, deps) => imsReference.listVariants(deps.db, payload as never),
    },

    "ims.products.saveVariant": {
      schema: schemas.imsVariantSaveSchema,
      permission: { module: "products", action: "edit" },
      handler: (payload, deps, ctx) =>
        imsReference.saveVariant(
          deps.db,
          ctx.actor,
          payload as never,
          ctx.nowIso,
          ctx.allowNegativeStock,
        ),
    },

    "ims.replenishment.list": {
      schema: schemas.imsReplenishmentSchema,
      permission: { module: "inventory", action: "view" },
      handler: (payload, deps) => replenishmentRows(deps.db, payload as never),
    },

    "ims.replenishment.createRequisition": {
      schema: schemas.imsReplenishmentConvertSchema,
      permission: { module: "purchases", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as { productIds: number[]; supplierId?: number | null; locationId?: number };
        return deps.db.transaction(() =>
          imsOperations.createRequisitionForProducts(operationContext(deps, ctx), {
            productIds: request.productIds,
            supplierId: request.supplierId ?? null,
            locationId: request.locationId ?? null,
          }),
        )();
      },
    },

    "ims.pos.state": {
      schema: emptySchema,
      permission: { module: "sales", action: "view" },
      handler: (_payload, deps) => imsPos.posState(deps.db),
    },

    "ims.pos.open": {
      schema: schemas.imsPosOpenSchema,
      permission: { module: "sales", action: "create" },
      handler: (payload, deps, ctx) => imsPos.openShift(posContext(deps, ctx), payload as never),
    },

    "ims.pos.close": {
      schema: schemas.imsPosCloseSchema,
      permission: { module: "sales", action: "edit" },
      handler: (payload, deps, ctx) => imsPos.closeShift(posContext(deps, ctx), payload as never),
    },

    "ims.pos.sale": {
      schema: schemas.imsPosSaleSchema,
      permission: { module: "sales", action: "create" },
      handler: (payload, deps, ctx) => {
        return deps.db.transaction(() => {
          const result = imsPos.completeSale(posContext(deps, ctx), payload as never);
          syncDocumentPosting(accountingContext(deps, ctx), documents.getDocument(deps.db, result.documentId));
          return result;
        })();
      },
    },

    "ims.pos.history": {
      schema: schemas.imsPosHistorySchema,
      permission: { module: "sales", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { limit?: number };
        return imsPos.posHistory(deps.db, request.limit ?? 100);
      },
    },

    /* ---------------------------------------------------------- documents -- */

    "documents.list": {
      schema: schemas.documentListSchema,
      permission: { module: "sales", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { kind?: "invoice" | "purchaseInvoice" };
        // A purchase screen asks for its own module; sales covers the rest.
        if (request.kind === "purchaseInvoice") {
          deps.session.require("purchases", "view");
        }
        return documents.listDocuments(deps.db, request);
      },
    },

    "documents.get": {
      schema: schemas.documentGetSchema,
      permission: { module: "sales", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return documents.getDocument(deps.db, request.id);
      },
    },

    "documents.save": {
      schema: schemas.documentSaveSchema,
      handler: (payload, deps, ctx) => {
        const request = payload as SaveDocumentRequest;

        const module: PermissionModule = request.kind === "purchaseInvoice" ? "purchases" : "sales";

        deps.session.require(module, request.id === undefined ? "create" : "edit");

        // The business write and its journal entry share one transaction, so a
        // document can never be saved without being posted, or posted without
        // being saved.
        return deps.db.transaction(() => {
          const saved = documents.saveDocument(
            {
              db: deps.db,
              actor: ctx.actor,
              fiscalYearStartMonth: ctx.fiscalYearStartMonth,
              nowIso: ctx.nowIso,
              nowDate: ctx.nowDate,
              allowNegativeStock: ctx.allowNegativeStock,
              vatRate: ctx.vatRate,
            },
            request,
          );

          syncDocumentPosting(accountingContext(deps, ctx), saved);

          return saved;
        })();
      },
    },

    "documents.cancel": {
      schema: schemas.documentCancelSchema,
      permission: { module: "sales", action: "cancel" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number; reason: string };
        return deps.db.transaction(() => {
          const cancelled = documents.cancelDocument(
            {
              db: deps.db,
              actor: ctx.actor,
              fiscalYearStartMonth: ctx.fiscalYearStartMonth,
              nowIso: ctx.nowIso,
              nowDate: ctx.nowDate,
              allowNegativeStock: ctx.allowNegativeStock,
              vatRate: ctx.vatRate,
            },
            request.id,
            request.reason,
          );

          // A cancelled document is corrected by a reversing entry, never by
          // deleting what it posted.
          reverseDocumentPosting(
            accountingContext(deps, ctx),
            cancelled,
            `Cancelled: ${request.reason}`,
          );

          return cancelled;
        })();
      },
    },

    "documents.delete": {
      schema: schemas.documentDeleteSchema,
      permission: { module: "sales", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        deps.db.transaction(() => {
          const document = documents.getDocument(deps.db, request.id);
          documents.deleteDocument(
            {
              db: deps.db,
              actor: ctx.actor,
              fiscalYearStartMonth: ctx.fiscalYearStartMonth,
              nowIso: ctx.nowIso,
              nowDate: ctx.nowDate,
              allowNegativeStock: ctx.allowNegativeStock,
              vatRate: ctx.vatRate,
            },
            request.id,
          );
          reverseDocumentPosting(
            accountingContext(deps, ctx),
            document,
            "The document was deleted",
          );
        })();
        return { ok: true as const };
      },
    },

    "documents.numberPreview": {
      schema: schemas.numberPreviewSchema,
      permission: { module: "sales", action: "view" },
      handler: (payload, deps, ctx) => {
        const request = payload as { kind: "invoice" | "purchaseInvoice" };
        return {
          number: peekStockNumber(deps.db, request.kind, ctx.fiscalYearOf(ctx.nowDate)),
        };
      },
    },

    /* ----------------------------------------------------------- payments -- */

    "payments.list": {
      schema: schemas.paymentListSchema,
      permission: { module: "payments", action: "view" },
      handler: (payload, deps) => payments.listPayments(deps.db, payload as never),
    },

    "payments.save": {
      schema: schemas.paymentSaveSchema,
      permission: { module: "payments", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as never;
        return deps.db.transaction(() => {
          const saved = payments.savePayment(
            {
              db: deps.db,
              actor: ctx.actor,
              fiscalYearStartMonth: ctx.fiscalYearStartMonth,
              nowIso: ctx.nowIso,
              nowDate: ctx.nowDate,
            },
            request,
          );
          syncPaymentPosting(accountingContext(deps, ctx), saved);
          return saved;
        })();
      },
    },

    "payments.delete": {
      schema: schemas.paymentDeleteSchema,
      permission: { module: "payments", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        deps.db.transaction(() => {
          const payment = payments.getPayment(deps.db, request.id);
          payments.deletePayment(
            {
              db: deps.db,
              actor: ctx.actor,
              fiscalYearStartMonth: ctx.fiscalYearStartMonth,
              nowIso: ctx.nowIso,
            },
            request.id,
          );
          reversePaymentPosting(accountingContext(deps, ctx), payment.id);
        })();
        return { ok: true as const };
      },
    },

    /* ----------------------------------------------------------- expenses -- */

    "expenses.list": {
      schema: schemas.expenseListSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => reports.listExpenses(deps.db, payload as never),
    },

    "expenses.save": {
      schema: schemas.expenseSaveSchema,
      permission: { module: "finance", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number };
        deps.session.require("finance", request.id === undefined ? "create" : "edit");
        return deps.db.transaction(() => {
          const saved = reports.saveExpense(
            { db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso },
            request as never,
          );
          syncExpensePosting(accountingContext(deps, ctx), saved);
          return saved;
        })();
      },
    },

    "expenses.delete": {
      schema: schemas.expenseDeleteSchema,
      permission: { module: "finance", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return deps.db.transaction(() => {
          reports.deleteExpense({ db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso }, request.id);
          // The expense's posting is reversed rather than deleted, so the
          // ledger keeps the record of what was there and what was undone.
          reverseExpensePosting(accountingContext(deps, ctx), request.id);
          return { ok: true as const };
        })();
      },
    },

    /* ------------------------------------------------------------- finance -- */

    /**
     * The Finance module.
     *
     * Every method is read-only except the ones that write: the chart of
     * accounts, the journal, the transfers and the opening balances. Each one
     * is checked for the "finance" permission, and the ones that create or
     * change financial records additionally require the matching action, so a
     * user who may look at the books cannot quietly rewrite them.
     */
    "finance.overview": {
      schema: schemas.financeOverviewSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as {
          fromDate: string;
          toDate: string;
          asOfDate: string;
          previousFromDate: string;
          previousToDate: string;
          granularity?: "day" | "week" | "month" | "quarter" | "year" | undefined;
        };
        return finance.readOverview(deps.db, request);
      },
    },

    "finance.chart": {
      schema: schemas.financeChartSchema,
      permission: { module: "finance", action: "view" },
      handler: (_payload, deps) => finance.readChart(deps.db),
    },

    "finance.chart.save": {
      schema: schemas.financeAccountSaveSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number | undefined };
        deps.session.require("finance", request.id === undefined ? "create" : "edit");
        return finance.writeChart(deps.db, request as never, ctx.nowIso);
      },
    },

    "finance.chart.setActive": {
      schema: schemas.financeAccountActiveSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number; isActive: boolean };
        return finance.toggleChartAccount(deps.db, request.id, request.isActive, ctx.nowIso);
      },
    },

    "finance.chart.delete": {
      schema: schemas.financeAccountIdSchema,
      permission: { module: "finance", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        finance.removeChartAccount(deps.db, request.id, ctx.nowIso);
        return { ok: true as const };
      },
    },

    "finance.chart.export": {
      schema: schemas.financeChartSchema,
      permission: { module: "finance", action: "export" },
      handler: (_payload, deps) => ({
        path: finance.exportFinanceReport(deps.db, deps.exportDir(), {
          dataset: "chartOfAccounts",
        }),
      }),
    },

    "finance.generalLedger": {
      schema: schemas.financeGeneralLedgerSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { code: string; fromDate: string; toDate: string };
        return finance.readGeneralLedger(deps.db, request.code, request.fromDate, request.toDate);
      },
    },

    "finance.journal.list": {
      schema: schemas.financeJournalListSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as {
          fromDate?: string | undefined;
          toDate?: string | undefined;
          source?: JournalSource | undefined;
          status?: JournalStatus | undefined;
          search?: string | undefined;
          accountCode?: string | undefined;
          limit?: number | undefined;
        };
        return finance.readJournal(deps.db, request);
      },
    },

    "finance.journal.get": {
      schema: schemas.financeJournalGetSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return finance.readJournalEntry(deps.db, request.id);
      },
    },

    "finance.journal.save": {
      schema: schemas.financeJournalSaveSchema,
      permission: { module: "finance", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number | undefined };
        deps.session.require("finance", request.id === undefined ? "create" : "edit");
        return finance.writeJournal(
          deps.db,
          request as never,
          ctx.nowIso,
          ctx.actor.name.length > 0 ? ctx.actor.name : undefined,
        );
      },
    },

    "finance.journal.post": {
      schema: schemas.financeJournalGetSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return finance.publishJournal(
          deps.db,
          request.id,
          ctx.nowIso,
          ctx.actor.name.length > 0 ? ctx.actor.name : undefined,
        );
      },
    },

    "finance.journal.reverse": {
      schema: schemas.financeJournalReverseSchema,
      permission: { module: "finance", action: "cancel" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number; reason: string };
        return finance.reverseJournal(
          deps.db,
          request.id,
          request.reason,
          ctx.nowIso,
          ctx.nowDate,
          ctx.actor.name.length > 0 ? ctx.actor.name : undefined,
        );
      },
    },

    "finance.journal.deleteDraft": {
      schema: schemas.financeJournalGetSchema,
      permission: { module: "finance", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        finance.discardDraft(
          deps.db,
          request.id,
          ctx.nowIso,
          ctx.actor.name.length > 0 ? ctx.actor.name : undefined,
        );
        return { ok: true as const };
      },
    },

    "finance.trialBalance": {
      schema: schemas.financeTrialBalanceSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { fromDate: string; toDate: string };
        return finance.readTrialBalance(deps.db, request.fromDate, request.toDate);
      },
    },

    "finance.balanceSheet": {
      schema: schemas.financeBalanceSheetSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { asOfDate: string };
        return finance.readBalanceSheet(deps.db, request.asOfDate);
      },
    },

    "finance.profitAndLoss": {
      schema: schemas.financePnlSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { fromDate: string; toDate: string };
        return finance.readProfitAndLoss(deps.db, request.fromDate, request.toDate);
      },
    },

    "finance.cashFlow": {
      schema: schemas.financeCashFlowSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { fromDate: string; toDate: string };
        return finance.readCashFlow(deps.db, request.fromDate, request.toDate);
      },
    },

    "finance.aging": {
      schema: schemas.financeAgingSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { asOfDate: string; side: "receivable" | "payable" };
        return finance.readAging(deps.db, request.asOfDate, request.side);
      },
    },

    "finance.partyStatement": {
      schema: schemas.financePartyStatementSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as {
          partyId: number;
          kind: "customer" | "supplier";
          fromDate: string;
          toDate: string;
        };
        return finance.readPartyStatement(
          deps.db,
          request.partyId,
          request.kind,
          request.fromDate,
          request.toDate,
        );
      },
    },

    "finance.partyBalances": {
      schema: schemas.financePartyBalancesSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { kind: "customer" | "supplier"; asOfDate: string };
        return finance.readPartyBalances(deps.db, request.kind, request.asOfDate);
      },
    },

    "finance.cashBook": {
      schema: schemas.financeCashBookSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { accountCode: string; fromDate: string; toDate: string };
        return finance.readCashBook(deps.db, request.accountCode, request.fromDate, request.toDate);
      },
    },

    "finance.periodComparison": {
      schema: schemas.financePeriodComparisonSchema,
      permission: { module: "finance", action: "view" },
      handler: (payload, deps) => {
        const request = payload as {
          fromDate: string;
          toDate: string;
          previousFromDate: string;
          previousToDate: string;
        };
        return finance.readPeriodComparison(
          deps.db,
          request.fromDate,
          request.toDate,
          request.previousFromDate,
          request.previousToDate,
        );
      },
    },

    "finance.export": {
      schema: schemas.financeExportSchema,
      permission: { module: "finance", action: "export" },
      handler: (payload, deps) => {
        const request = payload as {
          dataset: ExportDataset;
          fromDate?: string | undefined;
          toDate?: string | undefined;
          accountCode?: string | undefined;
          partyId?: number | undefined;
          partyKind?: "customer" | "supplier" | undefined;
        };
        return {
          path: finance.exportFinanceReport(deps.db, deps.exportDir(), request),
        };
      },
    },

    "finance.transfer": {
      schema: schemas.financeTransferSchema,
      permission: { module: "finance", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as {
          transferDate: string;
          fromAccountCode: string;
          toAccountCode: string;
          amountFils: number;
          reference?: string | null | undefined;
        };
        finance.recordTransfer(deps.db, request, ctx.nowIso, ctx.actor.name);
        return { ok: true as const };
      },
    },

    "finance.recordPayment": {
      schema: schemas.financeRecordPaymentSchema,
      permission: { module: "payments", action: "create" },
      handler: (payload, deps, ctx) => {
        const request = payload as {
          direction: "inbound" | "outbound";
          partyId: number;
          paymentDate: string;
          method: PaymentMethod;
          amountFils: number;
          reference?: string | null | undefined;
          notes?: string | null | undefined;
          allocations?: readonly { readonly documentId: number; readonly amountFils: number }[];
          postingKind?: PaymentPostingKind | undefined;
          cashAccountCode?: string | undefined;
          expenseAccountCode?: string | undefined;
        };
        return deps.db.transaction(() => {
          const saved = payments.savePayment(
            {
              db: deps.db,
              actor: ctx.actor,
              fiscalYearStartMonth: ctx.fiscalYearStartMonth,
              nowIso: ctx.nowIso,
              nowDate: ctx.nowDate,
            },
            request as never,
          );
          // The payment owns the cash movement, so it is the payment that
          // posts. Without this the money would sit in the records and never
          // reach the ledger, and the cash balance on the dashboard would be
          // short by exactly what was taken.
          syncPaymentPosting(accountingContext(deps, ctx), saved, {
            kind: request.postingKind ?? "auto",
            cashAccountCode: request.cashAccountCode,
            expenseAccountCode: request.expenseAccountCode,
          });
          return saved;
        })();
      },
    },

    "finance.periods.list": {
      schema: schemas.financeChartSchema,
      permission: { module: "finance", action: "view" },
      handler: (_payload, deps) => finance.listPeriods(deps.db),
    },

    "finance.periods.save": {
      schema: schemas.financePeriodSaveSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number | undefined };
        return finance.savePeriod(deps.db, request as never, ctx.nowIso);
      },
    },

    "finance.periods.close": {
      schema: schemas.financePeriodIdSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return finance.closePeriod(deps.db, request.id, ctx.nowIso, ctx.actor.name, {
          id: ctx.actor.id ?? 0,
          name: ctx.actor.name,
        });
      },
    },

    "finance.periods.reopen": {
      schema: schemas.financePeriodIdSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return finance.reopenPeriod(deps.db, request.id, ctx.nowIso, ctx.actor.name);
      },
    },

    "finance.openingBalances": {
      schema: schemas.financeOpeningBalancesSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as {
          entryDate: string;
          balances: readonly {
            readonly accountCode: string;
            readonly debitFils: number;
            readonly creditFils: number;
          }[];
        };
        finance.recordOpeningBalances(
          deps.db,
          request,
          ctx.nowIso,
          ctx.actor.name.length > 0 ? ctx.actor.name : undefined,
        );
        return { ok: true as const };
      },
    },

    "finance.migrationAudit": {
      schema: schemas.financeMigrationAuditSchema,
      permission: { module: "finance", action: "view" },
      handler: (_payload, deps) => finance.migrationAudit(deps.db),
    },

    "finance.backfill": {
      schema: schemas.financeBackfillSchema,
      permission: { module: "finance", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { confirm: boolean };
        return finance.backfillHistory(
          deps.db,
          request.confirm,
          ctx.nowIso,
          ctx.nowDate,
          ctx.actor.name,
        );
      },
    },

    /* ----------------------------------------------------------- partners -- */

    "partners.list": {
      schema: schemas.partnerListSchema,
      permission: { module: "partners", action: "view" },
      handler: (_payload, deps) => partners.listPartners(deps.db),
    },

    "partners.save": {
      schema: schemas.partnerSaveSchema,
      permission: { module: "partners", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id?: number };
        deps.session.require("partners", request.id === undefined ? "create" : "edit");
        return partners.savePartner(
          { db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso },
          request as never,
        );
      },
    },

    "partners.transactions": {
      schema: schemas.partnerTransactionsSchema,
      permission: { module: "partners", action: "view" },
      handler: (payload, deps) =>
        partners.listPartnerTransactions(deps.db, (payload as { limit?: number }).limit ?? 200),
    },

    /* ----------------------------------------------------- administration -- */

    "users.list": {
      schema: schemas.userListSchema,
      permission: { module: "users", action: "view" },
      handler: (_payload, deps) => auth.listUsers(deps.db),
    },

    "users.save": {
      schema: schemas.userSaveSchema,
      permission: { module: "users", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as SaveUserRequest;
        deps.session.require("users", request.id === undefined ? "create" : "edit");
        const result = auth.saveUser(
          { db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso },
          request,
        );
        // A user editing their own role must see the change immediately,
        // not at next sign-in.
        if (request.id !== undefined && deps.session.currentOrNull()?.user.id === request.id) {
          deps.session.reloadPermissions(request.id);
        }
        return result;
      },
    },

    "users.resetPassword": {
      schema: schemas.resetPasswordSchema,
      permission: { module: "users", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as {
          id: number;
          newPassword: string;
          mustChangePassword?: boolean;
        };
        return auth.resetPassword(
          { db: deps.db, actor: ctx.actor, nowIso: ctx.nowIso },
          request.id,
          request.newPassword,
          request.mustChangePassword !== false,
        );
      },
    },

    "settings.get": {
      schema: schemas.settingsGetSchema,
      handler: (_payload, deps) => deps.loadSettings(),
    },

    "settings.update": {
      schema: schemas.settingsUpdateSchema,
      permission: { module: "settings", action: "edit" },
      handler: (payload, deps, ctx) => {
        const patch = payload as UpdateSettings;
        const next = deps.updateSettings(patch);
        recordAudit(
          deps.db,
          ctx.actor,
          {
            module: "settings",
            action: "update",
            entityType: "settings",
            entityId: null,
            newValues: patch,
          },
          ctx.nowIso,
        );
        return next;
      },
    },

    /* --------------------------------------------------------------- MMS --- */

    "mms.config.get": {
      schema: emptySchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (_payload, deps) => mmsConfig.readConfig(deps.db),
    },

    "mms.config.update": {
      schema: schemas.mmsConfigUpdateSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsConfig.updateConfig(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.boms.list": {
      schema: schemas.mmsBomListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => mmsBom.listBoms(deps.db, payload as never),
    },

    "mms.boms.get": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return mmsBom.getBom(deps.db, request.id);
      },
    },

    "mms.boms.save": {
      schema: schemas.mmsSaveBomSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsBom.saveBom(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.boms.approve": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return mmsBom.approveBom(deps.db, ctx.actor, request.id, ctx.nowIso);
      },
    },

    "mms.bomComponents.save": {
      schema: schemas.mmsSaveBomComponentSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsBom.saveBomComponent(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.bomComponents.delete": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "delete" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return mmsBom.deleteBomComponent(deps.db, ctx.actor, request.id, ctx.nowIso);
      },
    },

    "mms.routes.list": {
      schema: schemas.mmsRouteListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => mmsRouting.listRoutes(deps.db, payload as never),
    },

    "mms.routes.get": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return mmsRouting.getRoute(deps.db, request.id);
      },
    },

    "mms.routes.save": {
      schema: schemas.mmsSaveRouteSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsRouting.saveRoute(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.routeOperations.save": {
      schema: schemas.mmsSaveRouteOperationSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsRouting.saveRouteOperation(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.workCenters.list": {
      schema: schemas.mmsWorkCenterListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsWorkCenters.listWorkCenters(deps.db, payload as never),
    },

    "mms.workCenters.save": {
      schema: schemas.mmsSaveWorkCenterSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsWorkCenters.saveWorkCenter(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.equipment.list": {
      schema: schemas.mmsEquipmentListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsWorkCenters.listEquipment(deps.db, payload as never),
    },

    "mms.equipment.save": {
      schema: schemas.mmsSaveEquipmentSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsWorkCenters.saveEquipment(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.orders.list": {
      schema: schemas.mmsMoListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsOrders.listManufacturingOrders(deps.db, payload as never),
    },

    "mms.orders.get": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return mmsOrders.getManufacturingOrder(deps.db, request.id);
      },
    },

    "mms.orders.save": {
      schema: schemas.mmsSaveManufacturingOrderSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsOrders.saveManufacturingOrder(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.orders.release": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return mmsOrders.releaseManufacturingOrder(
          deps.db,
          ctx.actor,
          request.id,
          ctx.nowIso,
        );
      },
    },

    "mms.orders.cancel": {
      schema: schemas.documentCancelSchema,
      permission: { module: "manufacturing", action: "cancel" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number; reason: string };
        return mmsOrders.cancelManufacturingOrder(
          deps.db,
          ctx.actor,
          request.id,
          request.reason,
          ctx.nowIso,
        );
      },
    },

    "mms.workOrders.list": {
      schema: schemas.mmsWorkOrderListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsWorkOrders.listWorkOrders(deps.db, payload as never),
    },

    "mms.workOrders.get": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return mmsWorkOrders.getWorkOrder(deps.db, request.id);
      },
    },

    "mms.workOrders.save": {
      schema: schemas.mmsSaveWorkOrderSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsWorkOrders.saveWorkOrder(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.workOrders.start": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return mmsWorkOrders.startWorkOrder(deps.db, ctx.actor, request.id, ctx.nowIso);
      },
    },

    "mms.workOrders.pause": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return mmsWorkOrders.pauseWorkOrder(deps.db, ctx.actor, request.id, ctx.nowIso);
      },
    },

    "mms.workOrders.resume": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as { id: number };
        return mmsWorkOrders.resumeWorkOrder(deps.db, ctx.actor, request.id, ctx.nowIso);
      },
    },

    "mms.workOrders.complete": {
      schema: z.object({
        id: z.number().int().positive(),
        actualQuantity: z.number().int().positive(),
        acceptedQuantity: z.number().int().optional(),
        rejectedQuantity: z.number().int().optional(),
      }),
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) => {
        const request = payload as {
          id: number;
          actualQuantity: number;
          acceptedQuantity?: number;
          rejectedQuantity?: number;
        };
        return mmsWorkOrders.completeWorkOrder(
          deps.db,
          ctx.actor,
          request.id,
          request.actualQuantity,
          request.acceptedQuantity ?? 0,
          request.rejectedQuantity ?? 0,
          ctx.nowIso,
        );
      },
    },

    "mms.jobTimeLogs.save": {
      schema: schemas.mmsSaveJobTimeLogSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsWorkOrders.saveJobTimeLog(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.jobTimeLogs.list": {
      schema: z.object({ workOrderId: z.number().int().positive() }),
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { workOrderId: number };
        return mmsWorkOrders.listJobTimeLogs(deps.db, request.workOrderId);
      },
    },

    "mms.materialIssues.list": {
      schema: schemas.mmsMaterialIssueListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsMaterialIssues.listMaterialIssues(deps.db, payload as never),
    },

    "mms.materialIssues.reserve": {
      schema: schemas.mmsSaveMaterialIssueSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsMaterialIssues.reserveMaterial(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.materialIssues.issueToWip": {
      schema: schemas.mmsSaveMaterialIssueSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsMaterialIssues.issueMaterialToWip(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.materialIssues.returnFromWip": {
      schema: schemas.mmsSaveMaterialIssueSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsMaterialIssues.returnMaterialFromWip(
          deps.db,
          ctx.actor,
          payload as never,
          ctx.nowIso,
        ),
    },

    "mms.materialIssues.consume": {
      schema: schemas.mmsSaveConsumptionRecordSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsMaterialIssues.consumeMaterial(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.materialIssues.consumptionList": {
      schema: z.object({ moId: z.number().int().positive().optional() }),
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { moId?: number };
        return mmsMaterialIssues.listConsumptionRecords(deps.db, request.moId);
      },
    },

    "mms.wip.list": {
      schema: schemas.mmsWipListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (_payload, _deps) => {
        // WIP records are derived from cost records and consumption; return empty
        // until WIP table writes are wired. Kept as a valid endpoint.
        return [];
      },
    },

    "mms.qualityChecks.list": {
      schema: schemas.mmsQualityCheckListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsQualityChecks.listQualityChecks(deps.db, payload as never),
    },

    "mms.qualityChecks.save": {
      schema: schemas.mmsSaveQualityCheckSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsQualityChecks.saveQualityCheck(
          deps.db,
          ctx.actor,
          payload as never,
          ctx.nowIso,
        ),
    },

    "mms.scrap.list": {
      schema: schemas.mmsScrapListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsScrap.listScrapRecords(deps.db, payload as never),
    },

    "mms.scrap.save": {
      schema: schemas.mmsSaveScrapSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsScrap.saveScrapRecord(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.rework.list": {
      schema: schemas.mmsReworkListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsRework.listReworkRecords(deps.db, payload as never),
    },

    "mms.rework.save": {
      schema: schemas.mmsSaveReworkSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsRework.saveReworkRecord(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.finishedReceipts.list": {
      schema: schemas.mmsFinishedReceiptListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsFinishedReceipts.listFinishedReceipts(deps.db, payload as never),
    },

    "mms.finishedReceipts.get": {
      schema: schemas.imsGetSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { id: number };
        return mmsFinishedReceipts.getFinishedReceipt(deps.db, request.id);
      },
    },

    "mms.finishedReceipts.save": {
      schema: schemas.mmsSaveFinishedReceiptSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsFinishedReceipts.saveFinishedReceipt(
          deps.db,
          ctx.actor,
          payload as never,
          ctx.nowIso,
        ),
    },

    "mms.costRecords.list": {
      schema: schemas.mmsCostListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) =>
        mmsCosting.listCostRecords(deps.db, payload as never),
    },

    "mms.costRecords.save": {
      schema: schemas.mmsSaveCostRecordSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (payload, deps, ctx) =>
        mmsCosting.saveCostRecord(deps.db, ctx.actor, payload as never, ctx.nowIso),
    },

    "mms.costRecords.moSummary": {
      schema: z.object({ moId: z.number().int().positive() }),
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { moId: number };
        return mmsCosting.getMoCostSummary(deps.db, request.moId);
      },
    },

    "mms.genealogy.list": {
      schema: schemas.mmsGenealogyListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (_payload, _deps) => [],
    },

    "mms.mrp.run": {
      schema: schemas.mmsMrpRunRequest,
      permission: { module: "manufacturing", action: "create" },
      handler: (payload, deps, ctx) =>
        mmsMrp.runMrp(deps.db, payload as never, ctx.nowIso, ctx.actor),
    },

    "mms.mrp.requirements.list": {
      schema: schemas.mmsMrpRequirementListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => mmsMrp.listMrpRequirements(deps.db, payload as never),
    },
    "mms.mrp.runs.list": {
      schema: z.object({}), permission: {module:"manufacturing",action:"view"},
      handler: (_p,d) => mmsMrp.listMrpRuns(d.db),
    },
    "mms.mrp.get": {
      schema: schemas.mmsPlanningIdSchema, permission: {module:"manufacturing",action:"view"},
      handler: (p,d) => mmsMrp.getMrpRun(d.db,(p as {id:number}).id),
    },
    "mms.mrp.approve": {
      schema: schemas.mmsPlanningIdSchema, permission: {module:"manufacturing",action:"edit"},
      handler: (p,d,c) => mmsMrp.approveMrp(d.db,(p as {id:number}).id,c.actor,c.nowIso),
    },
    "mms.mrp.generateRequisitions": {
      schema: schemas.mmsMrpConvertSchema, permission: {module:"manufacturing",action:"create"},
      handler: (p,d,c) => {
        d.session.require("purchases","create");
        const r=p as {id:number;requirementIds?:readonly number[]};
        return mmsMrp.convertMrp(operationContext(d,c),r.id,"purchase",r.requirementIds);
      },
    },
    "mms.mrp.generateOrders": {
      schema: schemas.mmsMrpConvertSchema, permission: {module:"manufacturing",action:"create"},
      handler: (p,d,c) => {
        const r=p as {id:number;requirementIds?:readonly number[]};
        return mmsMrp.convertMrp(operationContext(d,c),r.id,"manufacture",r.requirementIds);
      },
    },

    "mms.mps.plans.list": {
      schema: schemas.mmsMpsPlanListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => mmsMps.listMpsPlans(deps.db, payload as never),
    },
    "mms.mps.save": {
      schema: schemas.mmsSaveMpsPlanSchema,
      handler: (payload, deps, ctx) => {
        const request = payload as import("../shared/mms").SaveMpsPlanRequest;
        deps.session.require("manufacturing", request.id === undefined ? "create" : "edit");
        return mmsMps.saveMpsPlan(deps.db, request, ctx.actor, ctx.nowIso);
      },
    },
    "mms.mps.calculate": {
      schema: z.object({ id: z.number().int().positive() }), permission: { module: "manufacturing", action: "edit" },
      handler: (p, d, c) => mmsMps.calculateMps(d.db, (p as {id:number}).id, c.actor, c.nowIso),
    },
    "mms.mps.approve": {
      schema: z.object({ id: z.number().int().positive() }), permission: { module: "manufacturing", action: "edit" },
      handler: (p, d, c) => mmsMps.approveMps(d.db, (p as {id:number}).id, c.actor, c.nowIso),
    },
    "mms.mps.generateOrders": {
      schema: z.object({ id: z.number().int().positive() }), permission: { module: "manufacturing", action: "create" },
      handler: (p, d, c) => mmsMps.generateMpsOrders(d.db, (p as {id:number}).id, c.actor, c.nowIso),
    },
    "mms.mps.history": {
      schema: z.object({ id: z.number().int().positive() }), permission: { module: "manufacturing", action: "view" },
      handler: (p, d) => mmsMps.listMpsHistory(d.db, (p as {id:number}).id),
    },

    "mms.maintenanceRequests.list": {
      schema: schemas.mmsMaintenanceRequestListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (_payload, _deps) => [],
    },

    "mms.maintenanceRequests.save": {
      schema: schemas.mmsSaveMaintenanceRequestSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (_payload, _deps) => {
        throw new mmsWorkOrders.WorkOrderError("Maintenance requests table not yet wired.");
      },
    },

    "mms.subcontractOrders.list": {
      schema: schemas.mmsSubcontractOrderListSchema,
      permission: { module: "manufacturing", action: "view" },
      handler: (_payload, _deps) => [],
    },

    "mms.subcontractOrders.save": {
      schema: schemas.mmsSaveSubcontractOrderSchema,
      permission: { module: "manufacturing", action: "edit" },
      handler: (_payload, _deps) => {
        throw new mmsWorkOrders.WorkOrderError("Subcontract orders table not yet wired.");
      },
    },

    "mms.dashboard": {
      schema: schemas.mmsDashboardRequest,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => mmsAnalytics.mmsDashboard(deps.db, payload as never),
    },

    "mms.report": {
      schema: schemas.mmsReportRequest,
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => mmsAnalytics.runMmsReport(deps.db, payload as never),
    },

    "mms.reports.list": {
      schema: emptySchema,
      permission: { module: "manufacturing", action: "view" },
      handler: () => mmsAnalytics.mmsReportTitles(),
    },

    "mms.stock.snapshot": {
      schema: z.object({ productId: z.number().int().positive().optional() }),
      permission: { module: "manufacturing", action: "view" },
      handler: (payload, deps) => {
        const request = payload as { productId?: number };
        // Read-only snapshot derived from IMS stock ledger.
        const products = request.productId === undefined
          ? deps.db
              .prepare("SELECT id, sku, name FROM products WHERE is_service = 0 ORDER BY name")
              .all() as { id: number; sku: string; name: string }[]
          : deps.db
              .prepare("SELECT id, sku, name FROM products WHERE id = ?")
              .all(request.productId) as { id: number; sku: string; name: string }[];

        return products.map((p) => {
          const available = availableQuantity(deps.db, p.id);
          const reserved = reservedQuantity(deps.db, p.id);
          const onHand = available + reserved;
          const costRow = deps.db
            .prepare("SELECT average_cost_fils FROM products WHERE id = ?")
            .get(p.id) as { average_cost_fils: number } | undefined;
          return {
            productId: p.id,
            sku: p.sku,
            name: p.name,
            onHandMilli: onHand,
            reservedMilli: reserved,
            availableMilli: available,
            valueFils: Math.round((onHand * (costRow?.average_cost_fils ?? 0)) / 1000),
          };
        });
      },
    },
  };

  return definitions;
}

/** Fils to a rupee amount for a CSV cell. */
function toPkr(fils: number): string {
  return (fils / 100).toFixed(2);
}

function toActor(user: { id: number; displayName: string }): AuditActor {
  return { id: user.id, name: user.displayName };
}

/**
 * Execute an RPC method.
 *
 * The method arrives as a plain string over the bridge and is matched against
 * the registered table; an unknown name is a typed failure rather than an
 * exception. Returns `ApiResult` and never throws across the bridge.
 */
export async function dispatchRpc<M extends RpcMethod>(
  method: string,
  payload: unknown,
  deps: RpcDeps,
  appVersion: string,
): Promise<ApiResult<RpcResponseOf<M>>> {
  const requestId = randomUUID();
  const definitions = createRpcMethods();
  const definition = definitions[method];

  if (definition === undefined) {
    return fail<RpcResponseOf<M>>("UNKNOWN_METHOD", `"${method}" is not a known operation.`);
  }

  try {
    const parsed = definition.schema.parse(payload ?? {}) as RpcRequestOf<M>;

    const session = deps.session.currentOrNull();

    if (definition.permission !== undefined && session !== null) {
      deps.session.require(definition.permission.module, definition.permission.action);
    } else if (definition.permission !== undefined && definition.anonymous !== true) {
      return fail<RpcResponseOf<M>>("UNAUTHENTICATED", "Please sign in again.");
    }

    const now = deps.now();
    const settings = deps.loadSettings();
    const ctx: SaveContext = {
      db: deps.db,
      actor: session === null ? SYSTEM_ACTOR : toActor(session.user),
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
      nowIso: now.toISOString(),
      nowDate: todayIso(now),
      fiscalYearOf: (date: string) => fiscalYearOf(date, settings.fiscalYearStartMonth),
      allowNegativeStock: settings.allowNegativeStock,
      vatRate: settings.vatRatePercent / 100,
    };

    const result = await definition.handler(parsed, deps, ctx);
    void appVersion;

    return { ok: true, data: result as RpcResponseOf<M> };
  } catch (error) {
    const development = process.env["NODE_ENV"] === "development";
    const databaseError = error instanceof Error && error.name === "SqliteError";
    const schemaMessage = databaseError && /^no such (table|column): [A-Za-z0-9_.]+$/.test(error.message)
      ? error.message : undefined;
    // Never log request payloads: they may contain passwords or customer data.
    deps.log?.error("RPC operation failed", {
      requestId,
      operation: method,
      errorName: error instanceof Error ? error.name : "UnknownError",
      code: typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code : "UNEXPECTED",
      ...(schemaMessage ? { message: schemaMessage } : {}),
      ...(development ? {
        message: error instanceof Error ? error.message : "Unknown failure",
        stack: error instanceof Error ? error.stack : undefined,
      } : {}),
    });
    const result = toApiError(error);
    if (result.ok) return result;
    return { ok: false, error: {
      ...result.error,
      ...(databaseError ? { code: "DATABASE_QUERY_FAILED" } : {}),
      requestId,
      message: databaseError
        ? "The requested data could not be read. Please retry or contact support."
        : result.error.code === "UNEXPECTED"
        ? "The operation could not be completed. Please retry or contact support."
        : result.error.message,
    } };
  }
}

export { fail as rpcFail };
