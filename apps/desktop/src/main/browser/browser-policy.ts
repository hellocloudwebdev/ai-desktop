// PR34.3: apps/desktop — Browser Navigation Policy
//
// Invariants:
//   1. Checks isSafeBrowserUrl(url) from @ai-desktop/ai-core.
//   2. Strictly rejects dangerous schemes (javascript:, vbscript:, data:, file:, blob:).
//   3. Configurable allowed hostnames filter.
//   4. Throws BrowserNavigationDenied on assertion failure.

import { DANGEROUS_BROWSER_URL_PATTERN, isSafeBrowserUrl } from "@ai-desktop/ai-core";
import { BrowserNavigationDenied } from "./browser-errors.js";

export interface BrowserNavigationPolicyOptions {
  readonly allowedHostnames?: readonly string[];
  readonly allowAboutBlank?: boolean;
}

export class BrowserNavigationPolicy {
  private readonly _allowedHostnames?: readonly string[];
  private readonly _allowAboutBlank: boolean;

  constructor(options?: BrowserNavigationPolicyOptions) {
    this._allowedHostnames = options?.allowedHostnames?.map((h) => h.toLowerCase().trim());
    this._allowAboutBlank = options?.allowAboutBlank ?? true;
  }

  isAllowed(url: string): boolean {
    if (!url || typeof url !== "string") {
      return false;
    }

    const trimmed = url.trim();

    // 1. Explicitly check dangerous schemes pattern
    if (DANGEROUS_BROWSER_URL_PATTERN.test(trimmed)) {
      return false;
    }

    // 2. Validate against ai-core safety check
    if (!isSafeBrowserUrl(trimmed)) {
      return false;
    }

    try {
      const parsed = new URL(trimmed);

      // 3. Handle about: protocol
      if (parsed.protocol === "about:") {
        return this._allowAboutBlank && parsed.pathname === "blank";
      }

      // 4. Handle http / https protocols
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        if (!this._allowedHostnames || this._allowedHostnames.length === 0) {
          return true;
        }

        const hostname = parsed.hostname.toLowerCase();
        return this._allowedHostnames.some((pattern) => {
          if (pattern === hostname) {
            return true;
          }
          if (pattern.startsWith("*.") && hostname.endsWith(pattern.slice(1))) {
            return true;
          }
          if (hostname.endsWith("." + pattern)) {
            return true;
          }
          return false;
        });
      }

      return false;
    } catch {
      return false;
    }
  }

  assertAllowed(url: string): void {
    if (!this.isAllowed(url)) {
      throw new BrowserNavigationDenied(url, `Navigation to "${url}" denied by policy`);
    }
  }
}
