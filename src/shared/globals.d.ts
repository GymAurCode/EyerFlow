import type { MinhaApi } from "./ipc";

declare global {
  interface Window {
    /** Injected by the preload script via contextBridge. */
    readonly api: MinhaApi;
  }
}

export {};