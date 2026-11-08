import { describe, expect, it } from "vitest";
import {
  DONATION_RATE_PERCENT,
  buildClosingStatement,
  computeCapitalAccounts,
  normaliseDonationRate,
  verifyClosingBalances,
  type PartnerAccount,
} from "../src/domain/partner";
import { toFils } from "../src/domain/money";

const twoPartners: readonly PartnerAccount[] = [
  { id: "p1", name: "Rashid", sharePercent: 49 },
  { id: "p2", name: "Sayed", sharePercent: 49 },
];

function emptyMaps(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id) => [id, 0]));
}

describe("partnership closing (49/49 with 2% donation)", () => {
  it("is the documented rate", () => {
    expect(DONATION_RATE_PERCENT).toBe(2);
  });

  it("computes net profit, donation and the 49/49 split", () => {
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(100_000),
        costOfGoodsFils: toFils(60_000),
        operatingExpensesFils: toFils(10_000),
        vatPayableFils: 0,
      },
      twoPartners,
    );

    expect(statement.grossProfitFils).toBe(toFils(40_000));
    expect(statement.netProfitFils).toBe(toFils(30_000));
    expect(statement.donationFils).toBe(toFils(600));
    expect(statement.distributableProfitFils).toBe(toFils(29_400));
    expect(statement.allocations.map((a) => a.allocatedShareFils)).toEqual([
      toFils(14_700),
      toFils(14_700),
    ]);
    expect(statement.totalAllocatedFils).toBe(statement.distributableProfitFils);
  });

  it("deducts VAT payable before splitting", () => {
    const withVat = buildClosingStatement(
      {
        revenueFils: toFils(100_000),
        costOfGoodsFils: toFils(60_000),
        operatingExpensesFils: 0,
        vatPayableFils: toFils(5_000),
      },
      twoPartners,
    );
    expect(withVat.netProfitFils).toBe(toFils(35_000));
    expect(withVat.distributableProfitFils).toBe(toFils(34_300));
  });

  it("allocates every fil when the profit does not divide evenly", () => {
    // Net profit of Rs 1000.03 -> 2% = 20.0006 -> 20.00; distributable 980.03
    // Split 49/49 = 490.015 each, which cannot be expressed in fils.
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(1010.03),
        costOfGoodsFils: 0,
        operatingExpensesFils: toFils(10),
        vatPayableFils: 0,
      },
      twoPartners,
    );

    const total = statement.allocations.reduce((sum, a) => sum + a.allocatedShareFils, 0);
    expect(total).toBe(statement.distributableProfitFils);
    expect(total).toBe(statement.netProfitFils - statement.donationFils);

    // One partner takes the extra fil and the other does not lose one: the
    // split stays within one fil of equal for an equal partnership.
    const first = statement.allocations[0]?.allocatedShareFils ?? 0;
    const second = statement.allocations[1]?.allocatedShareFils ?? 0;
    expect(Math.abs(first - second)).toBeLessThanOrEqual(1);
  });

  it("balances to the fil across many odd totals", () => {
    // Revenue must exceed expenses or the period is a loss, which cannot be
    // distributed; 1.00 of expenses against revenue from 1.01 upward.
    for (const revenue of [1.01, 1.11, 3.33, 17.77, 99.99, 1234.57, 88_888.89]) {
      const statement = buildClosingStatement(
        {
          revenueFils: toFils(revenue),
          costOfGoodsFils: 0,
          operatingExpensesFils: toFils(1),
          vatPayableFils: 0,
        },
        twoPartners,
      );
      const allocated = statement.allocations.reduce((sum, a) => sum + a.allocatedShareFils, 0);
      expect(allocated).toBe(statement.distributableProfitFils);
      expect(allocated + statement.donationFils).toBe(statement.netProfitFils);
    }
  });

  it("handles a zero-profit period without dividing by zero", () => {
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(100),
        costOfGoodsFils: toFils(100),
        operatingExpensesFils: 0,
        vatPayableFils: 0,
      },
      twoPartners,
    );
    expect(statement.netProfitFils).toBe(0);
    expect(statement.donationFils).toBe(0);
    expect(statement.allocations.every((a) => a.allocatedShareFils === 0)).toBe(true);
  });

  it("respects unequal shares", () => {
    // 60% and 38% of the net profit, with the remaining 2% donated.
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(100_000),
        costOfGoodsFils: 0,
        operatingExpensesFils: 0,
        vatPayableFils: 0,
      },
      [
        { id: "p1", name: "A", sharePercent: 60 },
        { id: "p2", name: "B", sharePercent: 38 },
      ],
    );
    expect(statement.distributableProfitFils).toBe(toFils(98_000));
    expect(statement.allocations[0]?.allocatedShareFils).toBe(toFils(60_000));
    expect(statement.allocations[1]?.allocatedShareFils).toBe(toFils(38_000));
  });

  it("refuses to produce a statement for a loss period", () => {
    // A loss must be carried forward, not distributed as a negative profit.
    expect(() =>
      buildClosingStatement(
        {
          revenueFils: toFils(1000),
          costOfGoodsFils: toFils(1200),
          operatingExpensesFils: 0,
          vatPayableFils: 0,
        },
        twoPartners,
      ),
    ).toThrow(/negative/i);
  });

  it("refuses to split a net loss", () => {
    expect(() =>
      buildClosingStatement(
        {
          revenueFils: toFils(1000),
          costOfGoodsFils: toFils(500),
          operatingExpensesFils: toFils(700),
          vatPayableFils: 0,
        },
        twoPartners,
      ),
    ).toThrow(/carried-forward loss/i);
  });

  it("requires at least one partner", () => {
    expect(() =>
      buildClosingStatement(
        { revenueFils: 1000, costOfGoodsFils: 0, operatingExpensesFils: 0, vatPayableFils: 0 },
        [],
      ),
    ).toThrow(RangeError);
  });

  it("rejects a non-positive partner share", () => {
    expect(() =>
      buildClosingStatement(
        { revenueFils: 1000, costOfGoodsFils: 0, operatingExpensesFils: 0, vatPayableFils: 0 },
        [{ id: "p1", name: "A", sharePercent: 0 }],
      ),
    ).toThrow(RangeError);
  });

  it("gives each partner 49% of the profit and the donation 2%", () => {
    // The arrangement this business agreed: 49 + 49 + 2 = 100 of the profit.
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(100_000),
        costOfGoodsFils: 0,
        operatingExpensesFils: 0,
        vatPayableFils: 0,
      },
      twoPartners,
    );

    expect(statement.netProfitFils).toBe(toFils(100_000));
    expect(statement.donationFils).toBe(toFils(2_000));
    expect(statement.allocations.map((a) => a.allocatedShareFils)).toEqual([
      toFils(49_000),
      toFils(49_000),
    ]);
    expect(statement.totalSharePercent).toBe(98);

    // Everything allocated comes back to the profit: nothing is left over and
    // nothing is allocated twice.
    expect(statement.donationFils + statement.totalAllocatedFils).toBe(statement.netProfitFils);
  });

  it("refuses a split whose percentages do not come to 100", () => {
    // 50 + 50 + 2 = 102: the two partners would be handed more than the
    // profit there is to hand out.
    expect(() =>
      buildClosingStatement(
        {
          revenueFils: toFils(100_000),
          costOfGoodsFils: 0,
          operatingExpensesFils: 0,
          vatPayableFils: 0,
        },
        [
          { id: "p1", name: "Rashid", sharePercent: 50 },
          { id: "p2", name: "Sayed", sharePercent: 50 },
        ],
      ),
    ).toThrow(/must add up to 100%/);

    // 49 + 49 + 2 = 100 leaves nothing over, but 49 + 49 on its own with no
    // donation would leave a percent unaccounted for.
    expect(() =>
      buildClosingStatement(
        {
          revenueFils: toFils(100_000),
          costOfGoodsFils: 0,
          operatingExpensesFils: 0,
          vatPayableFils: 0,
        },
        twoPartners,
        0,
      ),
    ).toThrow(/must add up to 100%/);
  });
});

