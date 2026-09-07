// PR12: apps/desktop — Electron Main Process
//
// Invariants (Step 35):
//   1. Electron imports strictly confined to apps/desktop.
//   2. BrowserWindow enforces contextIsolation: true, nodeIntegration: false.
//   3. Preload script is the single controlled boundary.
//   4. Dev mode loads Vite dev server (e.g. localhost:5173); production loads local dist/index.html.
//   5. Standard lifecycle: handles window-all-closed, activate, single-instance.
//   6. Zero typed IPC or chat services implemented in PR12 (deferred to PR13/16).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { ActiveStreamRegistry } from "./chat/index.js";
import { IpcRegistry, registerIpcHandlers } from "./ipc/index.js";

export { ActiveStreamRegistry } from "./chat/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global reference prevents window from being garbage collected
let mainWindow: BrowserWindow | null = null;
let ipcRegistry: IpcRegistry | null = null;
let activeStreamRegistry: ActiveStreamRegistry | null = null;

export function getActiveStreamRegistry(): ActiveStreamRegistry {
  if (!activeStreamRegistry) {
    activeStreamRegistry = new ActiveStreamRegistry();
  }
  return activeStreamRegistry;
}

export function getSecureWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const preloadPath = path.join(__dirname, "../dist-electron/preload.js");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "AI Desktop",
    webPreferences: getSecureWebPreferences(preloadPath),
  });

  // Development vs. Production renderer loading
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    await mainWindow.loadFile(indexPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Application Lifecycle
// ---------------------------------------------------------------------------

export function initIpc(options?: { activeStreamRegistry?: ActiveStreamRegistry }): IpcRegistry {
  if (!ipcRegistry) {
    ipcRegistry = new IpcRegistry();
    const streamRegistry = options?.activeStreamRegistry ?? getActiveStreamRegistry();
    registerIpcHandlers(ipcRegistry, { streamRegistry });
  }
  return ipcRegistry;
}

if (app) {
  app.whenReady().then(async () => {
    initIpc();
    await createMainWindow();

    app.on("activate", async () => {
      if (BrowserWindow && BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    // Respect platform conventions: macOS applications typically stay open until Cmd+Q
    if (process.platform !== "darwin") {
      if (activeStreamRegistry) {
        activeStreamRegistry.clear();
        activeStreamRegistry = null;
      }
      if (ipcRegistry) {
        ipcRegistry.destroy();
        ipcRegistry = null;
      }
      app.quit();
    }
  });
}
