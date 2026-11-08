import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { DataTable, type DataTableProps } from "../../components/ui/DataTable";
import { Pagination, useTableView } from "../../components/ui/Dropdown";
import { EmptyState, TableSkeleton } from "../../components/ui/Feedback";
import { errorMessage } from "../../lib/api";
import { Field, Input, Select } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";

/** IMS Products' card, toolbar, table and pagination, with MMS bindings intact. */
export function MmsTable<T extends object>(
  props: DataTableProps<T> & {
    loading?: boolean;
    error?: unknown;
    onRetry?: () => void;
  },
): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const statuses = [
    ...new Set(props.rows.map((row) => (row as Record<string, unknown>)["status"])),
  ].filter((value): value is string => typeof value === "string");
  const columns = useMemo(
    () =>
      props.columns.map((column) => ({
        ...column,
        ...(column.id === "actions"
          ? {}
          : {
              sortValue:
                column.sortValue ??
                ((row: T) => {
                  const value = (row as Record<string, unknown>)[column.id] ?? column.cell(row);
                  return typeof value === "string" || typeof value === "number" ? value : null;
                }),
            }),
        cell: (row: T) => {
          const value = column.cell(row);
          if (column.id !== "status" || typeof value !== "string") return value;
          return (
            <Badge
              tone={
                /completed|approved|passed|received/.test(value)
                  ? "success"
                  : /failed|rejected|cancelled/.test(value)
                    ? "danger"
                    : /hold|blocked|pending|paused/.test(value)
                      ? "warning"
                      : "info"
              }
            >
              {value}
            </Badge>
          );
        },
      })),
    [props.columns],
  );
  const filtered = useMemo(
    () =>
      props.rows.filter(
        (row) =>
          (!status || (row as Record<string, unknown>)["status"] === status) &&
          (!search ||
            props.columns.some((column) => {
              const value = column.sortValue?.(row) ?? column.cell(row);
              return (
                (typeof value === "string" || typeof value === "number") &&
                String(value).toLowerCase().includes(search.toLowerCase())
              );
            })),
      ),
    [props.rows, props.columns, search, status],
  );
  const view = useTableView(filtered, columns);
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
        <div className="w-[280px]">
          <Field label="Search records" srLabelOnly>
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
                    view.setPage(1);
                  }}
                  placeholder="Search records"
                  className="ps-9"
                />
              </div>
            )}
          </Field>
        </div>
        {props.columns.some((column) => column.id === "status") && (
          <Field label="Status" srLabelOnly>
            {(id) => (
              <Select
                id={id}
                value={status}
              placeholder="All statuses"
                options={[
                  { value: "", label: "All statuses" },
                  ...statuses.map((value) => ({ value, label: value })),
                ]}
                onChange={(value) => {
                  setStatus(value);
                  view.setPage(1);
                }}
              />
            )}
          </Field>
        )}
      </div>
      {props.loading ? (
        <TableSkeleton columns={columns.length} />
      ) : props.error ? (
        <EmptyState
          title="The records could not load"
          description={errorMessage(props.error)}
          actionLabel="Try again"
          onAction={props.onRetry}
        />
      ) : (
        <DataTable
          {...props}
          frameless
          columns={columns}
          rows={view.rowsOnPage}
          sortId={props.sortId ?? view.sortId}
          sortDirection={props.sortDirection ?? view.sortDirection}
          onSortChange={props.onSortChange ?? ((id) => view.setSort(id))}
          emptyState={
            !search && typeof props.emptyState !== "string" && props.emptyState != null ? (
              props.emptyState
            ) : (
              <EmptyState
                title={search ? "No matching records" : "No records yet"}
                description={
                  typeof props.emptyState === "string"
                    ? props.emptyState
                    : "Records will appear here when created."
                }
              />
            )
          }
        />
      )}
      <Pagination
        total={view.totalRows}
        page={view.page}
        onPageChange={view.setPage}
        perPage={view.perPage}
        onPerPageChange={view.setPerPage}
      />
    </Card>
  );
}
