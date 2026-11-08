/**
 * Typed renderer-side API client.
 *
 * Wraps `window.api.invoke` so screens never touch the bridge directly, and
 * converts a typed failure into an exception carrying the field name. That lets
 * form screens use a single try/catch and highlight the offending input without
 * each one re-implementing the result unwrapping.
 */

import type {
  ApiError,
  ApiResult,
  MinhaApi,
  RpcMethod,
  RpcRequestOf,
  RpcResponseOf,
} from "../../shared/ipc";

/**
 * The preload bridge, or a clear explanation of why it is missing.
 *
 * `window.api` is injected by the preload script, so it is absent exactly when
 * the app did not start properly - the main process died before the window was
 * built, or the page was loaded outside the shell. Calling through it blindly
 * produces "Cannot read properties of undefined (reading 'getAppInfo')", which
 * says nothing about the actual cause and buries the real error, which is in
 * the main process log.
 */
export function bridge(): MinhaApi {
  const api: MinhaApi | undefined = window.api;
  if (api === undefined) {
    throw new Error(
      "The application could not reach its main process. Close and reopen the app; " +
        "if it keeps happening, send the log file from the app's data folder to your supplier.",
    );
  }
  return api;
}

/**
 * True when the preload bridge is present.
 *
 * Used at startup to tell "the app is still loading" apart from "the app can
 * never work in this window", which need very different screens: a missing
 * bridge means the page is running outside the Electron shell or the main
 * process died, and every API call would fail exactly the same way.
 */
export function hasBridge(): boolean {
  return window.api !== undefined;
}

export class ApiException extends Error {
  public readonly requestId: string | undefined;
  public readonly code: string;
  public readonly field: string | undefined;

  public constructor(error: ApiError) {
    super(error.message);
    this.name = "ApiException";
    this.code = error.code;
    this.field = error.field;
    this.requestId = error.requestId;
  }
}

/** Default ceiling for a single call across the bridge. */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * Call an RPC method and return its data.
 *
 * Throws `ApiException` on a typed failure. Transport failures (the bridge
 * itself rejecting, or being missing entirely) are also surfaced as
 * `ApiException` so callers have one error type to handle.
 *
 * The bridge is reached through `bridge()` rather than `window.api` directly:
 * touching `window.api.invoke` unguarded turns a missing bridge into the
 * useless "Cannot read properties of undefined (reading 'invoke')", which says
 * nothing about the real cause. `bridge()` throws that explanation instead.
 *
 * A timeout is not optional. `ipcRenderer.invoke` settles only when the main
 * process answers, and the main process can be busy for reasons the renderer
 * cannot see - reading hardware identifiers shells out to the OS, a backup
 * holds the database - none of which produce an error. Without a ceiling the
 * caller's spinner runs forever with nothing on screen to explain it, which is
 * exactly how a stuck Activate button became indistinguishable from a slow one.
 */
export async function call<M extends RpcMethod>(
  method: M,
  payload: RpcRequestOf<M>,
  options: { readonly timeoutMs?: number } = {},
): Promise<RpcResponseOf<M>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ApiException({
          code: "TIMEOUT",
          message:
            `The app did not respond within ${Math.round(timeoutMs / 1000)} seconds. ` +
            "Close the app and open it again, then try once more.",
        }),
      );
    }, timeoutMs);
  });

  let result: ApiResult<RpcResponseOf<M>>;

  try {
    result = await Promise.race([bridge().invoke(method, payload), timeout]);
  } catch (error) {
    if (import.meta.env.DEV)
      console.error(
        "Renderer RPC transport failed",
        {
          page: typeof location === "undefined" ? "(unknown)" : location.hash,
          method,
          message: error instanceof Error ? error.message : "Transport failure",
          stack: error instanceof Error ? error.stack : undefined,
        },
        error,
      );
    if (error instanceof ApiException) throw error;
    // The bridge being absent or the invoke itself failing: report what came
    // back rather than a generic transport message.
    throw new ApiException({
      code: "TRANSPORT",
      message:
        error instanceof Error
          ? error.message
          : "Could not reach the application. Restart it and try again.",
    });
  } finally {
    // Always cleared: a timer left running after a successful call would fire
    // into nothing and, on a busy screen, keep the event loop alive.
    if (timer !== undefined) clearTimeout(timer);
  }

  if (result.ok) return result.data;

  const error = new ApiException(result.error);
  if (import.meta.env.DEV)
    console.error(
      "Renderer RPC failed",
      {
        page: typeof location === "undefined" ? "(unknown)" : location.hash,
        method,
        code: error.code,
        requestId: error.requestId,
        message: error.message,
        stack: error.stack,
      },
      error,
    );
  throw error;
}

/**
 * Like `call`, but returns a result object instead of throwing.
 *
 * Used where a failure is an expected outcome rather than an error: search boxes
 * that should stay silent while the user is still typing, and background
 * refreshes that must not blank the screen.
 */
export async function tryCall<M extends RpcMethod>(
  method: M,
  payload: RpcRequestOf<M>,
  options: { readonly timeoutMs?: number } = {},
): Promise<ApiResult<RpcResponseOf<M>>> {
  return call(method, payload, options).then(
    (data): ApiResult<RpcResponseOf<M>> => ({ ok: true, data }),
    (error: unknown): ApiResult<RpcResponseOf<M>> =>
      error instanceof ApiException
        ? {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              requestId: error.requestId,
              field: error.field,
            },
          }
        : {
            ok: false,
            error: { code: "UNEXPECTED", message: "Something went wrong. Please try again." },
          },
  );
}

/** Message from any thrown value, for a toast or an inline error. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiException)
    return error.message + (error.requestId ? ` Reference: ${error.requestId}` : "");
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

/** Field name from a validation failure, if the error named one. */
export function errorField(error: unknown): string | undefined {
  return error instanceof ApiException ? error.field : undefined;
}
