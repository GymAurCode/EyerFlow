/**
 * Turning business transactions into journal entries.
 *
 * This is the only place that knows what a sale, a purchase, a payment or an
 * expense means to the ledger. Every screen that causes money to move goes
 * through here, so the accounting treatment of "a sale" is written down once
 * rather than once per screen.
 *
 * Each function is a pure mapping from an already-saved business record to a
 * balanced entry. It reads the amounts the repository stored rather than
 * recomputing them, so a posting can never disagree with the invoice it came
 * from. The repositories call these inside their own transaction, so the
 * business write and its posting succeed or roll back together.
 *
 * The four treatments worth stating outright, because they are the ones that are
 * easy to get wrong:
 *
 *  - Revenue is the invoice **net** of VAT; the VAT is a liability, not income.
 *    A sale of 50,000 + 5% VAT debits the customer 52,500 and credits revenue
 *    50,000 and tax payable 2,500.
 *  - Revenue is **not** cash received. A credit sale posts a receivable; only
 *    the receipt that later settles it moves cash. That is the whole reason
 *    "sales revenue" and "money in the bank" are different accounts.
 *  - A document never moves cash. The app writes a real payment row for money
 *    taken on the spot, and that payment owns the cash movement. If the sale
 *    also debited cash, the money would be counted twice.
 *  - A purchase never settles itself. The purchase raises the payable; the
 *    payment lowers it. Collapsing the two would make the payable vanish the
 *    moment the invoice was saved.
 *
 * VAT treatment on purchases: the chart has no dedicated input-tax account, so
 * recoverable purchase VAT is held in Prepaid Expenses (1040) until it is
 * claimed. This is a documented choice, not an accident, and it is the only
 * place the chart had to be interpreted.
 *
 * Each posting goes through `sync.ts`, so posting the same record twice
 * changes nothing and editing a record corrects its posting with a reversal
 * rather than rewriting it.
 */

import type { SqliteDatabase } from "../../data/connection";
import type { Fils } from "../../domain/money";
import type { DocumentDto, ExpenseDto, PaymentDto } from "../../shared/types";
import type { PaymentPostingKind } from "../../shared/finance";
import { SYSTEM_ACCOUNTS } from "./chart";
import type { JournalLine, PostContext } from "./posting";
import { syncEntry, type EntrySpec } from "./sync";

/** Which asset account money physically sits in. */
export type CashAccountCode =
  | typeof SYSTEM_ACCOUNTS.cashInHand
  | typeof SYSTEM_ACCOUNTS.bank;

export function cashAccountFor(method: string): CashAccountCode {
  // "card" and "online" settle through the bank; only physical cash is 1000.
  return method === "cash" ? SYSTEM_ACCOUNTS.cashInHand : SYSTEM_ACCOUNTS.bank;
}

/** Which side of the ledger a party id sits on. */
export type PartyKind = "customer" | "supplier";

export function partyKindOf(db: SqliteDatabase, partyId: number): PartyKind {
  const row = db.prepare("SELECT kind FROM parties WHERE id = ?").get(partyId) as
    | { kind: string }
    | undefined;
  if (row === undefined) return "customer";
  return row.kind === "supplier" ? "supplier" : "customer";
}

export interface MappingContext extends PostContext {
  /** Shown on the entry, e.g. "INV-0007". */
  readonly reference: string | undefined;
  /**
   * Which side of the ledger a party id is on. Passed in rather than looked up
   * here so this module stays free of the parties repository and the wording of
   * an entry does not depend on how parties are stored.
   */
  partyKind(partyId: number): PartyKind;
}

/* -------------------------------------------------------------------------- */
/* sales                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A sale's postings.
 *
 * The revenue posting is the invoice: what the customer is charged, debited to
 * the receivable in full. The payment that settles it credits the receivable
 * again, and it is the payment that moves the cash - the app writes a real
 * payment row for money taken on the spot, so a sale that also debited cash
 * would count that money twice.
 *
 * A sale with no customer is a cash sale: the whole amount is the cash leg and
 * no receivable is raised, because there is nobody to owe it. The app stores an
 * anonymous sale the same way - no payment row, nothing outstanding.
 *
 * The cost posting is the stock that left the shelf, relieved from inventory at
 * the cost that was recorded on the line.
 */
