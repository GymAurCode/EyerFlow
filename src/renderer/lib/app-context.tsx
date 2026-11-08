/**
 * Application-wide context: session, settings and theme.
 *
 * Theme is deliberately a separate context. It changes on a single click, and
 * before this split that click replaced the whole app context value, re-rendering
 * every screen that only wanted to know who is signed in. A theme switch now
 * updates the two components that show the choice; the page behind them stays
 * put.
 *
 * Language is deliberately absent: the app is English only. `t()` indirection
 * existed to pick between two dictionaries, and with one language it was pure
 * ceremony - every label is now written where it is used.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppSettingsSnapshot, Currency } from "../../shared/ipc";
import type { PermissionAction, PermissionModule } from "../../shared/permissions";
import type { SessionUser } from "../../shared/types";
import { call, errorMessage, hasBridge } from "./api";
import { prefetchLookups } from "./lookups";

import type { ThemePreference } from "../../shared/ipc";
import { DEFAULT_THEME_ID, normaliseThemeId, type ThemeId } from "../../shared/themes";

export type { ThemePreference };

/** A preference with `system` already resolved to the theme actually applied. */
export type Theme = Exclude<ThemePreference, "system">;

/**
 * Mirrors the stored preference for the inline pre-paint script in index.html,
 * which cannot ask the main process (the bridge is not up yet). The database
 * remains the source of truth; this is only the paint-time hint.
 */
const THEME_STORAGE_KEY = "eyerstock.theme";

/**
 * The paint-time hint for the colour pack.
 *
 * Same contract as `THEME_STORAGE_KEY`: the database is authoritative, this is
 * only what `theme-boot.js` can read before the bridge answers. Unknown ids are
 * ignored by the stylesheet anyway, and `storedPalette` normalises them to the
 * default before they reach React.
 */
const PALETTE_STORAGE_KEY = "eyerstock.themePalette";

/** Resolve a preference to the theme actually applied. */
export function resolveTheme(preference: ThemePreference): Theme {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return preference;
}

/**
 * Put the appearance on <html>.
 *
 * Every colour in the app is a CSS variable scoped to `:root`, `.dark` and the
 * palette block, so this one class/attribute swap repaints dialogs, tables,
 * charts, toasts, inputs and scrollbars at once - there is no per-component
 * state to keep in sync.
 */
export function applyThemeToDocument(preference: ThemePreference, palette: ThemeId): void {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-palette", palette);
}

/**
 * Apply a user-chosen appearance with a short, compositor-only wash.
 *
 * The theme itself is applied immediately: changing the class on <html> is what
 * makes the app feel like it answered the click. The old page colour is then
 * laid over the window at low opacity and faded out, which gives the eye a
 * 220ms transition without snapshotting the whole page. A view transition was
 * measured first and cost roughly 80ms more before the first frame; this wash
 * costs one extra paint and then only opacity, which the compositor owns.
 *
 * Reduced motion gets the immediate swap with no wash.
 */
function applyThemeWithTransition(preference: ThemePreference, palette: ThemeId): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    applyThemeToDocument(preference, palette);
    return;
  }

  const root = document.documentElement;
  const previousBackground = getComputedStyle(root).getPropertyValue("--bg").trim();
  applyThemeToDocument(preference, palette);

  // A second toggle while the first wash is still running replaces it rather
  // than stacking veils.
  document.querySelector(".theme-wash")?.remove();

  const wash = document.createElement("div");
  wash.className = "theme-wash";
  wash.setAttribute("aria-hidden", "true");
  wash.style.setProperty("--theme-wash-color", previousBackground);
  document.body.appendChild(wash);
  wash.addEventListener(
    "animationend",
    () => {
      wash.remove();
    },
    { once: true },
  );
}

function storedThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    /* Storage denial falls back to the database value below. */
  }
  return "system";
}

/**
 * The pack last mirrored for the pre-paint script.
 *
 * A localStorage value can be stale or hand-edited, so it is validated against
 * the catalogue rather than trusted; anything unrecognised starts on the
 * default pack, exactly as a fresh install does.
 */
