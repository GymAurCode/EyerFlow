import { beforeEach, afterEach, it, expect, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => ".", isPackaged: false },
  BrowserWindow: class {},
  dialog: {},
}));
import { createRpcMethods, dispatchRpc, type RpcDeps } from "../src/main/rpc";
import { SessionStore } from "../src/main/session";
import { DEFAULT_SNAPSHOT } from "../src/main/settings-store";
import { planningDb, NOW } from "./planning-fixtures";
import type { SqliteDatabase } from "../src/data/connection";
let db: SqliteDatabase, session: SessionStore, deps: RpcDeps;
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
function permissions(actions: string[]) {
  session.set({
    user: {
      id: 1,
      username: "warehouse",
      displayName: "Warehouse operator",
      roleId: null,
      roleName: null,
      mustChangePassword: false,
      email: null,
      phone: null,
      avatarDataUrl: null,
      createdAt: null,
      lastLoginAt: null,
      permissions: actions.map((action) => ({ module: "warehouse", action })),
    },
  });
}
beforeEach(() => {
  db = planningDb();
  session = new SessionStore(db);
  log.error.mockClear();
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
it("all WMS RPC methods require backend warehouse permissions", () => {
  const definitions = Object.entries(createRpcMethods()).filter(([key]) => key.startsWith("wms."));
  expect(definitions.length).toBeGreaterThan(20);
  for (const [, definition] of definitions) expect(definition.permission?.module).toBe("warehouse");
});
it("denies anonymous, read-only mutation and unprivileged exports", async () => {
  expect(await dispatchRpc("wms.snapshot", {}, deps, "1")).toMatchObject({
    ok: false,
    error: { code: "UNAUTHENTICATED" },
  });
  permissions(["view"]);
  expect(await dispatchRpc("wms.snapshot", {}, deps, "1")).toMatchObject({ ok: true });
  expect(
    await dispatchRpc("wms.warehouses.save", { code: "WH", name: "Warehouse" }, deps, "1"),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(await dispatchRpc("wms.report.export", { report: "stock" }, deps, "1")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(db.prepare("SELECT count(*) n FROM wms_warehouses").get()).toEqual({ n: 0 });
});
it("SQL failures are returned as failures with correlation ID and a main-process log", async () => {
  permissions(["view"]);
  db.exec("DROP VIEW wms_stock_movements");
  const result = await dispatchRpc("wms.snapshot", {}, deps, "1");
  expect(result).toMatchObject({
    ok: false,
    error: { code: "DATABASE_QUERY_FAILED", requestId: expect.any(String) },
  });
  expect(log.error).toHaveBeenCalled();
});
