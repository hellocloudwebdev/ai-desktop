import type { DesktopApplicationApi } from "../preload/index.js";

declare global {
  interface Window {
    readonly api?: DesktopApplicationApi;
  }
}
