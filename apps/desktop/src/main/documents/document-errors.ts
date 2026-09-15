// PR37: apps/desktop — Canonical Document Errors
//
// Invariants:
//   1. Document domain errors derive from BaseError with explicit codes.
//   2. Zero provider SDK, Electron, or subprocess types leak through errors.
//   3. toCanonicalDocumentError maps unknown/external errors into canonical
//      DocumentError instances without exposing credentials, tokens, or paths.
//   4. Error messages are model-safe: no API keys, cookies, auth headers, or
//      internal hostnames.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

const SECRET_PATTERNS: RegExp[] = [
  /api[_-]?key\s*[:=]\s*['"]?[^\s'"]+/gi,
  /bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /token\s*[:=]\s*['"]?[^\s'"]+/gi,
  /cookie\s*:\s*[^\r\n]+/gi,
  /authorization\s*:\s*[^\r\n]+/gi,
];

export function redactSecretsFromMessage(message: string): string {
  let redacted = message;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export class DocumentError extends BaseError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, redactSecretsFromMessage(message), options);
    this.name = "DocumentError";
  }
}

export class DocumentUnsupportedFormat extends DocumentError {
  readonly mimeType?: string;

  constructor(mimeType?: string, message?: string, options?: ErrorOptions) {
    super(
      "UNSUPPORTED_FORMAT",
      message ?? `Unsupported document format${mimeType ? `: "${mimeType}"` : ""}`,
      options,
    );
    this.name = "DocumentUnsupportedFormat";
    this.mimeType = mimeType;
  }
}

export class DocumentTooLarge extends DocumentError {
  constructor(message = "Document exceeded bounded size limits", options?: ErrorOptions) {
    super("TOO_LARGE", message, options);
    this.name = "DocumentTooLarge";
  }
}

export class DocumentMalformed extends DocumentError {
  constructor(message = "Document content is malformed", options?: ErrorOptions) {
    super("MALFORMED_CONTENT", message, options);
    this.name = "DocumentMalformed";
  }
}

export class DocumentNotFound extends DocumentError {
  constructor(message = "Document not found", options?: ErrorOptions) {
    super("NOT_FOUND", message, options);
    this.name = "DocumentNotFound";
  }
}

export class DocumentProjectMismatch extends DocumentError {
  constructor(
    message = "Document does not belong to the requested project",
    options?: ErrorOptions,
  ) {
    super("PROJECT_MISMATCH", message, options);
    this.name = "DocumentProjectMismatch";
  }
}

export class DocumentProcessingFailed extends DocumentError {
  constructor(message = "Document processing failed", options?: ErrorOptions) {
    super("PROCESSING_FAILED", message, options);
    this.name = "DocumentProcessingFailed";
  }
}

export class DocumentCancelled extends DocumentError {
  constructor(message = "Document operation cancelled", options?: ErrorOptions) {
    super("CANCELLED", message, options);
    this.name = "DocumentCancelled";
  }
}

export class DocumentDeleted extends DocumentError {
  constructor(message = "Document has been deleted", options?: ErrorOptions) {
    super("DELETED", message, options);
    this.name = "DocumentDeleted";
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ABORT_ERR")
  );
}

export function toCanonicalDocumentError(err: unknown): DocumentError {
  if (err instanceof DocumentError) {
    return err;
  }
  if (isAbortError(err)) {
    return new DocumentCancelled();
  }
  if (err instanceof Error) {
    const message = redactSecretsFromMessage(err.message);
    if (/unsupported|content-type|mime|format/i.test(message)) {
      return new DocumentUnsupportedFormat(undefined, message, { cause: err });
    }
    if (/too large|exceed|limit|bounded/i.test(message)) {
      return new DocumentTooLarge(message, { cause: err });
    }
    if (/malformed|invalid|unexpected token|parse|syntax/i.test(message)) {
      return new DocumentMalformed(message, { cause: err });
    }
    if (/not found|enoent|missing/i.test(message)) {
      return new DocumentNotFound(message, { cause: err });
    }
    return new DocumentProcessingFailed(message, { cause: err });
  }
  return new DocumentProcessingFailed(`Unknown document failure: ${String(err)}`);
}
