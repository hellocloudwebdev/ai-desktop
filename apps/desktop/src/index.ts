// PR12: apps/desktop — Package Entrypoint
//
// Re-exports main process and preload application contracts.
// Electron imports strictly confined to this package.

export {
  createMainWindow,
  getSecureWebPreferences,
  ActiveStreamRegistry,
  ChatService,
  IpcBatcher,
} from "./main/index.js";
export type { DesktopApplicationApi } from "./preload/index.js";
export { desktopApi } from "./preload/index.js";
