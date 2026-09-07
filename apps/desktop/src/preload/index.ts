// PR12: apps/desktop — Preload Bridge Boundary
//
// Invariants (Step 35):
//   1. Exposes ONLY a narrow, application-owned window.api bridge.
//   2. NEVER exposes raw ipcRenderer, ipcMain, BrowserWindow, app, shell, fs, or process.
//   3. Preload is the single controlled boundary between native main process and React renderer.
//   4. Full typed IPC channel contracts belong to PR13.

import { contextBridge } from "electron";

/**
 * Minimal application API exposed to the renderer in PR12.
 * PR13 will expand this with typed IPC commands, subscriptions, and event streams.
 */
export interface DesktopApplicationApi {
  readonly platform: string;
  readonly isPackaged: boolean;
  ping(): string;
}

export const desktopApi: DesktopApplicationApi = {
  platform: process.platform,
  isPackaged: process.env.NODE_ENV === "production",
  ping: () => "pong",
};

// Expose safe, narrow application API to the renderer's window object
if (contextBridge && typeof contextBridge.exposeInMainWorld === "function") {
  contextBridge.exposeInMainWorld("api", desktopApi);
}
