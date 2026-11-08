/**
 * Temporary visual review harness (not part of the test suite).
 *
 * Launches the real app, activates it with a freshly minted key, seeds a little
 * data over RPC so the pages are not all empty, walks every screen and writes a
 * screenshot per page.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "@playwright/test";

const OUT = join(process.env["TEMP"] ?? tmpdir(), "eyerstock-shots");
mkdirSync(OUT, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "eyerstock-shot-"));

const app = await electron.launch({
  args: [process.cwd(), `--eyerstock-e2e=${dataDir}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "development",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    EYERSTOCK_DATA_DIR: dataDir,
    EYERSTOCK_STUB_AUDIT: "1",
  },
  timeout: 60_000,
});

const window: Page = await app.firstWindow({ timeout: 60_000 });
window.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 300)));
window.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
await window.setViewportSize({ width: 1440, height: 900 });
await window.waitForLoadState("domcontentloaded");

async function rpc<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  return window.evaluate(
    async ([m, p]) => {
      const api = (window as unknown as { api: { invoke: (a: string, b: unknown) => Promise<unknown> } }).api;
      const r = (await api.invoke(m, p)) as {
        ok: boolean;
        data?: unknown;
        error?: { message: string };
      };
      if (!r.ok) throw new Error(`${m}: ${r.error?.message ?? "unknown"}`);
      return r.data;
    },
    [method, payload] as [string, Record<string, unknown>],
  ) as Promise<T>;
}

async function shot(name: string): Promise<void> {
  await window.waitForTimeout(700);
  await window.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("shot:", name);
}

// --- setup (license gate is forced open in the dist bundle for this run) ---
await window.waitForTimeout(2500);
await shot("00-initial");
console.log("BODY:", (await window.locator("body").innerText()).slice(0, 600));
await window.getByText(/Create administrator account|^Sign in$/i).first().waitFor({ timeout: 30_000 });
await shot("01-setup");
await window.getByLabel(/company name/i).first().fill("Blue Water Trading");
await window.getByLabel(/your name/i).first().fill("Test Administrator");
await window.getByLabel(/username/i).first().fill("admin");
await window.getByLabel(/password/i).first().fill("Water#2026");
await window.getByRole("button", { name: /finish setup/i }).click();
await window.waitForTimeout(2500);
await shot("01b-after-setup");
console.log("AFTER:", (await window.locator("body").innerText()).slice(0, 400));
try {
  await rpc("auth.setup", {
    companyName: "Blue Water Trading",
    companyTrn: "",
    companyAddress: "",
    companyPhone: "",
    fiscalYearStartMonth: 1,
    adminUsername: "admin2",
    adminDisplayName: "Admin Two",
    adminPassword: "Water#2026",
    currency: "PKR",
  });
  console.log("direct auth.setup OK");
} catch (e) {
  console.log("direct auth.setup FAILED:", String(e).slice(0, 300));
}
await window.getByRole("navigation").first().waitFor({ timeout: 30_000 });

// --- seed ------------------------------------------------------------------
async function seed(): Promise<void> {
  const customer = await rpc<{ id: number }>("parties.save", { kind: "customer", name: "Al Noor Bakery" });
  const supplier = await rpc<{ id: number }>("parties.save", { kind: "supplier", name: "Aqua Parts LLC" });

  const products = [] as number[];
  const seedRows: [string, number, number, number][] = [
    ["RO Membrane 75 GPD", 18000, 32000, 4],
    ["UV Lamp 11W", 6500, 12500, 9],
    ["PP Sediment Filter", 2200, 4500, 2],
    ["Carbon Block Cartridge", 1800, 3800, 40],
    ["Pressure Tank 3.4L", 9500, 17000, 7],
    ["Pump 1/4 HP", 16000, 28000, 3],
  ];
  for (const [name, cost, price, qty] of seedRows) {
    const p = await rpc<{ id: number }>("products.save", {
      name,
      sku: `SKU-${name.slice(0, 3).toUpperCase()}`,
      unit: "pcs",
      costPriceFils: cost,
      salePriceFils: price,
      quantityMilli: qty * 1000,
      reorderLevelMilli: 5 * 1000,
    });
    products.push(p.id);
  }

  await rpc("documents.save", {
    documentType: "invoice",
    partyId: customer.id,
    issueDate: new Date().toISOString().slice(0, 10),
    lines: [0, 1, 2].map((index) => ({
      productId: products[index] ?? 0,
      description: seedRows[index]?.[0] ?? "",
      quantityMilli: 1000,
      unitPriceFils: 32000 + index * 1000,
      vatPercent: 5,
    })),
  });

  await rpc("documents.save", {
    documentType: "purchaseInvoice",
    partyId: supplier.id,
    issueDate: new Date().toISOString().slice(0, 10),
    lines: [
      {
        productId: products[3] ?? 0,
        description: "Carbon Block Cartridge",
        quantityMilli: 20000,
        unitPriceFils: 1800,
        vatPercent: 5,
      },
    ],
  });

  await rpc("finance.expense.save", {
    category: "Rent",
    amountFils: 4500000,
    incurredOn: new Date().toISOString().slice(0, 10),
    description: "Shop rent",
  });
}
// Pass the value through rather than stringifying it: the error may be an
// object, and the console renders it with its stack, which is more useful.
await seed().catch((e: unknown) => console.log("seed note:", e));

// --- walk ------------------------------------------------------------------
const PAGES: readonly (readonly [string, string])[] = [
  ["02-dashboard", "Dashboard"],
  ["03-sales", "Sales"],
  ["04-purchases", "Purchases"],
  ["05-products", "Products"],
  ["06-customers", "Customers"],
  ["07-suppliers", "Suppliers"],
  ["08-expenses", "Expenses"],
  ["09-reports", "Reports"],
  ["10-settings", "Settings"],
];

async function gotoPath(path: string): Promise<void> {
  await window.evaluate((p) => {
    window.history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await window.waitForTimeout(1000);
}
void gotoPath;

async function goto(linkName: string): Promise<void> {
  const link = window.getByRole("link", { name: new RegExp(`^${linkName}$`, "i") }).first();
  await link.click({ timeout: 10_000 }).catch(() => undefined);
  await window.waitForTimeout(1100);
}

for (const [name, path] of PAGES) {
  await goto(path);
  await shot(name);
  console.log(`--- ${name}:`, (await window.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200));
}

// Document detail + editor
await goto("Sales");
const firstRow = window.locator("tbody tr").first();
if (await firstRow.count()) {
  await firstRow.click().catch(() => undefined);
  await shot("11-document-detail");
}

// Login screen (sign out last)
await goto("Dashboard");
const signOut = window.getByRole("button", { name: /sign out/i }).first();
if (await signOut.count()) {
  await signOut.click();
  await window.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  await shot("13-login");
  const probe = await window.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    return inputs.map((el) => {
      const cs = getComputedStyle(el);
      return { cls: el.className.slice(0, 60), bw: cs.borderTopWidth, bc: cs.borderTopColor };
    });
  });
  console.log("INPUT PROBE:", JSON.stringify(probe, null, 1).slice(0, 1200));
}

console.log("OUTPUT:", OUT);
writeFileSync(join(OUT, "done.txt"), "ok");
await app.close();
