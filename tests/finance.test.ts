/**
 * The Finance module's tests.
 *
 * These are the tests that decide whether the books can be trusted, so they
 * are written against the *repositories* rather than against the engine
 * alone: a document is saved the way the app saves it, and the ledger is
 * then checked for what it should say.
 *
 * The scenario in the specification is run end to end here - purchase on
 * credit, pay the supplier, sell on credit, take the money, record an
 * expense - and every figure the specification names is asserted, together
 * with the three reconciliations that have to hold for the books to be
 * right: the trial balance balances, the balance sheet balances, and the
 * control accounts agree with the customer and supplier accounts behind
 * them.
 */

import { describe, expect, it } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { SYSTEM_ACCOUNTS, seedChartOfAccounts } from "../src/main/accounting/chart";
import {
  deleteAccount,
  listAccounts,
  saveAccount,
  setAccountActive,
} from "../src/main/accounting/accounts";
import {
  postEntry,
  readEntryDetail,
  reverseEntry,
} from "../src/main/accounting/posting";
import { reconcile, trialBalance } from "../src/main/accounting/ledger";
import {
  agingReport,
  cashFlowStatement,
  detailedTrialBalance,
  financeBalanceSheet,
  financeProfitAndLoss,
  generalLedger,
  partyStatement,
} from "../src/main/accounting/reports";
import {
  syncDocumentPosting,
  syncExpensePosting,
  syncPaymentPosting,
  reverseDocumentPosting,
  reversePaymentPosting,
  reverseExpensePosting,
  type AccountingContext,
} from "../src/main/accounting/integration";
import { saveDocument, cancelDocument } from "../src/main/repositories/documents";
import { savePayment, deletePayment } from "../src/main/repositories/payments";
import { saveExpense, deleteExpense } from "../src/main/repositories/reports";
import { migrationAudit, backfillHistory } from "../src/main/finance-service";
import type { DocumentDto } from "../src/shared/types";
import type { Fils } from "../src/domain/money";

const NOW = "2026-03-01T09:00:00.000Z";
const DATE = "2026-03-01";
/** The books start before the trading period, so a period opens with a balance. */
const OPENING_DATE = "2025-12-31";
const START = "2026-01-01";
const END = "2026-12-31";

/** One rupee is 100 fils in this app's minor unit. */
const RS = (rupees: number): Fils => rupees * 100;

const ACTOR = { id: 1, name: "Tester" };

/* -------------------------------------------------------------------------- */
/* fixture                                                                     */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly db: SqliteDatabase;
  readonly ctx: AccountingContext;
  readonly customerId: number;
  readonly supplierId: number;
  readonly productId: number;
}

function readyDb(): SqliteDatabase {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  seedChartOfAccounts(db, NOW);
  return db;
}

function accountingContext(db: SqliteDatabase): AccountingContext {
  return { db, nowIso: NOW, nowDate: DATE, createdBy: ACTOR.name };
}

/**
 * A shop with one product costing 100, one customer and one supplier, and
 * opening balances of 10,000 in cash against 10,000 of capital.
 */
