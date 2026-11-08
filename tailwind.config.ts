import type { Config } from "tailwindcss";

/**
 * Design tokens for EyerStock.
 *
 * Every colour resolves to a CSS variable declared in
 * `src/renderer/styles.css`, so light/dark themes swap by changing variables
 * only. No component may hardcode a hex value: the palette lives here and in
 * the variable block, nowhere else.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "var(--brand-50)",
          100: "var(--brand-100)",
          200: "var(--brand-200)",
          300: "var(--brand-300)",
          400: "var(--brand-400)",
          500: "var(--brand-500)",
          600: "var(--brand-600)",
          700: "var(--brand-700)",
          800: "var(--brand-800)",
          900: "var(--brand-900)",
          DEFAULT: "var(--brand)",
          hover: "var(--brand-hover)",
          soft: "var(--brand-soft)",
          contrast: "var(--brand-contrast)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          raised: "var(--surface-raised)",
          sunken: "var(--surface-2)",
          overlay: "var(--surface-overlay)",
        },
        bg: "var(--bg)",
        page: "var(--bg)",
        line: {
          DEFAULT: "var(--border)",
          soft: "var(--divider)",
          strong: "var(--border-strong)",
        },
        text: {
          DEFAULT: "var(--text)",
          2: "var(--text-2)",
          3: "var(--text-3)",
        },
        ink: {
          DEFAULT: "var(--text)",
          secondary: "var(--text-2)",
          muted: "var(--text-3)",
          inverse: "var(--brand-contrast)",
        },
        success: {
          DEFAULT: "var(--success)",
          soft: "var(--success-soft)",
          fg: "var(--success)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
          fg: "var(--warning)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
          fg: "var(--danger)",
        },
        info: {
          DEFAULT: "var(--info)",
          soft: "var(--info-soft)",
          fg: "var(--info)",
        },
        /**
         * Secondary accents. Functional, not decorative: a category in a chart,
         * a small icon accent, a soft tint on a chip. A panel is never filled
         * with one.
         */
        violet: {
          DEFAULT: "var(--violet)",
          soft: "var(--violet-soft)",
        },
        cyan: {
          DEFAULT: "var(--cyan)",
          soft: "var(--cyan-soft)",
        },
        teal: {
          DEFAULT: "var(--teal)",
          soft: "var(--teal-soft)",
        },
        gold: {
          DEFAULT: "var(--gold)",
          soft: "var(--gold-soft)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar-bg)",
          hover: "var(--sidebar-hover)",
          panel: "var(--sidebar-panel)",
          active: "var(--sidebar-active-bg)",
          activeFg: "var(--sidebar-active-fg)",
          indicator: "var(--sidebar-active-indicator)",
          text: "var(--sidebar-text)",
          border: "var(--sidebar-border)",
        },
        input: {
          DEFAULT: "var(--input-bg)",
          border: "var(--input-border)",
          ring: "var(--input-focus-ring)",
        },
        avatar: {
          1: "var(--avatar-1)",
          2: "var(--avatar-2)",
          3: "var(--avatar-3)",
          4: "var(--avatar-4)",
          5: "var(--avatar-5)",
          6: "var(--avatar-6)",
        },
        chart: {
          1: "var(--chart-1)",
          2: "var(--chart-2)",
          3: "var(--chart-3)",
          4: "var(--chart-4)",
          5: "var(--chart-5)",
          primary: "var(--chart-1)",
          secondary: "var(--chart-2)",
          grid: "var(--chart-grid)",
          area: "var(--chart-area)",
          amber: "var(--chart-4)",
          green: "var(--success)",
        },
      },
      fontFamily: {
        sans: ["Inter", "Cairo", "system-ui", "sans-serif"],
        ar: ["Cairo", "Inter", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "Cascadia Mono", "Consolas", "monospace"],
      },
      fontSize: {
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "18px" }],
        base: ["14px", { lineHeight: "20px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["18px", { lineHeight: "26px" }],
        "2xl": ["22px", { lineHeight: "30px" }],
        "3xl": ["28px", { lineHeight: "36px" }],
      },
      borderRadius: {
        sm: "8px",
        DEFAULT: "10px",
        md: "12px",
        lg: "14px",
        xl: "18px",
        "2xl": "24px",
        "3xl": "30px",
        panel: "var(--radius-panel)",
        sidebar: "var(--radius-sidebar)",
        header: "var(--radius-header)",
        control: "var(--radius-control)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        raised: "var(--shadow-raised)",
        overlay: "var(--shadow-overlay)",
        focus: "var(--shadow-focus)",
        topbar: "var(--shadow-topbar)",
        button: "var(--shadow-button)",
        glass: "var(--shadow-glass)",
        "glass-hover": "var(--shadow-glass-hover)",
        float: "var(--shadow-float)",
      },
      spacing: {
        sidebar: "var(--sidebar-width)",
        sidebarPanel: "var(--sidebar-panel-width)",
        sidebarGutter: "var(--sidebar-gutter)",
        header: "var(--header-height)",
        topbar: "var(--header-height)",
        bottomnav: "var(--bottomnav-height)",
      },
      transitionDuration: {
        fast: "150ms",
        normal: "200ms",
        sidebar: "var(--dur-sidebar)",
      },
      transitionTimingFunction: {
        glass: "var(--ease-glass)",
        sidebar: "var(--ease-sidebar)",
      },
      keyframes: {
        /**
         * Enter-only motion for floating surfaces - menus, popovers, toasts.
         * Opacity and transform only, so appearing never triggers layout.
         * Anything that animated width, height, top or filter would force a
         * reflow on every frame. Modals need a matching exit and so use the
         * `dialog-*` / `scrim-*` pairs below instead of reusing these.
         */
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.98)" },
          to: { opacity: "1", transform: "scale(1)" },
        },

        /**
         * Modal and scrim motion, as separate enter/exit pairs.
         *
         * They have to be separate because Radix keeps the node mounted
         * through its closed state and waits for the exit animation to finish
         * before unmounting. An enter-only animation has nothing to wait for,
         * which is why dialogs used to vanish instantly on close.
         *
         * Every pair animates only `opacity` and `transform`, so the sequence
         * stays on the compositor and never asks layout for a new frame.
         * Nothing here animates the backdrop-filter, the box shadow or the
         * panel's box: on a glass surface those are the expensive properties,
         * and moving one forces the compositor to redo the blur every frame.
         */
        "scrim-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "scrim-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        /**
         * A short lift on open and a smaller one back on close. The travel is
         * kept small on purpose: the panel carries a large backdrop-filter, and
         * the less its surface moves, the less of that filter is recomputed.
         */
        "dialog-in": {
          from: { opacity: "0", transform: "translateY(6px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "dialog-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(4px) scale(0.985)" },
        },
        /**
         * The drawer slides from whichever edge it is pinned to. The distance is
         * a variable so one keyframe pair serves both edges and both reading
         * directions, instead of four near-identical copies.
         */
        /**
         * The sign-in screen's entrance.
         *
         * Two panels, one movement each: the brand side slides in from the edge
         * it lives on, the form rises into place. Opacity and transform only,
         * so the whole sequence stays on the compositor and never asks layout
         * for a frame.
         *
         * The animation is decoration, never a gate: the form is usable while
         * it plays, and the authentication call is never held back for it.
         */
        "auth-panel-in": {
          from: { opacity: "0", transform: "translate3d(-12px, 0, 0)" },
          to: { opacity: "1", transform: "translate3d(0, 0, 0)" },
        },
        "auth-form-in": {
          from: { opacity: "0", transform: "translate3d(0, 12px, 0)" },
          to: { opacity: "1", transform: "translate3d(0, 0, 0)" },
        },
        "drawer-in": {
          from: { opacity: "0", transform: "translateX(var(--drawer-from, 100%))" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "drawer-out": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: { opacity: "0", transform: "translateX(var(--drawer-from, 100%))" },
        },
      },
      animation: {
        "fade-in": "fade-in var(--dur-fast) ease-out",
        "slide-up": "slide-up var(--dur-fast) ease-out",
        "slide-in-right": "slide-in-right var(--dur-normal) ease-out",
        "scale-in": "scale-in var(--dur-fast) ease-out",
        "scrim-in": "scrim-in var(--dur-dialog) ease-out",
        "scrim-out": "scrim-out var(--dur-dialog-close) ease-in",
        "dialog-in": "dialog-in var(--dur-dialog) var(--ease-glass)",
        "dialog-out": "dialog-out var(--dur-dialog-close) var(--ease-dialog-out)",
        "drawer-in": "drawer-in var(--dur-dialog) var(--ease-glass)",
        "drawer-out": "drawer-out var(--dur-dialog-close) var(--ease-dialog-out)",
        "auth-panel-in": "auth-panel-in 460ms var(--ease-glass) both",
        "auth-form-in": "auth-form-in 460ms var(--ease-glass) 80ms both",
      },
    },
  },
  plugins: [],
};

export default config;
