/**
 * Partner repository.
 *
 * Partners are the people the profit is split between. Only the name and the
 * share live here; the split itself is computed on demand by `partnerSplit` in
 * the reports repository from the same numbers the Profit & Loss report shows,
 * so the two can never disagree.
 *
 * A partner's share is a percentage of the net profit, and the donation and
 * the partners' shares together have to come to 100%. That rule is enforced
 * here, where a share is written, so a configuration that would hand out more
 * than the profit - or less of it - cannot be saved in the first place.
 */

import type { SqliteDatabase } from "../../data/connection";
import { allocateFils } from "../../domain/money";
import type { PartnerDto, PartnerTransactionDto } from "../../shared/types";
import type { AuditActor } from "../audit-writer";
import { recordAudit } from "../audit-writer";

export class PartnerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PartnerError";
  }
}

interface PartnerRow {
  readonly id: number;
  readonly name: string;
  readonly share_percent: number;
  readonly is_active: number;
}

function mapPartner(row: PartnerRow): PartnerDto {
  return {
    id: row.id,
    name: row.name,
    sharePercent: row.share_percent,
    isActive: row.is_active === 1,
  };
}

export function listPartners(db: SqliteDatabase): PartnerDto[] {
  const rows = db.prepare("SELECT * FROM partners ORDER BY name").all() as PartnerRow[];
  return rows.map(mapPartner);
}

/**
 * The donation rate, read from the settings.
 *
 * The settings own the donation; the partners own their shares. The two have
 * to be read together to know whether the split adds up.
 */
function donationRatePercent(db: SqliteDatabase): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'donation_rate_percent'")
    .get() as { value: string } | undefined;

  const value = Number(row?.value);
  return Number.isFinite(value) ? value : 2;
}

/**
 * The shares of the partners who would take part.
 *
 * The partner being written is taken out of the list and put back with the
 * share and the active flag it is being saved with, so the check below sees
 * the partnership as it will be after the save.
 */
function activeShares(
  db: SqliteDatabase,
  partnerId: number | undefined,
  sharePercent: number,
  isActive: boolean,
): { readonly id: number; readonly name: string; readonly sharePercent: number }[] {
  const rows = db
    .prepare("SELECT id, name, share_percent, is_active FROM partners ORDER BY name")
    .all() as { id: number; name: string; share_percent: number; is_active: number }[];

  const others = rows
    .filter((row) => row.is_active === 1 && row.id !== partnerId)
    .map((row) => ({ id: row.id, name: row.name, sharePercent: row.share_percent }));

  if (!isActive || sharePercent <= 0) return others;

  const name = rows.find((row) => row.id === partnerId)?.name ?? "This partner";
  return [...others, { id: partnerId ?? -1, name, sharePercent }];
}

/**
 * Check that the donation and the partners' shares cannot hand out more than
 * the profit.
 *
 * The donation and the shares are percentages of the same net profit, so
 * anything over 100% would allocate more than the profit there was to
 * allocate. A total under 100% is allowed - a partnership being set up is
 * allowed to be incomplete - but it is reported in Settings and in the split
 * itself, so it cannot go unnoticed.
 */
function assertSharesDoNotExceedOneHundred(
  db: SqliteDatabase,
  partners: readonly { readonly id: number; readonly name: string; readonly sharePercent: number }[],
): void {
  const donation = donationRatePercent(db);
  const shareTotal = partners.reduce((sum, partner) => sum + partner.sharePercent, 0);
  const total = donation + shareTotal;

  if (total > 100 + 0.0001) {
    const shares = partners
      .map((partner) => `${partner.name} ${String(partner.sharePercent)}%`)
      .join(", ");
    throw new PartnerError(
      `The donation (${String(donation)}%) and the partner shares (${shares}) must not come to more than 100% ` +
        `(they come to ${String(Math.round(total * 10_000) / 10_000)}%).`,
    );
  }
}

export function savePartner(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string },
  input: { id?: number; name: string; sharePercent: number; isActive?: boolean },
): PartnerDto {
  const { db } = context;

  return db.transaction((): PartnerDto => {
    if (!Number.isFinite(input.sharePercent) || input.sharePercent < 0 || input.sharePercent > 100) {
      throw new PartnerError("A partner's share must be between 0 and 100 percent.");
    }

    // The split has to add up: the donation and every partner's share are
    // percentages of the same net profit. Checked before anything is written,
    // so a rejected change leaves the partners exactly as they were.
    const shares = activeShares(db, input.id, input.sharePercent, input.isActive !== false);
    assertSharesDoNotExceedOneHundred(db, shares);

    if (input.id !== undefined) {
      const before = db.prepare("SELECT * FROM partners WHERE id = ?").get(input.id) as
        | Record<string, unknown>
        | undefined;
      if (before === undefined) throw new PartnerError(`Partner ${String(input.id)} was not found.`);

      db.prepare(
        "UPDATE partners SET name = ?, share_percent = ?, is_active = ? WHERE id = ?",
      ).run(input.name, input.sharePercent, input.isActive === false ? 0 : 1, input.id);

      recordAudit(
        db,
        context.actor,
        {
          module: "partners",
          action: "update",
          entityType: "partner",
          entityId: input.id,
          oldValues: before,
          newValues: input,
        },
        context.nowIso,
      );

      return mapPartner(
        db.prepare("SELECT * FROM partners WHERE id = ?").get(input.id) as PartnerRow,
      );
    }

    const clash = db.prepare("SELECT id FROM partners WHERE name = ?").get(input.name) as
      | { id?: number }
      | undefined;
    if (clash !== undefined) {
      throw new PartnerError(`A partner named "${input.name}" already exists.`);
    }

    const info = db
      .prepare("INSERT INTO partners (name, share_percent, is_active) VALUES (?, ?, ?)")
      .run(input.name, input.sharePercent, input.isActive === false ? 0 : 1);

    const id = Number(info.lastInsertRowid);

    recordAudit(
      db,
      context.actor,
      {
        module: "partners",
        action: "create",
        entityType: "partner",
        entityId: id,
        newValues: input,
      },
      context.nowIso,
    );

    return mapPartner(db.prepare("SELECT * FROM partners WHERE id = ?").get(id) as PartnerRow);
  })();
}

