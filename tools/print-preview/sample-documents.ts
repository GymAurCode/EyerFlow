/**
 * Sample documents for checking the print layout.
 *
 * Builds the same documents the app prints - a sales report, an invoice, an
 * expense voucher, a statement - from made-up but realistic data, so the
 * layout can be looked at without a database. The templates are the real ones:
 * if a column overlaps or a heading is cut off here, it is cut off in the app
 * too.
 *
 *   npx tsx tools/print-preview/sample-documents.ts [outDir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppSettingsSnapshot } from "../../src/shared/ipc";
import type {
  DocumentDto,
  DocumentLineDto,
  ExpenseDto,
  PaymentDto,
  ProductDto,
} from "../../src/shared/types";
import type { PartyStatementDto } from "../../src/shared/finance";
import {
  renderExpenseDocument,
  renderInvoiceDocument,
  renderReceiptDocument,
  renderStatementDocument,
} from "../../src/renderer/components/print/record-templates";
import {
  documentRegisterReport,
  expenseReport,
  inventoryReport,
  profitAndLossReport,
  stockReport,
} from "../../src/renderer/components/print/report-templates";
import { renderReportDocument } from "../../src/renderer/components/print/report-document";
import { companyProfile } from "../../src/renderer/components/print/company-document";

const outDir = resolve(process.argv[2] ?? join(process.cwd(), "print-preview-out"));

const settings: AppSettingsSnapshot = {
  theme: "light",
  themePalette: "ocean-teal",
  themeOnboardingComplete: true,
  companyName: "Bluewave Water Solutions",
  companyTrn: "100428836500003",
  companyAddress: "Shop 12, Al Nakheel Street\nAl Quoz First\nDubai, United Arab Emirates",
  companyPhone: "+971 4 339 8120",
  companyEmail: "accounts@bluewavewater.ae",
  companyLogoPath: "",
  companyLogoDataUrl: null,
  invoiceFooter: "Thank you for your business.",
  vendorName: "Eyercall",
  invoiceTerms:
    "Goods once sold are not returnable unless defective. Warranty applies as per the manufacturer terms.",
  fiscalYearStartMonth: 1,
  backupDirectory: "",
  backupKeepCount: 30,
  dailyBackupEnabled: true,
  dailyBackupHour: 2,
  donationRatePercent: 2,
  currency: "PKR",
  vatRatePercent: 5,
  allowNegativeStock: false,
};

const recordOptions = {
  profile: companyProfile(settings),
  currency: settings.currency,
  generatedAt: new Date(),
};

function line(
  id: number,
  description: string,
  quantityMilli: number,
  unitPriceFils: number,
  netFils: number,
  vatFils: number,
): DocumentLineDto {
  return {
    id,
    lineNo: id,
    productId: null,
    description,
    quantityMilli,
    unitPriceFils,
    netFils,
    vatFils,
    vatTreatment: "standard",
    unitCostFils: 0,
    costFils: 0,
  };
}

const invoice: DocumentDto = {
  id: 1,
  kind: "invoice",
  number: "INV-2026-0142",
  partyId: 7,
  partyName: "Marina View Hotel & Apartments",
  issueDate: "2026-10-18",
  dueDate: "2026-11-17",
  status: "partPaid",
  netFils: 1845000,
  vatFils: 92250,
  grossFils: 1937250,
  discountFils: 150000,
  paidFils: 1000000,
  outstandingFils: 937250,
  costFils: 0,
  fiscalYear: 2026,
  notes: "Delivery to the main entrance. Please call before arriving.",
  reason: null,
  createdBy: "Rashid",
  createdAt: "2026-10-18T09:12:00.000Z",
  updatedAt: "2026-10-18T09:12:00.000Z",
  lines: [
    line(1, "5-stage RO filtration system, 2000 GPD", 1_000, 890000, 890000, 44500),
    line(2, "Inline UV steriliser, 40 GPM", 2_000, 245000, 490000, 24500),
    line(3, "Activated carbon filter cartridge, 10 inch", 6_000, 42000, 252000, 12600),
    line(4, "Post-foaming inline membrane housing", 3_000, 71000, 213000, 10650),
  ],
};

const receipt: PaymentDto = {
  id: 3,
  receiptNumber: "RCP-2026-0088",
  direction: "inbound",
  partyId: 7,
  partyName: "Marina View Hotel & Apartments",
  paymentDate: "2026-10-19",
  method: "bank",
  amountFils: 1000000,
  reference: "TRF-4471",
  notes: "Part payment against INV-2026-0142.",
  allocations: [{ documentId: 1, documentNumber: "INV-2026-0142", amountFils: 1000000 }],
  createdBy: "Rashid",
  createdAt: "2026-10-19T11:02:00.000Z",
};

const expense: ExpenseDto = {
  id: 5,
  expenseDate: "2026-10-16",
  category: "rent",
  description: "Shop and warehouse rent for October 2026",
  amountFils: 450000,
  vatFils: 0,
  paymentMethod: "bank",
  reference: "INV-RENT-2026-10",
  notes: "Paid by bank transfer, standing order.",
  accountCode: "6200",
  paidFils: 450000,
};

const product: ProductDto = {
  id: 3,
  sku: "ITM-00012",
  barcode: "6281000112233",
  name: "Inline UV steriliser, 40 GPM, stainless steel",
  description: "Inline ultraviolet steriliser rated 40 GPM, 1/2 inch ports.",
  category: "Filters",
  unit: "pcs",
  quantityMilli: 14_000,
  reorderLevelMilli: 5_000,
  averageCostFils: 185000,
  salePriceFils: 245000,
  vatTreatment: "standard",
  isActive: true,
  stockValueFils: 2590000,
  isLowStock: false,
  lastCostFils: 192000,
  lastSalePriceFils: 245000,
};

const statement: PartyStatementDto = {
  partyId: 7,
  partyName: "Marina View Hotel & Apartments",
  kind: "customer",
  fromDate: "2026-09-01",
  toDate: "2026-10-19",
  openingBalanceFils: 1250000,
  rows: [
    {
      entryId: 1,
      entryNo: "JE-000091",
      entryDate: "2026-09-08",
      reference: null,
      documentNumber: "INV-2026-0118",
      kind: "invoice",
      description: "RO system service visit",
      debitFils: 1250000,
      creditFils: 0,
      runningBalanceFils: 2500000,
      isSettled: false,
      dueDate: "2026-10-08",
      documentId: 118,
    },
    {
      entryId: 2,
      entryNo: "JE-000104",
      entryDate: "2026-09-21",
      reference: "TRF-3310",
      documentNumber: null,
      kind: "receipt",
      description: "Payment received",
      debitFils: 0,
      creditFils: 1250000,
      runningBalanceFils: 1250000,
      isSettled: true,
      dueDate: null,
      documentId: null,
    },
  ],
  totalDebitFils: 1250000,
  totalCreditFils: 1250000,
  closingBalanceFils: 1250000,
  overdueFils: 1250000,
};

const partyNames = [
  "Marina View Hotel & Apartments",
  "Sunrise Trading Company",
  "Al Noor Restaurant",
  "Blue Sky Laundry",
  "Green Valley Villa Complex",
  "Caspian Business Centre",
];

const statuses = ["paid", "issued", "partPaid", "cancelled", "draft"] as const;

const registerRows = Array.from({ length: 46 }, (_, index) => ({
  id: index + 1,
  number: `INV-2026-${String(1400 + index)}`,
  issueDate: `2026-${String(9 + Math.floor(index / 12)).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
  partyName: partyNames[index % partyNames.length] ?? "",
  status: statuses[index % statuses.length] ?? "issued",
  netFils: 125000 + index * 17500,
  vatFils: 6250 + Math.round(index * 875),
  grossFils: 131250 + index * 18375,
  paidFils: index % 3 === 0 ? 0 : 131250 + index * 18375,
  outstandingFils: index % 3 === 0 ? 131250 + index * 18375 : 0,
  lineCount: 1 + (index % 5),
}));

const products: ProductDto[] = Array.from({ length: 34 }, (_, index) => ({
  ...product,
  id: index + 1,
  sku: `ITM-${String(index + 1).padStart(5, "0")}`,
  name: `${product.name} variant ${String.fromCharCode(65 + (index % 26))}`,
  quantityMilli: (index % 11) * 2500,
  stockValueFils: (index % 11) * 2500 * 185000,
  isLowStock: index % 7 === 0,
}));

mkdirSync(outDir, { recursive: true });

function write(name: string, html: string): void {
  const path = join(outDir, `${name}.html`);
  writeFileSync(path, html, "utf8");
  console.log(`wrote ${path}`);
}

write("invoice", renderInvoiceDocument(invoice, recordOptions));
write("receipt", renderReceiptDocument(receipt, recordOptions));
write("expense", renderExpenseDocument(expense, recordOptions));
write("statement", renderStatementDocument(statement, recordOptions));

write(
  "report-sales",
  renderReportDocument(
    documentRegisterReport(
      {
        title: "Sales Report",
        subtitle: "Every sales invoice and what is still owed",
        partyHeader: "Customer",
        numberHeader: "Invoice No.",
        rows: registerRows,
        fromDate: "2026-09-01",
        toDate: "2026-10-19",
      },
    ),
    { profile: companyProfile(settings) },
  ),
);

write(
  "report-profit-and-loss",
  renderReportDocument(
    profitAndLossReport(
      {
        fromDate: "2026-01-01",
        toDate: "2026-10-19",
        revenueFils: 28476500,
        netSalesFils: 28476500,
        costOfGoodsFils: 15947840,
        grossProfitFils: 12528660,
        grossMarginPercent: 43.99,
        operatingExpensesFils: 6132500,
        netProfitFils: 6396160,
        expensesByCategory: [
          { category: "rent", amountFils: 4500000 },
          { category: "salaries", amountFils: 1200000 },
          { category: "transport", amountFils: 268500 },
          { category: "utilities", amountFils: 164000 },
        ],
      },
    ),
    { profile: companyProfile(settings) },
  ),
);

const expenseCategories = ["rent", "utilities", "transport", "salaries", "marketing", "office"];
const expenseDescriptions = [
  "rent",
  "electricity",
  "delivery fuel",
  "staff salary",
  "social posts",
  "printing",
];

write(
  "report-expenses",
  renderReportDocument(
    expenseReport(
      Array.from({ length: 28 }, (_, index) => ({
        ...expense,
        id: index + 1,
        expenseDate: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        category: expenseCategories[index % expenseCategories.length] ?? "general",
        description: `Monthly ${
          expenseDescriptions[index % expenseDescriptions.length] ?? "other"
        } charge`,
        amountFils: 25000 + index * 3400,
      })),
      "2026-10-01",
      "2026-10-19",
    ),
    { profile: companyProfile(settings) },
  ),
);

write(
  "report-inventory",
  renderReportDocument(inventoryReport(products), {
    profile: companyProfile(settings),
  }),
);

write(
  "report-stock",
  renderReportDocument(
    stockReport(
      products.map((item) => ({
        productId: item.id,
        sku: item.sku,
        name: item.name,
        category: item.category,
        quantityMilli: item.quantityMilli,
        averageCostFils: item.averageCostFils,
        valueFils: item.stockValueFils,
      })),
      "2026-10-19",
    ),
    { profile: companyProfile(settings) },
  ),
);
