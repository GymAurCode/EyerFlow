/**
 * Combobox: a searchable select.
 *
 * Every party, product and document picker in the app uses this. Typing filters,
 * arrow keys move the highlight, Enter picks, Escape closes — the keyboard flow
 * a counter assistant expects when entering an invoice without touching the
 * mouse.
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Ceiling on rendered options.
 *
 * A busy shop can hold a couple of thousand products. Mounting one row per
 * match turned every keystroke in a picker into thousands of DOM insertions and
 * made the whole dialog feel stuck. Fifty rows is far more than anyone scrolls
 * before typing a second character, and the counter below the list tells them
 * to do exactly that.
 */
const MAX_RENDERED = 50;

export interface ComboboxOption {
  readonly value: number | string;
  readonly label: string;
  /** Secondary line: code, phone, stock level. */
  readonly hint?: string | undefined;
  /** Right-aligned meta: balance, stock, price. */
  readonly meta?: string | undefined;
  readonly disabled?: boolean | undefined;
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  readonly value: number | string | null;
  readonly onChange: (value: number | string | null) => void;
  readonly placeholder?: string | undefined;
  readonly searchPlaceholder?: string | undefined;
  readonly emptyMessage?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly invalid?: boolean | undefined;
  readonly id?: string | undefined;
  readonly ariaLabel?: string | undefined;
  /** Receives the typed term so a caller can fetch more options. */
  readonly onSearch?: (term: string) => void | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * Case-insensitive match across label, hint and meta.
 *
 * A search for a customer's phone fragment should find them even though the
 * phone number is only shown as a hint, which is why all three are searched.
 * The needle is already trimmed and lower-cased by the caller.
 */
function matches(option: ComboboxOption, needle: string): boolean {
  return (
    option.label.toLowerCase().includes(needle) ||
    (option.hint ?? "").toLowerCase().includes(needle) ||
    (option.meta ?? "").toLowerCase().includes(needle)
  );
}

interface OptionRowProps {
  readonly option: ComboboxOption;
  readonly index: number;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly onHighlight: (index: number) => void;
  readonly onChoose: (option: ComboboxOption) => void;
}

/**
 * One row of the dropdown.
 *
 * Memoised because the mouse moving across the list changes only `highlighted`
 * - without it, hovering one row would re-render all fifty and the list would
 * stutter under the pointer.
 */
const OptionRow = memo(function OptionRow({
  option,
  index,
  selected,
  highlighted,
  onHighlight,
  onChoose,
}: OptionRowProps): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={option.disabled === true}
        onMouseEnter={() => {
          onHighlight(index);
        }}
        onClick={() => {
          onChoose(option);
        }}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm",
          "focus-visible:outline-none disabled:opacity-50",
          highlighted ? "bg-[var(--table-row-hover)]" : "",
          selected && "font-medium text-[var(--brand)]",
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-[var(--text)]">{option.label}</span>
          {option.hint !== undefined && (
            <span className="block truncate text-xs text-[var(--text-3)]">{option.hint}</span>
          )}
        </span>
        {option.meta !== undefined && (
          <span className="tabular shrink-0 text-xs text-[var(--text-2)]">{option.meta}</span>
        )}
      </button>
    </li>
  );
});

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder,
  emptyMessage = "Nothing found",
  disabled = false,
  invalid = false,
  id,
  ariaLabel,
  onSearch,
  autoFocus = false,
  className,
}: ComboboxProps): React.JSX.Element {
  const generated = useId();
  const listId = `${id ?? generated}-list`;
  const inputId = `${id ?? generated}-input`;

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [highlight, setHighlight] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((option) => option.value === value) ?? null;

  // Filtering is done over the cached list in memory - no round trip per
  // keystroke - and only the first MAX_RENDERED matches reach the DOM.
  const { visible, matchCount } = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) {
      const slice = options.slice(0, MAX_RENDERED);
      return { visible: slice, matchCount: options.length };
    }

    const hits: ComboboxOption[] = [];
    let count = 0;
    for (const option of options) {
      if (!matches(option, needle)) continue;
      count += 1;
      if (hits.length < MAX_RENDERED) hits.push(option);
    }
    return { visible: hits, matchCount: count };
  }, [options, term]);

  const highlightedOption = visible[highlight] ?? null;

  const onHighlight = useCallback((index: number) => {
    setHighlight(index);
  }, []);

  // Keep the highlight on a valid row whenever the filtered list changes.
  useEffect(() => {
    setHighlight((current) => {
      if (visible.length === 0) return 0;
      return Math.min(current, visible.length - 1);
    });
  }, [visible.length]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open && autoFocus) inputRef.current?.focus();
  }, [open, autoFocus]);

  const choose = (option: ComboboxOption): void => {
    onChange(option.value);
    setTerm("");
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => Math.min(current + 1, Math.max(0, visible.length - 1)));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === "Enter") {
      if (open) {
        event.preventDefault();
        if (highlightedOption !== null && highlightedOption.disabled !== true) {
          choose(highlightedOption);
        }
      }
      return;
    }

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "glass-input flex h-10 items-center gap-2 rounded-lg px-3 focus-within:ring-0",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-text",
          invalid ? "border-[var(--danger)]" : "",
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-[var(--text-3)]" aria-hidden="true" />

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          value={open ? term : (selected?.label ?? "")}
          placeholder={open ? (searchPlaceholder ?? placeholder) : (selected?.label ?? placeholder)}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
            setHighlight(0);
            onSearch?.(event.target.value);
          }}
          onFocus={() => {
            setOpen(true);
            setTerm("");
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
        />

        {selected !== null && !disabled && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => {
              onChange(null);
              setTerm("");
            }}
            className="rounded text-[var(--text-3)] transition-colors duration-fast hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          onClick={() => {
            setOpen((current) => !current);
          }}
          className="shrink-0 text-[var(--text-3)]"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-fast", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="glass-float absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-xl py-1 animate-slide-up"
        >
          {visible.length === 0 ? (
            <li className="px-3 py-3 text-center text-sm text-[var(--text-3)]">{emptyMessage}</li>
          ) : (
            <>
              {visible.map((option, index) => (
                <OptionRow
                  key={String(option.value)}
                  option={option}
                  index={index}
                  selected={option.value === value}
                  highlighted={index === highlight}
                  onHighlight={onHighlight}
                  onChoose={choose}
                />
              ))}

              {matchCount > visible.length && (
                <li className="border-t border-[var(--border)] px-3 py-2 text-center text-xs text-[var(--text-3)]">
                  Showing {visible.length} of {matchCount} - keep typing to narrow it down
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
