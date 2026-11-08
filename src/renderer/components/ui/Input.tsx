/**
 * Form field primitives.
 *
 * Label above input, message underneath, required marker on the label.
 * Money inputs get a fixed currency prefix and right-aligned tabular numerals.
 * 40px controls, 8px radius, 13.5px text - the same height as the default
 * Button so a toolbar of filters lines up on one baseline.
 *
 * `Select` is the only dropdown in the app. A native `<select>` paints its
 * option list with the operating system's own colours, which no token can
 * reach: in the dark theme the list came up white-on-white and was unreadable.
 * It is therefore a Radix listbox in a portal, styled only through tokens, so a
 * dropdown is themed by exactly the same variables as everything around it.
 */

import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface FieldProps {
  readonly label?: ReactNode | undefined;
  readonly required?: boolean | undefined;
  readonly hint?: ReactNode | undefined;
  readonly error?: string | null | undefined;
  readonly children: (id: string, describedBy: string | undefined) => ReactNode;
  readonly className?: string | undefined;
  /** Renders the label for screen readers only (compact table filters). */
  readonly srLabelOnly?: boolean | undefined;
}

export function Field({
  label,
  required = false,
  hint,
  error,
  children,
  className,
  srLabelOnly = false,
}: FieldProps): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(" ");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label !== undefined && (
        <label
          htmlFor={id}
          className={cn("text-[13px] font-medium text-[var(--text)]", srLabelOnly && "sr-only")}
        >
          {label}
          {required && (
            <span className="ms-0.5 text-[var(--danger)]" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      {children(id, describedBy.length > 0 ? describedBy : undefined)}

      {hint !== undefined && (
        <p id={hintId} className="text-xs text-[var(--text-3)]">
          {hint}
        </p>
      )}

      {error !== undefined && error !== null && (
        <p
          id={errorId}
          className="flex items-center gap-1 text-xs text-[var(--danger)]"
          role="alert"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

/** Shared border + focus treatment, so every control looks like one family. */
const CONTROL_BASE =
  "glass-input w-full rounded-lg px-3 text-[13.5px] text-[var(--text)] " +
  "placeholder:text-[var(--text-3)] " +
  "focus-visible:outline-none focus-visible:ring-0";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean | undefined;
  readonly valid?: boolean | undefined;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, valid = false, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL_BASE,
        "h-10 disabled:cursor-not-allowed disabled:bg-[var(--surface-2)] disabled:text-[var(--text-3)]",
        invalid
          ? "border-[var(--danger)] focus-visible:ring-[var(--danger)]"
          : valid
            ? "border-[var(--success)] focus-visible:ring-[var(--success)]"
            : "border-[var(--border-strong)] hover:border-[var(--brand)]",
        className,
      )}
      {...rest}
    />
  );
});

/** Amount input with a fixed currency prefix and tabular numerals. */
export const MoneyInput = forwardRef<HTMLInputElement, Omit<InputProps, "type">>(
  function MoneyInput({ className, ...rest }, ref) {
    return (
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-xs text-[var(--text-3)]">
          Rs
        </span>
        <input
          ref={ref}
          type="text"
          inputMode="decimal"
          dir="ltr"
          className={cn(
            CONTROL_BASE,
            "tabular h-10 pe-3 ps-12 text-end",
            rest.invalid === true
              ? "border-[var(--danger)] focus-visible:ring-[var(--danger)]"
              : "border-[var(--border-strong)] hover:border-[var(--brand)]",
            className,
          )}
          {...rest}
        />
      </div>
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        CONTROL_BASE,
        "min-h-[88px] py-2.5 leading-relaxed",
        "border-[var(--border-strong)] hover:border-[var(--brand)]",
        className,
      )}
      {...rest}
    />
  );
});

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

