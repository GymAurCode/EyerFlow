/**
 * Stock Ledger: every movement of stock, across every product.
 *
 * Until now the ledger existed but was only ever read one product at a time,
 * from a dialog on the product row. That answers "what happened to this box"
 * and not the question a shopkeeper actually asks when the numbers disagree:
 * "what moved, when, at what cost, and on whose document" - which is only
 * answerable with all products in one list.
 *
 * The rows are the `stock_movements` table itself, read through
 * `products.movements`. Nothing here is calculated twice: quantity, unit cost
 * and value are the figures the posting wrote, so the ledger agrees with the
 * stock balance because both come from the same rows.
 *
 * The date range and the movement kind are applied by the query, not filtered
 * after the fact, so the limit of rows returned is a limit of the rows in the
 * period rather than a sample of all time that is then trimmed.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { toast } from "sonner";
import type { ProductDto, StockMovementDto } from "../../../shared/types";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatQuantity } from "../../lib/format";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "../../lib/finance";
import { formatDate, todayIso } from "../../lib/utils";
import { useLookup } from "../../lib/lookups";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { Pagination, useTableView } from "../../components/ui/Dropdown";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, Select, type SelectOption } from "../../components/ui/Input";
import { DateRangePicker } from "../finance/FinanceLayout";

/** The six kinds `stock_movements.kind` can hold. */
const MOVEMENT_LABELS: Record<StockMovementDto["kind"], string> = {
  receipt: "Receipt",
  issue: "Issue",
  reversal: "Reversal",
  adjustmentIn: "Adjustment in",
  adjustmentOut: "Adjustment out",
  opening: "Opening balance",
};

const MOVEMENT_TONES: Record<StockMovementDto["kind"], "success" | "warning" | "neutral"> = {
  receipt: "success",
  issue: "warning",
  // A reversal is a correction, not a movement of goods: it is the row that
  // proves the mistake was answered rather than quietly overwritten.
  reversal: "neutral",
  adjustmentIn: "success",
  adjustmentOut: "warning",
  opening: "neutral",
};

const KIND_OPTIONS: readonly SelectOption[] = Object.entries(MOVEMENT_LABELS).map(
  ([value, label]) => ({ value, label }),
);

/**
 * The rows the ledger is allowed to fetch.
 *
 * The engine caps the query at a limit, and 5,000 movements is roughly two
 * years of trading for a counter shop. Beyond that the period is what has to
 * narrow, and the footer says so rather than letting the list look complete when
 * it is a truncated one.
 */
const ROW_LIMIT = 5000;

