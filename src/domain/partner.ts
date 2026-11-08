/**
 * Partnership accounting.
 *
 * The business is a two-partner firm sharing profit 49/49 with a 2% donation.
 * All three percentages are percentages of the same base - the net profit - and
 * they add up to exactly 100%, so the donation and the two partner shares
 * together account for every rupee of profit and no more.
 *
 * All amounts are fils; rounding residue is distributed by `allocateFils` so
 * the closing statement always balances to the penny with no unassigned fils.
 */

import { type Fils, assertFils, allocateFils, roundFils, sumFils } from "./money";

export const DONATION_RATE_PERCENT = 2;

/** Guard so a hand-edited setting cannot make the split meaningless. */
export function normaliseDonationRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 50) return DONATION_RATE_PERCENT;
  return Math.round(value * 10_000) / 10_000;
}

export interface PartnerAccount {
  readonly id: string;
  readonly name: string;
  /**
   * The partner's share of the net profit, as a percentage.
   *
   * This is an absolute percentage, not a weight: a partner with 49% gets 49%
   * of the net profit, whatever the donation is. The donation and the partner
   * shares together must come to 100%.
   */
  readonly sharePercent: number;
}

export interface ClosingInputs {
  readonly revenueFils: Fils;
  readonly costOfGoodsFils: Fils;
  readonly operatingExpensesFils: Fils;
  readonly vatPayableFils: Fils;
}

export interface PartnerAllocation {
  readonly partnerId: string;
  readonly partnerName: string;
  readonly sharePercent: number;
  readonly grossProfitFils: Fils;
  readonly allocatedShareFils: Fils;
}

export interface ClosingStatement {
  readonly revenueFils: Fils;
  readonly costOfGoodsFils: Fils;
  readonly grossProfitFils: Fils;
  readonly operatingExpensesFils: Fils;
  readonly netProfitFils: Fils;
  readonly donationRatePercent: number;
  readonly donationFils: Fils;
  readonly distributableProfitFils: Fils;
  /** The partners' shares added together, as a percentage of the net profit. */
  readonly totalSharePercent: number;
  readonly allocations: readonly PartnerAllocation[];
  /** Sum of allocations. Asserted to equal distributable profit. */
  readonly totalAllocatedFils: Fils;
}

function requireNonNegativeNet(value: Fils, label: string): void {
  if (value < 0) {
    throw new RangeError(
      `${label} must not be negative (received ${value} fils). ` +
        `A trading loss cannot be split as a profit distribution; handle it as a carried-forward loss.`,
    );
  }
}

/**
 * Build a period-closing statement: net profit, donation, then partner split.
 *
 * The donation and the partner shares are percentages of the same base - the
 * net profit - and they must add up to exactly 100%. A 2% donation with two
 * partners at 49% each is the arrangement this business agreed: Rs 100,000 of
 * profit is Rs 2,000 to the donation, Rs 49,000 to each partner, and nothing
 * left over.
 *
 * The shares are checked before anything is allocated, so a configuration that
 * would hand out more than the profit, or less of it, is refused rather than
 * quietly producing a wrong statement.
 */
export function buildClosingStatement(
  inputs: ClosingInputs,
  partners: readonly PartnerAccount[],
  donationRatePercent: number = DONATION_RATE_PERCENT,
): ClosingStatement {
  assertFils(inputs.revenueFils, "revenueFils");
  assertFils(inputs.costOfGoodsFils, "costOfGoodsFils");
  assertFils(inputs.operatingExpensesFils, "operatingExpensesFils");
  assertFils(inputs.vatPayableFils, "vatPayableFils");

  if (partners.length === 0) {
    throw new RangeError("At least one partner is required to close a period");
  }

  const grossProfitFils = inputs.revenueFils - inputs.costOfGoodsFils;

  if (grossProfitFils < 0) {
    throw new RangeError(
      `Gross profit is negative (${grossProfitFils} fils); a closing statement cannot be produced for a loss period.`,
    );
  }

  const netProfitFils = grossProfitFils - inputs.operatingExpensesFils - inputs.vatPayableFils;
  requireNonNegativeNet(netProfitFils, "Net profit");

  const appliedDonationRate = normaliseDonationRate(donationRatePercent);

  const weights = partners.map((partner) => {
    if (!Number.isFinite(partner.sharePercent) || partner.sharePercent <= 0) {
      throw new RangeError(
        `Partner ${partner.name} must have a positive share percentage, received ${String(partner.sharePercent)}`,
      );
    }
    return partner.sharePercent;
  });

  const totalSharePercent = weights.reduce((sum, weight) => sum + weight, 0);
  const totalPercent = appliedDonationRate + totalSharePercent;

  // The three shares are percentages of the same net profit, so they have to
  // come to 100 between them. Anything else either hands out more than the
  // profit or leaves some of it unaccounted for.
  if (Math.abs(totalPercent - 100) > 0.0001) {
    const shares = partners
      .map((partner) => `${partner.name} ${String(partner.sharePercent)}%`)
      .join(", ");
    throw new RangeError(
      `The donation (${String(appliedDonationRate)}%) and the partner shares (${shares}) must add up to 100% ` +
        `(they add up to ${String(Math.round(totalPercent * 10_000) / 10_000)}%).`,
    );
  }

  const donationFils = roundFils((netProfitFils * appliedDonationRate) / 100);
  const distributableProfitFils = netProfitFils - donationFils;

  // The weights are the partners' absolute shares, and they come to
  // 100 - the donation - so dividing the distributable profit between them by
  // those weights gives each partner their share of the *net* profit.
  const shares = allocateFils(distributableProfitFils, weights);

  const allocations: PartnerAllocation[] = partners.map((partner, index) => ({
    partnerId: partner.id,
    partnerName: partner.name,
    sharePercent: partner.sharePercent,
    grossProfitFils: netProfitFils,
    allocatedShareFils: shares[index] ?? 0,
  }));

  const totalAllocatedFils = sumFils(
    allocations.map((allocation) => allocation.allocatedShareFils),
  );

  if (totalAllocatedFils !== distributableProfitFils) {
    throw new Error(
      `Internal error: allocations total ${totalAllocatedFils} but distributable profit is ${distributableProfitFils}`,
    );
  }

  return {
    revenueFils: inputs.revenueFils,
    costOfGoodsFils: inputs.costOfGoodsFils,
    grossProfitFils,
    operatingExpensesFils: inputs.operatingExpensesFils,
    netProfitFils,
    donationRatePercent: appliedDonationRate,
    donationFils,
    distributableProfitFils,
    totalSharePercent,
    allocations,
    totalAllocatedFils,
  };
}

