/**
 * Theme boot script.
 *
 * Runs before the first paint. The renderer cannot read the stored appearance
 * from the database at this point - the preload bridge has not answered yet -
 * so it reads the mirror the app keeps in localStorage and puts the mode and
 * the colour pack on <html> itself. Without this, every launch paints the
 * light Ocean Teal palette and then snaps to the user's choice a few frames
 * later, which reads as a glitch.
 *
 * The pack id is copied through rather than validated against a second list
 * here: the ids live in `src/shared/themes.ts`, a stale id simply matches no
 * stylesheet block and falls back to the default colours, and duplicating the
 * list in a plain script is exactly how the two copies would drift apart.
 *
 * Deliberately a separate file rather than an inline <script>: it stays render
 * blocking, but it keeps `script-src 'self'` free of 'unsafe-inline', so the
 * strict Content-Security-Policy the app ships is left intact.
 */
(function () {
  "use strict";
  try {
    var stored = window.localStorage.getItem("eyerstock.theme");
    var preference =
      stored === "dark" || stored === "light" || stored === "system" ? stored : "system";

    var resolved =
      preference === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : preference;

    var root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.setAttribute("data-theme", resolved);

    var storedPalette = window.localStorage.getItem("eyerstock.themePalette");
    root.setAttribute(
      "data-palette",
      typeof storedPalette === "string" && storedPalette.length > 0 ? storedPalette : "ocean-teal",
    );
  } catch {
    // Storage can be denied in a locked-down profile. The app still renders,
    // it just starts on the default appearance until React takes over.
  }
})();
