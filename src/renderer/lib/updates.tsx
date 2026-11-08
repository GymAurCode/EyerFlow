/**
 * Update state for the renderer.
 *
 * The updater lives in the main process - it is the only place that may
 * replace the installed application - so the renderer keeps a copy of its
 * state and follows it. One provider means a screen that shows "version 1.0.0
 * is installed" and a notification that says "1.0.1 is available" are talking
 * about the same thing.
 *
 * Nothing here decides anything. The provider asks; the main process decides
 * and pushes the answer back.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ApiResult, UpdateStatus } from "../../shared/ipc";
import { bridge, errorMessage } from "./api";

export interface UpdatesState {
  /** The updater's state, as last heard from the main process. */
  readonly status: UpdateStatus;
  /** True while a request the user asked for is in flight. */
  readonly busy: boolean;
  /** The last failure, in words the reader can act on. */
  readonly error: string | null;
  /** Ask the release server whether a newer version exists. */
  check(): Promise<void>;
  /** Download the installer for the version that was found. */
  download(): Promise<void>;
  /** Close the app and install the downloaded update. */
  install(): Promise<void>;
}

/**
 * The state before the main process has been asked.
 *
 * `supported: false` is the honest answer for a build that has not reported
 * yet: nothing is known, so nothing is claimed.
 */
const INITIAL_STATUS: UpdateStatus = {
  supported: false,
  state: "idle",
  currentVersion: "",
  latestVersion: null,
  progressPercent: null,
  message: null,
  releaseUrl: null,
  checkedAtIso: null,
};

const UpdatesContext = createContext<UpdatesState | null>(null);

export function useUpdates(): UpdatesState {
  const value = useContext(UpdatesContext);
  if (value === null) {
    throw new Error("useUpdates must be used inside <UpdateProvider>");
  }
  return value;
}

/**
 * Unwrap a bridge answer, or report that it failed.
 *
 * A typed failure is the updater's answer ("there is no update"), not a
 * transport problem, so it is returned as-is rather than thrown.
 */
function unwrap(result: ApiResult<UpdateStatus>): UpdateStatus | null {
  return result.ok ? result.data : null;
}

export interface UpdateProviderProps {
  readonly children: ReactNode;
}

export function UpdateProvider({ children }: UpdateProviderProps): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>(INITIAL_STATUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the main process's state.
  //
  // The current state is read once on mount, because a background check may
  // have finished before this screen existed - the push alone would have
  // missed it - and then every change is followed as it happens.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;

    try {
      const api = bridge();

      stop = api.onUpdateStatus((next) => {
        if (cancelled) return;
        setStatus(next);
        setError(null);
      });

      void (async () => {
        const current = unwrap(await api.currentUpdate());
        if (cancelled || current === null) return;
        setStatus(current);
      })();
    } catch {
      // No bridge: the app is already showing its recovery screen, and the
      // update state is the least of the problems.
    }

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const run = useCallback(
    async (action: (api: ReturnType<typeof bridge>) => Promise<ApiResult<UpdateStatus>>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await action(bridge());
        const next = unwrap(result);
        if (next !== null) setStatus(next);
        if (!result.ok) setError(result.error.message);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const check = useCallback(async (): Promise<void> => {
    await run((api) => api.checkForUpdate());
  }, [run]);

  const download = useCallback(async (): Promise<void> => {
    await run((api) => api.downloadUpdate());
  }, [run]);

  const install = useCallback(async (): Promise<void> => {
    await run((api) => api.installUpdate());
  }, [run]);

  const value = useMemo<UpdatesState>(
    () => ({ status, busy, error, check, download, install }),
    [status, busy, error, check, download, install],
  );

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}