export function saleEntrySpecs(
  document: DocumentDto,
  cashAccount: CashAccountCode,
): readonly EntrySpec[] {
  const grossFils: Fils = document.grossFils;
  const netFils: Fils = document.netFils;
  const vatFils: Fils = document.vatFils;
  const isAnonymous = document.partyId === null || document.partyId === undefined;

  if (grossFils <= 0) return [];

  const revenueLines: EntrySpec["lines"][number][] = [
    isAnonymous
      ? {
          accountCode: cashAccount,
          debitFils: grossFils,
          description: "Sale with no customer on the account",
          documentId: document.id,
        }
      : {
          accountCode: SYSTEM_ACCOUNTS.accountsReceivable,
          debitFils: grossFils,
          description: "Invoiced",
          partyId: document.partyId ?? undefined,
          documentId: document.id,
        },
    {
      accountCode: SYSTEM_ACCOUNTS.salesRevenue,
      creditFils: netFils,
      description: document.number,
      documentId: document.id,
    },
  ];
  if (vatFils > 0) {
    revenueLines.push({
      accountCode: SYSTEM_ACCOUNTS.taxPayable,
      creditFils: vatFils,
      description: "VAT charged on the sale",
      documentId: document.id,
    });
  }

  const specs: EntrySpec[] = [
    {
      baseKey: `sale:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Sale ${document.number}`,
      source: "sale",
      lines: revenueLines,
    },
  ];

  // Cost of goods: what the stock actually cost, relieved from inventory.
  if (document.costFils > 0) {
    specs.push({
      baseKey: `sale-cogs:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Cost of goods sold ${document.number}`,
      source: "sale",
      lines: [
        {
          accountCode: SYSTEM_ACCOUNTS.costOfGoodsSold,
          debitFils: document.costFils,
          description: document.number,
          documentId: document.id,
        },
        {
          accountCode: SYSTEM_ACCOUNTS.inventory,
          creditFils: document.costFils,
          description: "Stock issued",
          documentId: document.id,
        },
      ],
    });
  }

  return specs;
}

/** Post a sale. Idempotent: posting the same sale twice leaves one entry. */
export function postSale(
  context: MappingContext,
  document: DocumentDto,
  cashAccount: CashAccountCode,
): void {
  for (const spec of saleEntrySpecs(document, cashAccount)) {
    syncEntry(context, spec);
  }
}

/* -------------------------------------------------------------------------- */
/* purchases                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A purchase capitalises stock and owes the supplier.
 *
 * Payment is deliberately *not* folded in here. A purchase and a payment are two
 * separate events with two separate dates, and the payment has its own posting
 * that reduces the payable. Collapsing them would make the payable disappear the
 * moment the invoice was saved, which is exactly the double-count the ledger
 * exists to prevent.
 *
 * A purchase with no supplier has no one to owe, so it is credited to Other
 * Current Liabilities - a payable to somebody not yet named, rather than a sale
 * in disguise.
 */
export function purchaseEntrySpecs(document: DocumentDto): readonly EntrySpec[] {
  const netFils: Fils = document.netFils;
  const vatFils: Fils = document.vatFils;
  const grossFils: Fils = document.grossFils;
  const hasParty = document.partyId !== null && document.partyId !== undefined;

  if (grossFils <= 0) return [];

  const lines: EntrySpec["lines"][number][] = [
    {
      accountCode: SYSTEM_ACCOUNTS.inventory,
      debitFils: netFils,
      description: `Stock purchased ${document.number}`,
      documentId: document.id,
    },
  ];

  if (vatFils > 0) {
    lines.push({
      accountCode: SYSTEM_ACCOUNTS.prepaidExpenses,
      debitFils: vatFils,
      description: "Recoverable VAT on purchases",
      documentId: document.id,
    });
  }

  lines.push({
    accountCode: hasParty
      ? SYSTEM_ACCOUNTS.accountsPayable
      : SYSTEM_ACCOUNTS.otherCurrentLiabilities,
    creditFils: grossFils,
    description: document.number,
    partyId: document.partyId ?? undefined,
    documentId: document.id,
  });

  return [
    {
      baseKey: `purchase:${String(document.id)}`,
      entryDate: document.issueDate,
      description: `Purchase ${document.number}`,
      source: "purchase",
      lines,
    },
  ];
}

/** Post a purchase. */
export function postPurchase(context: MappingContext, document: DocumentDto): void {
  for (const spec of purchaseEntrySpecs(document)) {
    syncEntry(context, spec);
  }
}

/* -------------------------------------------------------------------------- */
/* payments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Money moving in or out of a cash or bank account.
 *
 * Which control account it settles is decided by the party, not by the
 * direction: a customer paying us reduces what they owe, a supplier being paid
 * reduces what we owe. A supplier sending money back is a refund rather than a
 * receipt, and a customer being refunded is an advance rather than a payment -
 * neither belongs on the receivable or the payable.
 *
 * The optional `options` cover the cases that are not simply "settle the
 * invoice": money paid before there is an invoice is an advance, the owner's
 * own money in or out is not a sale, and a payment method is not an account, so
 * the cash or bank ledger can be named explicitly.
 */