describe("configurable donation rate", () => {
  const closingInputs = {
    revenueFils: toFils(100_000),
    costOfGoodsFils: toFils(60_000),
    operatingExpensesFils: toFils(10_000),
    vatPayableFils: 0,
  };

  it("keeps 2% when the setting is missing", () => {
    expect(normaliseDonationRate(Number.NaN)).toBe(DONATION_RATE_PERCENT);
    expect(normaliseDonationRate(-1)).toBe(DONATION_RATE_PERCENT);
    expect(normaliseDonationRate(51)).toBe(DONATION_RATE_PERCENT);
    expect(normaliseDonationRate(Number.POSITIVE_INFINITY)).toBe(DONATION_RATE_PERCENT);
  });

  it("accepts a configured rate and rounds it to four decimals", () => {
    expect(normaliseDonationRate(2.5)).toBe(2.5);
    expect(normaliseDonationRate(0)).toBe(0);
    expect(normaliseDonationRate(50)).toBe(50);
    expect(normaliseDonationRate(2.50001)).toBe(2.5);
  });

  it("takes the donation off the top before the partner split", () => {
    // A 5% donation leaves 95% for the partners: 47.5% each.
    const statement = buildClosingStatement(
      closingInputs,
      [
        { id: "p1", name: "Rashid", sharePercent: 47.5 },
        { id: "p2", name: "Sayed", sharePercent: 47.5 },
      ],
      5,
    );
    expect(statement.donationRatePercent).toBe(5);
    expect(statement.netProfitFils).toBe(toFils(30_000));
    expect(statement.donationFils).toBe(toFils(1_500));
    expect(statement.distributableProfitFils).toBe(toFils(28_500));
    expect(statement.allocations.map((a) => a.allocatedShareFils)).toEqual([
      toFils(14_250),
      toFils(14_250),
    ]);
    expect(statement.totalAllocatedFils).toBe(statement.distributableProfitFils);
  });

  it("still balances with no donation at all", () => {
    // With no donation the partners take the whole profit between them.
    const statement = buildClosingStatement(
      closingInputs,
      [
        { id: "p1", name: "Rashid", sharePercent: 50 },
        { id: "p2", name: "Sayed", sharePercent: 50 },
      ],
      0,
    );
    expect(statement.donationFils).toBe(0);
    expect(statement.distributableProfitFils).toBe(toFils(30_000));
    expect(statement.totalAllocatedFils).toBe(toFils(30_000));
  });

  it("falls back to 2% for an unusable configured rate", () => {
    const statement = buildClosingStatement(closingInputs, twoPartners, 250);
    expect(statement.donationRatePercent).toBe(DONATION_RATE_PERCENT);
    expect(statement.donationFils).toBe(toFils(600));
  });

  it("balances exactly across an uneven three-way split", () => {
    // 33% + 33% + 32% of the profit, with the remaining 2% donated.
    const partners: readonly PartnerAccount[] = [
      { id: "p1", name: "Rashid", sharePercent: 33 },
      { id: "p2", name: "Sayed", sharePercent: 33 },
      { id: "p3", name: "Third", sharePercent: 32 },
    ];
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(10_000),
        costOfGoodsFils: toFils(0),
        operatingExpensesFils: 0,
        vatPayableFils: 0,
      },
      partners,
    );
    expect(statement.totalAllocatedFils).toBe(statement.distributableProfitFils);
    expect(statement.allocations.reduce((s, a) => s + a.allocatedShareFils, 0)).toBe(
      statement.distributableProfitFils,
    );
  });

  it("balances for a single-fils net profit", () => {
    const statement = buildClosingStatement(
      { revenueFils: 1, costOfGoodsFils: 0, operatingExpensesFils: 0, vatPayableFils: 0 },
      twoPartners,
    );
    expect(statement.netProfitFils).toBe(1);
    expect(statement.totalAllocatedFils).toBe(statement.distributableProfitFils);
  });
});