export function StockLedgerPage(): React.JSX.Element {
  const { can } = useApp();
  const canSeeProducts = can("products", "view");

  const [preset, setPreset] = useState<DateRangePreset>("month");
  const [customFrom, setCustomFrom] = useState(todayIso());
  const [customTo, setCustomTo] = useState(todayIso());
  const [productId, setProductId] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");

  const period = resolveDateRange(preset, customFrom, customTo);

  // The cached list the dialogs use, so the product filter costs no round trip
  // and cannot disagree with the picker in a sale dialog about what is callable.
  const products = useLookup<ProductDto>("product");

  const productOptions = useMemo<readonly SelectOption[]>(
    () =>
      products.map((product) => ({
        value: String(product.id),
        label: `${product.name} · ${product.sku}`,
      })),
    [products],
  );

  const query = useQuery({
    queryKey: [
      "stock-ledger",
      {
        fromDate: period.fromDate,
        toDate: period.toDate,
        productId,
        kind,
      },
    ],
    queryFn: () =>
      call("products.movements", {
        fromDate: period.fromDate,
        toDate: period.toDate,
        ...(productId === "" ? {} : { productId: Number(productId) }),
        ...(kind === "" ? {} : { kind: kind as StockMovementDto["kind"] }),
        limit: ROW_LIMIT,
      }),
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return all;
    // Product name, SKU and document number: the three things a person has in
    // front of them when they go looking for a row.
    return all.filter(
      (row) =>
        row.productName.toLowerCase().includes(needle) ||
        (row.documentNumber ?? "").toLowerCase().includes(needle),
    );
  }, [query.data, search]);

  const columns = useMemo<readonly Column<StockMovementDto>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        cell: (row) => (
          <span className="tabular text-[var(--text-2)]">{formatDate(row.movementDate)}</span>
        ),
        sortValue: (row) => row.movementDate,
      },
      {
        id: "product",
        header: "Product",
        cell: (row) => <span className="text-[var(--text)]">{row.productName}</span>,
        sortValue: (row) => row.productName,
      },
      {
        id: "kind",
        header: "Kind",
        cell: (row) => <Badge tone={MOVEMENT_TONES[row.kind]}>{MOVEMENT_LABELS[row.kind]}</Badge>,
        sortValue: (row) => MOVEMENT_LABELS[row.kind],
      },
      {
        id: "document",
        header: "Document",
        cell: (row) => row.documentNumber ?? "—",
        sortValue: (row) => row.documentNumber,
      },
      {
        id: "quantity",
        header: "Quantity",
        align: "end",
        // Inbound rows carry a positive quantity and outbound a negative one, so
        // the sign is the posting's own statement of direction and is never
        // re-derived here from the kind.
        cell: (row) => (
          <span
            className={
              row.quantityMilli < 0 ? "tabular text-[var(--danger)]" : "tabular text-[var(--text)]"
            }
          >
            {formatQuantity(row.quantityMilli)}
          </span>
        ),
        sortValue: (row) => row.quantityMilli,
      },
      {
        id: "unitCost",
        header: "Unit cost",
        align: "end",
        cell: (row) => <span className="tabular">{formatAmount(row.unitCostFils)}</span>,
        sortValue: (row) => row.unitCostFils,
      },
      {
        id: "value",
        header: "Value",
        align: "end",
        cell: (row) => <span className="tabular">{formatAmount(row.costFils)}</span>,
        sortValue: (row) => row.costFils,
      },
      {
        id: "notes",
        header: "Notes",
        cell: (row) => <span className="text-[var(--text-2)]">{row.notes ?? "—"}</span>,
        sortValue: (row) => row.notes,
        defaultHidden: true,
      },
    ],
    [],
  );

  const view = useTableView(rows, columns, 50, { rowKey: (row) => row.id });

  const totals = useMemo(() => {
    let inbound = 0;
    let outbound = 0;
    for (const row of rows) {
      if (row.quantityMilli >= 0) inbound += row.quantityMilli;
      else outbound += row.quantityMilli;
    }
    return { inbound, outbound };
  }, [rows]);

  const exportCsv = (): void => {
    const header = [
      "Date",
      "Product",
      "Kind",
      "Document",
      "Quantity",
      "Unit cost",
      "Value",
      "Notes",
    ];
    const body = rows.map((row) => [
      row.movementDate,
      row.productName,
      MOVEMENT_LABELS[row.kind],
      row.documentNumber ?? "",
      (row.quantityMilli / 1000).toFixed(3),
      (row.unitCostFils / 1000).toFixed(3),
      (row.costFils / 1000).toFixed(3),
      row.notes ?? "",
    ]);
    const csv = [header, ...body]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stock-ledger-${period.fromDate}-to-${period.toDate}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${String(rows.length)} movements`);
  };

  return (
    <div>
      <PageHeader
        title="Stock Ledger"
        description={`${formatDate(period.fromDate)} to ${formatDate(period.toDate)} · ${formatQuantity(
          totals.inbound,
        )} in, ${formatQuantity(Math.abs(totals.outbound))} out`}
        actions={
          <Button
            variant="secondary"
            iconLeft={<Download className="h-4 w-4" />}
            onClick={exportCsv}
            disabled={rows.length === 0}
          >
            Export CSV
          </Button>
        }
      />

      <Card flush>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
          <div className="w-[260px]">
            <Field label="Search" srLabelOnly>
              {(id) => (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-[var(--text-3)]"
                    aria-hidden="true"
                  />
                  <Input
                    id={id}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                    placeholder={canSeeProducts ? "Product or document number" : "Document number"}
                    className="ps-9"
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="w-[220px]">
            <Select
              value={productId}
              options={productOptions}
              placeholder="All Products"
              onChange={(next) => {
                setProductId(next);
              }}
              aria-label="Product filter"
            />
          </div>

          <div className="w-[170px]">
            <Select
              value={kind}
              options={KIND_OPTIONS}
              placeholder="All Movements"
              onChange={(next) => {
                setKind(next);
              }}
              aria-label="Movement kind filter"
            />
          </div>

          <div className="ms-auto">
            <DateRangePicker
              preset={preset}
              fromDate={customFrom}
              toDate={customTo}
              presets={DATE_RANGE_PRESETS}
              onPresetChange={(value) => {
                setPreset(value as DateRangePreset);
              }}
              onFromChange={setCustomFrom}
              onToChange={setCustomTo}
            />
          </div>
        </div>

        {query.isLoading ? (
          <TableSkeleton columns={7} rows={10} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Search className="h-6 w-6" />}
            title="No movements in this period"
            description="Nothing was received, issued or adjusted between the dates shown. Widen the period, or clear the product and kind filters."
          />
        ) : (
          <>
            <DataTable
              frameless
              columns={columns}
              rows={view.rowsOnPage}
              rowKey={(row) => row.id}
              sortId={view.sortId}
              sortDirection={view.sortDirection}
              onSortChange={view.setSort}
              hiddenColumnIds={view.hiddenColumnIds}
              caption="Stock movements"
            />
            <Pagination
              total={view.totalRows}
              page={view.page}
              onPageChange={view.setPage}
              perPage={view.perPage}
              onPerPageChange={view.setPerPage}
              itemLabel="movements"
            />
          </>
        )}

        {/* The ledger is capped at the newest rows the period can hold. Saying so
            matters: a list that silently stopped at 5,000 would be read as the
            whole truth, and a missing movement is exactly what someone comes here
            to look for. */}
        {(query.data?.length ?? 0) >= ROW_LIMIT && (
          <p className="border-t border-[var(--divider)] px-4 py-2.5 text-[12px] text-[var(--warning)]">
            Showing the newest {String(ROW_LIMIT)} movements in this period. Narrow the dates to see
            the rest.
          </p>
        )}
      </Card>
    </div>
  );
}
