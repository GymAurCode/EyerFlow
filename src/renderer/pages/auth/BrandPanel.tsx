/**
 * The brand half of the sign-in screen.
 *
 * Eyercall's own side of the split: the mark, the company name, one line
 * about what the product does, and the three things it is good at.
 *
 * Its colours are the chosen theme's navigation rail. The panel borrows the
 * rail's background, ink, hairline and chip values, so the sign-in screen and
 * the signed-in application never disagree about which pack is in use. The
 * accent is the pack's brand colour, pulled towards the rail's ink so it stays
 * readable on both a deep and a pale rail.
 *
 * The decoration is a block of boxes drawn in outline. The mark on the logo
 * is a box, and boxes are what this software counts. It is one faint line
 * drawing anchored in the corner and cropped by the panel, so it gives the
 * panel depth without ever competing with the copy.
 *
 * On a narrow window the panel collapses into a slim brand bar: the logo and
 * the two names stay, the rest of the copy goes, and the form keeps the
 * screen.
 */

import { ArrowLeftRight, Boxes, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import logoUrl from "@assets/Logo.png";

interface Highlight {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
}

/**
 * The three things the product is for.
 *
 * Every line describes something the software actually does - a catalogue
 * with counts and movements, two ledgers of documents, and a set of books and
 * reports behind them - so none of it is a claim the app cannot back up.
 */
const HIGHLIGHTS: readonly Highlight[] = [
  {
    icon: Boxes,
    title: "Inventory & Stock Control",
    detail: "Products, counts and stock movements in one place.",
  },
  {
    icon: ArrowLeftRight,
    title: "Sales & Purchase Management",
    detail: "Invoices, receipts and supplier purchases.",
  },
  {
    icon: TrendingUp,
    title: "Financial Insights & Reporting",
    detail: "Expenses, ledgers and reports that add up.",
  },
];

export function BrandPanel(): React.JSX.Element {
  return (
    <section
      aria-label="Eyercall"
      className={cn(
        "auth-panel relative isolate flex shrink-0 flex-row items-center gap-3",
        "px-6 py-4 text-[var(--auth-panel-ink)]",
        "shadow-[inset_-1px_0_0_var(--auth-panel-line)]",
        "animate-auth-panel-in",
        // Wide enough to hold the copy and the ruling, narrow enough to leave
        // the form the larger half of the screen.
        "lg:w-[47%] lg:flex-col lg:items-stretch lg:justify-between lg:gap-0 lg:px-12 lg:py-12",
        "xl:w-[46%] xl:px-16 xl:py-14",
      )}
    >
      {/* The ruling: a ledger's grid, one pixel, fading out downwards. */}
      <div
        className="auth-panel-grid pointer-events-none absolute inset-0 -z-10"
        aria-hidden="true"
      />

      {/*
        The art is cropped by its own wrapper rather than by the panel, so a
        window too short for the copy scrolls the panel instead of clipping
        the words off the bottom of it.
      */}
      <div
        className="pointer-events-none absolute inset-0 hidden overflow-hidden lg:block"
        aria-hidden="true"
      >
        <BrandArt />
      </div>

      {/* The lockup. The mark sits in a chip of the same glass the app uses
          everywhere else, so it belongs to the product rather than floating
          on the panel. */}
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border border-[var(--auth-panel-line)] bg-[var(--auth-panel-chip)] shadow-[inset_0_1px_0_var(--auth-panel-line)]">
          <img src={logoUrl} alt="" className="h-[30px] w-[30px] object-contain" />
        </span>
        <div className="min-w-0">
          <p className="text-[17px] font-semibold leading-tight tracking-[-0.015em]">Eyercall</p>
          <p className="mt-0.5 text-[11.5px] font-medium leading-tight text-[var(--auth-panel-accent)]">
            EyerStock
          </p>
        </div>
      </div>

      {/* The message. Hidden on a narrow window, where the panel is only a bar
          and the form needs the room. */}
      <div className="hidden lg:my-auto lg:block lg:py-8">
        <h2 className="max-w-[15ch] text-[32px] font-semibold leading-[1.14] tracking-[-0.02em] xl:text-[36px]">
          Smarter Inventory.{" "}
          <span className="text-[var(--auth-panel-accent)]">Clearer Decisions.</span>
        </h2>

        <p className="mt-5 max-w-[44ch] text-[14px] leading-relaxed text-[var(--auth-panel-ink-2)]">
          Manage your products, purchases, sales, stock movements, and business finances from one
          reliable desktop application.
        </p>

        <ul className="mt-9 border-t border-[var(--auth-panel-line)]">
          {HIGHLIGHTS.map((highlight, index) => {
            const Icon = highlight.icon;
            return (
              <li
                key={highlight.title}
                className={cn(
                  "flex items-center gap-3.5 py-4",
                  index > 0 && "border-t border-[var(--auth-panel-line)]",
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-[var(--auth-panel-line)] bg-[var(--auth-panel-chip)] text-[var(--auth-panel-accent)]">
                  <Icon className="h-[17px] w-[17px]" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium leading-tight">
                    {highlight.title}
                  </span>
                  <span className="mt-1 block text-[12.5px] leading-relaxed text-[var(--auth-panel-ink-3)]">
                    {highlight.detail}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* The credit. It lives at the foot of the panel rather than on the
          form, because it belongs to the company and not to the sign-in. */}
      <div className="hidden items-center gap-3 text-[12px] text-[var(--auth-panel-ink-3)] lg:flex">
        <span className="h-px w-8 bg-[var(--auth-panel-line)]" aria-hidden="true" />
        <span>
          Powered by <span className="font-medium text-[var(--auth-panel-ink-2)]">Eyercall</span>
        </span>
      </div>
    </section>
  );
}

/**
 * A block of boxes, drawn in outline.
 *
 * Four boxes in isometric: two on the ground, two stacked on them. The
 * geometry is a true isometric box - a rhombus for the top face, two
 * parallelograms for the sides - so the stack sits on itself correctly
 * instead of merely looking like it.
 */
function BrandArt(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 200 180"
      aria-hidden="true"
      className="absolute -bottom-8 -end-6 h-auto w-[260px] text-[var(--auth-panel-accent)] opacity-[0.15] lg:w-[330px] lg:opacity-[0.18] xl:-bottom-6 xl:-end-4 xl:w-[420px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <g transform="translate(100 96)">
        <g>
          <Box />
        </g>
        <g transform="translate(46 -23)">
          <Box />
        </g>
        <g transform="translate(0 -40)">
          <Box />
        </g>
        <g transform="translate(46 -63)">
          <Box />
        </g>
      </g>
    </svg>
  );
}

/** One isometric box: the top face, the left face and the right face. */
function Box(): React.JSX.Element {
  return (
    <>
      <path d="M0 -23 46 0 0 23 -46 0Z" />
      <path d="M-46 0 0 23 0 63 -46 40Z" />
      <path d="M46 0 0 23 0 63 46 40Z" />
    </>
  );
}
