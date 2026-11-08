/**
 * Product catalogue and stock.
 *
 * The product form is deliberately simple: a name, an opening quantity, a unit
 * and an optional category. Cost and price are not stored on the product - the
 * "Last cost" and "Last sale price" columns are read-only values taken from the
 * most recent purchase and sale, so there is nothing to maintain here.
 *
 * The form is laid out as the two cards it really is: what the item *is*, and
 * how much of it there is. Stock is never written by this form on an existing
 * product - that is the stock count dialog's job, and it keeps the audit trail.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  History,
  Package,
  Pencil,
  Plus,
  Printer,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import type { ProductDto, StockMovementDto } from "../../../shared/types";
import { call, errorField, errorMessage } from "../../lib/api";
import { invalidateLookups } from "../../lib/lookups";
import { useApp } from "../../lib/app-context";
import { formatAmount, formatMoney, formatQuantity, parseQuantity } from "../../lib/format";
import { formatDate } from "../../lib/utils";
import { productDocumentHtml, stockMovementsDocumentHtml } from "../../lib/print-records";
import { Avatar } from "../../components/ui/Avatar";
import { Badge, StockBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, FormSection } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { DeleteConfirmDialog } from "../../components/ui/DeleteConfirmDialog";
import { DetailList, DetailRow } from "../../components/ui/DetailList";
import {
  DocumentPrintDialog,
  type PrintableDocument,
} from "../../components/print/DocumentPrintDialog";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { Pagination, useTableView } from "../../components/ui/Dropdown";
import { HighlightText } from "../../components/ui/HighlightText";
import { RecordActions, standardRecordActions } from "../../components/ui/RecordActions";
import { EmptyState, PageHeader, TableSkeleton } from "../../components/ui/Feedback";
import { Field, Input, Select, type SelectOption } from "../../components/ui/Input";
import { useSearchHighlight } from "../../lib/search-highlight";

const UNITS = ["pcs", "litre", "metre", "box", "set", "kg", "hour"] as const;

const productKey = (row: ProductDto): number => row.id;

/** The same fields `products.list` searches. */
const PRODUCT_SEARCH_FIELDS = [
  (row: ProductDto) => row.name,
  (row: ProductDto) => row.sku,
  (row: ProductDto) => row.barcode,
];

const PRODUCT_RANK_FIELDS = [(row: ProductDto) => row.name, (row: ProductDto) => row.sku];

/** The unit list the catalogue offers, as select options. */
const unitOptions: SelectOption[] = UNITS.map((value) => ({ value, label: value }));

const MOVEMENT_LABELS: Record<StockMovementDto["kind"], string> = {
  receipt: "Purchase",
  issue: "Sale",
  reversal: "Reversal",
  adjustmentIn: "Count up",
  adjustmentOut: "Count down",
  opening: "Opening",
};

