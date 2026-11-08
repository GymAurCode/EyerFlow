import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { MmsTable as Table } from "../mms/MmsTable";
import type { WmsReportRequest } from "../../../shared/wms";

export function AnalyticsPage(): React.JSX.Element {
  const settings = useLocation().pathname.endsWith("/settings"),
    { can } = useApp(),
    client = useQueryClient();
  const snapshot = useQuery({ queryKey: ["wms"], queryFn: () => call("wms.snapshot", {}) });
  const [report, setReport] = useState<NonNullable<WmsReportRequest["report"]>>("stock");
  const [warehouse, setWarehouse] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const request: WmsReportRequest = {
    report,
    ...(warehouse ? { warehouseId: Number(warehouse) } : {}),
    ...(from ? { fromDate: from } : {}),
    ...(to ? { toDate: to } : {}),
  };
  const query = useQuery({
    queryKey: ["wms-report", request],
    queryFn: () => call("wms.report", request),
    enabled: !settings,
  });
  const save = useMutation({
    mutationFn: (p: { autoPutaway: boolean; pickFaceFirst: boolean }) =>
      call("wms.settings.save", p),
    onSuccess: () => {
      toast.success("Warehouse settings saved.");
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  const exportReport = useMutation({
    mutationFn: () => call("wms.report.export", request),
    onSuccess: (r) => toast.success(`CSV saved: ${r.path}`),
    onError: (e: unknown) => {
      console.error(e);
      toast.error(errorMessage(e));
    },
  });
  const values = snapshot.data?.settings;
  return (
    <div className="space-y-5">
      <PageHeader
        title={settings ? "WMS Settings" : "Warehouse Reports"}
        description={
          settings
            ? "Controls read by warehouse execution services."
            : "SQL reports from the shared stock ledger and recorded warehouse operations."
        }
      />
      {settings ? (
        <>
          {snapshot.isPending ? (
            <TableSkeleton />
          ) : snapshot.isError ? (
            <p role="alert" className="text-danger">
              {errorMessage(snapshot.error)}
            </p>
          ) : (
            values && (
              <Card>
                <div className="space-y-6">
                  <section>
                    <h2 className="text-base font-semibold">Inbound workflow</h2>
                    <p className="my-2 text-sm text-ink-secondary">
                      When enabled, an accepted receipt creates putaway tasks automatically. When
                      disabled, create an internal movement from receiving.
                    </p>
                    <Field label="Automatic putaway tasks">
                      {(id) => (
                        <Select
                          id={id}
                          disabled={!can("warehouse", "edit") || save.isPending}
                          value={String(values.autoPutaway)}
                          onChange={(v) => save.mutate({ ...values, autoPutaway: v === "true" })}
                          options={[
                            { value: "true", label: "Enabled" },
                            { value: "false", label: "Disabled" },
                          ]}
                        />
                      )}
                    </Field>
                  </section>
                  <section>
                    <h2 className="text-base font-semibold">Outbound allocation</h2>
                    <p className="my-2 text-sm text-ink-secondary">
                      Choose whether pick-face bins are allocated before bulk storage. Within each
                      group, allocation uses bin code order.
                    </p>
                    <Field label="Pick source priority">
                      {(id) => (
                        <Select
                          id={id}
                          disabled={!can("warehouse", "edit") || save.isPending}
                          value={String(values.pickFaceFirst)}
                          onChange={(v) => save.mutate({ ...values, pickFaceFirst: v === "true" })}
                          options={[
                            { value: "true", label: "Pick face first, then bulk" },
                            { value: "false", label: "Bin code order" },
                          ]}
                        />
                      )}
                    </Field>
                  </section>
                </div>
              </Card>
            )
          )}
        </>
      ) : (
        <>
          <Card>
            <div className="grid gap-4 md:grid-cols-4">
              <Field label="Report">
                {(id) => (
                  <Select
                    id={id}
                    value={report}
                    onChange={(v) => setReport(v as typeof report)}
                    options={[
                      { value: "stock", label: "Stock by warehouse / bin / lot / status" },
                      { value: "receiving", label: "Receiving summary & damage" },
                      { value: "movements", label: "Physical movement history" },
                      { value: "tasks", label: "Warehouse task history" },
                      { value: "dispatch", label: "Dispatch summary" },
                      { value: "counts", label: "Cycle count variances" },
                      { value: "exceptions", label: "Warehouse exceptions" },
                    ]}
                  />
                )}
              </Field>
              <Field label="Warehouse">
                {(id) => (
                  <Select
                    id={id}
                    value={warehouse}
                    onChange={setWarehouse}
                    options={[
                      { value: "", label: "All warehouses" },
                      ...(snapshot.data?.warehouses.map((w) => ({
                        value: String(w.id),
                        label: w.code,
                      })) ?? []),
                    ]}
                  />
                )}
              </Field>
              <Field
                label="From date"
                hint={
                  report === "stock" ? "Stock balances include all earlier movements." : undefined
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                )}
              </Field>
              <Field label="To date">
                {(id) => (
                  <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                )}
              </Field>
            </div>
            <div className="mt-4 flex gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Refresh report
              </Button>
              {can("warehouse", "export") && (
                <Button
                  disabled={exportReport.isPending || query.isError}
                  onClick={() => exportReport.mutate()}
                >
                  Export CSV
                </Button>
              )}
            </div>
          </Card>
          {query.isPending ? (
            <TableSkeleton />
          ) : query.isError ? (
            <div role="alert" className="card p-5">
              <p className="text-danger">{errorMessage(query.error)}</p>
              <Button
                onClick={() => {
                  void query.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            query.data && (
              <>
                <Table<Record<string, string | number | null>>
                  rows={query.data.rows.map((row, index) => ({ ...row, _row: index }))}
                  rowKey={(row) => Number(row["_row"])}
                  columns={query.data.columns.map((key) => ({
                    id: key,
                    header: key.replaceAll("_", " "),
                    cell: (row) => row[key] ?? "—",
                  }))}
                />
                <p className="text-xs text-ink-secondary">
                  Generated: {new Date(query.data.generatedAt).toLocaleString()} · Data cutoff:{" "}
                  {query.data.cutoff} · Maximum {query.data.limit} rows
                </p>
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
