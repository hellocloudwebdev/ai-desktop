// PR37: apps/desktop — Deterministic Document Text Normalizer
//
// Collapses platform line endings, strips unsafe control characters, and
// trims whitespace so downstream chunking and retrieval see a canonical form.
// The transform is deterministic: identical input always yields identical
// output, and normalizing twice is a no-op.

export interface NormalizedParsedDocumentPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface NormalizedParsedDocument {
  readonly text: string;
  readonly pages?: NormalizedParsedDocumentPage[];
}

// Strip C0 controls except tab/newline (kept). Explicit unicode escapes
// keep literal control bytes out of this source file.
const CONTROL_CHARS_PATTERN = new RegExp("[\u0000-\u0008\u000B\u000C\u000E-\u001F]", "g");
const THREE_PLUS_NEWLINES = /\n{3,}/g;

export function normalizeDocumentText(text: string): string {
  const unified = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutControls = unified.replace(CONTROL_CHARS_PATTERN, "");
  const lines = withoutControls.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  return lines.join("\n").replace(THREE_PLUS_NEWLINES, "\n\n").trim();
}

export function normalizeParsedDocument(parsed: {
  readonly text: string;
  readonly pages?: ReadonlyArray<{ readonly pageNumber: number; readonly text: string }>;
}): NormalizedParsedDocument {
  const text = normalizeDocumentText(parsed.text);
  if (!parsed.pages || parsed.pages.length === 0) {
    return { text };
  }
  const pages = parsed.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: normalizeDocumentText(page.text),
  }));
  return { text, pages };
}