export interface SelectProps {
  /** The chosen value, or `""` for nothing chosen. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** Shown in the control when `value` matches no option. */
  readonly placeholder?: string | undefined;
  readonly id?: string | undefined;
  /**
   * The accessible name for a select with no visible <label> - a filter in a
   * toolbar, for instance. Prefer a real `Field` label where there is one.
   */
  readonly "aria-label"?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * The one dropdown.
 *
 * Every colour comes from a token: the list is `--surface` on `--border` with
 * `--shadow-md`, a highlighted row is `--brand-soft`, a disabled row is
 * `--text-3`, and the check mark marks the selected row. The list is portalled
 * and capped at 280px with the app's own thin scrollbar, so a long list never
 * runs off the screen and never repaints the page around it.
 *
 * Keyboard behaviour is Radix's, which is the behaviour a keyboard user already
 * expects: Enter/Space/ArrowDown to open, arrows to move, Enter to choose,
 * Escape to close, and type-ahead to jump to an option by its first letters.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  id,
  "aria-label": ariaLabel,
  invalid = false,
  disabled = false,
  className,
}: SelectProps): React.JSX.Element {
  const fallbackId = useId();
  const triggerId = id ?? fallbackId;

  return (
    <SelectPrimitive.Root
      // Radix reserves `""` for "nothing chosen", and the project compiles with
      // exactOptionalPropertyTypes, so the empty case is an omitted prop rather
      // than an explicit undefined.
      {...(value === "" ? {} : { value })}
      onValueChange={(next) => {
        onChange(next);
      }}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={triggerId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL_BASE,
          "flex h-10 items-center justify-between gap-2 text-start",
          "data-[placeholder]:text-[var(--text-3)]",
          invalid
            ? "border-[var(--danger)] focus-visible:ring-[var(--danger)]"
            : "border-[var(--border-strong)] hover:border-[var(--brand)]",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-3)]" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          // Above dialogs: a portal inside a modal can end up behind the overlay
          // that made it modal.
          className={cn(LISTBOX, "z-[60] min-w-[var(--radix-select-trigger-width)]")}
        >
          <SelectPrimitive.Viewport className="max-h-[280px] overflow-y-auto p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled === true}
                className={LISTBOX_ITEM}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="shrink-0">
                  <Check className="h-3.5 w-3.5 text-[var(--brand)]" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/** The option list's own surface: tokens only, never a literal colour. */
const LISTBOX =
  "overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] " +
  "text-[var(--text)] shadow-[var(--shadow-md)] backdrop-blur-xl animate-scale-in";

/** One row: 36px tall, tinted on highlight, muted when disabled. */
const LISTBOX_ITEM =
  "relative flex h-9 w-full cursor-pointer select-none items-center justify-between gap-2 " +
  "rounded-md px-2.5 text-[13.5px] text-[var(--text)] outline-none " +
  "data-[highlighted]:bg-[var(--brand-soft)] " +
  "data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-3)]";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly label?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;

  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className={cn(
            "peer h-4 w-4 cursor-pointer appearance-none rounded border border-[var(--border-strong)] bg-[var(--surface)]",
            "checked:border-[var(--brand)] checked:bg-[var(--brand)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--input-focus-ring)] focus-visible:ring-offset-2",
            "focus-visible:ring-offset-[var(--surface)]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          {...rest}
        />
        <Check
          className="pointer-events-none absolute h-3 w-3 text-[var(--on-brand)] opacity-0 peer-checked:opacity-100"
          aria-hidden="true"
          strokeWidth={3}
        />
      </span>

      {label !== undefined && (
        <label htmlFor={inputId} className="cursor-pointer select-none">
          <span className="block text-[13.5px] text-[var(--text)]">{label}</span>
          {description !== undefined && (
            <span className="block text-xs text-[var(--text-3)]">{description}</span>
          )}
        </label>
      )}
    </div>
  );
});

export interface RadioOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly description?: ReactNode | undefined;
}

/** Segmented control used for language, theme and paper size. */
export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
  name,
  className,
}: {
  readonly value: T;
  readonly options: readonly RadioOption<T>[];
  readonly onChange: (value: T) => void;
  readonly name: string;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={cn("inline-flex rounded-lg border bg-[var(--surface-2)] p-0.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-fast",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--input-focus-ring)]",
              selected
                ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                : "text-[var(--text-2)] hover:text-[var(--text)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Switch for boolean settings: a glass track with a lit brand state. */
export const Switch = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
  readonly disabled?: boolean | undefined;
}): React.JSX.Element => {
  const id = useId();

  return (
    <div className="flex items-start justify-between gap-4">
      {label !== undefined && (
        <label htmlFor={id} className="cursor-pointer select-none">
          <span className="block text-[13.5px] font-medium text-[var(--text)]">{label}</span>
          {description !== undefined && (
            <span className="block text-xs text-[var(--text-3)]">{description}</span>
          )}
        </label>
      )}

      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        data-switch-state={checked ? "on" : "off"}
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          "pressable relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-fast",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--input-focus-ring)] focus-visible:ring-offset-2",
          "focus-visible:ring-offset-[var(--surface)] disabled:opacity-50",
          checked
            ? "border-[color-mix(in_srgb,var(--brand)_70%,white)] bg-[linear-gradient(180deg,var(--brand-hover),var(--brand))] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_18px_-12px_var(--brand-glow)]"
            : "border-[var(--border-strong)] bg-[var(--surface-2)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.12)]",
        )}
      >
        <span
          className={cn(
            "inline-block h-[18px] w-[18px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] transition-transform duration-fast",
            checked ? "translate-x-[22px]" : "translate-x-[3px]",
          )}
        />
      </button>
    </div>
  );
};
