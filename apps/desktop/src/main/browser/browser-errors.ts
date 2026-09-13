// PR34.3: apps/desktop — Canonical Browser Errors
//
// Invariants:
//   1. Canonical browser domain errors derive from BaseError (which derives from Error)
//      with explicit error codes.
//   2. Zero Puppeteer or vendor SDK types are leaked in these errors.
//   3. toCanonicalBrowserError maps unknown/external errors into canonical BrowserError instances.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

export class BrowserError extends BaseError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "BrowserError";
  }
}

export class BrowserNotFound extends BrowserError {
  constructor(message = "Browser executable or instance not found", options?: ErrorOptions) {
    super("BROWSER_NOT_FOUND", message, options);
    this.name = "BrowserNotFound";
  }
}

export class BrowserSessionNotFound extends BrowserError {
  readonly sessionId?: string;

  constructor(sessionId?: string, message?: string, options?: ErrorOptions) {
    const msg =
      message ??
      (sessionId ? `Browser session "${sessionId}" not found` : "Browser session not found");
    super("SESSION_NOT_FOUND", msg, options);
    this.name = "BrowserSessionNotFound";
    this.sessionId = sessionId;
  }
}

export class BrowserPageNotFound extends BrowserError {
  readonly pageId?: string;

  constructor(pageId?: string, message?: string, options?: ErrorOptions) {
    const msg =
      message ?? (pageId ? `Browser page "${pageId}" not found` : "Browser page not found");
    super("PAGE_NOT_FOUND", msg, options);
    this.name = "BrowserPageNotFound";
    this.pageId = pageId;
  }
}

export class BrowserNavigationDenied extends BrowserError {
  readonly url?: string;

  constructor(url?: string, message?: string, options?: ErrorOptions) {
    const msg =
      message ??
      (url ? `Navigation to "${url}" denied by policy` : "Browser navigation denied by policy");
    super("NAVIGATION_DENIED", msg, options);
    this.name = "BrowserNavigationDenied";
    this.url = url;
  }
}

export class BrowserTimeout extends BrowserError {
  constructor(message = "Browser operation timed out", options?: ErrorOptions) {
    super("TIMEOUT", message, options);
    this.name = "BrowserTimeout";
  }
}

export class BrowserActionFailed extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super("ACTION_FAILED", message, options);
    this.name = "BrowserActionFailed";
  }
}

export class BrowserStaleReference extends BrowserError {
  readonly ref?: string;

  constructor(ref?: string, message?: string, options?: ErrorOptions) {
    const msg =
      message ?? (ref ? `Stale or missing element reference "${ref}"` : "Stale element reference");
    super("STALE_REFERENCE", msg, options);
    this.name = "BrowserStaleReference";
    this.ref = ref;
  }
}

export class BrowserConnectionFailed extends BrowserError {
  constructor(message = "Failed to connect to browser engine", options?: ErrorOptions) {
    super("CONNECTION_FAILED", message, options);
    this.name = "BrowserConnectionFailed";
  }
}

export class BrowserResourceLimit extends BrowserError {
  constructor(message = "Browser resource limit exceeded", options?: ErrorOptions) {
    super("RESOURCE_LIMIT", message, options);
    this.name = "BrowserResourceLimit";
  }
}

export class BrowserCancelled extends BrowserError {
  constructor(message = "Browser operation cancelled", options?: ErrorOptions) {
    super("CANCELLED", message, options);
    this.name = "BrowserCancelled";
  }
}

/**
 * Maps any unknown error to a canonical BrowserError.
 */
export function toCanonicalBrowserError(err: unknown): BrowserError {
  if (err instanceof BrowserError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";

  if (
    name === "AbortError" ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
    /\b(aborted|cancelled|canceled)\b/i.test(message)
  ) {
    return new BrowserCancelled(message || "Browser operation cancelled", { cause: err });
  }

  if (name === "TimeoutError" || /\b(timed?\s*out|timeout)\b/i.test(message)) {
    return new BrowserTimeout(message || "Browser operation timed out", { cause: err });
  }

  if (/\b(stale|element is not attached|node is detached)\b/i.test(message)) {
    return new BrowserStaleReference(undefined, message, { cause: err });
  }

  if (/\b(navigation denied|unsafe scheme|disallowed protocol)\b/i.test(message)) {
    return new BrowserNavigationDenied(undefined, message, { cause: err });
  }

  if (
    /\b(browser.*not found|executable.*not found|cannot find chrome|cannot find browser)\b/i.test(
      message,
    )
  ) {
    return new BrowserNotFound(message, { cause: err });
  }

  if (
    /\b(connection failed|target closed|session closed|websocket connection|failed to connect|disconnected)\b/i.test(
      message,
    )
  ) {
    return new BrowserConnectionFailed(message, { cause: err });
  }

  if (/\b(resource limit|max.*exceeded|limit exceeded)\b/i.test(message)) {
    return new BrowserResourceLimit(message, { cause: err });
  }

  return new BrowserActionFailed(message || "Browser action failed", { cause: err });
}
