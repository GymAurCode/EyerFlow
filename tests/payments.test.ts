/**
 * The rules a payment has to obey.
 *
 * These are the tests that decide whether the shop can be overpaid by
 * accident: the amount may never exceed what is outstanding, a document that
 * is paid is not offered for payment again, and the ledger agrees with the
 * invoice after every rupee that moves.
 */

import { describe, expect, it } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { seedChartOfAccounts } from "../src/main/accounting/chart";
import { syncDocumentPosting, syncPaymentPosting } from "../src/main/accounting/integration";
import type { AccountingContext } from "../src/main/accounting/integration";
import { saveDocument } from "../src/main/repositories/documents";
import { getDocument } from "../src/main/repositories/documents";
import { PaymentError, savePayment } from "../src/main/repositories/payments";
import type { DocumentDto } from "../src/shared/types";
import type { Fils } from "../src/domain/money";

const NOW = "2026-03-01T09:00:00.000Z";
const DATE = "2026-03-01";
const RS = (rupees: number): Fils => rupees * 100;
const ACTOR = { id: 1, name: "Tester" };

interface Fixture {
  readonly db: SqliteDatabase;
  readonly ctx: AccountingContext;
  readonly customerId: number;
  readonly supplierId: number;
}

function fixture(): Fixture {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  seedChartOfAccounts(db, NOW);

  db.prepare(
    `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, is_active, created_at, updated_at)
     VALUES ('SKU-1', 'Filter', 0, ?, ?, 1, ?, ?)`,
  ).run(RS(100), RS(150), NOW, NOW);
  const productId = Number(
    (db.prepare("SELECT id FROM products WHERE sku = 'SKU-1'").get() as { id: number }).id,
  );
  expect(productId).toBeGreaterThan(0);

  const mkParty = (code: string, name: string, kind: "customer" | "supplier"): number => {
    db.prepare(
      "INSERT INTO parties (code, name, kind, opening_balance, is_active, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
    ).run(code, name, kind, NOW, NOW);
    return Number((db.prepare("SELECT id FROM parties WHERE code = ?").get(code) as { id: number }).id);
  };

  const supplierId = mkParty("S-1", "Filter Supplier", "supplier");
  const customerId = mkParty("C-1", "Water Company", "customer");

  return {
    db,
    ctx: { db, nowIso: NOW, nowDate: DATE, createdBy: ACTOR.name },
    customerId,
    supplierId,
  };
}

function saveDocumentIn(
  db: SqliteDatabase,
  request: Parameters<typeof saveDocument>[1],
): DocumentDto {
  return db.transaction(() => {
    const saved = saveDocument(
      {
        db,
        actor: ACTOR,
        fiscalYearStartMonth: 1,
        nowIso: NOW,
        nowDate: DATE,
        allowNegativeStock: true,
        vatRate: 0,
      },
      request,
    );
    syncDocumentPosting({ db, nowIso: NOW, nowDate: DATE, createdBy: ACTOR.name }, saved);
    return saved;
  })();
}

/** A purchase of Rs 10,000 from the supplier, unpaid. */
function purchase(db: SqliteDatabase, supplierId: number): DocumentDto {
  return saveDocumentIn(db, {
    kind: "purchaseInvoice",
    partyId: supplierId,
    issueDate: DATE,
    dueDate: null,
    status: "issued",
    notes: null,
    lines: [
      {
        productId: 1,
        description: "Filters",
        quantityMilli: 10_000,
        unitPriceFils: RS(1_000),
        vatTreatment: "zero",
        unitCostFils: RS(1_000),
      },
    ],
  });
}

/** A sale of Rs 10,000 to the customer, unpaid. */
function sale(db: SqliteDatabase, customerId: number): DocumentDto {
  return saveDocumentIn(db, {
    kind: "invoice",
    partyId: customerId,
    issueDate: DATE,
    dueDate: null,
    status: "issued",
    notes: null,
    lines: [
      {
        productId: 1,
        description: "Filters",
        quantityMilli: 10_000,
        unitPriceFils: RS(1_000),
        vatTreatment: "zero",
        unitCostFils: RS(1_000),
      },
    ],
  });
}

