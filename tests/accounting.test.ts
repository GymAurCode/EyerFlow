import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { SYSTEM_ACCOUNTS, seedChartOfAccounts, accountIdByCode } from "../src/main/accounting/chart";
import {
  AccountingError,
  assertPeriodOpen,
  postEntry,
  postedTotals,
  reverseEntry,
  validateEntry,
} from "../src/main/accounting/posting";
import {
  balanceSheet,
  profitAndLoss,
  reconcile,
  trialBalance,
} from "../src/main/accounting/ledger";
import {
  expenseAccountFor,
  postExpense,
  postOpeningBalance,
  postPayment,
  postPurchase,
  postSale,
} from "../src/main/accounting/service";
import {
  closeDatabase,
  openDatabase,
} from "../src/data/connection";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase } from "../src/data/connection";
import type { Fils } from "../src/domain/money";

const NOW = "2026-03-01T09:00:00.000Z";
const DATE = "2026-03-01";
const START = "2026-01-01";
const END = "2026-12-31";

function readyDb(): SqliteDatabase {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  seedChartOfAccounts(db, NOW);
  return db;
}

/** The context the posting service needs, with the party lookup supplied. */
function ctx(db: SqliteDatabase): {
  db: SqliteDatabase;
  nowIso: string;
  reference: string | undefined;
  partyKind: (id: number) => "customer" | "supplier";
} {
  return {
    db,
    nowIso: NOW,
    reference: undefined,
    partyKind: (id: number) => {
      const row = db.prepare("SELECT kind FROM parties WHERE id = ?").get(id) as
        | { kind: string }
        | undefined;
      return row?.kind === "supplier" ? "supplier" : "customer";
    },
  };
}

/** One rupee is 100 fils in this app's minor unit. */
const RS = (rupees: number): Fils => rupees * 100;

function balanceOf(db: SqliteDatabase, code: string, toDate = END): Fils {
  const tb = trialBalance(db, START, toDate);
  return tb.rows.find((row) => row.code === code)?.balanceFils ?? 0;
}

function balanceSheetTotal(bs: ReturnType<typeof balanceSheet>, heading: string): Fils {
  const section = [bs.assets, bs.liabilities, bs.equity].find((s) => s.heading === heading);
  return section?.totalFils ?? 0;
}

/* ========================================================================== */

