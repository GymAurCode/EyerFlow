/**
 * Data hooks.
 *
 * Thin wrappers over the RPC layer that give every screen consistent loading,
 * error and refetch behaviour. Keeping them here means a screen never has to
 * remember to handle the "loading" branch, which is the main source of layout
 * flicker across an app this size.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call, errorMessage } from "./api";
import { formatAmount, formatQuantity } from "./format";

/* -------------------------------------------------------------------------- */
/* parties                                                                    */
/* -------------------------------------------------------------------------- */

export function useParties(kind: "customer" | "supplier", search = "") {
  return useQuery({
    queryKey: ["parties", kind, search],
    queryFn: () =>
      call("parties.list", {
        kind,
        ...(search.length > 0 ? { search } : {}),
      }),
  });
}

/**
 * Combobox options for a party picker.
 *
 * The balance is shown as the meta line because it is what a shopkeeper checks
 * before extending credit.
 */
export function usePartyOptions(
  kind: "customer" | "supplier",
  limit = 500,
): { readonly id: number; readonly label: string; readonly hint: string; readonly meta: string }[] {
  const { data } = useParties(kind);

  return (data ?? []).slice(0, limit).map((party) => ({
    id: party.id,
    label: party.name,
    hint: [party.code, party.phone].filter((value) => value !== null && value.length > 0).join(" · "),
    meta: formatAmount(party.balanceFils),
  }));
}

/* -------------------------------------------------------------------------- */
/* products                                                                   */
/* -------------------------------------------------------------------------- */

export function useProducts(search = "", category?: string) {
  return useQuery({
    queryKey: ["products", search, category ?? ""],
    queryFn: () =>
      call("products.list", {
        ...(search.length > 0 ? { search } : {}),
        ...(category !== undefined ? { category } : {}),
        limit: 1000,
      }),
  });
}

/** Combobox options for a product picker, with stock on hand as the hint. */
export function useProductOptions(): {
  readonly id: number;
  readonly label: string;
  readonly hint: string;
  readonly meta: string;
}[] {
  const { data } = useProducts();

  return (data ?? []).map((product) => ({
    id: product.id,
    label: product.name,
    hint: product.sku,
    meta: `${formatQuantity(product.quantityMilli)} ${product.unit}`,
  }));
}

/* -------------------------------------------------------------------------- */
/* documents                                                                  */
/* -------------------------------------------------------------------------- */

export function useDocuments(
  kind: "invoice" | "purchaseInvoice",
  filters: { readonly status?: string; readonly search?: string; readonly partyId?: number } = {},
) {
  return useQuery({
    queryKey: ["documents", kind, filters],
    queryFn: () =>
      call("documents.list", {
        kind,
        ...(filters.status !== undefined ? { status: filters.status as never } : {}),
        ...(filters.search !== undefined && filters.search.length > 0
          ? { search: filters.search }
          : {}),
        ...(filters.partyId !== undefined ? { partyId: filters.partyId } : {}),
        limit: 500,
      }),
  });
}

/* -------------------------------------------------------------------------- */
/* mutation helper                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a write so every caller gets a success toast and a consistent failure
 * message without repeating the try/catch.
 */
export function useWrite<TArgs, TResult>(
  mutation: (args: TArgs) => Promise<TResult>,
  options: {
    readonly successMessage?: string | undefined;
    readonly onSuccess?: (result: TResult) => void | undefined;
    readonly invalidate?: readonly (readonly (readonly unknown[])[])[] | undefined;
  },
): {
  readonly mutate: (args: TArgs) => void;
  readonly mutateAsync: (args: TArgs) => Promise<TResult>;
  readonly busy: boolean;
} {
  const client = useQueryClient();

  const run = useMutation({
    mutationFn: (args: TArgs): Promise<TResult> => mutation(args),
    onSuccess: (result) => {
      if (options.successMessage !== undefined) toast.success(options.successMessage);
      options.onSuccess?.(result);
      void client.invalidateQueries();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  return {
    mutate: (args) => {
      run.mutate(args);
    },
    mutateAsync: (args) => run.mutateAsync(args),
    busy: run.isPending,
  };
}
