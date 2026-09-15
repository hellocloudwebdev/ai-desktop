// PR37: apps/desktop — Document Normalizer Tests

import { describe, expect, it } from "vitest";
import { normalizeDocumentText, normalizeParsedDocument } from "../document-normalizer.js";

describe("normalizeDocumentText", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeDocumentText("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("converts lone CR to LF", () => {
    expect(normalizeDocumentText("a\rb\rc")).toBe("a\nb\nc");
  });

  it("collapses 3+ newlines to 2", () => {
    expect(normalizeDocumentText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("keeps exactly 2 newlines intact", () => {
    expect(normalizeDocumentText("a\n\nb")).toBe("a\n\nb");
  });

  it("strips trailing spaces per line but keeps leading indentation", () => {
    expect(normalizeDocumentText("keep  \n  a   \n\tb\t ")).toBe("keep\n  a\n\tb");
  });

  it("removes C0 control chars but keeps tab and newline", () => {
    expect(normalizeDocumentText("a\u0001\u0002b\tc\nd")).toBe("ab\tc\nd");
  });

  it("trims leading and trailing whitespace overall", () => {
    expect(normalizeDocumentText("  \n hello \n  ")).toBe("hello");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeDocumentText("   \n \n ")).toBe("");
  });

  it("is idempotent", () => {
    const input = "a\r\n\r\n\r\nb   \n\tc\u0001end  ";
    const once = normalizeDocumentText(input);
    expect(normalizeDocumentText(once)).toBe(once);
  });

  it("is deterministic for the same input", () => {
    const input = "x\r\ny\u0001z\n\n\nw   ";
    expect(normalizeDocumentText(input)).toBe(normalizeDocumentText(input));
  });
});

describe("normalizeParsedDocument", () => {
  it("normalizes top-level text and each page", () => {
    const out = normalizeParsedDocument({
      text: "a\r\n\r\n\r\nb",
      pages: [
        { pageNumber: 2, text: "p2   \r\ntext" },
        { pageNumber: 1, text: "p1\u0001x" },
      ],
    });
    expect(out.text).toBe("a\n\nb");
    expect(out.pages).toHaveLength(2);
    expect(out.pages?.[0]).toEqual({ pageNumber: 2, text: "p2\ntext" });
    expect(out.pages?.[1]).toEqual({ pageNumber: 1, text: "p1x" });
  });

  it("omits pages when none are provided", () => {
    expect(normalizeParsedDocument({ text: "hi" }).pages).toBeUndefined();
  });
});
