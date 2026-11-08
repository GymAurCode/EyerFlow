/**
 * Editable line-items table shared by the sale and purchase dialogs.
 *
 * One component serves both: the columns differ (a sale shows cost, price and
 * profit per line; a purchase shows cost and total) but the row behaviour -
 * pick a product, type a quantity, remove the line - is identical, and keeping
 * one implementation is what stops the two dialogs drifting apart.
 */

import { Plus, Trash2 } from "lucide-react";
import type { ProductDto } from "../../../shared/types";
import { formatQuantity } from "../../lib/format";
import { Button } from "../ui/Button";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { Input } from "../ui/Input";

export interface LineItem {
  readonly id: number;
  readonly productId: number | null;
  readonly description: string;
  readonly quantityText: string;
  readonly costText: string;
  readonly priceText: string;
}

export interface LineItemsEditorProps {
  readonly items: readonly LineItem[];
  readonly products: readonly ProductDto[];
  /** A sale shows both a cost and a price per line; a purchase only a cost. */
  readonly isSale: boolean;
  /**
   * Whether to show the profit column and computed profit. Hidden for Staff,
   * who may still record the sale - only the profit figure is withheld.
   */
  readonly showProfit: boolean;
  readonly costLabel: string;
  readonly onChange: (items: readonly LineItem[]) => void;
}

let nextId = 1;

export function newLineItem(): LineItem {
  return {
    id: nextId++,
    productId: null,
    description: "",
    quantityText: "1",
    costText: "0",
    priceText: "0",
  };
}

export function productOptions(products: readonly ProductDto[]): ComboboxOption[] {
  return products.map((product) => ({
    value: product.id,
    label: product.name,
    hint: product.category ?? undefined,
    meta: `${String(formatQuantity(product.quantityMilli))} in stock`,
  }));
}

export function LineItemsEditor({
  items,
  products,
  isSale,
  showProfit,
  costLabel,
  onChange,
}: LineItemsEditorProps): React.JSX.Element {
  const productMap = new Map<number, ProductDto>();
  products.forEach((p) => productMap.set(p.id, p));

  const update = (id: number, patch: Partial<LineItem>): void => {
    onChange(items.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const pickProduct = (id: number, productId: number | null): void => {
    const product = productId !== null ? productMap.get(productId) : undefined;
    update(id, {
      productId,
      description: product?.name ?? "",
      // Pre-fill cost from the last purchase cost and price from the last sale
      // price. Both are editable; the user overrides them per line.
      costText: product && product.lastCostFils > 0 ? String(product.lastCostFils / 100) : "0",
      priceText:
        product && product.lastSalePriceFils > 0 ? String(product.lastSalePriceFils / 100) : "0",
    });
  };

  const addLine = (): void => {
    onChange([...items, newLineItem()]);
  };

  const removeLine = (id: number): void => {
    onChange(items.filter((line) => line.id !== id));
  };

  return (
    <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-[var(--divider)] text-start text-xs text-[var(--text-secondary)]">
            <th className="px-2 py-1.5 font-medium">Product</th>
            <th className="w-20 px-2 py-1.5 text-end font-medium">Qty</th>
            <th className="w-24 px-2 py-1.5 text-end font-medium">{costLabel}</th>
            {isSale ? (
              <>
                <th className="w-24 px-2 py-1.5 text-end font-medium">Sell at</th>
                {showProfit && <th className="w-24 px-2 py-1.5 text-end font-medium">Profit</th>}
              </>
            ) : (
              <th className="w-24 px-2 py-1.5 text-end font-medium">Line total</th>
            )}
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {items.map((line) => {
            const qty = Number(line.quantityText) || 0;
            const cost = Number(line.costText) || 0;
            const price = Number(line.priceText) || 0;
            const profit = (price - cost) * qty;
            const product = line.productId !== null ? productMap.get(line.productId) : undefined;
            const overStock =
              product !== undefined && qty * 1000 > product.quantityMilli && qty > 0;

            return (
              <tr key={line.id} className="border-b border-[var(--divider)] last:border-0">
                <td className="px-2 py-1.5">
                  <div className="space-y-1">
                    <Combobox
                      options={productOptions(products)}
                      value={line.productId}
                      onChange={(value) => {
                        pickProduct(line.id, value === "" ? null : Number(value));
                      }}
                      placeholder="Pick a product"
                      ariaLabel="Product"
                    />
                    <Input
                      value={line.description}
                      onChange={(event) => {
                        update(line.id, { description: event.target.value });
                      }}
                      placeholder="Description"
                      className="h-8 text-xs"
                      aria-label="Description"
                    />
                    {overStock && (
                      <p className="text-[11px] text-danger-fg">
                        Only {formatQuantity(product?.quantityMilli ?? 0)} in stock
                      </p>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    min={0}
                    step="0.001"
                    value={line.quantityText}
                    onChange={(event) => {
                      update(line.id, { quantityText: event.target.value });
                    }}
                    className="h-8 w-full text-right text-xs"
                    aria-label="Quantity"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={line.costText}
                    onChange={(event) => {
                      update(line.id, { costText: event.target.value });
                    }}
                    className="h-8 w-full text-right text-xs"
                    aria-label={costLabel}
                  />
                </td>
                {isSale ? (
                  <>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={line.priceText}
                        onChange={(event) => {
                          update(line.id, { priceText: event.target.value });
                        }}
                        className="h-8 w-full text-right text-xs"
                        aria-label="Sell at"
                      />
                    </td>
                    {showProfit && (
                      <td className="px-2 py-1.5 text-end">
                        <span
                          className={`tabular text-xs font-medium ${
                            profit < 0 ? "text-danger-fg" : "text-success-fg"
                          }`}
                        >
                          {new Intl.NumberFormat("en-AE", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }).format(profit)}
                        </span>
                        {price < cost && (
                          <p className="text-[10px] font-medium text-danger-fg">Loss</p>
                        )}
                      </td>
                    )}
                  </>
                ) : (
                  <td className="tabular px-2 py-1.5 text-end text-xs font-medium text-[var(--text-primary)]">
                    {new Intl.NumberFormat("en-AE", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format(cost * qty)}
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      removeLine(line.id);
                    }}
                    className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger-fg)]"
                    aria-label="Remove line"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Button
        variant="secondary"
        size="sm"
        iconLeft={<Plus className="h-3.5 w-3.5" />}
        onClick={addLine}
        className="mt-2"
      >
        Add item
      </Button>
    </div>
  );
}
