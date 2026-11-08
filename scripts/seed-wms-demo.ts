import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchApp, rpc, todayIso } from "../e2e/app";
import type { WmsSnapshot, Dispatch } from "../src/shared/wms";

/** Runs only in a fixed disposable company through the real Electron RPCs. */
async function seed(): Promise<void> {
  if (process.env["NODE_ENV"] === "production")
    throw Error("Demo seeding is disabled in production.");
  const dataDir = resolve(".tmp/wms-demo");
  mkdirSync(dataDir, { recursive: true });
  const app = await launchApp(dataDir),
    page = app.window;
  try {
    const setup = await rpc<{ isComplete: boolean; companyName: string }>(page, "auth.setupStatus");
    if (setup.isComplete && setup.companyName !== "EyerFlow Warehouse Demo")
      throw Error("Refusing to seed a company other than the isolated warehouse demo.");
    if (!setup.isComplete)
      await rpc(page, "auth.setup", {
        companyName: "EyerFlow Warehouse Demo",
        companyTrn: "",
        companyAddress: "Lahore demo distribution center",
        companyPhone: "",
        fiscalYearStartMonth: 1,
        adminUsername: "wms-demo",
        adminDisplayName: "Warehouse Demo Manager",
        adminPassword: "WarehouseDemo#2026",
      });
    const login = await rpc<{ user: { id: number } }>(page, "auth.login", {
      username: "wms-demo",
      password: "WarehouseDemo#2026",
    });
    const state = () => rpc<WmsSnapshot>(page, "wms.snapshot");
    let s = await state();
    let warehouse = s.warehouses.find((w) => w.code === "DEMO-WH");
    if (!warehouse)
      warehouse = await rpc(page, "wms.warehouses.save", {
        code: "DEMO-WH",
        name: "Lahore Distribution Center",
        site: "Lahore",
        address: "Isolated demonstration company",
      });
    const wid = warehouse!.id;
    const definitions = [
      ["DEMO-REC", "receiving"],
      ["DEMO-HOLD", "quarantine"],
      ["DEMO-PACK", "packing"],
      ["DEMO-DISPATCH", "dispatch"],
      ["DEMO-RET", "returns"],
      ["DEMO-FACE", "pickFace"],
      ...Array.from({ length: 10 }, (_, i) => [
        `DEMO-A01-R${String(i + 1).padStart(2, "0")}-L01-B01`,
        "storage",
      ]),
    ];
    for (const [code, type] of definitions) {
      s = await state();
      if (!s.bins.some((b) => b.code === code))
        await rpc(page, "wms.bins.save", {
          warehouseId: wid,
          code,
          type,
          zone: type === "storage" ? "BULK" : type === "pickFace" ? "PICK" : "OPERATIONS",
          aisle: type === "storage" ? "A01" : "",
          rack: type === "storage" ? code?.split("-")[2] : "",
          shelf: type === "storage" ? "L01" : "",
          capacityMilli: type === "storage" ? 100_000 : null,
        });
    }
    const products: number[] = [];
    for (let i = 0; i < 10; i++) {
      const sku = `WMS-DEMO-${String(i + 1).padStart(3, "0")}`;
      s = await state();
      let p = s.products.find((p) => p.sku === sku);
      if (!p)
        p = await rpc(page, "products.save", {
          sku,
          name: [
            "Sediment filter",
            "Carbon cartridge",
            "Filter housing",
            "Pressure gauge",
            "Inlet valve",
            "Outlet valve",
            "Pipe coupling",
            "Mounting bracket",
            "Seal kit",
            "Service wrench",
          ][i],
          unit: "pcs",
          category: i < 3 ? "Filtration" : "Components",
          averageCostFils: 1000,
          vatTreatment: "standard",
        });
      products.push(p!.id);
    }
    s = await state();
    const bin = (code: string) => s.bins.find((b) => b.code === code)!.id;
    const receiving = bin("DEMO-REC"),
      packing = bin("DEMO-PACK");
    if (!s.docks.length)
      await rpc(page, "wms.docks.save", {
        warehouseId: wid,
        code: "DOOR-01",
        name: "Receiving dock",
      });
    s = await state();
    if (!s.appointments.some((a) => a.code === "DEMO-APPT")) {
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(10, 0, 0, 0);
      const end = new Date(start.getTime() + 3600000);
      await rpc(page, "wms.appointments.save", {
        warehouseId: wid,
        dockId: s.docks[0]!.id,
        code: "DEMO-APPT",
        name: "DEMO-INBOUND-001",
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        carrier: "Local freight",
        vehicle: "DEMO-TRUCK-01",
        priority: "high",
      });
    }
    s = await state();
    let inbound = s.inbounds.find((d) => d.reference === "DEMO-INBOUND-001");
    if (!inbound) {
      const id = await rpc<number>(page, "wms.inbound.create", {
        warehouseId: wid,
        reference: "DEMO-INBOUND-001",
        lines: products.map((productId) => ({ productId, quantityMilli: 100_000 })),
      });
      s = await state();
      inbound = s.inbounds.find((d) => d.id === id)!;
    }
    if (inbound.status === "expected") await rpc(page, "wms.inbound.arrive", { id: inbound.id });
    for (let i = 0; i < products.length; i++) {
      s = await state();
      const line = s.inbounds
        .find((d) => d.id === inbound!.id)!
        .lines.find((l) => l.product_id === products[i])!;
      if (!line.received_milli)
        await rpc(page, "wms.receiving.post", {
          lineId: line.id,
          binId: receiving,
          quantityMilli: i === 0 ? 70_000 : 100_000,
          damagedMilli: i === 0 ? 5000 : 0,
          commandKey: randomUUID(),
        });
    }
    s = await state();
    for (const task of s.tasks.filter(
      (t) =>
        t.type === "putaway" &&
        t.status !== "completed" &&
        !s.inbounds.some((d) => d.reference === "DEMO-PENDING-002"),
    )) {
      if (!task.destination_bin_id) throw Error("Demo putaway capacity was exhausted.");
      await rpc(page, "wms.tasks.assign", { id: task.id, workerId: login.user.id });
      await rpc(page, "wms.tasks.start", { id: task.id });
      await rpc(page, "wms.tasks.complete", {
        id: task.id,
        destinationBinId: task.destination_bin_id,
        sourceScan: task.source,
        productScan: task.sku,
        destinationScan: task.destination!,
        quantityMilli: task.quantity_milli,
        commandKey: randomUUID(),
      });
    }
    async function shipment(
      reference: string,
      productId: number,
      qty: number,
      complete: boolean,
    ): Promise<Dispatch> {
      s = await state();
      let d = s.dispatches.find((d) => d.reference === reference);
      if (!d) {
        const id = await rpc<number>(page, "wms.dispatch.create", {
          warehouseId: wid,
          recipient: complete ? "Retail branch Lahore" : "Distributor Faisalabad",
          reference,
          requiredDate: todayIso(),
          commandKey: randomUUID(),
          lines: [{ productId, quantityMilli: qty }],
        });
        s = await state();
        d = s.dispatches.find((d) => d.id === id)!;
      }
      if (d.status === "draft")
        await rpc(page, "wms.dispatch.release", { id: d.id, packingBinId: packing });
      s = await state();
      const lineIds = new Set(d.lines.map((l) => l.id));
      for (const task of s.tasks.filter(
        (t) =>
          t.dispatch_line_id !== null &&
          lineIds.has(t.dispatch_line_id) &&
          t.status !== "completed",
      ))
        await rpc(page, "wms.picks.confirm", {
          id: task.id,
          destinationBinId: task.destination_bin_id,
          sourceScan: task.source,
          productScan: task.sku,
          destinationScan: task.destination,
          quantityMilli: task.quantity_milli,
          commandKey: randomUUID(),
        });
      s = await state();
      d = s.dispatches.find((x) => x.id === d!.id)!;
      const cartonCount = complete ? 2 : 1;
      for (let i = 0; i < cartonCount; i++) {
        const code = `${reference}-CTN-${i + 1}`;
        if (!s.cartons.some((c) => c.code === code)) {
          await rpc(page, "wms.cartons.pack", {
            dispatchId: d.id,
            code,
            weightGrams: 2500,
            commandKey: randomUUID(),
            lines: [
              {
                lineId: d.lines[0]!.id,
                quantityMilli: qty / cartonCount,
                productScan: s.products.find((p) => p.id === productId)!.sku,
              },
            ],
          });
          s = await state();
        }
      }
      for (const carton of s.cartons.filter(
        (c) => c.dispatch_id === d!.id && c.status === "closed",
      ))
        await rpc(page, "wms.cartons.scan", {
          dispatchId: d.id,
          scan: carton.code,
          action: "stage",
        });
      if (complete) {
        s = await state();
        for (const carton of s.cartons.filter(
          (c) => c.dispatch_id === d!.id && c.status === "staged",
        ))
          await rpc(page, "wms.cartons.scan", {
            dispatchId: d.id,
            scan: carton.code,
            action: "load",
          });
        await rpc(page, "wms.dispatch.handover", {
          id: d.id,
          carrier: "Demo Logistics",
          vehicle: "DEMO-TRUCK-02",
          acknowledgement: "Demo signed manifest",
        });
      }
      s = await state();
      return s.dispatches.find((x) => x.id === d!.id)!;
    }
    const shipped = await shipment("DEMO-SHIP-001", products[0]!, 20_000, true);
    await shipment("DEMO-STAGED-001", products[1]!, 10_000, false);
    s = await state();
    if (!s.returns.some((r) => r.dispatch_line_id === shipped.lines[0]!.id))
      await rpc(page, "wms.returns.receive", {
        dispatchLineId: shipped.lines[0]!.id,
        binId: bin("DEMO-RET"),
        quantityMilli: 5000,
        productScan: "WMS-DEMO-001",
        condition: "Three sealed units, two damaged",
        commandKey: randomUUID(),
      });
    s = await state();
    const returned = s.returns.find((r) => r.dispatch_line_id === shipped.lines[0]!.id)!;
    if (returned.status === "quarantine") {
      const target = s.positions.find(
        (p) =>
          p.product_id === products[0] && p.stock_status === "available" && p.bin !== "DEMO-PACK",
      )!;
      await rpc(page, "wms.returns.inspect", {
        id: returned.id,
        sellableMilli: 3000,
        destinationBinId: target.bin_id,
        reason: "Demo inspection of all five units",
      });
    }
    s = await state();
    if (!s.counts.some((c) => c.product_id === products[2])) {
      const position = s.positions.find(
        (p) => p.product_id === products[2] && p.stock_status === "available",
      )!;
      await rpc(page, "wms.counts.record", {
        binId: position.bin_id,
        productId: products[2],
        countedMilli: 98_000,
        binScan: position.bin,
        productScan: "WMS-DEMO-003",
        reason: "Demo blind count: two-unit variance, awaiting a different supervisor",
        commandKey: randomUUID(),
      });
    }
    s = await state();
    if (!s.inbounds.some((d) => d.reference === "DEMO-PENDING-002")) {
      const id = await rpc<number>(page, "wms.inbound.create", {
        warehouseId: wid,
        reference: "DEMO-PENDING-002",
        lines: [{ productId: products[4], quantityMilli: 50_000 }],
      });
      await rpc(page, "wms.inbound.arrive", { id });
      s = await state();
      await rpc(page, "wms.receiving.post", {
        lineId: s.inbounds.find((d) => d.id === id)!.lines[0]!.id,
        binId: receiving,
        quantityMilli: 20_000,
        commandKey: randomUUID(),
      });
    }
    s = await state();
    for (const task of s.tasks.filter((t) => t.status === "created"))
      await rpc(page, "wms.tasks.assign", { id: task.id, workerId: login.user.id });
    s = await state();
    if (s.reconciliation.length) throw Error("Demo stock failed reconciliation.");
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    mkdirSync("docs/wms-verify", { recursive: true });
    for (const route of ["overview", "stock-locator", "dispatch", "counts", "receiving"]) {
      await page.evaluate((p) => {
        location.hash = `/wms/${p}`;
      }, route);
      await page.getByText(/Data cutoff:/).waitFor();
      await page.screenshot({ path: `docs/wms-verify/demo-${route}.png`, fullPage: true });
    }
    const summary = {
      dataDir,
      database: join(dataDir, "eyerstock.db"),
      company: "EyerFlow Warehouse Demo",
      warehouses: s.warehouses.length,
      bins: s.bins.length,
      products: s.products.length,
      inbounds: s.inbounds.length,
      tasks: s.tasks.length,
      dispatches: s.dispatches.length,
      cartons: s.cartons.length,
      counts: s.counts.length,
      returns: s.returns.length,
      reconciliationExceptions: s.reconciliation.length,
      totalWarehouseQuantityMilli: s.positions.reduce((sum, p) => sum + p.quantity_milli, 0),
    };
    writeFileSync("docs/wms-verify/demo-summary.json", JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
  }
}
seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