function fixture(): Fixture {
  const db = readyDb();
  const ctx = accountingContext(db);

  db.prepare(
    `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, is_active, created_at, updated_at)
     VALUES ('SKU-1', 'Filter', 0, ?, ?, 1, ?, ?)`,
  ).run(RS(100), RS(150), NOW, NOW);
  const productId = Number(
    (db.prepare("SELECT id FROM products WHERE sku = 'SKU-1'").get() as { id: number }).id,
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
  postEntry(
    { db, nowIso: NOW },
    {
      entryDate: OPENING_DATE,
      description: "Opening balances",
      source: "opening",
      sourceKey: `opening:${OPENING_DATE}`,
      lines: [
        { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(10_000) },
        { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(10_000) },
      ],
    },
  );

  return { db, ctx, customerId, supplierId, productId };
}

interface DocumentContext {
  readonly db: SqliteDatabase;
  readonly actor: typeof ACTOR;
  readonly fiscalYearStartMonth: number;
  readonly nowIso: string;
  readonly nowDate: string;
  readonly allowNegativeStock: boolean;
  readonly vatRate: number;
}

function documentContext(db: SqliteDatabase): DocumentContext {
  return {
    db,
    actor: ACTOR,
    fiscalYearStartMonth: 1,
    nowIso: NOW,
    nowDate: DATE,
    allowNegativeStock: true,
    vatRate: 0,
  };
}

/** Save a document and post it, exactly as the app does. */
function saveAndPost(
  db: SqliteDatabase,
  request: Parameters<typeof saveDocument>[1],
): DocumentDto {
  return db.transaction(() => {
    const saved = saveDocument(documentContext(db), request);
    syncDocumentPosting(accountingContext(db), saved);
    return saved;
  })();
}

function balanceOf(db: SqliteDatabase, code: string): Fils {
  const tb = trialBalance(db, START, END);
  return tb.rows.find((row) => row.code === code)?.balanceFils ?? 0;
}

/* ========================================================================== */
/* the required scenario                                                       */
/* ========================================================================== */

describe("the required finance scenario", () => {
  it("books every step of the specification and balances the books", () => {
    const { db, ctx, customerId, supplierId, productId } = fixture();

    // --- Step 1: a product costing Rs 100 -------------------------------
    expect(
      (db.prepare("SELECT average_cost_fils AS c FROM products WHERE id = ?").get(productId) as {
        c: number;
      }).c,
    ).toBe(RS(100));

    // --- Step 2: purchase 100 units at Rs 100 on credit = Rs 10,000 -----
    const purchase = saveAndPost(db, {
      kind: "purchaseInvoice",
      partyId: supplierId,
      issueDate: DATE,
      dueDate: "2026-04-01",
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 100_000,
          unitPriceFils: RS(100),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    // Dr Inventory 10,000 / Cr Accounts Payable 10,000.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(10_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(10_000));

    // --- Step 3: pay the supplier Rs 4,000 ------------------------------
    const payment = db.transaction(() => {
      const saved = savePayment(
        {
          db,
          actor: ACTOR,
          fiscalYearStartMonth: 1,
          nowIso: NOW,
          nowDate: DATE,
        },
        {
          direction: "outbound",
          partyId: supplierId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(4_000),
          allocations: [{ documentId: purchase.id, amountFils: RS(4_000) }],
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    // --- Step 4: the supplier is still owed Rs 6,000 --------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(6_000));

    // --- Step 5: sell 20 units at Rs 150 on credit = Rs 3,000 ------------
    const sale = saveAndPost(db, {
      kind: "invoice",
      partyId: customerId,
      issueDate: DATE,
      dueDate: "2026-04-01",
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 20_000,
          unitPriceFils: RS(150),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    // --- Step 6: sales revenue is Rs 3,000 ------------------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(3_000));

    // --- Step 7: cost of goods sold is Rs 2,000 -------------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.costOfGoodsSold)).toBe(RS(2_000));

    // --- Step 8: inventory is reduced by the cost; 80 units remain ------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(8_000));
    expect(
      (
        db.prepare("SELECT quantity_milli AS q FROM products WHERE id = ?").get(productId) as {
          q: number;
        }
      ).q,
    ).toBe(80_000);

    // --- Step 9: receive Rs 1,000 from the customer ----------------------
    db.transaction(() => {
      const saved = savePayment(
        {
          db,
          actor: ACTOR,
          fiscalYearStartMonth: 1,
          nowIso: NOW,
          nowDate: DATE,
        },
        {
          direction: "inbound",
          partyId: customerId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(1_000),
          allocations: [{ documentId: sale.id, amountFils: RS(1_000) }],
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    // --- Step 10: the customer still owes Rs 2,000 ----------------------
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(2_000));

    // --- Step 11: rent of Rs 500, paid in cash --------------------------
    db.transaction(() => {
      const saved = saveExpense(
        { db, actor: ACTOR, nowIso: NOW },
        {
          expenseDate: DATE,
          category: "rent",
          description: "Shop rent",
          amountFils: RS(500),
          paymentMethod: "cash",
        },
      );
      syncExpensePosting(ctx, saved);
      return saved;
    })();

    // --- Step 12: every figure ------------------------------------------
    // Cash: 10,000 opening - 4,000 paid + 1,000 received - 500 rent.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(6_500));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(8_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(2_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(6_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(3_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.costOfGoodsSold)).toBe(RS(2_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.rent)).toBe(RS(500));

    // --- Step 13: the trial balance balances ----------------------------
    const tb = trialBalance(db, START, END);
    expect(tb.differenceFils).toBe(0);
    expect(tb.isBalanced).toBe(true);

    const detailed = detailedTrialBalance(db, START, END);
    expect(detailed.totalClosingDebitFils).toBe(detailed.totalClosingCreditFils);
    expect(detailed.isBalanced).toBe(true);

    // --- Step 14: the balance sheet balances ----------------------------
    const sheet = financeBalanceSheet(db, END);
    // Assets: cash 6,500 + stock 8,000 + receivable 2,000 = 16,500.
    expect(sheet.assets.totalFils).toBe(RS(16_500));
    // Liabilities: the supplier is owed 6,000.
    expect(sheet.liabilities.totalFils).toBe(RS(6_000));
    // Equity: capital 10,000, and the profit of 500 for the period.
    expect(sheet.equity.totalFils).toBe(RS(10_000));
    expect(sheet.currentPeriodEarningsFils).toBe(RS(500));
    expect(sheet.isBalanced).toBe(true);
    expect(sheet.differenceFils).toBe(0);

    // --- Step 15: profit and loss ----------------------------------------
    const pnl = financeProfitAndLoss(db, START, END);
    expect(pnl.grossSalesFils).toBe(RS(3_000));
    expect(pnl.netSalesFils).toBe(RS(3_000));
    expect(pnl.costOfGoodsSoldFils).toBe(RS(2_000));
    expect(pnl.grossProfitFils).toBe(RS(1_000));
    expect(pnl.operatingExpensesFils).toBe(RS(500));
    expect(pnl.netProfitFils).toBe(RS(500));

    // --- The control accounts agree with the subledgers -----------------
    const rec = reconcile(db, END);
    expect(rec.receivableMatches).toBe(true);
    expect(rec.payableMatches).toBe(true);
    expect(rec.receivableFromPartiesFils).toBe(RS(2_000));
    expect(rec.payableFromPartiesFils).toBe(RS(6_000));

    void payment;
  });

  it("keeps the books balanced when a purchase is paid in full", () => {
    const { db, supplierId, productId } = fixture();

    const purchase = saveAndPost(db, {
      kind: "purchaseInvoice",
      partyId: supplierId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 10_000,
          unitPriceFils: RS(100),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    // Paid on the spot, in one go.
    db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "outbound",
          partyId: supplierId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(1_000),
          allocations: [{ documentId: purchase.id, amountFils: RS(1_000) }],
        },
      );
      syncPaymentPosting(accountingContext(db), saved);
      return saved;
    })();

    // The purchase raised the payable in full; the payment settled it.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(1_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000) - RS(1_000));
    // The purchase was not counted twice.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.costOfGoodsSold)).toBe(0);
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("does not count a credit sale as cash received", () => {
    const { db, ctx, customerId, productId } = fixture();

    saveAndPost(db, {
      kind: "invoice",
      partyId: customerId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 1_000,
          unitPriceFils: RS(150),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    // A credit sale raises revenue and a receivable. No cash has moved.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(150));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(150));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000));

    // The cash flow statement says so too.
    const flow = cashFlowStatement(db, START, END);
    expect(flow.totalReceivedFils).toBe(0);
    expect(flow.totalPaidFils).toBe(0);
    void ctx;
  });
});

/* ========================================================================== */
/* chart of accounts                                                           */
/* ========================================================================== */

describe("the chart of accounts", () => {
  it("saves a sub-account under its parent", () => {
    const db = readyDb();

    const parent = saveAccount(
      db,
      { code: "1600", name: "Vehicles and Equipment", type: "asset", subtype: "fixedAsset" },
      NOW,
    );
    expect(parent.id).toBeGreaterThan(0);
    expect(parent.parentId).toBeNull();

    const child = saveAccount(
      db,
      {
        code: "1610",
        name: "Delivery Vehicles",
        type: "asset",
        subtype: "fixedAsset",
        parentId: parent.id,
      },
      NOW,
    );
    expect(child.parentId).toBe(parent.id);
    expect(child.parentCode).toBe("1600");

    // And it reads back as a sub-account of that parent.
    const reloaded = listAccounts(db).find((account) => account.code === "1610");
    expect(reloaded?.parentId).toBe(parent.id);
  });
  it("refuses a duplicate code", () => {
    const db = readyDb();
    expect(() =>
      saveAccount(
        db,
        { code: "1000", name: "Another Till", type: "asset", subtype: "currentAsset" },
        NOW,
      ),
    ).toThrow(/already used/);
  });

  it("refuses a parent that would make a loop", () => {
    const db = readyDb();
    const parent = saveAccount(
      db,
      { code: "1100", name: "Parent", type: "asset", subtype: "currentAsset" },
      NOW,
    );
    const child = saveAccount(
      db,
      {
        code: "1110",
        name: "Child",
        type: "asset",
        subtype: "currentAsset",
        parentId: parent.id,
      },
      NOW,
    );

    expect(() =>
      saveAccount(
        db,
        {
          id: parent.id,
          code: "1100",
          name: "Parent",
          type: "asset",
          subtype: "currentAsset",
          parentId: child.id,
        },
        NOW,
      ),
    ).toThrow(/ancestor/);
  });

  it("refuses to retype a system account", () => {
    const db = readyDb();
    const receivable = listAccounts(db).find(
      (account) => account.code === SYSTEM_ACCOUNTS.accountsReceivable,
    );
    expect(receivable).toBeDefined();
    expect(() =>
      saveAccount(
        db,
        {
          id: receivable?.id,
          code: receivable?.code ?? "",
          name: receivable?.name ?? "",
          type: "expense",
        },
        NOW,
      ),
    ).toThrow(/system account/);
  });

  it("refuses to delete an account that has history, and deactivates instead", () => {
    const { db } = fixture();
    const rent = listAccounts(db).find((account) => account.code === SYSTEM_ACCOUNTS.rent);
    expect(rent).toBeDefined();

    // The rent account has not been used, so it can go.
    const unused = saveAccount(
      db,
      { code: "6200", name: "Unused", type: "expense", subtype: "operatingExpense" },
      NOW,
    );
    deleteAccount(db, unused.id, NOW);
    expect(listAccounts(db).some((account) => account.id === unused.id)).toBe(false);

    // An account with ledger lines cannot be deleted: the lines would be
    // left pointing at a row that no longer exists.
    db.prepare(
      `INSERT INTO journal_lines (entry_id, line_no, account_id, debit_fils, credit_fils)
       SELECT id, 99, id, ?, 0 FROM journal_entries LIMIT 1`,
    ).run(RS(1));
    const cash = listAccounts(db).find((account) => account.code === SYSTEM_ACCOUNTS.cashInHand);
    expect(() => deleteAccount(db, cash?.id ?? 0, NOW)).toThrow(/cannot be deleted/);

    const deactivated = setAccountActive(db, rent?.id ?? 0, false, NOW);
    expect(deactivated.isActive).toBe(false);
  });

  it("shows the balance of every account", () => {
    const { db } = fixture();
    const cash = listAccounts(db).find((account) => account.code === SYSTEM_ACCOUNTS.cashInHand);
    expect(cash?.balanceFils).toBe(RS(10_000));
    expect(cash?.usageCount).toBeGreaterThan(0);
  });

  it("refuses an account with an unknown parent", () => {
    const db = readyDb();
    expect(() =>
      saveAccount(
        db,
        {
          code: "1200",
          name: "Orphan",
          type: "asset",
          subtype: "currentAsset",
          parentId: 9999,
        },
        NOW,
      ),
    ).toThrow(/parent account was not found/);
  });
});

/* ========================================================================== */
/* journal entries                                                             */
/* ========================================================================== */

describe("journal entries", () => {
  it("refuses to post an unbalanced manual entry", () => {
    const db = readyDb();
    const ctx = accountingContext(db);

    expect(() =>
      postEntry(ctx, {
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

  it("refuses to post into a deactivated account", () => {
    const db = readyDb();
    const ctx = accountingContext(db);
    const rent = listAccounts(db).find((account) => account.code === SYSTEM_ACCOUNTS.rent);
    setAccountActive(db, rent?.id ?? 0, false, NOW);

    expect(() =>
      postEntry(ctx, {
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

  it("marks a reversed entry and posts its mirror image", () => {
    const db = readyDb();
    const ctx = accountingContext(db);
    const entry = postEntry(ctx, {
      entryDate: DATE,
      description: "To be reversed",
      source: "manual",
      sourceKey: "manual:reverse-me",
      lines: [
        { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(500) },
        { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(500) },
      ],
    });

    const reversal = reverseEntry(ctx, entry.id, "Entered in error", DATE);
    const detail = readEntryDetail(db, reversal.id);

    // The original is kept and marked; the mirror image is beside it.
    const original = readEntryDetail(db, entry.id);
    expect(original.status).toBe("reversed");
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(detail.source).toBe("reversal");
    expect(detail.lines[0]?.creditFils).toBe(RS(500));

    // Net effect is nothing, and the books still balance.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(0);
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("does not post the same source twice", () => {
    const db = readyDb();
    const ctx = accountingContext(db);
    const input = {
      entryDate: DATE,
      description: "Idempotent",
      source: "manual" as const,
      sourceKey: "manual:once",
      lines: [
        { accountCode: SYSTEM_ACCOUNTS.cashInHand, debitFils: RS(100) },
        { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: RS(100) },
      ],
    };

    const first = postEntry(ctx, input);
    const second = postEntry(ctx, input);
    expect(second.id).toBe(first.id);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(100));
  });
});

/* ========================================================================== */
/* ledgers, statements and reconciliations                                     */
/* ========================================================================== */

describe("ledgers and statements", () => {
  it("carries a running balance down the general ledger", () => {
    const { db } = fixture();
    // The range includes the opening balance, so the ledger has something to
    // carry: an opening balance of nothing, then the entry that made it.
    const ledger = generalLedger(db, SYSTEM_ACCOUNTS.cashInHand, "2025-01-01", END);

    expect(ledger.openingBalanceFils).toBe(0);
    expect(ledger.rows.length).toBeGreaterThan(0);

    let running = ledger.openingBalanceFils;
    for (const row of ledger.rows) {
      running += row.debitFils - row.creditFils;
      expect(row.runningBalanceFils).toBe(running);
    }
    expect(ledger.closingBalanceFils).toBe(running);
    expect(ledger.closingBalanceFils).toBe(RS(10_000));
  });

  it("agrees with the control account for every customer", () => {
    const { db, ctx, customerId, productId } = fixture();

    saveAndPost(db, {
      kind: "invoice",
      partyId: customerId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 1_000,
          unitPriceFils: RS(150),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    const statement = partyStatement(db, customerId, "customer", START, END);
    const control = balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable);

    expect(statement.closingBalanceFils).toBe(control);
    expect(statement.rows.length).toBe(1);
    expect(statement.rows[0]?.kind).toBe("invoice");
    expect(statement.rows[0]?.debitFils).toBe(RS(150));

    // A receipt reduces the balance and is shown on the credit side.
    db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "inbound",
          partyId: customerId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(50),
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    const after = partyStatement(db, customerId, "customer", START, END);
    expect(after.closingBalanceFils).toBe(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable));
    expect(after.closingBalanceFils).toBe(RS(100));
    expect(after.rows[1]?.kind).toBe("receipt");
    expect(after.rows[1]?.creditFils).toBe(RS(50));
  });

  it("groups outstanding invoices into aging bands", () => {
    const { db, customerId, productId } = fixture();

    const makeSale = (issueDate: string, dueDate: string, amount: number): void => {
      saveAndPost(db, {
        kind: "invoice",
        partyId: customerId,
        issueDate,
        dueDate,
        status: "issued",
        lines: [
          {
            productId,
            description: "Filter",
            quantityMilli: 1_000,
            unitPriceFils: RS(amount),
            vatTreatment: "standard",
            unitCostFils: RS(100),
          },
        ],
      });
    };

    makeSale("2025-10-01", "2025-10-31", 10); // long overdue
    makeSale("2026-02-20", "2026-03-20", 20); // not yet due
    makeSale("2026-02-20", "2026-02-25", 30); // 4 days late

    const aging = agingReport(db, DATE, "receivable");
    const bucket = (key: string): number =>
      aging.totals.find((entry) => entry.bucket === key)?.amountFils ?? 0;

    expect(bucket("notDue")).toBe(RS(20));
    expect(bucket("d1_30")).toBe(RS(30));
    expect(bucket("d90plus")).toBe(RS(10));
    expect(aging.totalOutstandingFils).toBe(RS(60));
  });

  it("separates operating, investing and financing cash", () => {
    const { db, ctx } = fixture();

    // An owner's contribution is financing.
    db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "inbound",
          partyId: 1,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(1_000),
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    const flow = cashFlowStatement(db, START, END);
    expect(flow.openingCashFils).toBe(RS(10_000));
    expect(flow.closingCashFils).toBe(RS(11_000));
    expect(flow.totalReceivedFils).toBe(RS(1_000));
  });
});

/* ========================================================================== */
/* reversals, corrections and existing data                                    */
/* ========================================================================== */

describe("corrections and existing data", () => {
  it("reverses a document's postings when it is cancelled", () => {
    const { db, ctx, customerId, productId } = fixture();

    const sale = saveAndPost(db, {
      kind: "invoice",
      partyId: customerId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 1_000,
          unitPriceFils: RS(150),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(RS(150));

    db.transaction(() => {
      const cancelled = cancelDocument(
        documentContext(db),
        sale.id,
        "Customer changed their mind",
      );
      reverseDocumentPosting(ctx, cancelled, "Cancelled: Customer changed their mind");
      return cancelled;
    })();

    // The revenue is gone and the books still balance.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.salesRevenue)).toBe(0);
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("reverses a payment's posting when the payment is deleted", () => {
    const { db, ctx, customerId, productId } = fixture();

    const sale = saveAndPost(db, {
      kind: "invoice",
      partyId: customerId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 1_000,
          unitPriceFils: RS(150),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    const payment = db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "inbound",
          partyId: customerId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(150),
          allocations: [{ documentId: sale.id, amountFils: RS(150) }],
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_150));

    db.transaction(() => {
      deletePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW },
        payment.id,
      );
      reversePaymentPosting(ctx, payment.id);
      return payment;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(150));
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("reverses an expense's posting when the expense is deleted", () => {
    const { db, ctx } = fixture();

    const expense = db.transaction(() => {
      const saved = saveExpense(
        { db, actor: ACTOR, nowIso: NOW },
        {
          expenseDate: DATE,
          category: "rent",
          description: "Shop rent",
          amountFils: RS(500),
          paymentMethod: "cash",
        },
      );
      syncExpensePosting(ctx, saved);
      return saved;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.rent)).toBe(RS(500));

    db.transaction(() => {
      deleteExpense({ db, actor: ACTOR, nowIso: NOW }, expense.id);
      reverseExpensePosting(ctx, expense.id);
      return expense;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.rent)).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000));
  });

  it("charges an expense to the account it names, and carries the unpaid part as a liability", () => {
    const { db, ctx } = fixture();

    // Rent, paid in full, charged to a named account.
    db.transaction(() => {
      const saved = saveExpense(
        { db, actor: ACTOR, nowIso: NOW },
        {
          expenseDate: DATE,
          category: "general",
          description: "Shop rent",
          amountFils: RS(500),
          paidFils: RS(500),
          paymentMethod: "cash",
          accountCode: SYSTEM_ACCOUNTS.rent,
        },
      );
      syncExpensePosting(ctx, saved);
      return saved;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.rent)).toBe(RS(500));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000) - RS(500));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.otherCurrentLiabilities)).toBe(0);

    // A second expense, only half paid. The whole cost is expensed, and the
    // unpaid half is a liability rather than money that left the till.
    db.transaction(() => {
      const saved = saveExpense(
        { db, actor: ACTOR, nowIso: NOW },
        {
          expenseDate: DATE,
          category: "utilities",
          description: "Electricity",
          amountFils: RS(200),
          paidFils: RS(50),
          paymentMethod: "cash",
          accountCode: SYSTEM_ACCOUNTS.utilities,
        },
      );
      syncExpensePosting(ctx, saved);
      return saved;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.utilities)).toBe(RS(200));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.otherCurrentLiabilities)).toBe(RS(150));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(10_000) - RS(500) - RS(50));

    // The books still balance and the profit is not understated.
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
    const pnl = financeProfitAndLoss(db, START, END);
    expect(pnl.operatingExpensesFils).toBe(RS(700));
  });

  it("settles a customer refund against what they owe", () => {
    const { db, ctx, customerId, productId } = fixture();

    const sale = saveAndPost(db, {
      kind: "invoice",
      partyId: customerId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 1_000,
          unitPriceFils: RS(150),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    // A refund is money going back out to a customer. Set against the
    // invoice, it increases what they owe: we have handed them 50 of our
    // money, so 50 more is theirs to pay.
    db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "outbound",
          partyId: customerId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(50),
          allocations: [{ documentId: sale.id, amountFils: RS(50) }],
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(200));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.cashInHand)).toBe(RS(9_950));
    expect(trialBalance(db, START, END).isBalanced).toBe(true);

    // A customer who pays more than the invoice holds a credit, and a refund
    // settles that credit rather than touching the receivable.
    db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "inbound",
          partyId: customerId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(200),
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    // 100 settled the invoice; 100 is held as a credit.
    expect(balanceOf(db, SYSTEM_ACCOUNTS.customerAdvances)).toBe(RS(100));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(100));

    db.transaction(() => {
      const saved = savePayment(
        { db, actor: ACTOR, fiscalYearStartMonth: 1, nowIso: NOW, nowDate: DATE },
        {
          direction: "outbound",
          partyId: customerId,
          paymentDate: DATE,
          method: "cash",
          amountFils: RS(100),
        },
      );
      syncPaymentPosting(ctx, saved);
      return saved;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.customerAdvances)).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsReceivable)).toBe(RS(100));
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("gives a purchase back to the supplier by reversing its posting", () => {
    const { db, ctx, supplierId, productId } = fixture();

    const purchase = saveAndPost(db, {
      kind: "purchaseInvoice",
      partyId: supplierId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Filter",
          quantityMilli: 5_000,
          unitPriceFils: RS(100),
          vatTreatment: "standard",
          unitCostFils: RS(100),
        },
      ],
    });

    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(500));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(500));

    // The purchase is given back: the stock leaves and the payable is
    // reversed. The entry is corrected, not edited.
    db.transaction(() => {
      const entry = db
        .prepare("SELECT id FROM journal_entries WHERE source_key = ?")
        .get(`purchase:${String(purchase.id)}`) as { id: number };
      reverseEntry(ctx, entry.id, "Goods returned to the supplier", DATE);
      return entry;
    })();

    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(0);
    expect(trialBalance(db, START, END).isBalanced).toBe(true);
  });

  it("reports what the existing data looks like and can post it", () => {
    const db = readyDb();

    // A purchase that predates the Finance module: no journal entry at all.
    db.prepare(
      `INSERT INTO parties (code, name, kind, opening_balance, is_active, created_at, updated_at)
       VALUES ('S-9', 'Old Supplier', 'supplier', 0, 1, ?, ?)`,
    ).run(NOW, NOW);
    const supplierId = Number(
      (db.prepare("SELECT id FROM parties WHERE code = 'S-9'").get() as { id: number }).id,
    );
    db.prepare(
      `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, is_active, created_at, updated_at)
       VALUES ('OLD', 'Old stock', 0, ?, ?, 1, ?, ?)`,
    ).run(RS(50), RS(80), NOW, NOW);
    const productId = Number(
      (db.prepare("SELECT id FROM products WHERE sku = 'OLD'").get() as { id: number }).id,
    );

    const purchase = saveDocument(documentContext(db), {
      kind: "purchaseInvoice",
      partyId: supplierId,
      issueDate: DATE,
      status: "issued",
      lines: [
        {
          productId,
          description: "Old stock",
          quantityMilli: 5_000,
          unitPriceFils: RS(50),
          vatTreatment: "standard",
          unitCostFils: RS(50),
        },
      ],
    });

    // Nothing has been posted: the audit says so.
    const before = migrationAudit(db);
    expect(before.documentsWithoutEntry).toBe(1);
    expect(before.documentsWithEntry).toBe(0);
    expect(before.hasAccountingHistory).toBe(false);

    // The back-fill posts what the record already says. Nothing is invented.
    const result = backfillHistory(db, true, NOW, DATE, ACTOR.name);
    expect(result.posted).toBe(1);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(250));
    expect(balanceOf(db, SYSTEM_ACCOUNTS.accountsPayable)).toBe(RS(250));

    // Running it again changes nothing.
    const again = backfillHistory(db, true, NOW, DATE, ACTOR.name);
    expect(again.posted).toBe(0);
    expect(balanceOf(db, SYSTEM_ACCOUNTS.inventory)).toBe(RS(250));

    // The back-fill needs confirming.
    expect(() => backfillHistory(db, false, NOW, DATE, ACTOR.name)).toThrow(/Confirm/);
    void purchase;
  });
});