function storedPalette(): ThemeId {
  try {
    return normaliseThemeId(window.localStorage.getItem(PALETTE_STORAGE_KEY) ?? DEFAULT_THEME_ID);
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Keep the paint-time hints in step with what is actually on screen. */
function mirrorAppearance(preference: ThemePreference, palette: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    localStorage.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    /* The database write is the source of truth. */
  }
}

export interface SetupInput {
  companyName: string;
  companyTrn: string;
  companyAddress: string;
  companyPhone: string;
  fiscalYearStartMonth: number;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  /** The application trades in Pakistani Rupees only. */
  currency: Currency;
}

export interface AppState {
  readonly ready: boolean;
  /** True when the preload bridge is absent: the window is not inside Electron. */
  readonly bridgeMissing: boolean;
  /** True when license check is in progress */
  readonly licenseChecking: boolean;
  /** True when no valid license is found */
  readonly licenseRequired: boolean;
  readonly machineId: string;
  readonly licenseStatus: {
    clientName: string;
    expiresAt: string | null;
    daysUntilExpiry: number | null;
    isExpiringSoon: boolean;
  } | null;
  readonly user: SessionUser | null;
  readonly settings: AppSettingsSnapshot;
  readonly setupRequired: boolean;

  can(module: PermissionModule, action: PermissionAction): boolean;
  signIn(username: string, password: string): Promise<void>;
  completeSetup(input: SetupInput): Promise<void>;
  signOut(): Promise<void>;
  refreshSession(): Promise<void>;
  updateSettings(patch: Partial<AppSettingsSnapshot>): Promise<void>;
  /** Re-read settings written by a main-process flow, such as registration. */
  refreshSettings(): Promise<void>;
  activateLicense(key: string): Promise<void>;
}

export interface ThemeState {
  /** The stored preference, which may be `system`. */
  readonly theme: ThemePreference;
  /** The preference with `system` resolved against the OS appearance. */
  readonly resolvedTheme: Theme;
  /** The colour pack, independent of the light/dark preference. */
  readonly palette: ThemeId;
  setTheme(theme: ThemePreference): Promise<void>;
  setPalette(palette: ThemeId): Promise<void>;
}

const AppContext = createContext<AppState | null>(null);
const ThemeContext = createContext<ThemeState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (value === null) {
    throw new Error("useApp must be used inside <AppProvider>");
  }
  return value;
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used inside <AppProvider>");
  }
  return value;
}

/** Query client tuned for a local database: no refetch storms, no network. */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export interface AppProviderProps {
  readonly children: ReactNode;
}

export function AppProvider({ children }: AppProviderProps): React.JSX.Element {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <AppStateProvider>{children}</AppStateProvider>
    </QueryClientProvider>
  );
}

const FALLBACK_SETTINGS: AppSettingsSnapshot = {
  theme: "system",
  themePalette: DEFAULT_THEME_ID,
  // The fallback is only used before settings load; it must not hide the
  // chooser from a real first login.
  themeOnboardingComplete: false,
  companyName: "EyerStock",
  companyTrn: "",
  companyAddress: "",
  companyPhone: "",
  companyEmail: "",
  companyLogoPath: "",
  companyLogoDataUrl: null,
  invoiceFooter: "Thank you for your business.",
  vendorName: "Eyercall",
  invoiceTerms:
    "Goods once sold are not returnable unless defective. Warranty applies as per the manufacturer terms.",
  fiscalYearStartMonth: 1,
  backupDirectory: "",
  backupKeepCount: 30,
  dailyBackupEnabled: true,
  dailyBackupHour: 2,
  donationRatePercent: 2,
  currency: "PKR",
  vatRatePercent: 5,
  allowNegativeStock: false,
};

function AppStateProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const client = useQueryClient();

  const [ready, setReady] = useState(false);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [licenseChecking, setLicenseChecking] = useState(true);
  const [licenseRequired, setLicenseRequired] = useState(false);
  const [machineId, setMachineId] = useState("");
  const [licenseStatus, setLicenseStatus] = useState<{
    clientName: string;
    expiresAt: string | null;
    daysUntilExpiry: number | null;
    isExpiringSoon: boolean;
  } | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<AppSettingsSnapshot>(FALLBACK_SETTINGS);
  const [setupRequired, setSetupRequired] = useState(true);

  const [themePreference, setThemePreference] = useState<ThemePreference>(storedThemePreference);
  const [palette, setPaletteState] = useState<ThemeId>(storedPalette);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() => resolveTheme(themePreference));
  // The DOM and the refs move in the same tick as the click. React state is a
  // render behind, which is enough for two fast clicks to disagree about what
  // the previous appearance was and leave the app on the wrong one.
  const themePreferenceRef = useRef<ThemePreference>(themePreference);
  const paletteRef = useRef<ThemeId>(palette);

  const adoptAppearance = useCallback((preference: ThemePreference, nextPalette: ThemeId): void => {
    themePreferenceRef.current = preference;
    paletteRef.current = nextPalette;
    setThemePreference(preference);
    setPaletteState(nextPalette);
    setResolvedTheme(resolveTheme(preference));
    applyThemeToDocument(preference, nextPalette);
    // Keep the pre-paint hints in step, so the next launch paints the same
    // appearance the database says rather than flashing the default.
    mirrorAppearance(preference, nextPalette);
  }, []);

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await call("settings.get", {});
      setSettings(snapshot);
      adoptAppearance(snapshot.theme, snapshot.themePalette);
    } catch (error) {
      // Settings are needed to render, so a failure here is worth surfacing
      // once rather than silently falling back forever.
      toast.error(errorMessage(error));
    }
  }, [adoptAppearance]);

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      setUser(await call("auth.currentUser", {}));
    } catch {
      setUser(null);
    }
  }, []);

  /**
   * Warm the picker cache as soon as there is a user to query on behalf of.
   *
   * Sale, purchase and payment dialogs all need products and parties the
   * moment they open. Loading them here, once, while the user is still
   * reading the page they landed on, is what lets those dialogs paint their
   * first frame with no database round trip in it.
   */
  useEffect(() => {
    if (user !== null) prefetchLookups();
  }, [user]);

  const checkLicense = useCallback(async (): Promise<boolean> => {
    try {
      const result = await call("license.check", {});
      // license.check returns LicenseCheckResponse directly (unwrapped by call())
      if (result.ok) {
        setLicenseStatus({
          clientName: result.clientName,
          expiresAt: result.expiresAt,
          daysUntilExpiry: result.daysUntilExpiry,
          isExpiringSoon: result.isExpiringSoon,
        });
        setMachineId(result.machineId);
        setLicenseRequired(false);
        return true;
      } else {
        setMachineId(result.machineId);
        setLicenseRequired(true);
        return false;
      }
    } catch {
      setLicenseRequired(true);
      return false;
    }
  }, []);

  // Bootstrap: check license first, then read settings, then resolve the session.
  useEffect(() => {
    let cancelled = false;

    // No bridge means this window is not running inside the Electron shell (or
    // the main process died before the window was built). Every call in the app
    // would fail identically, so there is nothing to bootstrap - skip straight
    // to the recovery screen instead of a wizard that cannot complete.
    if (!hasBridge()) {
      setBridgeMissing(true);
      setReady(true);
      setLicenseChecking(false);
      return;
    }

    void (async () => {
      try {
        setLicenseChecking(true);
        const licenseValid = await checkLicense();
        if (cancelled) return;

        if (!licenseValid) {
          setReady(true);
          return;
        }

        await loadSettings();
        if (cancelled) return;

        const status = await call("auth.setupStatus", {});
        if (cancelled) return;
        setSetupRequired(!status.isComplete);

        if (status.isComplete) {
          // In dev mode, try to restore a persisted session first
          const devUser = await call("auth.loadDevSession", {});
          if (devUser) {
            setUser(devUser);
          } else {
            await refreshSession();
          }
        }
      } catch (error) {
        if (!cancelled) toast.error(errorMessage(error));
      } finally {
        if (!cancelled) {
          setReady(true);
          setLicenseChecking(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSettings, refreshSession, checkLicense]);

  const persistSettings = useCallback(
    async (patch: Partial<AppSettingsSnapshot>): Promise<void> => {
      const next = await call("settings.update", patch);
      setSettings(next);
      // Settings are read from this context by the screens that need them.
      // Nothing in the database query cache depends on them, so invalidating
      // every query here only made Save changes refetch the whole app.
    },
    [],
  );

  // A `system` preference follows the OS while the app is open. The initial
  // class was already put on <html> by theme-boot.js before the first paint.
  useEffect(() => {
    if (themePreference !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      // The pack does not change with the OS: only which of its two modes is
      // shown. Reading the ref keeps this listener from re-subscribing every
      // time the user picks a different pack.
      applyThemeToDocument("system", paletteRef.current);
      setResolvedTheme(resolveTheme("system"));
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [themePreference]);

  const can = useCallback(
    (module: PermissionModule, action: PermissionAction): boolean => {
      if (user === null) return false;
      return user.permissions.some(
        (permission) => permission.module === module && permission.action === action,
      );
    },
    [user],
  );

  const signIn = useCallback(
    async (username: string, password: string): Promise<void> => {
      await call("auth.login", { username, password });
      setSetupRequired(false);
      await refreshSession();
      // In dev mode, persist the session so a restart doesn't require login again
      const user = await call("auth.currentUser", {});
      if (user) {
        await call("auth.saveDevSession", {});
      }
    },
    [refreshSession],
  );

  const completeSetup = useCallback(
    async (input: SetupInput): Promise<void> => {
      await call("auth.setup", input);
      await loadSettings();
      setSetupRequired(false);
      // Setup does NOT create a session. The user is redirected to the login page.
    },
    [loadSettings],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await call("auth.logout", {});
    setUser(null);
    await call("auth.clearDevSession", {});
    client.clear();
  }, [client]);

  const setTheme = useCallback(async (theme: ThemePreference): Promise<void> => {
    // Applied to <html> immediately, before the write is awaited. Persisting
    // goes over IPC and back, which is far too slow to wait on: the toggle
    // would sit unresponsive for a frame or two before anything changed.
    // The write still happens, and a failure rolls the class back.
    const previous = themePreferenceRef.current;
    if (theme === previous) return;

    themePreferenceRef.current = theme;
    setThemePreference(theme);
    setResolvedTheme(resolveTheme(theme));
    applyThemeWithTransition(theme, paletteRef.current);
    mirrorAppearance(theme, paletteRef.current);

    try {
      await call("settings.update", { theme });
    } catch (error) {
      themePreferenceRef.current = previous;
      setThemePreference(previous);
      setResolvedTheme(resolveTheme(previous));
      applyThemeToDocument(previous, paletteRef.current);
      mirrorAppearance(previous, paletteRef.current);
      toast.error(errorMessage(error));
    }
  }, []);

  const setPalette = useCallback(async (next: ThemeId): Promise<void> => {
    // Same optimistic contract as `setTheme`: paint now, persist behind the
    // click, roll back visibly if the write is refused. The two choices are
    // independent, so only the palette field is sent - picking a colour pack
    // can never quietly change whether the app is light or dark.
    const previous = paletteRef.current;
    if (next === previous) return;

    paletteRef.current = next;
    setPaletteState(next);
    applyThemeWithTransition(themePreferenceRef.current, next);
    mirrorAppearance(themePreferenceRef.current, next);

    try {
      await call("settings.update", { themePalette: next });
    } catch (error) {
      paletteRef.current = previous;
      setPaletteState(previous);
      applyThemeToDocument(themePreferenceRef.current, previous);
      mirrorAppearance(themePreferenceRef.current, previous);
      toast.error(errorMessage(error));
    }
  }, []);

  const activateLicense = useCallback(
    async (key: string): Promise<void> => {
      // 10 second ceiling, applied by `call`. Everything this touches can block
      // the main process - reading the machine ID shells out to the OS three
      // times - and a call with no ceiling is a spinner that never stops.
      const result = await call("license.activate", { key: key.trim() });

      if (!result.ok) throw new Error("Activation failed");
      setLicenseRequired(false);
      setMachineId(result.machineId);
      setLicenseStatus({
        clientName: result.clientName,
        expiresAt: result.expiresAt,
        daysUntilExpiry: result.daysUntilExpiry,
        isExpiringSoon: result.isExpiringSoon,
      });
      // After activation, continue bootstrap. Wrapped so a failure here is
      // reported as "activated, but the app could not finish starting" rather
      // than looking like the key itself was refused - the licence is already
      // saved at this point and the next launch will pick it up.
      try {
        await loadSettings();
        const status = await call("auth.setupStatus", {});
        setSetupRequired(!status.isComplete);
        if (status.isComplete) {
          await refreshSession();
        }
      } catch {
        toast.error("License activated, but the app could not finish starting up. Reopen it.");
      }
    },
    [loadSettings, refreshSession],
  );

  const value = useMemo<AppState>(
    () => ({
      ready,
      bridgeMissing,
      licenseChecking,
      licenseRequired,
      machineId,
      licenseStatus,
      user,
      settings,
      setupRequired,
      can,
      signIn,
      completeSetup,
      signOut,
      refreshSession,
      updateSettings: persistSettings,
      refreshSettings: loadSettings,
      activateLicense,
    }),
    [
      bridgeMissing,
      can,
      completeSetup,
      loadSettings,
      persistSettings,
      ready,
      refreshSession,
      settings,
      setupRequired,
      signIn,
      signOut,
      user,
      licenseChecking,
      licenseRequired,
      machineId,
      licenseStatus,
      activateLicense,
    ],
  );

  const themeValue = useMemo<ThemeState>(
    () => ({
      theme: themePreference,
      resolvedTheme,
      palette,
      setTheme,
      setPalette,
    }),
    [themePreference, resolvedTheme, palette, setTheme, setPalette],
  );

  return (
    <ThemeContext.Provider value={themeValue}>
      <AppContext.Provider value={value}>{children}</AppContext.Provider>
    </ThemeContext.Provider>
  );
}