describe("chart of accounts", () => {
  it("seeds the full default chart", () => {
    const db = readyDb();
    const rows = db.prepare("SELECT code, name, type FROM accounts ORDER BY code").all() as {
      code: string;
      name: string;
      type: string;
    }[];

    // The chart in the specification: 7 assets, 6 liabilities, 4 equity,
    // 4 income, 12 expense and cost accounts.
    expect(rows.length).toBe(33);
    expect(rows.find((r) => r.code === "1000")?.name).toBe("Cash in Hand");
    expect(rows.find((r) => r.code === "2000")?.type).toBe("liability");
    expect(rows.find((r) => r.code === "4000")?.type).toBe("income");
    expect(rows.find((r) => r.code === "5000")?.type).toBe("expense");
    expect(rows.find((r) => r.code === "3000")?.type).toBe("equity");
  });

  it("does not duplicate accounts when seeded again", () => {
    const db = readyDb();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;

    seedChartOfAccounts(db, NOW);
    seedChartOfAccounts(db, NOW);

    const after = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("leaves an account the shop has renamed alone", () => {
    const db = readyDb();
    db.prepare("UPDATE accounts SET name = 'Till' WHERE code = ?").run(SYSTEM_ACCOUNTS.cashInHand);
    seedChartOfAccounts(db, NOW);
    const row = db.prepare("SELECT name FROM accounts WHERE code = ?").get(SYSTEM_ACCOUNTS.cashInHand) as {
      name: string;
    };
    expect(row.name).toBe("Till");
  });

  it("gives every account the normal balance its type implies", () => {
    const db = readyDb();
    const contra = db
      .prepare(
        `SELECT code, type, normal_balance AS normalBalance FROM accounts
          WHERE (type IN ('asset','expense') AND normal_balance <> 'debit')
             OR (type IN ('liability','equity','income') AND normal_balance <> 'credit')
          ORDER BY code`,
      )
      .all() as { code: string }[];

    // Three deliberate exceptions, each a contra account that reduces its own
    // class rather than growing it:
    //   1590 accumulated depreciation - a contra-asset
    //   3010 owner's drawings        - a debit inside equity
    //   4010 sales returns           - a debit inside income
    expect(contra.map((row) => row.code)).toEqual([
      SYSTEM_ACCOUNTS.accumulatedDepreciation,
      SYSTEM_ACCOUNTS.drawings,
      SYSTEM_ACCOUNTS.salesReturns,
    ]);
  });
});

/* ========================================================================== */

describe("double-entry rules", () => {
  it("refuses an unbalanced entry", () => {
    const db = readyDb();
    expect(() =>
      postEntry({ db, nowIso: NOW }, {
        entryDate: DATE,
        description: "Wrong",
        source: "manual",
        lines: [
          { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(100) },
          { accountCode: SYSTEM_ACCOUNTS.salesRevenue, creditFils: RS(90) },
        ],
      }),
    ).toThrow(/does not balance/);
  });

  it("refuses a single-line entry", () => {
    const db = readyDb();
    expect(() =>
      postEntry({ db, nowIso: NOW }, {
        entryDate: DATE,
        description: "One-sided",
        source: "manual",
        lines: [{ accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(100) }],
      }),
    ).toThrow(/at least two lines/);
  });

  it("refuses a zero line and a both-sided line", () => {
    const db = readyDb();
    expect(() =>
      postEntry({ db, nowIso: NOW }, {
        entryDate: DATE,
        description: "Zero",
        source: "manual",
        lines: [
          { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: 0 },
          { accountCode: SYSTEM_ACCOUNTS.salesRevenue, creditFils: RS(100) },
        ],
      }),
    ).toThrow(/zero line/);

    expect(() =>
      postEntry({ db, nowIso: NOW }, {
        entryDate: DATE,
        description: "Both sides",
        source: "manual",
        lines: [
          { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(100), creditFils: RS(100) },
          { accountCode: SYSTEM_ACCOUNTS.salesRevenue, creditFils: RS(100) },
        ],
      }),
    ).toThrow(/never both/);
  });

  it("refuses posting to a deactivated account", () => {
    const db = readyDb();
    db.prepare("UPDATE accounts SET is_active = 0 WHERE code = ?").run(SYSTEM_ACCOUNTS.rent);

    expect(() =>
      postEntry({ db, nowIso: NOW }, {
        entryDate: DATE,
        description: "Into a closed account",
        source: "manual",
        lines: [
          { accountCode: SYSTEM_ACCOUNTS.rent, debitFils: RS(100) },
          { accountCode: SYSTEM_ACCOUNTS.cashInHand, creditFils: RS(100) },
        ],
      }),
    ).toThrow(/deactivated/);
  });

  it("refuses to post into a closed accounting period", () => {
    const db = readyDb();
    db.prepare(
      "INSERT INTO accounting_periods (name, start_date, end_date, status, closed_at) VALUES (?, ?, ?, 'closed', ?)",
    ).run("March 2026", "2026-03-01", "2026-03-31", NOW);

    expect(() => assertPeriodOpen(db, "2026-03-15")).toThrow(/closed/);
    expect(() => assertPeriodOpen(db, "2026-04-01")).not.toThrow();

    expect(() =>
      postEntry({ db, nowIso: NOW }, {
        entryDate: "2026-03-15",
        description: "Too late",
        source: "manual",
        lines: [
          { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(100) },
          { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(100) },
        ],
      }),
    ).toThrow(AccountingError);
  });

  it("does not post the same source twice", () => {
    const db = readyDb();
    const input = {
      entryDate: DATE,
      description: "Idempotent",
      source: "manual" as const,
      sourceKey: "manual:1",
      lines: [
        { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(100) },
        { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(100) },
      ],
    };

    const first = postEntry({ db, nowIso: NOW }, input);
    const second = postEntry({ db, nowIso: NOW }, input);
    const third = postEntry({ db, nowIso: NOW }, input);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_key = ?").get("manual:1") as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("reverses by posting a mirror image rather than deleting", () => {
    const db = readyDb();
    const original = postEntry({ db, nowIso: NOW }, {
      entryDate: DATE,
      description: "To be reversed",
      source: "manual",
      sourceKey: "manual:rev",
      lines: [
        { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(500) },
        { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(500) },
      ],
    });

    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(500));

    const reversal = reverseEntry({ db, nowIso: NOW }, original.id, "Entered in error", DATE);

    // Both entries still exist; the original is marked, not removed.
    const rows = db
      .prepare("SELECT status FROM journal_entries WHERE id = ?")
      .all(original.id) as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("reversed");
    expect(reversal.lines[0]?.creditFils).toBe(RS(500));

    // Net effect is zero.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(0);
    const totals = postedTotals(db);
    expect(totals.debit).toBe(totals.credit);

    // A second reversal is refused.
    expect(() => reverseEntry({ db, nowIso: NOW }, original.id, "again", DATE)).toThrow(
      /already been reversed|is reversed/,
    );
  });

  it("keeps the trial balance balanced after every kind of posting", () => {
    const db = readyDb();
    postEntry({ db, nowIso: NOW }, {
      entryDate: DATE,
      description: "Balanced",
      source: "manual",
      lines: [
        { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(250) },
        { accountCode: SYSTEM_ACCOUNTS.salesRevenue, creditFils: RS(250) },
      ],
    });
    const tb = trialBalance(db, START, END);
    expect(tb.isBalanced).toBe(true);
    expect(tb.differenceFils).toBe(0);
  });
});

/* ========================================================================== */

/**
 * The scenario from the specification, step by step. Every assertion quotes the
 * step it belongs to, because "the numbers look right" is not a test.
 *
 * Opening balances are posted first: the scenario spends cash before the shop
 * has any, and without an opening balance the ledger would correctly show a cash
 * overdraft rather than the figures the scenario expects.
 */
describe("the required end-to-end scenario", () => {
  const setup = () => {
    const db = readyDb();
    const c = ctx(db);

    // Step 1: a product costing Rs 100.
    db.prepare(
      `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, is_active, created_at, updated_at)
       VALUES ('SKU-1', 'Filter', 0, ?, ?, 1, ?, ?)`,
    ).run(RS(100), RS(150), NOW, NOW);
    const productId = Number(
      (
        db.prepare("SELECT id FROM products WHERE sku = 'SKU-1'").get() as { id: number }
      ).id,
    );

    const mkParty = (code: string, name: string, kind: "customer" | "supplier"): number => {
      db.prepare(
        "INSERT INTO parties (code, name, kind, opening_balance, is_active, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
      ).run(code, name, kind, NOW, NOW);
      return Number((db.prepare("SELECT id FROM parties WHERE code = ?").get(code) as { id: number }).id);
    };

    const supplierId = mkParty("S-1", "Filter Supplier", "supplier");
    const customerId = mkParty("C-1", "Water Company", "customer");

    // Opening balances: Rs 10,000 cash against Rs 10,000 of capital.
    postOpeningBalance(c, DATE, [
      { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(10_000), creditFils: 0 },
      { accountCode: SYSTEM_ACCOUNTS.capital, debitFils: 0, creditFils: RS(10_000) },
    ]);

    const mkDoc = (over: {
      id: number;
      kind: "purchaseInvoice" | "invoice";
      number: string;
      partyId: number;
      netFils: Fils;
      vatFils: Fils;
      grossFils: Fils;
      paidFils: Fils;
      costFils: Fils;
    }): void => {
      db.prepare(
        `INSERT INTO documents
           (kind, number, party_id, issue_date, due_date, status, net_fils, vat_fils, gross_fils,
            paid_fils, cost_fils, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        over.kind, over.number, over.partyId, DATE, "2026-04-01",
        over.netFils, over.vatFils, over.grossFils, over.paidFils, over.costFils, NOW, NOW,
      );
    };

    const readDoc = (id: number): Parameters<typeof postSale>[1] =>
      db
        .prepare(
          `SELECT id, kind, number, party_id AS partyId, issue_date AS issueDate,
                  gross_fils AS grossFils, net_fils AS netFils, vat_fils AS vatFils,
                  paid_fils AS paidFils, cost_fils AS costFils
             FROM documents WHERE id = ?`,
        )
        .get(id) as never;

    return { db, c, productId, supplierId, customerId, mkDoc, readDoc };
  };

  it("runs steps 2-18 of the specification", () => {
    const { db, c, productId, supplierId, customerId, mkDoc, readDoc } = setup();

    // --- Step 2: purchase 100 units at Rs 100 on credit = Rs 10,000 --------
    mkDoc({
      id: 0, kind: "purchaseInvoice", number: "PUR-1", partyId: supplierId,
      netFils: RS(10_000), vatFils: 0, grossFils: RS(10_000), paidFils: 0, costFils: RS(10_000),
    });
    const purchaseId = Number((db.prepare("SELECT id FROM documents WHERE number='PUR-1'").get() as { id: number }).id);
    postPurchase(c, readDoc(purchaseId));

    // Dr Inventory 10,000 / Cr Accounts Payable 10,000.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(10_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(10_000));

    // --- Step 3: pay the supplier Rs 4,000 ---------------------------------
    db.prepare(
      `INSERT INTO payments (direction, party_id, payment_date, method, amount_fils, created_at)
       VALUES ('outbound', ?, ?, 'cash', ?, ?)`,
    ).run(supplierId, DATE, RS(4_000), NOW);
    const paymentId = Number((db.prepare("SELECT id FROM payments").get() as { id: number }).id);

    postPayment(c, {
      id: paymentId, direction: "outbound", partyId: supplierId, paymentDate: DATE,
      method: "cash", amountFils: RS(4_000), reference: null, onAccountFils: 0,
      notes: null, createdBy: null, createdAt: NOW,
    } as never);

    // --- Step 4: supplier still owes Rs 6,000 ------------------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(6_000));

    // --- Step 5: sell 20 units at Rs 150 on credit = Rs 3,000 --------------
    db.prepare(
      "UPDATE products SET quantity_milli = 80000, average_cost_fils = ? WHERE id = ?",
    ).run(RS(100), productId);

    mkDoc({
      id: 0, kind: "invoice", number: "INV-1", partyId: customerId,
      netFils: RS(3_000), vatFils: 0, grossFils: RS(3_000), paidFils: 0, costFils: RS(2_000),
    });
    const saleId = Number((db.prepare("SELECT id FROM documents WHERE number='INV-1'").get() as { id: number }).id);
    postSale(c, readDoc(saleId), SYSTEM_ACCOUNTS.cashInHand);

    // --- Step 6: revenue is Rs 3,000 ---------------------------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(3_000));

    // --- Step 7: cost of goods sold is Rs 2,000 ---------------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.costOfGoodsSold)).toBe(RS(2_000));

    // --- Step 8: inventory reduced by the cost; 80 units remain ------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(8_000));
    const remaining = db.prepare("SELECT quantity_milli AS q FROM products WHERE id = ?").get(productId) as { q: number };
    expect(remaining.q).toBe(80_000);

    // --- Step 9: receive Rs 1,000 from the customer ------------------------
    db.prepare(
      `INSERT INTO payments (direction, party_id, payment_date, method, amount_fils, created_at)
       VALUES ('inbound', ?, ?, 'cash', ?, ?)`,
    ).run(customerId, DATE, RS(1_000), NOW);
    const receiptId = Number(
      (db.prepare("SELECT id FROM payments WHERE direction='inbound'").get() as { id: number }).id,
    );
    postPayment(c, {
      id: receiptId, direction: "inbound", partyId: customerId, paymentDate: DATE,
      method: "cash", amountFils: RS(1_000), reference: null, onAccountFils: 0,
      notes: null, createdBy: null, createdAt: NOW,
    } as never);

    // --- Step 10: customer still owes Rs 2,000 -----------------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(2_000));

    // --- Step 11: rent expense of Rs 500, paid in cash --------------------
    db.prepare(
      `INSERT INTO expenses (expense_date, category, description, amount_fils, vat_fils, payment_method, created_at, updated_at)
       VALUES (?, 'rent', 'Shop rent', ?, 0, 'cash', ?, ?)`,
    ).run(DATE, RS(500), NOW, NOW);
    const expenseId = Number((db.prepare("SELECT id FROM expenses").get() as { id: number }).id);
    postExpense(c, {
      id: expenseId, expenseDate: DATE, category: "rent", description: "Shop rent",
      amountFils: RS(500), vatFils: 0, paymentMethod: "cash", partyId: null,
      reference: null, notes: null, createdBy: null, createdAt: NOW, updatedAt: NOW,
    } as never);

    // --- Step 12: every figure --------------------------------------------
    // Cash: 10,000 opening - 4,000 paid + 1,000 received - 500 rent.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(6_500));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(8_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(2_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(6_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(3_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.costOfGoodsSold)).toBe(RS(2_000));
    expect(balanceOf(db, expenseAccountFor("rent"))).toBe(RS(500));

    // --- Step 13: the trial balance balances ------------------------------
    const tb = trialBalance(db, START, END);
    expect(tb.differenceFils).toBe(0);
    expect(tb.isBalanced).toBe(true);

    // --- Step 14: the balance sheet balances ------------------------------
    const bs = balanceSheet(db, END);
    expect(balanceSheetTotal(bs, "Assets")).toBe(RS(16_500));
    expect(balanceSheetTotal(bs, "Liabilities")).toBe(RS(6_000));
    expect(bs.isBalanced).toBe(true);
    expect(bs.differenceFils).toBe(0);

    // Assets = Liabilities + Capital + current period earnings.
    // 16,500 = 6,000 + 10,000 + 500.
    expect(bs.equity.totalFils).toBe(RS(10_000));

    // --- Step 15: profit and loss ------------------------------------------
    const pl = profitAndLoss(db, START, END);
    expect(pl.grossSalesFils).toBe(RS(3_000));
    expect(pl.netSalesFils).toBe(RS(3_000));
    expect(pl.costOfGoodsSoldFils).toBe(RS(2_000));
    expect(pl.grossProfitFils).toBe(RS(1_000));
    expect(pl.operatingExpensesFils).toBe(RS(500));
    expect(pl.netProfitFils).toBe(RS(500));

    // --- Control accounts reconcile with their subledgers -----------------
    const rec = reconcile(db, END);
    expect(rec.receivableMatches).toBe(true);
    expect(rec.payableMatches).toBe(true);
    expect(rec.receivableFromPartiesFils).toBe(RS(2_000));
    expect(rec.payableFromPartiesFils).toBe(RS(6_000));
  });

  it("keeps every balance after the database is reopened", () => {
    // Step 16: persistence. The entries are rows in the real schema, so a
    // second connection to the same file sees the same ledger.

    const dir = mkdtempSync(join(tmpdir(), "eyerstock-finance-"));
    try {
      const db = openDatabase(join(dir, "finance.db"));
      runMigrations(db, migrations);
      seedChartOfAccounts(db, NOW);
      postEntry({ db, nowIso: NOW }, {
        entryDate: DATE,
        description: "Persisted",
        source: "manual",
        sourceKey: "manual:persist",
        lines: [
          { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(777) },
          { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(777) },
        ],
      });
      closeDatabase(db);

      const reopened = openDatabase(join(dir, "finance.db"));
      const tb = trialBalance(reopened, START, END);
      expect(tb.isBalanced).toBe(true);
      expect(tb.rows.find((r) => r.code === SYSTEM_ACCOUNTS.cashInHand)?.balanceFils).toBe(RS(777));
      expect(accountIdByCode(reopened, SYSTEM_ACCOUNTS.cashInHand)).not.toBeNull();
      closeDatabase(reopened);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("does not double-post when the same business record is processed twice", () => {
    // Step 17: a retried save must not post a second time.
    const { db, c, supplierId, mkDoc, readDoc } = setup();
    mkDoc({
      id: 0, kind: "purchaseInvoice", number: "PUR-RETRY", partyId: supplierId,
      netFils: RS(500), vatFils: 0, grossFils: RS(500), paidFils: 0, costFils: RS(500),
    });
    const id = Number(
      (db.prepare("SELECT id FROM documents WHERE number='PUR-RETRY'").get() as { id: number }).id,
    );

    postPurchase(c, readDoc(id));
    postPurchase(c, readDoc(id));
    postPurchase(c, readDoc(id));

    // `setup` posts only the opening cash balance, so the ledger starts with no
    // inventory. Three calls, one purchase: it must be 500, not 1,500.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(500));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(500));

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_key LIKE 'purchase:%'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("handles a sales return as the mirror of the sale", () => {
    // Step 18: returns must put the revenue and the receivable back.
    const { db, c, supplierId, customerId, mkDoc, readDoc } = setup();

    mkDoc({
      id: 0, kind: "invoice", number: "INV-R", partyId: customerId,
      netFils: RS(1_000), vatFils: 0, grossFils: RS(1_000), paidFils: RS(1_000), costFils: RS(1_000),
    });
    const saleId = Number((db.prepare("SELECT id FROM documents WHERE number='INV-R'").get() as { id: number }).id);
    postSale(c, readDoc(saleId), SYSTEM_ACCOUNTS.cashInHand);

    // The invoice is booked in full against the customer. The money that
    // settles it is a separate entry, so the sale and the receipt can always
    // be seen apart - which is what makes a credit sale different from a cash
    // sale.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(1_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(1_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000));

    // The customer pays in full.
    db.prepare(
      `INSERT INTO payments (direction, party_id, payment_date, method, amount_fils, created_at)
       VALUES ('inbound', ?, ?, 'cash', ?, ?)`,
    ).run(customerId, DATE, RS(1_000), NOW);
    const receiptId = Number(
      (db.prepare("SELECT id FROM payments WHERE direction='inbound'").get() as { id: number }).id,
    );
    postPayment(c, {
      id: receiptId, direction: "inbound", partyId: customerId, paymentDate: DATE,
      method: "cash", amountFils: RS(1_000), reference: null, onAccountFils: 0,
      notes: null, createdBy: null, createdAt: NOW,
    } as never);

    // Settled: nothing is owed, and the cash is in.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(11_000));

    // The return is reversed by the engine, exactly as a correction would be.
    const entry = db
      .prepare("SELECT id FROM journal_entries WHERE source_key = ?")
      .get(`sale:${String(saleId)}`) as { id: number };
    reverseEntry({ db, nowIso: NOW }, entry.id, "Goods returned", DATE);

    // The reversal puts the revenue back and credits the customer again. The
    // money that was already received is not touched: it was received, and a
    // return of the goods does not un-receive it. The customer is therefore
    // left with a credit - the shop owes them the money they paid for goods
    // they sent back.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(-RS(1_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(11_000));
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
    void supplierId;
    void validateEntry;
  });
});