function pay(
  db: SqliteDatabase,
  request: {
    readonly direction: "inbound" | "outbound";
    readonly partyId: number;
    readonly amountFils: number;
    readonly allocations?: readonly { readonly documentId: number; readonly amountFils: number }[];
  },
): void {
  db.transaction(() => {
    const saved = savePayment(
      { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
      {
        direction: request.direction,
        partyId: request.partyId,
        paymentDate: DATE,
        method: "cash",
        amountFils: request.amountFils,
        reference: null,
        notes: null,
        ...(request.allocations !== undefined ? { allocations: request.allocations } : {}),
      },
    );
    syncPaymentPosting({ db, nowIso: NOW, nowDate: DATE, createdBy: ACTOR.name }, saved);
  })();
}

describe("payment limits", () => {
  it("accepts a payment equal to the outstanding balance and marks the invoice paid", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(10_000),
      allocations: [{ documentId: bill.id, amountFils: RS(10_000) }],
    });

    const after = getDocument(db, bill.id);
    expect(after.paidFils).toBe(RS(10_000));
    expect(after.outstandingFils).toBe(0);
    expect(after.status).toBe("paid");
  });

  it("refuses a payment larger than the outstanding balance", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(6_000),
      allocations: [{ documentId: bill.id, amountFils: RS(6_000) }],
    });

    expect(() =>
      pay(db, {
        direction: "outbound",
        partyId: supplierId,
        amountFils: RS(4_001),
        allocations: [{ documentId: bill.id, amountFils: RS(4_001) }],
      }),
    ).toThrowError(PaymentError);

    // Nothing was written: the invoice still owes exactly Rs 4,000.
    const after = getDocument(db, bill.id);
    expect(after.paidFils).toBe(RS(6_000));
    expect(after.outstandingFils).toBe(RS(4_000));
    expect(after.status).toBe("partPaid");
  });

  it("names the outstanding balance in the message", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(6_000),
      allocations: [{ documentId: bill.id, amountFils: RS(6_000) }],
    });

    expect(() =>
      pay(db, {
        direction: "outbound",
        partyId: supplierId,
        amountFils: RS(4_001),
      }),
    ).toThrowError(/Payment cannot exceed the outstanding balance of Rs 4,000\.00\./);
  });

  it("accepts the remaining balance exactly and leaves nothing outstanding", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(6_000),
      allocations: [{ documentId: bill.id, amountFils: RS(6_000) }],
    });

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(4_000),
      allocations: [{ documentId: bill.id, amountFils: RS(4_000) }],
    });

    const after = getDocument(db, bill.id);
    expect(after.outstandingFils).toBe(0);
    expect(after.status).toBe("paid");
  });

  it("refuses a second payment of the same money", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(10_000),
      allocations: [{ documentId: bill.id, amountFils: RS(10_000) }],
    });

    // The same click, twice. The second one has nothing left to settle.
    expect(() =>
      pay(db, {
        direction: "outbound",
        partyId: supplierId,
        amountFils: RS(10_000),
        allocations: [{ documentId: bill.id, amountFils: RS(10_000) }],
      }),
    ).toThrowError(PaymentError);

    const payments = db.prepare("SELECT COUNT(*) AS count FROM payments").get() as { count: number };
    expect(payments.count).toBe(1);
  });

  it("refuses a payment of nothing, and a negative one", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    expect(() =>
      pay(db, {
        direction: "outbound",
        partyId: supplierId,
        amountFils: 0,
        allocations: [{ documentId: bill.id, amountFils: RS(1) }],
      }),
    ).toThrowError(PaymentError);

    expect(() =>
      pay(db, {
        direction: "outbound",
        partyId: supplierId,
        amountFils: -RS(100),
        allocations: [{ documentId: bill.id, amountFils: RS(100) }],
      }),
    ).toThrowError(PaymentError);

    const payments = db.prepare("SELECT COUNT(*) AS count FROM payments").get() as { count: number };
    expect(payments.count).toBe(0);
  });

  it("refuses an overpayment against a sale", () => {
    const { db, customerId } = fixture();
    const invoice = sale(db, customerId);

    expect(() =>
      pay(db, {
        direction: "inbound",
        partyId: customerId,
        amountFils: RS(10_001),
        allocations: [{ documentId: invoice.id, amountFils: RS(10_001) }],
      }),
    ).toThrowError(/Payment cannot exceed the outstanding balance/);
  });

  it("keeps the payment history when a payment is added", () => {
    const { db, supplierId } = fixture();
    const bill = purchase(db, supplierId);

    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(6_000),
      allocations: [{ documentId: bill.id, amountFils: RS(6_000) }],
    });
    pay(db, {
      direction: "outbound",
      partyId: supplierId,
      amountFils: RS(4_000),
      allocations: [{ documentId: bill.id, amountFils: RS(4_000) }],
    });

    const allocations = db
      .prepare("SELECT COUNT(*) AS count FROM payment_allocations")
      .get() as { count: number };
    expect(allocations.count).toBe(2);

    const payments = db.prepare("SELECT COUNT(*) AS count FROM payments").get() as { count: number };
    expect(payments.count).toBe(2);
  });
});
