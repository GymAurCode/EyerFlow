/**
 * Mini horizontal bars for Top 5 products.
 */

export interface MiniBarItem {
  readonly name: string;
  readonly value: number;
  readonly display?: string | undefined;
}

export interface MiniBarsProps {
  
  readonly data: readonly MiniBarItem[];
  readonly maxValue?: number | undefined;
}

export function MiniBars({ data, maxValue }: MiniBarsProps): React.JSX.Element {
  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1);

  if (data.length === 0) {
    return <p className="py-4 text-center text-xs text-[var(--text-muted)]">No data yet.</p>;
  }

  return (
    <div className="space-y-2">
      {data.map((item) => {
        const pct = Math.round((item.value / max) * 100);
        return (
          <div key={item.name}>
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-[var(--text-secondary)]">{item.name}</span>
              <span className="tabular shrink-0 text-[var(--text-muted)]">
                {item.display ?? item.value.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
              <div
                className="h-full rounded-full bg-[var(--chart-primary)] transition-[width] duration-normal"
                style={{ width: `${String(pct)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
