/**
 * Teal gradient panel for the login and setup screens.
 *
 * The illustration is inline SVG so it is bundled with the app and renders with
 * no network: an offline shop must never see an empty panel waiting on a CDN.
 */

import { useApp } from "../../lib/app-context";

export function AuthPanel(): React.JSX.Element {
  const { settings } = useApp();
  const vendor = settings.vendorName.trim();

  return (
    <div className="auth-panel relative hidden overflow-hidden lg:block">
      {/*
        The illustration is confined to the top of the panel and drawn to fit
        rather than to cover. Scaled to the panel it used to crop through the
        ripples and fill the whole column, which left the copy underneath
        competing with it for attention and read as clutter on a short screen.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-1/2 max-h-[300px] items-start justify-center">
        <WaterDropArt />
      </div>

      <div className="relative flex h-full flex-col justify-end p-8 text-white lg:p-10">
        <div className="max-w-sm">
          <h2 className="text-2xl font-semibold leading-snug">Welcome back</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/85">
            Stock, sales, purchases, expenses and accounts for a water purification business — all
            on this computer, working without internet.
          </p>

          <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-white/20 pt-5 text-xs">
            <div>
              <dt className="text-white/70">Sales</dt>
              <dd className="mt-1 font-semibold">Invoices &amp; receipts</dd>
            </div>
            <div>
              <dt className="text-white/70">Stock</dt>
              <dd className="mt-1 font-semibold">Products &amp; counts</dd>
            </div>
            <div>
              <dt className="text-white/70">Money</dt>
              <dd className="mt-1 font-semibold">Profit &amp; split</dd>
            </div>
          </dl>

          {/* Who to call. Hidden entirely when the name is cleared, rather
              than leaving a dangling "Developed by" with nothing after it. */}
          {vendor.length > 0 && (
            <p className="mt-6 border-t border-white/20 pt-4 text-xs text-white/70">
              Developed by <span className="font-semibold text-white/90">{vendor}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Water-drop composition: a large drop, concentric ripples, and a filter-stage
 * motif. Abstract rather than literal so it reads as a brand mark at any size.
 *
 * Drawn with `currentColor` rather than literal white so the art inherits the
 * white text colour of the teal panel it sits on, with no colour of its own to
 * keep in sync.
 *
 * `meet` rather than `slice` so the whole mark stays inside whatever box it is
 * given instead of cropping to fill, and it is sized by its container rather
 * than the viewport.
 */
function WaterDropArt(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 400 600"
      className="h-full w-full max-w-[190px] text-white"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="drop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {/* ripples */}
      <circle
        cx="200"
        cy="250"
        r="70"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.14"
        strokeWidth="1.5"
      />
      <circle
        cx="200"
        cy="250"
        r="110"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.1"
        strokeWidth="1.5"
      />
      <circle
        cx="200"
        cy="250"
        r="150"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.07"
        strokeWidth="1.5"
      />
      <circle
        cx="200"
        cy="250"
        r="190"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.05"
        strokeWidth="1.5"
      />

      {/* main drop */}
      <path
        d="M200 96c58 66 96 116 96 158a96 96 0 0 1-192 0c0-42 38-92 96-158Z"
        fill="url(#drop)"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="2"
      />

      {/* filter cartridge motif inside the drop */}
      <g
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      >
        <line x1="160" y1="212" x2="240" y2="212" />
        <line x1="160" y1="238" x2="240" y2="238" />
        <line x1="160" y1="264" x2="240" y2="264" />
        <line x1="160" y1="290" x2="240" y2="290" />
      </g>

      {/* falling droplets */}
      <circle cx="86" cy="150" r="7" fill="currentColor" fillOpacity="0.14" />
      <circle cx="316" cy="196" r="5" fill="currentColor" fillOpacity="0.12" />
      <circle cx="72" cy="330" r="4" fill="currentColor" fillOpacity="0.1" />
      <circle cx="330" cy="392" r="6" fill="currentColor" fillOpacity="0.1" />
    </svg>
  );
}