describe("partner capital accounts", () => {
  const statement = buildClosingStatement(
    {
      revenueFils: toFils(100_000),
      costOfGoodsFils: toFils(60_000),
      operatingExpensesFils: toFils(10_000),
      vatPayableFils: 0,
    },
    twoPartners,
  );

  it("builds a closing balance per partner", () => {
    const accounts = computeCapitalAccounts(
      twoPartners,
      new Map([
        ["p1", toFils(200)],
        ["p2", toFils(300)],
      ]),
      new Map([
        ["p1", toFils(50)],
        ["p2", 0],
      ]),
      new Map([
        ["p1", toFils(20)],
        ["p2", toFils(40)],
      ]),
      statement.allocations,
    );

    // The period nets Rs 30,000, donates Rs 600, and shares Rs 14,700 each.
    // p1: 200.00 + 50.00 + 14,700.00 - 20.00 = 14,930.00 Rs
    expect(accounts[0]?.closingBalanceFils).toBe(toFils(14_930));
    // p2: 300.00 + 0 + 14,700.00 - 40.00 = 14,960.00 Rs
    expect(accounts[1]?.closingBalanceFils).toBe(toFils(14_960));
  });

  it("defaults missing entries to zero rather than NaN", () => {
    const accounts = computeCapitalAccounts(
      twoPartners,
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      statement.allocations,
    );
    expect(accounts[0]?.closingBalanceFils).toBe(toFils(14_700));
    expect(accounts.every((account) => Number.isFinite(account.closingBalanceFils))).toBe(true);
  });

  it("lets drawings drive a balance negative", () => {
    const accounts = computeCapitalAccounts(
      twoPartners,
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      new Map([
        ["p1", toFils(20_000)],
        ["p2", 0],
      ]),
      statement.allocations,
    );
    // A partner who takes more out than their profit share is overdrawn.
    expect(accounts[0]?.closingBalanceFils).toBeLessThan(0);
    expect(accounts[1]?.closingBalanceFils).toBeGreaterThan(0);
  });

  it("charges an advanced donation against the capital account", () => {
    // One partner pays the firm's Rs 600 donation personally.
    const accounts = computeCapitalAccounts(
      twoPartners,
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      statement.allocations,
      new Map([["p1", statement.donationFils]]),
    );

    // Only p1 is debited, so the total drops by exactly one donation.
    const total = accounts.reduce((sum, account) => sum + account.closingBalanceFils, 0);
    expect(total).toBe(statement.distributableProfitFils - statement.donationFils);
    expect(accounts[0]?.closingBalanceFils).toBe(toFils(14_700) - statement.donationFils);
    expect(accounts[1]?.closingBalanceFils).toBe(toFils(14_700));
  });

  it("leaves capital untouched when the firm bears the donation centrally", () => {
    const accounts = computeCapitalAccounts(
      twoPartners,
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      emptyMaps(["p1", "p2"]),
      statement.allocations,
    );
    const total = accounts.reduce((sum, account) => sum + account.closingBalanceFils, 0);
    expect(total).toBe(statement.distributableProfitFils);
  });
});

describe("verifyClosingBalances", () => {
  it("reports balanced when nothing is unaccounted for", () => {
    const statement = buildClosingStatement(
      {
        revenueFils: toFils(50_000),
        costOfGoodsFils: toFils(20_000),
        operatingExpensesFils: toFils(5000),
        vatPayableFils: 0,
      },
      twoPartners,
    );
    const accounts = computeCapitalAccounts(
      twoPartners,
      new Map([["p1", 0]]),
      new Map([["p2", 0]]),
      new Map([
        ["p1", 1000],
        ["p2", 2000],
      ]),
      statement.allocations,
    );

    const check = verifyClosingBalances(statement, accounts);
    expect(check.balanced).toBe(true);
  });
});