export interface PaymentPostingOptions {
  /** What the money settles, when it is not simply the party's invoice. */
  readonly kind?: PaymentPostingKind | undefined;
  /** Which cash or bank ledger the money lands in. */
  readonly cashAccountCode?: string | undefined;
  /**
   * How much of the payment was set against an invoice. The rest is money paid
   * or received ahead of one, and is held as an advance.
   */
  readonly allocatedFils?: number | undefined;
  /** The account an expense-type payment is charged to. */
  readonly expenseAccountCode?: string | undefined;
}

export function paymentEntrySpecs(
  payment: PaymentDto,
  kind: PartyKind,
  options: PaymentPostingOptions = {},
): readonly EntrySpec[] {
  const cashAccount = options.cashAccountCode ?? cashAccountFor(payment.method);
  const amountFils: Fils = payment.amountFils;
  const postingKind = options.kind ?? "auto";

  if (amountFils <= 0) return [];

  const partyId = payment.partyId;
  const settled = Math.min(options.allocatedFils ?? amountFils, amountFils);
  const advance = amountFils - settled;

  // The explicit kinds: money that is not settling a party balance at all.
  if (postingKind !== "auto") {
    const lines: EntrySpec["lines"][number][] =
      postingKind === "customerAdvance"
        ? [
            { accountCode: cashAccount, debitFils: amountFils, partyId },
            { accountCode: SYSTEM_ACCOUNTS.customerAdvances, creditFils: amountFils, partyId },
          ]
        : postingKind === "supplierAdvance"
          ? [
              { accountCode: SYSTEM_ACCOUNTS.supplierAdvances, debitFils: amountFils, partyId },
              { accountCode: cashAccount, creditFils: amountFils, partyId },
            ]
          : postingKind === "expense"
            ? [
                {
                  accountCode:
                    options.expenseAccountCode ?? SYSTEM_ACCOUNTS.miscellaneous,
                  debitFils: amountFils,
                  partyId,
                },
                { accountCode: cashAccount, creditFils: amountFils, partyId },
              ]
            : postingKind === "ownerDrawing"
              ? [
                  { accountCode: SYSTEM_ACCOUNTS.drawings, debitFils: amountFils },
                  { accountCode: cashAccount, creditFils: amountFils },
                ]
              : postingKind === "ownerContribution"
                ? [
                    { accountCode: cashAccount, debitFils: amountFils },
                    { accountCode: SYSTEM_ACCOUNTS.capital, creditFils: amountFils },
                  ]
                : postingKind === "fixedAsset"
                  ? [
                      { accountCode: SYSTEM_ACCOUNTS.equipment, debitFils: amountFils },
                      { accountCode: cashAccount, creditFils: amountFils },
                    ]
                  : postingKind === "otherIncome"
                    ? [
                        { accountCode: cashAccount, debitFils: amountFils },
                        { accountCode: SYSTEM_ACCOUNTS.otherIncome, creditFils: amountFils },
                      ]
                    : [
                        {
                          accountCode: SYSTEM_ACCOUNTS.otherOperatingExpenses,
                          debitFils: amountFils,
                        },
                        { accountCode: cashAccount, creditFils: amountFils },
                      ];

    return [
      {
        baseKey: `payment:${String(payment.id)}`,
        entryDate: payment.paymentDate,
        description: describePayment(postingKind, kind),
        source: "payment",
        lines,
      },
    ];
  }

  if (payment.direction === "inbound") {
    const creditAccount =
      kind === "customer" ? SYSTEM_ACCOUNTS.accountsReceivable : SYSTEM_ACCOUNTS.otherIncome;
    const advanceAccount =
      kind === "customer" ? SYSTEM_ACCOUNTS.customerAdvances : SYSTEM_ACCOUNTS.supplierAdvances;

    const lines: EntrySpec["lines"][number][] = [
      {
        accountCode: cashAccount,
        debitFils: amountFils,
        description: payment.reference ?? "Receipt",
        partyId,
      },
    ];
    if (settled > 0) {
      lines.push({
        accountCode: creditAccount,
        creditFils: settled,
        description:
          kind === "customer"
            ? "Settles what the customer owed"
            : "Money returned to us by a supplier",
        partyId,
      });
    }
    if (advance > 0) {
      lines.push({
        accountCode: advanceAccount,
        creditFils: advance,
        description: "Received ahead of an invoice",
        partyId,
      });
    }

    return [
      {
        baseKey: `payment:${String(payment.id)}`,
        entryDate: payment.paymentDate,
        description:
          kind === "customer" ? "Receipt from customer" : "Refund received from supplier",
        source: "payment",
        lines,
      },
    ];
  }

  // Money going out.
  //
  // The part set against an invoice settles that invoice: paying a supplier
  // reduces what we owe, and paying a customer increases what they owe. The
  // part that is not set against anything is money going back out of a
  // credit the party already holds, and it settles that credit.
  const debitAccount =
    kind === "supplier" ? SYSTEM_ACCOUNTS.accountsPayable : SYSTEM_ACCOUNTS.accountsReceivable;
  const advanceAccount =
    kind === "supplier" ? SYSTEM_ACCOUNTS.supplierAdvances : SYSTEM_ACCOUNTS.customerAdvances;

  const lines: EntrySpec["lines"][number][] = [];
  if (settled > 0) {
    lines.push({
      accountCode: debitAccount,
      debitFils: settled,
      description:
        kind === "supplier" ? "Settles what we owed" : "Money given back to a customer",
      partyId,
    });
  }
  if (advance > 0) {
    lines.push({
      accountCode: advanceAccount,
      debitFils: advance,
      description:
        kind === "supplier"
          ? "Paid ahead of an invoice"
          : "Refunds a credit the customer already held",
      partyId,
    });
  }
  lines.push({
    accountCode: cashAccount,
    creditFils: amountFils,
    description: payment.reference ?? "Payment",
    partyId,
  });

  return [
    {
      baseKey: `payment:${String(payment.id)}`,
      entryDate: payment.paymentDate,
      description: kind === "supplier" ? "Payment to supplier" : "Refund to customer",
      source: "payment",
      lines,
    },
  ];
}