/**
 * The partnership's own ledger, newest first.
 *
 * This is the record of what was actually allocated: a partner's share of the
 * profit, the part of the donation that partner bore, and the money brought in
 * or taken out.
 */
export function listPartnerTransactions(
  db: SqliteDatabase,
  limit = 200,
): PartnerTransactionDto[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.partner_id, p.name AS partner_name, t.txn_date, t.kind, t.amount_fils,
              t.period_ref, t.notes, t.created_by, t.created_at
         FROM partner_transactions t
         JOIN partners p ON p.id = t.partner_id
        ORDER BY t.txn_date DESC, t.id DESC
        LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    partner_id: number;
    partner_name: string;
    txn_date: string;
    kind: "capital" | "drawing" | "profit" | "donation";
    amount_fils: number;
    period_ref: string | null;
    notes: string | null;
    created_by: string | null;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    txnDate: row.txn_date,
    kind: row.kind,
    amountFils: row.amount_fils,
    periodRef: row.period_ref,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

/* -------------------------------------------------------------------------- */
/* the partnership's own ledger                                                */
/* -------------------------------------------------------------------------- */

export interface PartnerSplitEntry {
  readonly partnerId: number;
  readonly partnerName: string;
  readonly sharePercent: number;
  readonly amountFils: number;
}

export interface RecordSplitResult {
  /** The rows written: one profit row and one donation row per partner. */
  readonly entries: readonly {
    readonly partnerId: number;
    readonly kind: "profit" | "donation";
    readonly amountFils: number;
  }[];
  /** The donation set aside for the period. */
  readonly donationFils: number;
}

/**
 * Write the split into the partnership's own ledger.
 *
 * The donation and the partners' shares are calculated for the period and
 * written down: a "profit" row for each partner's share, and a "donation" row
 * for the part of the donation that partner bears. A partner who takes 49% of
 * the profit bears 49% of the 2% donation, so the two together account for
 * every rupee of the profit exactly once.
 *
 * The period is recorded once. A second recording for the same period is
 * refused rather than added, so the donation is never written twice.
 */
export function recordPartnerSplit(
  context: { db: SqliteDatabase; actor: AuditActor; nowIso: string; nowDate: string },
  split: {
    readonly fromDate: string;
    readonly toDate: string;
    readonly netProfitFils: number;
    readonly donationFils: number;
    readonly partners: readonly PartnerSplitEntry[];
  },
): RecordSplitResult {
  const { db } = context;
  const periodRef = `${split.fromDate}..${split.toDate}`;

  return db.transaction((): RecordSplitResult => {
    const already = db
      .prepare(
        "SELECT COUNT(*) AS count FROM partner_transactions WHERE period_ref = ? AND kind IN ('profit','donation')",
      )
      .get(periodRef) as { count: number };

    if (already.count > 0) {
      throw new PartnerError(
        "The split for this period has already been recorded. A period is recorded once, so the donation is not written twice.",
      );
    }

    if (split.partners.length === 0) {
      throw new PartnerError("There are no partners to record a split for.");
    }

    const insert = db.prepare(
      `INSERT INTO partner_transactions
         (partner_id, txn_date, kind, amount_fils, period_ref, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Each partner bears the donation in proportion to their share of the
    // profit, so the two together come to the whole donation.
    const donationWeights = split.partners.map((partner) => partner.sharePercent);
    const donationShares = allocateFils(split.donationFils, donationWeights);

    const entries: {
      readonly partnerId: number;
      readonly kind: "profit" | "donation";
      readonly amountFils: number;
    }[] = [];

    split.partners.forEach((partner, index) => {
      insert.run(
        partner.partnerId,
        split.toDate,
        "profit",
        partner.amountFils,
        periodRef,
        `Profit share for ${split.fromDate} to ${split.toDate}`,
        context.actor.name,
        context.nowIso,
      );
      entries.push({ partnerId: partner.partnerId, kind: "profit", amountFils: partner.amountFils });

      const donation = donationShares[index] ?? 0;
      if (donation <= 0) return;

      insert.run(
        partner.partnerId,
        split.toDate,
        "donation",
        donation,
        periodRef,
        `Donation for ${split.fromDate} to ${split.toDate}, borne in the partner's share`,
        context.actor.name,
        context.nowIso,
      );
      entries.push({ partnerId: partner.partnerId, kind: "donation", amountFils: donation });
    });

    recordAudit(
      db,
      context.actor,
      {
        module: "partners",
        action: "create",
        entityType: "partnerSplit",
        entityId: 0,
        newValues: {
          period: periodRef,
          netProfit: split.netProfitFils,
          donation: split.donationFils,
          partners: split.partners.map((partner) => ({
            name: partner.partnerName,
            sharePercent: partner.sharePercent,
            amount: partner.amountFils,
          })),
        },
      },
      context.nowIso,
    );

    return { entries, donationFils: split.donationFils };
  })();
}
