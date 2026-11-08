/**
 * MMS Production Reports page.
 *
 * Real reports from the MMS report engine. Select a report, set filters, view
 * columns, rows and totals. All data comes from SQL over posted records.
 */

import type { MmsReportTitle } from "../../../shared/types";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MmsTable } from "./MmsTable";
import { EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { errorMessage } from "../../lib/api";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { Field } from "../../components/ui/Input";
import { Card, CardBody, CardHeader, FormSection } from "../../components/ui/Card";

export function MmsReportsPage(): React.JSX.Element {
  const { can } = useApp();
  const [reportId, setReportId] = useState<string>("moSummary");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [limit, setLimit] = useState<number>(500);

  const titlesQuery = useQuery({
    queryKey: ["mms-report-titles"],
    queryFn: () => call("mms.reports.list", {}),
    enabled: can("manufacturing", "view"),
  });

  const reportQuery = useQuery({
    queryKey: ["mms-report", reportId, fromDate, toDate, limit],
    queryFn: () =>
      call("mms.report", {
        report: reportId,
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
        limit,
      } as any),
    enabled: can("manufacturing", "view") && !!reportId,
  });

  const titles: readonly MmsReportTitle[] = titlesQuery.data ?? [];
  const report = reportQuery.data;

  const columns = report?.columns ?? [];
  const rows = report?.rows ?? [];
  const totals = report?.totals ?? {};

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Production Reports</h1>
        <p className="text-sm text-ink-secondary">
          Real SQL reports over posted manufacturing records.
        </p>
      </div>

      <Card flush>
        <CardBody>
          <FormSection title="Report Filters">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Field label="Report">
                {(id: string, describedBy: string | undefined) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    value={reportId}
                    onChange={(e) => setReportId(e.target.value)}
                    className="w-full border border-[var(--line)] rounded-lg bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                  >
                    {titles.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title} ({t.group})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="From Date">
                {(id: string, describedBy: string | undefined) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="w-full border border-[var(--line)] rounded-lg bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                  />
                )}
              </Field>
              <Field label="To Date">
                {(id: string, describedBy: string | undefined) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="w-full border border-[var(--line)] rounded-lg bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                  />
                )}
              </Field>
              <Field label="Limit">
                {(id: string, describedBy: string | undefined) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    type="number"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value) || 500)}
                    className="w-full border border-[var(--line)] rounded-lg bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                  />
                )}
              </Field>
            </div>
          </FormSection>
        </CardBody>
      </Card>

      {reportQuery.isLoading && <TableSkeleton columns={6} />}
      {reportQuery.isError && (
        <EmptyState
          title="The report could not load"
          description={errorMessage(reportQuery.error)}
          actionLabel="Try again"
          onAction={() => void reportQuery.refetch()}
        />
      )}
      {report && (
        <Card flush>
          <CardHeader
            title={report.title}
            description={`${report.period.fromDate} to ${report.period.toDate} • ${rows.length} rows`}
          />
          <CardBody>
            <MmsTable
              columns={columns.map((col) => ({
                id: col.id,
                header: col.label,
                cell: (row: Record<string, string | number | null>) =>
                  formatCell(row[col.id] ?? null, col.type),
                sortValue: (row: Record<string, string | number | null>) => row[col.id],
              }))}
              rows={rows}
              rowKey={(row) => rows.indexOf(row)}
              emptyState="No production records in this period."
            />
            {Object.keys(totals).length > 0 && (
              <div className="mt-3 border-t border-[var(--line-soft)] pt-3 flex flex-wrap gap-4 text-xs text-ink-secondary">
                {columns
                  .filter((c: any) => totals[c.id] !== undefined)
                  .map((c: any) => (
                    <span key={c.id} className="flex flex-col">
                      <span className="text-[10px] uppercase">{c.label}</span>
                      <span className="text-ink font-mono">
                        {formatNumber(totals[c.id] ?? 0, c.type)}
                      </span>
                    </span>
                  ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function formatCell(value: string | number | null, type?: string): string {
  if (value === null || value === undefined) return "—";
  if (type === "money") return `Rs ${((value as number) / 100).toLocaleString()}`;
  if (type === "quantity") return `${Math.round((value as number) / 1000)}`;
  return String(value);
}

function formatNumber(value: number, type?: string): string {
  if (type === "money") return `Rs ${(value / 100).toLocaleString()}`;
  if (type === "quantity") return `${Math.round(value / 1000)}`;
  return String(value);
}
