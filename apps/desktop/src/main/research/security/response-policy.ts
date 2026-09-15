// PR35.9: apps/desktop — Response Policy (bounded body + MIME gate)
//
// Invariants:
//   1. Bodies stream through a bounded reader: compressed bytes capped,
//      decompressed text capped (compression-bomb guard). Limits derive from
//      the research policy; exceeding them fails closed.
//   2. Content-Type is validated against the ai-core allowlist before the
//      body is trusted. Binaries are unsupported, never executed.
//   3. AbortSignal cancels the read; cancellation propagates as AbortError
//      for the canonical classifier.

import { isAllowedResponseMimeType } from "@ai-desktop/ai-core";
import { ResearchResponseTooLarge, ResearchUnsupportedMime } from "../research-errors.js";

export interface BoundedBody {
  readonly text: string;
  readonly mimeType: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

export interface ResponsePolicyOptions {
  readonly maxBytes?: number;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

function mimeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase();
}

/**
 * Reads a fetch Response body with byte + character ceilings. Returns the
 * decoded text with truncation flagged (never silently cut). Throws
 * ResearchUnsupportedMime / ResearchResponseTooLarge on policy violation.
 */
export async function readBoundedBody(
  response: Response,
  options?: ResponsePolicyOptions,
): Promise<BoundedBody> {
  const mimeType = mimeOf(response);
  if (!isAllowedResponseMimeType(mimeType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResearchUnsupportedMime(mimeType);
  }
  const maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
  const maxChars = options?.maxChars ?? 50000;
  const signal = options?.signal;
  if (signal?.aborted) {
    throw Object.assign(new Error("Research operation cancelled"), { name: "AbortError" });
  }
  if (!response.body) {
    const text = await response.text();
    return {
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      mimeType,
      truncated: text.length > maxChars,
      bytes: text.length,
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let chars = 0;
  let truncated = false;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        throw Object.assign(new Error("Research operation cancelled"), { name: "AbortError" });
      }
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ResearchResponseTooLarge(`Research response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
      const piece = decoder.decode(value, { stream: true });
      if (chars + piece.length > maxChars) {
        text += piece.slice(0, maxChars - chars);
        chars = maxChars;
        truncated = true;
        break;
      }
      text += piece;
      chars += piece.length;
    }
    text += decoder.decode();
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader already closed or errored; release below regardless.
    }
    reader.releaseLock();
  }
  void chunks;
  return { text, mimeType, truncated, bytes };
}
