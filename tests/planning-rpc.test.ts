import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => ".", isPackaged: false },
  BrowserWindow: class {},
  dialog: {},
}));
import { dispatchRpc, type RpcDeps } from "../src/main/rpc";
import { SessionStore } from "../src/main/session";
import { DEFAULT_SNAPSHOT } from "../src/main/settings-store";
import { planningDb, item, bom, NOW } from "./planning-fixtures";
import type { SqliteDatabase } from "../src/data/connection";
describe("planning RPC validation, logging and permissions", () => {
  let db: SqliteDatabase;
  let deps: RpcDeps;
  let fg: number;
  let bid: number;
  let session: SessionStore;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  function permissions(list: { module: string; action: string }[]) {
    session.set({
      user: {
        id: 1,
        username: "planner",
        displayName: "Planner",
        roleId: null,
        roleName: null,
        mustChangePassword: false,
        email: null,
        phone: null,
        avatarDataUrl: null,
        createdAt: null,
        lastLoginAt: null,
        permissions: list,
      },
    });
  }
  beforeEach(() => {
    db = planningDb();
    session = new SessionStore(db);
    log.error.mockClear();
    fg = item(db, "Tables");
    bid = bom(db, fg, [{ id: item(db, "Legs"), qty: 4000 }]);
    deps = {
      db,
      session,
      log,
      now: () => new Date(NOW),
      loadSettings: () => DEFAULT_SNAPSHOT,
      updateSettings: () => DEFAULT_SNAPSHOT,
      refreshSettings: () => DEFAULT_SNAPSHOT,
      exportDir: () => ".",
      avatarsDir: () => ".",
      token: "test",
      saveDevSession: () => {},
      loadDevSession: () => null,
      canRestoreDevSession: () => false,
      clearDevSession: () => {},
    };
  });
  afterEach(() => db.close());
  const save = () => ({
    productId: fg,
    bomId: bid,
    fromDate: "2026-11-07",
    toDate: "2026-11-07",
    horizon: "daily",
    forecastDemand: 100_000,
    confirmedDemand: 0,
    plannedProduction: 0,
    safetyStock: 0,
  });
  it("denies anonymous and unauthorized access without creating a plan", async () => {
    expect(await dispatchRpc("mms.mps.save", save(), deps, "1")).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    permissions([{ module: "manufacturing", action: "view" }]);
    expect(await dispatchRpc("mms.mps.save", save(), deps, "1")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM manufacturing_mps_plans").get()).toEqual({ n: 0 });
  });
  it("requires edit permission to approve and purchase permission to create requisitions", async () => {
    permissions([{ module: "manufacturing", action: "create" }]);
    const result = await dispatchRpc<"mms.mps.save">("mms.mps.save", save(), deps, "1");
    expect(result.ok).toBe(true);
    expect(
      await dispatchRpc("mms.mps.approve", { id: result.ok ? result.data.id : 0 }, deps, "1"),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await dispatchRpc("mms.mrp.generateRequisitions", { id: 1 }, deps, "1")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
  it("rejects malformed dates, negative quantities and forged company scope", async () => {
    permissions([{ module: "manufacturing", action: "create" }]);
    for (const patch of [{ forecastDemand: -1 }, { fromDate: "oops" }, { companyId: 999 }]) {
      expect(await dispatchRpc("mms.mps.save", { ...save(), ...patch }, deps, "1")).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM manufacturing_mps_plans").get()).toEqual({ n: 0 });
  });
  it("propagates an actual SQL failure with a diagnostic ID and main-process log", async () => {
    permissions([{ module: "manufacturing", action: "view" }]);
    db.exec("DROP TABLE manufacturing_mrp_requirements");
    const result = await dispatchRpc("mms.mrp.requirements.list", {}, deps, "1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DATABASE_QUERY_FAILED", requestId: expect.any(String) },
    });
    if (!result.ok)
      expect(log.error).toHaveBeenCalledWith(
        "RPC operation failed",
        expect.objectContaining({
          requestId: result.error.requestId,
          operation: "mms.mrp.requirements.list",
          errorName: "SqliteError",
          message: "no such table: manufacturing_mrp_requirements",
        }),
      );
  });
});
