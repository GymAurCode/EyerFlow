/**
 * Lookup cache for the pickers inside dialogs.
 *
 * Products, customers, suppliers and categories are small, slow-changing lists
 * that every dialog needs the instant it opens. Fetching them per-dialog meant
 * a sale waited on two SQLite round trips before it could draw, and a purchase
 * did the same again - which read as the dialog being slow to appear.
 *
 * Instead they are loaded once when the app starts and kept here in memory. A
 * dialog reads the cache synchronously during render, so its first paint costs
 * nothing but the DOM it actually needs. Saves call `invalidateLookups()`, which
 * refetches in the background; the next dialog open already sees the new row.
 *
 * This is deliberately not react-query: the value has to be readable during
 * render without subscribing the caller, so opening a dialog cannot re-render
 * the list page behind it.
 */

import { useEffect, useState } from "react";
import { call } from "./api";
import type { PartyDto, ProductDto } from "../../shared/types";

export type LookupKind = "product" | "customer" | "supplier";

interface CacheEntry {
  /** The rows themselves. Readers narrow this to their own DTO type. */
  data: readonly unknown[];
  /** In-flight load, so concurrent readers share one round trip. */
  pending: Promise<void> | null;
  loaded: boolean;
}

const EMPTY: CacheEntry = { data: [], pending: null, loaded: false };

const cache: Record<LookupKind, CacheEntry> = {
  product: { ...EMPTY },
  customer: { ...EMPTY },
  supplier: { ...EMPTY },
};

/** Alphabetical by name, so a cached list always arrives in the order shown. */
function byName(rows: readonly { name: string }[]): readonly { name: string }[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchKind(kind: LookupKind): Promise<void> {
  switch (kind) {
    case "product":
      cache.product.data = byName(await call("products.list", { limit: 2000 }));
      return;
    case "customer":
      cache.customer.data = byName(
        await call("parties.list", { kind: "customer", limit: 2000 }),
      );
      return;
    case "supplier":
      cache.supplier.data = byName(
        await call("parties.list", { kind: "supplier", limit: 2000 }),
      );
      return;
  }
}

/**
 * The distinct categories in use, derived from the cached product list.
 *
 * A category is free text on the product rather than a row of its own, so
 * there is nothing to fetch: the picker offers what has already been typed.
 */
export function readCategories(): string[] {
  const seen = new Set<string>();
  for (const row of cache.product.data as readonly { category: string | null }[]) {
    if (row.category !== null && row.category.length > 0) seen.add(row.category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Read a cached list without triggering a fetch.
 *
 * Returns an empty array on the very first call, before the prefetch lands.
 * Callers that must not show a blank picker check `isLookupLoading`.
 */
export function readLookup<T>(kind: LookupKind): readonly T[] {
  return cache[kind].data as readonly T[];
}

/** Whether a list has finished its first load. */
export function isLookupLoaded(kind: LookupKind): boolean {
  return cache[kind].loaded;
}

/**
 * Load a list if it is not already cached, and share the request between
 * concurrent callers. Never throws: a failed prefetch leaves the cache empty
 * and a later `invalidateLookups` retries.
 */
export function ensureLookup(kind: LookupKind): Promise<void> {
  const entry = cache[kind];
  if (entry.pending !== null) return entry.pending;

  const promise = fetchKind(kind)
    .then(() => {
      entry.loaded = true;
      notifyLookupChanged(kind);
    })
    .catch(noop)
    .then(() => {
      entry.pending = null;
    });

  entry.pending = promise;
  return promise;
}

function noop(): void {
  /* Swallowed on purpose: a prefetch failure must not reject a render. */
}

/**
 * Drop a cached list and refetch it.
 *
 * Called after any save that could change one - adding a product, recording a
 * purchase that moves a cost, editing a customer. The refetch is fire and
 * forget: the dialog that triggered it has already saved and closed, and the
 * updated list is only needed the next time a picker opens.
 */
export function invalidateLookups(...kinds: LookupKind[]): void {
  const targets = kinds.length > 0 ? kinds : (Object.keys(cache) as LookupKind[]);
  for (const kind of targets) {
    cache[kind].data = [];
    cache[kind].loaded = false;
    cache[kind].pending = null;
  }
  for (const kind of targets) {
    void ensureLookup(kind);
  }
}

/** Warm the cache. Called once the user is signed in and the app is usable. */
export function prefetchLookups(): void {
  for (const kind of Object.keys(cache) as LookupKind[]) {
    void ensureLookup(kind);
  }
}

export type { PartyDto, ProductDto };

/**
 * Subscribe a component to one cached list.
 *
 * Only re-renders when the list for `kind` actually changes - the four hooks
 * are independent, so a new product does not wake a customer picker.
 */
export function useLookup<T>(kind: LookupKind): readonly T[] {
  const [rows, setRows] = useState<readonly T[]>(() => readLookup<T>(kind));

  useEffect(() => {
    let cancelled = false;

    const sync = (): void => {
      if (cancelled) return;
      setRows(readLookup<T>(kind));
    };

    // The prefetch may already be in flight; adopt it, then follow the cache.
    void ensureLookup(kind).then(sync);
    const unsubscribe = subscribe(kind, sync);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [kind]);

  return rows;
}

type Listener = () => void;
const listeners = new Map<LookupKind, Set<Listener>>();

function subscribe(kind: LookupKind, listener: Listener): () => void {
  const set = listeners.get(kind) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(kind, set);
  return () => {
    set.delete(listener);
  };
}

/**
 * Tell every subscriber of a list that its contents changed.
 *
 * Called when a prefetch resolves, so a picker that opened before the data
 * landed fills itself in without the user reopening the dialog.
 */
export function notifyLookupChanged(kind: LookupKind): void {
  const set = listeners.get(kind);
  if (set === undefined) return;
  for (const listener of [...set]) listener();
}