function describePayment(postingKind: PaymentPostingKind, kind: PartyKind): string {
  switch (postingKind) {
    case "customerAdvance":
      return "Advance received from a customer";
    case "supplierAdvance":
      return "Advance paid to a supplier";
    case "expense":
      return "Expense paid";
    case "ownerDrawing":
      return "Owner's drawings";
    case "ownerContribution":
      return "Capital contributed by the owner";
    case "fixedAsset":
      return "Fixed asset purchased";
    case "otherIncome":
      return "Other income received";
    case "otherExpense":
      return "Other expense paid";
    default:
      return kind === "supplier" ? "Payment to supplier" : "Receipt from customer";
  }
}

/** Post a payment. */
export function postPayment(context: MappingContext, payment: PaymentDto): void {
  if (payment.partyId === undefined || payment.partyId === null) {
    throw new Error(
      "This payment has no customer or supplier attached, so there is no account to settle. Choose who it is from.",
    );
  }
  const kind = context.partyKind(payment.partyId);
  for (const spec of paymentEntrySpecs(payment, kind)) {
    syncEntry(context, spec);
  }
}

/* -------------------------------------------------------------------------- */
/* expenses                                                                    */
/* -------------------------------------------------------------------------- */

/** Existing expense categories mapped onto the chart. */
const EXPENSE_CATEGORY_TO_ACCOUNT: Readonly<Record<string, string>> = {
  rent: SYSTEM_ACCOUNTS.rent,
  utilities: SYSTEM_ACCOUNTS.utilities,
  salaries: SYSTEM_ACCOUNTS.salaries,
  transport: SYSTEM_ACCOUNTS.transport,
  marketing: SYSTEM_ACCOUNTS.marketing,
  repairs: SYSTEM_ACCOUNTS.repairs,
  office: SYSTEM_ACCOUNTS.officeSupplies,
  bank: SYSTEM_ACCOUNTS.bankCharges,
  depreciation: SYSTEM_ACCOUNTS.depreciation,
  general: SYSTEM_ACCOUNTS.miscellaneous,
};

export function expenseAccountFor(category: string): string {
  return EXPENSE_CATEGORY_TO_ACCOUNT[category.toLowerCase()] ?? SYSTEM_ACCOUNTS.miscellaneous;
}

/**
 * The account an expense is charged to.
 *
 * An expense that names an account of its own uses it. The category is only
 * the fallback, used for expenses recorded before the Chart of Accounts was
 * linked to the expense form.
 */
export function expenseAccountForRecord(expense: ExpenseDto): string {
  const explicit = (expense as { accountCode?: string | null }).accountCode;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return expenseAccountFor(expense.category);
}

