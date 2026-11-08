/**
 * MMS production policies.
 *
 * These are the server-enforced defaults the manufacturing repositories read
 * while posting documents, so the screen is a form over `mms.config`: one read,
 * one patch. It does not restate the rules in the UI - the label says what the
 * value does and the server remains the one that applies it.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call, errorMessage } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { Button } from "../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import type { MmsConfigDto } from "../../../shared/types";

interface Form {
  negativeStockPolicy: "block" | "allow";
  defaultCostingMethod: "standard" | "weightedAverage" | "fifo";
  allowBackflush: boolean;
  requireQCBeforeReceipt: boolean;
  scrapAllowancePercent: number;
  overheadRateFilsPerHour: number;
  autoCreateWorkOrders: boolean;
}

const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-[var(--brand)]";

function toForm(config: MmsConfigDto): Form {
  return {
    negativeStockPolicy: config.negativeStockPolicy,
    defaultCostingMethod: config.defaultCostingMethod,
    allowBackflush: config.allowBackflush,
    requireQCBeforeReceipt: config.requireQCBeforeReceipt,
    scrapAllowancePercent: config.scrapAllowancePercent,
    overheadRateFilsPerHour: config.overheadRateFilsPerHour,
    autoCreateWorkOrders: config.autoCreateWorkOrders,
  };
}

export function MmsSettingsPage(): React.JSX.Element {
  const { can } = useApp();
  const client = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ["mms-config"],
    queryFn: () => call("mms.config.get", {}),
    enabled: can("manufacturing", "view"),
  });

  useEffect(() => {
    if (query.data !== undefined) setForm(toForm(query.data));
  }, [query.data]);

  const editable = can("manufacturing", "edit");

  const save = async (): Promise<void> => {
    if (form === null) return;
    setSaving(true);
    try {
      await call("mms.config.update", form);
      await client.invalidateQueries({ queryKey: ["mms-config"] });
      toast.success("Production policies saved.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (form === null) {
    return <div className="card p-8 text-center text-sm text-ink-secondary">Loading policies…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">MMS Settings</h1>
        <p className="text-sm text-ink-secondary">
          Production policies applied by the server when documents are posted.
        </p>
      </div>

      <Card flush>
        <CardHeader title="Production Policies" description="Stored with the company database." />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-ink">Negative stock policy</span>
              <select
                className={inputClass}
                disabled={!editable}
                value={form.negativeStockPolicy}
                onChange={(event) => {
                  setForm({
                    ...form,
                    negativeStockPolicy: event.target.value as Form["negativeStockPolicy"],
                  });
                }}
              >
                <option value="block">Block issues that would go negative</option>
                <option value="allow">Allow negative stock</option>
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-ink">Default costing method</span>
              <select
                className={inputClass}
                disabled={!editable}
                value={form.defaultCostingMethod}
                onChange={(event) => {
                  setForm({
                    ...form,
                    defaultCostingMethod: event.target.value as Form["defaultCostingMethod"],
                  });
                }}
              >
                <option value="standard">Standard cost</option>
                <option value="weightedAverage">Weighted average</option>
                <option value="fifo">FIFO</option>
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-ink">Scrap allowance (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                className={inputClass}
                disabled={!editable}
                value={form.scrapAllowancePercent}
                onChange={(event) => {
                  setForm({ ...form, scrapAllowancePercent: Number(event.target.value) });
                }}
              />
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-ink">Overhead rate (fils per hour)</span>
              <input
                type="number"
                min={0}
                className={inputClass}
                disabled={!editable}
                value={form.overheadRateFilsPerHour}
                onChange={(event) => {
                  setForm({ ...form, overheadRateFilsPerHour: Number(event.target.value) });
                }}
              />
            </label>
          </div>

          <div className="mt-4 space-y-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                disabled={!editable}
                checked={form.allowBackflush}
                onChange={(event) => {
                  setForm({ ...form, allowBackflush: event.target.checked });
                }}
              />
              Allow backflush consumption
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                disabled={!editable}
                checked={form.requireQCBeforeReceipt}
                onChange={(event) => {
                  setForm({ ...form, requireQCBeforeReceipt: event.target.checked });
                }}
              />
              Require quality check before finished-goods receipt
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                disabled={!editable}
                checked={form.autoCreateWorkOrders}
                onChange={(event) => {
                  setForm({ ...form, autoCreateWorkOrders: event.target.checked });
                }}
              />
              Create work orders automatically when an order is released
            </label>
          </div>

          <div className="mt-5 flex justify-end">
            <Button
              variant="primary"
              disabled={!editable || saving}
              onClick={() => {
                void save();
              }}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