export function ProductsPage(): React.JSX.Element {
  const { can, settings } = useApp();
  const client = useQueryClient();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [onlyLowStock, setOnlyLowStock] = useState(false);
  const [editing, setEditing] = useState<ProductDto | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [viewing, setViewing] = useState<ProductDto | null>(null);
  const [deleting, setDeleting] = useState<ProductDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [printing, setPrinting] = useState<PrintableDocument | null>(null);
  const [stockFor, setStockFor] = useState<ProductDto | null>(null);
  const [movementsFor, setMovementsFor] = useState<ProductDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["products", { search, category, onlyLowStock }],
    queryFn: () =>
      call("products.list", {
        ...(search.length > 0 ? { search } : {}),
        ...(category.length > 0 ? { category } : {}),
        ...(onlyLowStock ? { onlyLowStock: true } : {}),
        limit: 1000,
      }),
  });

  const rows = useMemo(() => data ?? [], [data]);

  const highlight = useSearchHighlight(rows, search, {
    rowKey: productKey,
    fields: PRODUCT_SEARCH_FIELDS,
    rankFields: PRODUCT_RANK_FIELDS,
  });

  const categories = useMemo(
    () =>
      Array.from(
        new Set(rows.map((row) => row.category).filter((value): value is string => value !== null)),
      ).sort(),
    [rows],
  );

  // The filter's option list, and "All Categories" is the control's own
  // placeholder rather than an option: Radix reserves "" for nothing chosen.
  const categoryOptions = useMemo<SelectOption[]>(
    () => categories.map((value) => ({ value, label: value })),
    [categories],
  );

  const lowStockCount = useMemo(() => rows.filter((row) => row.isLowStock).length, [rows]);
  const totalValue = useMemo(() => rows.reduce((sum, row) => sum + row.stockValueFils, 0), [rows]);

  const columns: readonly Column<ProductDto>[] = [
    {
      id: "name",
      header: "Product",
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={row.name} size="sm" square tone="neutral" />
          <span className="truncate font-medium text-[var(--text)]">
            <HighlightText text={row.name} term={search} />
          </span>
        </div>
      ),
      sortValue: (row) => row.name,
    },
    {
      id: "sku",
      header: "SKU",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">
          <HighlightText text={row.sku} term={search} />
        </span>
      ),
      sortValue: (row) => row.sku,
    },
    {
      id: "category",
      header: "Category",
      cell: (row) => <span className="text-[var(--text-2)]">{row.category ?? "—"}</span>,
      sortValue: (row) => row.category,
    },
    {
      id: "unit",
      header: "Unit",
      cell: (row) => <span className="text-[var(--text-2)]">{row.unit}</span>,
      sortValue: (row) => row.unit,
    },
    {
      id: "stock",
      header: "Stock",
      align: "end",
      cell: (row) => (
        <span
          className={row.isLowStock ? "font-medium text-[var(--danger)]" : "text-[var(--text)]"}
        >
          {formatQuantity(row.quantityMilli)}
        </span>
      ),
      sortValue: (row) => row.quantityMilli,
    },
    {
      id: "cost",
      header: "Last cost",
      align: "end",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">
          {row.lastCostFils > 0 ? formatAmount(row.lastCostFils) : "—"}
        </span>
      ),
      sortValue: (row) => row.lastCostFils,
    },
    {
      id: "price",
      header: "Last sale price",
      align: "end",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">
          {row.lastSalePriceFils > 0 ? formatAmount(row.lastSalePriceFils) : "—"}
        </span>
      ),
      sortValue: (row) => row.lastSalePriceFils,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => (
        <StockBadge
          quantityMilli={row.quantityMilli}
          isLowStock={row.isLowStock}
          isActive={row.isActive}
        />
      ),
      sortValue: (row) => (row.quantityMilli <= 0 ? 0 : row.isLowStock ? 1 : 2),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      widthClass: "w-14",
      cell: (row) => <RecordActions items={actionsFor(row)} />,
    },
  ];

  function actionsFor(row: ProductDto): ReturnType<typeof standardRecordActions> {
    const items = standardRecordActions({
      canView: true,
      onView: () => {
        setViewing(row);
      },
      canEdit: can("products", "edit"),
      onEdit: () => {
        setEditing(row);
        setEditorOpen(true);
      },
      canPrint: true,
      onPrint: () => {
        // The document is shown first: printing is never a leap of faith.
        setPrinting({
          html: productDocumentHtml(row, { settings }),
          title: `Product ${row.sku}`,
          description: row.name,
          filename: `${row.sku}.pdf`,
        });
      },
      canDelete: can("products", "delete"),
      onDelete: () => {
        setDeleting(row);
      },
    });

    if (can("inventory", "edit")) {
      items.push(
        {
          id: "stock",
          label: "Adjust stock",
          icon: <Boxes className="h-4 w-4" />,
          onSelect: () => {
            setStockFor(row);
          },
        },
        {
          id: "movements",
          label: "Movements",
          icon: <History className="h-4 w-4" />,
          onSelect: () => {
            setMovementsFor(row);
          },
        },
      );
    }

    return items;
  }

  const confirmDelete = (): void => {
    if (deleting === null || deleteBusy) return;
    setDeleteBusy(true);

    void call("products.delete", { id: deleting.id })
      .then(() => {
        toast.success(`"${deleting.name}" deleted`);
        void client.invalidateQueries({ queryKey: ["products"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        invalidateLookups("product");
        setDeleting(null);
        setViewing(null);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const view = useTableView(rows, columns, 25, {
    focusKey: highlight.primaryKey,
    rowKey: productKey,
  });

  const openEditor = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  // The dashboard's quick actions reach this screen from elsewhere, so the
  // create dialog is opened by the same event the shell already uses for sales
  // and purchases.
  useEffect(() => {
    const onNewProduct = (): void => {
      if (!can("products", "create")) return;
      setEditing(null);
      setEditorOpen(true);
    };
    window.addEventListener("eyerstock:new-product", onNewProduct);
    return () => {
      window.removeEventListener("eyerstock:new-product", onNewProduct);
    };
  }, [can]);

  return (
    <div>
      <PageHeader
        title="Products"
        description="The catalogue and what is currently on the shelf."
        actions={
          can("products", "create") ? (
            <Button variant="primary" iconLeft={<Plus className="h-4 w-4" />} onClick={openEditor}>
              New product
            </Button>
          ) : undefined
        }
      />

      <Card flush>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
          <div className="w-[280px]">
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
                    placeholder="Name, category or code"
                    className="ps-9"
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="w-[180px]">
            <Select
              value={category}
              options={categoryOptions}
              placeholder="All Categories"
              onChange={(next) => {
                setCategory(next);
              }}
              aria-label="Category filter"
            />
          </div>

          <Button
            variant={onlyLowStock ? "primary" : "secondary"}
            iconLeft={<AlertTriangle className="h-4 w-4" />}
            aria-pressed={onlyLowStock}
            onClick={() => {
              setOnlyLowStock(!onlyLowStock);
            }}
          >
            Low stock
          </Button>

          {rows.length > 0 && (
            <div className="ms-auto flex items-center gap-4 text-[13px] text-[var(--text-2)]">
              <SummaryStat label="Products" value={String(rows.length)} />
              <SummaryStat label="Low stock" value={String(lowStockCount)} />
              <SummaryStat label="Stock value" value={formatMoney(totalValue)} />
            </div>
          )}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="p-4">
            <TableSkeleton columns={7} rows={8} />
          </div>
        ) : (
          <>
            <DataTable
              frameless
              columns={columns}
              rows={view.rowsOnPage}
              rowKey={(row) => row.id}
              onRowClick={(row) => {
                setViewing(row);
              }}
              sortId={view.sortId}
              sortDirection={view.sortDirection}
              onSortChange={view.setSort}
              hiddenColumnIds={view.hiddenColumnIds}
              highlightedRowKeys={highlight.keys}
              primaryRowKey={highlight.primaryKey}
              scrollToRowKey={highlight.primaryKey}
              caption="Products"
              compact
              emptyState={
                <EmptyState
                  compact
                  icon={<Package className="h-5 w-5" />}
                  title="No products yet"
                  description="Add the items you sell so invoices and purchases can pick them from a list."
                  actionLabel={can("products", "create") ? "New product" : undefined}
                  onAction={can("products", "create") ? openEditor : undefined}
                />
              }
            />
            <Pagination
              total={view.totalRows}
              page={view.page}
              onPageChange={view.setPage}
              perPage={view.perPage}
              onPerPageChange={view.setPerPage}
              itemLabel="products"
            />
          </>
        )}
      </Card>

      <ProductEditor
        open={editorOpen}
        product={editing}
        categories={categories}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
      />

      <ProductDetailDialog
        product={viewing}
        canEdit={can("products", "edit")}
        canDelete={can("products", "delete")}
        onClose={() => {
          setViewing(null);
        }}
        onEdit={(product) => {
          setViewing(null);
          setEditing(product);
          setEditorOpen(true);
        }}
        onDelete={(product) => {
          setDeleting(product);
        }}
        onPrint={(product) => {
          setPrinting({
            html: productDocumentHtml(product, { settings }),
            title: `Product ${product.sku}`,
            description: product.name,
            filename: `${product.sku}.pdf`,
          });
        }}
      />

      <DeleteConfirmDialog
        open={deleting !== null}
        subject={deleting === null ? "" : `"${deleting.name}"`}
        message={
          deleting === null
            ? ""
            : `"${deleting.name}" will be removed from the catalogue. This cannot be undone. ` +
              "An item that has stock history or invoices against it cannot be deleted - mark it inactive instead."
        }
        busy={deleteBusy}
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={confirmDelete}
      />

      <DocumentPrintDialog
        open={printing !== null}
        html={printing?.html ?? ""}
        title={printing?.title ?? ""}
        description={printing?.description}
        filename={printing?.filename ?? "document.pdf"}
        orientation={printing?.orientation}
        onClose={() => {
          setPrinting(null);
        }}
      />

      <StockCountDialog
        product={stockFor}
        onClose={() => {
          setStockFor(null);
        }}
      />

      <MovementsDialog
        product={movementsFor}
        onClose={() => {
          setMovementsFor(null);
        }}
        onPrint={(document) => {
          setPrinting(document);
        }}
      />
    </div>
  );
}

function SummaryStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[var(--text-3)]">{label}:</span>
      <span className="tabular font-medium text-[var(--text)]">{value}</span>
    </span>
  );
}

function ProductEditor({
  open,
  product,
  categories,
  onClose,
}: {
  readonly open: boolean;
  readonly product: ProductDto | null;
  readonly categories: readonly string[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [openingText, setOpeningText] = useState("0");
  const [unit, setUnit] = useState<string>("pcs");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAt, setErrorAt] = useState<string | undefined>(undefined);
  const [seeded, setSeeded] = useState<number | null>(null);

  // Seed once per opened product, in an effect rather than during render.
  // Setting state while rendering makes React throw the work away and
  // immediately re-render the whole dialog, which doubled the cost of opening
  // it for no benefit.
  useEffect(() => {
    if (!open) return;
    const seedKey = product?.id ?? null;
    if (seeded === seedKey) return;
    setSeeded(seedKey);
    setName(product?.name ?? "");
    setOpeningText(product === null ? "0" : String(product.quantityMilli / 1000));
    setUnit(product?.unit ?? "pcs");
    setCategory(product?.category ?? "");
    setError(null);
    setErrorAt(undefined);
  }, [open, product, seeded]);

  const submit = (): void => {
    if (busy) return;
    setError(null);
    setErrorAt(undefined);
    setBusy(true);

    void call("products.save", {
      ...(product === null ? {} : { id: product.id }),
      name: name.trim(),
      category: category.trim().length > 0 ? category.trim() : null,
      unit,
      ...(product === null ? { openingQuantityMilli: parseQuantity(openingText) ?? 0 } : {}),
    })
      .then(() => {
        toast.success(product === null ? "Product added" : "Product updated");
        // Pickers in sale/purchase dialogs read this cache; a new product has
        // to be in it before the next one is opened.
        invalidateLookups("product");
        void client.invalidateQueries({ queryKey: ["products"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        onClose();
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
        setErrorAt(errorField(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title={product === null ? "New product" : "Edit product"}
      description={product === null ? "Add an item to the catalogue." : product.name}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSection title="Product Information" className="sm:col-span-2">
          <div className="space-y-3">
            <Field label="Product name" required error={errorAt === "name" ? error : null}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  autoFocus
                />
              )}
            </Field>

            <Field label="Category" hint="Groups the item on the list and in reports.">
              {(id) => (
                <>
                  <Input
                    id={id}
                    value={category}
                    onChange={(event) => {
                      setCategory(event.target.value);
                    }}
                    placeholder="Filters, cartridges, spares"
                  />
                  {/* Offer what is already in use without forcing it: the
                      catalogue has never required a category, and a shop with
                      its own wording must still be able to type it.

                      These are buttons rather than a <datalist>, because a
                      datalist popup is painted by the operating system and
                      cannot be themed - it came up white-on-white in the dark
                      palette, which is the same bug the native selects had. */}
                  {categories.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {categories.map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            setCategory(value);
                          }}
                          className="rounded-full border border-[var(--glass-border)] bg-[var(--surface-2)] px-2 py-0.5 text-[11.5px] text-[var(--text-2)] transition-colors duration-fast hover:border-[var(--brand)] hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Stock"
          description={
            product === null
              ? "What the item starts with. Later changes go through a stock count."
              : undefined
          }
          className="sm:col-span-2"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {product === null && (
              <Field
                label="Opening quantity"
                required
                hint="The stock this product starts with."
                error={errorAt === "openingQuantityMilli" ? error : null}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    step="0.001"
                    value={openingText}
                    onChange={(event) => {
                      setOpeningText(event.target.value);
                    }}
                  />
                )}
              </Field>
            )}

            <Field label="Unit" required>
              {(id) => (
                <Select
                  id={id}
                  value={unit}
                  options={unitOptions}
                  onChange={(next) => {
                    setUnit(next);
                  }}
                />
              )}
            </Field>

            {product !== null && (
              <div className="sm:col-span-2">
                <p className="mb-1.5 text-[13px] font-medium text-[var(--text)]">On hand</p>
                <p className="tabular flex h-10 items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] text-[var(--text-2)]">
                  {formatQuantity(product.quantityMilli)} {product.unit}
                </p>
              </div>
            )}
          </div>

          {product !== null && (
            <p className="mt-3 flex items-start gap-2 text-xs text-[var(--text-2)]">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              Use &ldquo;Adjust stock&rdquo; on the row to record a count. That writes a movement,
              so the history always explains the figure.
            </p>
          )}
        </FormSection>

        {error !== null && errorAt === undefined && (
          <p
            className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger)] sm:col-span-2"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ProductDetailDialog({
  product,
  canEdit,
  canDelete,
  onClose,
  onEdit,
  onDelete,
  onPrint,
}: {
  readonly product: ProductDto | null;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onClose: () => void;
  readonly onEdit: (product: ProductDto) => void;
  readonly onDelete: (product: ProductDto) => void;
  readonly onPrint: (product: ProductDto) => void;
}): React.JSX.Element {

  return (
    <Dialog
      open={product !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title={product?.name ?? ""}
      description={product === null ? undefined : product.sku}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {canDelete && product !== null && (
            <Button
              variant="danger"
              onClick={() => {
                onDelete(product);
              }}
            >
              Delete
            </Button>
          )}
          {product !== null && (
            <Button
              variant="secondary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint(product);
              }}
            >
              Print
            </Button>
          )}
          {canEdit && product !== null && (
            <Button
              variant="primary"
              iconLeft={<Pencil className="h-4 w-4" />}
              onClick={() => {
                onEdit(product);
              }}
            >
              Edit
            </Button>
          )}
        </>
      }
    >
      {product === null ? null : (
        <div className="space-y-4">
          <DetailList>
            <DetailRow label="Code" value={product.sku} />{" "}
            <DetailRow label="Unit" value={product.unit} />
            <DetailRow label="Category" value={product.category ?? "—"} />
            <DetailRow label="VAT treatment" value={product.vatTreatment} />
            <DetailRow
              label="On hand"
              value={`${formatQuantity(product.quantityMilli)} ${product.unit}`}
            />
            <DetailRow
              label="Reorder level"
              value={`${formatQuantity(product.reorderLevelMilli)} ${product.unit}`}
            />
            <DetailRow
              label="Reference cost"
              value={formatMoney(product.averageCostFils)}
            />
            <DetailRow
              label="Last purchase cost"
              value={formatMoney(product.lastCostFils)}
            />
            <DetailRow
              label="Last sale price"
              value={formatMoney(product.lastSalePriceFils)}
            />
            <DetailRow
              label="Stock value"
              value={formatMoney(product.stockValueFils)}
            />
            <DetailRow label="Status" value={product.isActive ? "Active" : "Inactive"} />
            <DetailRow label="Barcode" value={product.barcode ?? "—"} />
          </DetailList>

          {product.description !== null && product.description.trim().length > 0 && (
            <div>
              <p className="mb-1 text-[13px] font-medium text-[var(--text)]">Description</p>
              <p className="text-[13.5px] text-[var(--text-2)]">{product.description}</p>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function StockCountDialog({
  product,
  onClose,
}: {
  readonly product: ProductDto | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [countedText, setCountedText] = useState("");
  const [costText, setCostText] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (product === null) return;
    if (seeded === product.id) return;
    setSeeded(product.id);
    setCountedText(String(product.quantityMilli / 1000));
    setCostText(String(product.averageCostFils / 100));
    setNotes("");
    setError(null);
  }, [product, seeded]);

  const counted = parseQuantity(countedText);

  const submit = (): void => {
    if (product === null || busy) return;
    if (counted === null) {
      setError("Enter the quantity you counted.");
      return;
    }
    setError(null);
    setBusy(true);

    void call("products.openStock", {
      productId: product.id,
      quantityMilli: counted,
      unitCostFils: Math.round(Number(costText || "0") * 100),
      notes: notes.trim().length > 0 ? notes.trim() : undefined,
    })
      .then(() => {
        toast.success("Stock adjusted");
        void client.invalidateQueries({ queryKey: ["products"] });
        void client.invalidateQueries({ queryKey: ["dashboard"] });
        onClose();
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open={product !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="sm"
      title="Adjust stock"
      description={product?.name}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save count
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2.5 text-[13px] text-[var(--text-2)]">
          On hand now:{" "}
          <span className="tabular font-medium text-[var(--text)]">
            {product === null ? "" : `${formatQuantity(product.quantityMilli)} ${product.unit}`}
          </span>{" "}
          · reference cost{" "}
          <span className="tabular font-medium text-[var(--text)]">
            {product === null ? "" : formatMoney(product.averageCostFils)}
          </span>
        </div>

        <Field label="Counted quantity" required error={error}>
          {(id) => (
            <Input
              id={id}
              type="number"
              step="0.001"
              value={countedText}
              onChange={(event) => {
                setCountedText(event.target.value);
              }}
              autoFocus
            />
          )}
        </Field>

        <Field label="Unit cost" hint="Becomes the product's reference cost.">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              step="0.01"
              value={costText}
              onChange={(event) => {
                setCostText(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Reason" hint="Written on the stock movement.">
          {(id) => (
            <Input
              id={id}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
              placeholder="Stock count"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function MovementsDialog({
  product,
  onClose,
  onPrint,
}: {
  readonly product: ProductDto | null;
  readonly onClose: () => void;
  readonly onPrint: (document: PrintableDocument) => void;
}): React.JSX.Element {
  const { settings } = useApp();
  const { data, isLoading } = useQuery({
    queryKey: ["stock-movements", product?.id ?? 0],
    queryFn: () => call("products.movements", { productId: product?.id ?? 0, limit: 200 }),
    enabled: product !== null,
  });

  const rows = useMemo(() => data ?? [], [data]);

  const columns: readonly Column<StockMovementDto>[] = [
    {
      id: "date",
      header: "Date",
      cell: (row) => (
        <span className="tabular text-[var(--text-2)]">{formatDate(row.movementDate)}</span>
      ),
      sortValue: (row) => row.movementDate,
    },
    {
      id: "kind",
      header: "Kind",
      cell: (row) => (
        <Badge
          tone={row.kind === "issue" ? "warning" : row.kind === "receipt" ? "success" : "neutral"}
        >
          {MOVEMENT_LABELS[row.kind]}
        </Badge>
      ),
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
      cell: (row) => (
        <span className={row.quantityMilli < 0 ? "text-[var(--danger)]" : "text-[var(--text)]"}>
          {formatQuantity(row.quantityMilli)}
        </span>
      ),
      sortValue: (row) => row.quantityMilli,
    },
    {
      id: "cost",
      header: "Unit cost",
      align: "end",
      cell: (row) => formatAmount(row.unitCostFils),
      sortValue: (row) => row.unitCostFils,
    },
    {
      id: "value",
      header: "Value",
      align: "end",
      cell: (row) => formatAmount(row.costFils),
      sortValue: (row) => row.costFils,
    },
    {
      id: "notes",
      header: "Notes",
      cell: (row) => row.notes ?? "—",
      sortValue: (row) => row.notes,
    },
  ];

  return (
    <Dialog
      open={product !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title="Stock movements"
      description={product?.name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {product !== null && (
            <Button
              variant="primary"
              iconLeft={<Printer className="h-4 w-4" />}
              onClick={() => {
                onPrint({
                  html: stockMovementsDocumentHtml(
                    {
                      sku: product.sku,
                      name: product.name,
                      unit: product.unit,
                    },
                    rows,
                    { settings },
                  ),
                  title: `Stock Record ${product.sku}`,
                  description: product.name,
                  filename: `stock-movements-${product.sku}.pdf`,
                });
              }}
            >
              Print record
            </Button>
          )}
        </>
      }
    >
      {isLoading ? (
        <TableSkeleton columns={6} rows={6} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          caption="Stock movements"
          maxBodyHeight="24rem"
          compact
          emptyState={
            <EmptyState
              compact
              title="No movements yet"
              description="Purchases, sales and stock counts all appear here."
            />
          }
        />
      )}
    </Dialog>
  );
}
