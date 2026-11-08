/**
 * The partner split, as the shop sees it.
 *
 * The business agreed 49% each with a 2% donation: 49 + 49 + 2 is exactly
 * 100% of the net profit. These tests check that the report says so, that a
 * partnership whose percentages do not add up is reported rather than quietly
 * given money that is not there, and that a closed period's split is written
 * down once and only once.
 */

import { describe, expect, it } from "vitest";
import { openInMemoryDatabase, type SqliteDatabase } from "../src/data/connection";
import { runMigrations } from "../src/data/migrator";
import { migrations } from "../src/data/migrations";
import { saveDocument } from "../src/main/repositories/documents";
import { listPartnerTransactions, recordPartnerSplit } from "../src/main/repositories/partners";
import { partnerSplit } from "../src/main/repositories/reports";
import type { Fils } from "../src/domain/money";

const NOW = "2026-03-01T09:00:00.000Z";
const DATE = "2026-03-01";
const RS = (rupees: number): Fils => rupees * 100;
const ACTOR = { id: 1, name: "Tester" };

function readyDb(): SqliteDatabase {
  const db = openInMemoryDatabase();
  runMigrations(db, migrations);
  return db;
}

/** A shop with one customer, one product and a sale of Rs 100,000. */
function shopWithSale(netFils: Fils): { db: SqliteDatabase; customerId: number } {
  const db = readyDb();

  db.prepare(
    `INSERT INTO products (sku, name, quantity_milli, average_cost_fils, sale_price_fils, is_active, created_at, updated_at)
     VALUES ('SKU-1', 'Filter', 0, ?, ?, 1, ?, ?)`,
  ).run(RS(100), netFils, NOW, NOW);
  const productId = Number(
    (db.prepare("SELECT id FROM products WHERE sku = 'SKU-1'").get() as { id: number }).id,
  );

  db.prepare(
    "INSERT INTO parties (code, name, kind, opening_balance, is_active, created_at, updated_at) VALUES ('C-1', 'Water Company', 'customer', 0, 1, ?, ?)",
  ).run(NOW, NOW);
  const customerId = Number(
    (db.prepare("SELECT id FROM parties WHERE code = 'C-1'").get() as { id: number }).id,
  );

  db.transaction(() => {
    saveDocument(
      {
        db,
        actor: ACTOR,
        fiscalYearStartMonth: 1,
        nowIso: NOW,
        nowDate: DATE,
        allowNegativeStock: true,
        vatRate: 0,
      },
      {
        kind: "invoice",
        partyId: customerId,
        issueDate: DATE,
        dueDate: null,
        status: "issued",
        notes: null,
        lines: [
          {
            productId,
            description: "Filters",
            quantityMilli: 1_000,
            unitPriceFils: netFils,
            vatTreatment: "zero",
            unitCostFils: 0,
          },
        ],
      },
    );
  })();

  return { db, customerId };
}

/** The partners, read the way the report reads them. */
function listPartnersOf(db: SqliteDatabase): {
  readonly id: number;
  readonly name: string;
  readonly sharePercent: number;
  readonly isActive: boolean;
}[] {
  const rows = db.prepare("SELECT * FROM partners ORDER BY name").all() as {
    id: number;
    name: string;
    share_percent: number;
    is_active: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sharePercent: row.share_percent,
    isActive: row.is_active === 1,
  }));
}

describe("the partner split", () => {
  it("seeds the partnership at 49% each with a 2% donation", () => {
    const { db } = shopWithSale(RS(100_000));

    const partners = listPartnersOf(db);
    expect(partners).toHaveLength(2);
    expect(partners.map((partner) => partner.sharePercent)).toEqual([49, 49]);
  });

  it("gives each partner 49% and the donation 2% of the net profit", () => {
    const { db } = shopWithSale(RS(100_000));

    const split = partnerSplit(db, DATE, DATE, listPartnersOf(db), { donationRatePercent: 2 });

    expect(split.configurationError).toBeNull();
    expect(split.netProfitFils).toBe(RS(100_000));
    expect(split.donationRatePercent).toBe(2);
    expect(split.donationFils).toBe(RS(2_000));
    expect(split.distributableFils).toBe(RS(98_000));
    expect(split.partners.map((partner) => partner.sharePercent)).toEqual([49, 49]);
    expect(split.partners.map((partner) => partner.amountFils)).toEqual([
      RS(49_000),
      RS(49_000),
    ]);

    // The three shares come to the whole profit: nothing is left over and
    // nothing is allocated twice.
    const allocated =
      split.donationFils + split.partners.reduce((sum, partner) => sum + partner.amountFils, 0);
    expect(allocated).toBe(split.netProfitFils);
  });

  it("reports a partnership whose shares do not come to 100", () => {
    const { db } = shopWithSale(RS(100_000));
    db.prepare("UPDATE partners SET share_percent = 50").run();

    const split = partnerSplit(db, DATE, DATE, listPartnersOf(db), { donationRatePercent: 2 });

    // Nothing is invented: the report says the split cannot be worked out.
    expect(split.configurationError).not.toBeNull();
    expect(split.configurationError).toMatch(/must add up to 100%/);
    expect(split.donationFils).toBe(0);
    expect(split.partners).toEqual([]);
  });

  it("writes the split into the partnership's own ledger, once", () => {
    const { db } = shopWithSale(RS(100_000));

    const split = partnerSplit(db, DATE, DATE, listPartnersOf(db), { donationRatePercent: 2 });
    const partners = listPartnersOf(db);

    const recorded = recordPartnerSplit(
      { db, actor: ACTOR, nowIso: NOW, nowDate: DATE },
      {
        fromDate: DATE,
        toDate: DATE,
        netProfitFils: split.netProfitFils,
        donationFils: split.donationFils,
        partners: split.partners.map((partner) => ({
          partnerId: partner.partnerId,
          partnerName: partner.name,
          sharePercent: partner.sharePercent,
          amountFils: partner.amountFils,
        })),
      },
    );

    // A profit row for each partner and a donation row for each partner's
    // part of the donation.
    expect(recorded.entries).toHaveLength(4);
    expect(recorded.donationFils).toBe(RS(2_000));

    const rows = listPartnerTransactions(db);
    expect(rows).toHaveLength(4);

    const profits = rows.filter((row) => row.kind === "profit");
    expect(profits.map((row) => row.amountFils)).toEqual([RS(49_000), RS(49_000)]);
    expect(profits.map((row) => row.partnerId).sort()).toEqual(
      partners.map((partner) => partner.id).sort(),
    );

    const donations = rows.filter((row) => row.kind === "donation");
    expect(donations.reduce((sum, row) => sum + row.amountFils, 0)).toBe(RS(2_000));

    // The same period is never recorded twice, so the donation is not written
    // twice.
    expect(() =>
      recordPartnerSplit(
        { db, actor: ACTOR, nowIso: NOW, nowDate: DATE },
        {
          fromDate: DATE,
          toDate: DATE,
          netProfitFils: split.netProfitFils,
          donationFils: split.donationFils,
          partners: split.partners.map((partner) => ({
            partnerId: partner.partnerId,
            partnerName: partner.name,
            sharePercent: partner.sharePercent,
            amountFils: partner.amountFils,
          })),
        },
      ),
    ).toThrow(/already been recorded/);

    expect(listPartnerTransactions(db)).toHaveLength(4);
  });
});