export interface PartnerCapitalAccount {
  readonly partnerId: string;
  readonly partnerName: string;
  readonly openingBalanceFils: Fils;
  readonly capitalIntroducedFils: Fils;
  readonly drawingsFils: Fils;
  readonly closingBalanceFils: Fils;
}

/**
 * Capital account per partner.
 *
 * Closing balance = opening + capital introduced + allocated profit
 * - drawings - donations charged to the partner.
 *
 * `donationsPaidByPartner` holds the donation each partner paid personally, for
 * shops where a partner advances the donation in their own name and it is
 * settled from their capital account. Omit it (or pass an empty map) when the
 * firm bears the donation centrally.
 *
 * This is a per-partner map rather than a single amount because charging one
 * total to every partner would multiply the donation by the partner count.
 */
export function computeCapitalAccounts(
  partners: readonly PartnerAccount[],
  openingBalances: ReadonlyMap<string, Fils>,
  capitalIntroduced: ReadonlyMap<string, Fils>,
  drawings: ReadonlyMap<string, Fils>,
  allocations: readonly PartnerAllocation[],
  donationsPaidByPartner: ReadonlyMap<string, Fils> = new Map(),
): PartnerCapitalAccount[] {
  const allocationById = new Map(
    allocations.map((allocation) => [allocation.partnerId, allocation.allocatedShareFils]),
  );

  return partners.map((partner) => {
    const opening = openingBalances.get(partner.id) ?? 0;
    const introduced = capitalIntroduced.get(partner.id) ?? 0;
    const drawn = drawings.get(partner.id) ?? 0;
    const share = allocationById.get(partner.id) ?? 0;
    const donationPaid = donationsPaidByPartner.get(partner.id) ?? 0;

    assertFils(opening, `openingBalance for ${partner.name}`);
    assertFils(introduced, `capitalIntroduced for ${partner.name}`);
    assertFils(drawn, `drawings for ${partner.name}`);
    assertFils(donationPaid, `donationPaid for ${partner.name}`);

    return {
      partnerId: partner.id,
      partnerName: partner.name,
      openingBalanceFils: opening,
      capitalIntroducedFils: introduced,
      drawingsFils: drawn,
      closingBalanceFils: opening + introduced + share - drawn - donationPaid,
    };
  });
}

export interface SettlementCheck {
  readonly balanced: boolean;
  readonly totalCapitalFils: Fils;
  readonly totalAllocatedFils: Fils;
  readonly totalDrawingsFils: Fils;
  readonly totalDonationFils: Fils;
}

/**
 * Sanity check for a closed period: allocated profit must exactly fund the
 * donation plus the capital accounts, with no fils unaccounted for.
 */
export function verifyClosingBalances(
  statement: ClosingStatement,
  accounts: readonly PartnerCapitalAccount[],
): SettlementCheck {
  const totalCapitalFils = sumFils(
    accounts.map((account) => account.openingBalanceFils + account.capitalIntroducedFils),
  );
  const totalAllocatedFils = sumFils(accounts.map((account) => account.closingBalanceFils));
  const totalDrawingsFils = sumFils(accounts.map((account) => account.drawingsFils));
  const totalDonationFils = statement.donationFils;

  const balanced =
    totalAllocatedFils + totalDrawingsFils + totalDonationFils ===
    statement.netProfitFils + totalCapitalFils;

  return { balanced, totalCapitalFils, totalAllocatedFils, totalDrawingsFils, totalDonationFils };
}