/**
 * An expense is an expense account on one side and money on the other.
 *
 * The word "expense" is the trap: a payment for stock is not one, and neither
 * is a loan repayment or a drawing. Those arrive here only if they were
 * recorded as an expense, and by then the choice was made at the form.
 *
 * An expense that has not been paid in full debits the expense account for
 * the whole amount and credits a liability for the unpaid part, so the profit
 * is not understated by an expense that is still owed.
 */
export function expenseEntrySpecs(expense: ExpenseDto): readonly EntrySpec[] {
  const accountCode = expenseAccountForRecord(expense);
  const cashAccount = cashAccountFor(expense.paymentMethod);
  const amountFils: Fils = expense.amountFils;
  const paidFils = (expense as { paidFils?: number }).paidFils ?? amountFils;
  const unpaidFils = Math.max(0, amountFils - paidFils);

  if (amountFils <= 0) return [];

  const lines: EntrySpec["lines"][number][] = [
    {
      accountCode,
      debitFils: amountFils,
      description: expense.description,
    },
  ];
  if (expense.vatFils > 0) {
    lines.push({
      accountCode: SYSTEM_ACCOUNTS.prepaidExpenses,
      debitFils: expense.vatFils,
      description: "Recoverable VAT on the expense",
    });
  }
  if (paidFils > 0) {
    lines.push({
      accountCode: cashAccount,
      creditFils: paidFils,
      description: expense.reference ?? expense.paymentMethod,
    });
  }
  if (unpaidFils > 0) {
    lines.push({
      accountCode: SYSTEM_ACCOUNTS.otherCurrentLiabilities,
      creditFils: unpaidFils,
      description: "Expense not yet paid",
    });
  }

  return [
    {
      baseKey: `expense:${String(expense.id)}`,
      entryDate: expense.expenseDate,
      description: `Expense: ${expense.description}`,
      source: "expense",
      lines,
    },
  ];
}

/** Post an expense. */
export function postExpense(context: MappingContext, expense: ExpenseDto): void {
  for (const spec of expenseEntrySpecs(expense)) {
    syncEntry(context, spec);
  }
}

/* -------------------------------------------------------------------------- */
/* opening balances and transfers                                              */
/* -------------------------------------------------------------------------- */

/**
 * One opening posting: what the books start with.
 *
 * Balances are taken by account code rather than as a single figure, because
 * the trial balance is only balanced when the caller's numbers are, and that
 * should be checked here rather than discovered on the first report.
 */
export function openingEntrySpec(
  entryDate: string,
  balances: readonly {
    readonly accountCode: string;
    readonly debitFils: Fils;
    readonly creditFils: Fils;
  }[],
): EntrySpec {
  const lines: EntrySpec["lines"][number][] = balances
    .filter((line) => (line.debitFils ?? 0) > 0 || (line.creditFils ?? 0) > 0)
    .map((line) => ({
      accountCode: line.accountCode,
      ...(line.debitFils > 0
        ? { debitFils: line.debitFils }
        : { creditFils: line.creditFils }),
      description: "Opening balance",
    }));

  return {
    baseKey: `opening:${entryDate}`,
    entryDate,
    description: "Opening balances",
    source: "opening",
    lines,
  };
}

/**
 * Post the opening balances of the books.
 *
 * The entry must balance before it is written: an unbalanced opening balance
 * would make every later report wrong in a way that is very hard to trace
 * back, so it is refused here rather than at the first trial balance.
 */
export function postOpeningBalance(
  context: MappingContext,
  entryDate: string,
  balances: readonly {
    readonly accountCode: string;
    readonly debitFils: Fils;
    readonly creditFils: Fils;
  }[],
): void {
  const spec = openingEntrySpec(entryDate, balances);
  if (spec.lines.length < 2) {
    throw new Error("An opening balance needs at least one debit and one credit.");
  }
  syncEntry(context, spec);
}

/**
 * Cash to bank, or bank to cash.
 *
 * Never income and never an expense: both sides are assets, so the entry moves
 * money between them and the profit and loss statement is untouched.
 */
export function transferEntrySpec(
  entryDate: string,
  reference: string | undefined,
  from: CashAccountCode,
  to: CashAccountCode,
  amountFils: Fils,
): EntrySpec {
  return {
    baseKey: `transfer:${entryDate}:${from}:${to}:${String(amountFils)}`,
    entryDate,
    description: `Transfer ${from} to ${to}`,
    source: "transfer",
    lines: [
      { accountCode: to, debitFils: amountFils, description: reference ?? "Transfer in" },
      { accountCode: from, creditFils: amountFils, description: reference ?? "Transfer out" },
    ],
  };
}

export type { JournalLine };
