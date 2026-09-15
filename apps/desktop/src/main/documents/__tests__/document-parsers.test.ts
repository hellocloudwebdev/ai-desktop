// PR37: apps/desktop — Document Parsers Tests

import { describe, expect, it } from "vitest";
import {
  DocumentCancelled,
  DocumentMalformed,
  DocumentUnsupportedFormat,
} from "../document-errors.js";
import {
  CsvParser,
  DocumentParserRegistry,
  JsonParser,
  MarkdownParser,
  PdfParser,
  PlainTextParser,
  createDefaultDocumentParserRegistry,
} from "../document-parsers.js";

const enc = new TextEncoder();
const bytesOf = (text: string): Uint8Array => enc.encode(text);

function minimalPdf(pageTexts: string[]): Uint8Array {
  const pages = pageTexts
    .map((text, index) => {
      const objId = 3 + index;
      return `${objId} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${10 + index} 0 R >>\nendobj\n${10 + index} 0 obj\n<< /Length ${text.length + 20} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream\nendobj`;
    })
    .join("\n");
  return enc.encode(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n${pages}\n%%EOF`,
  );
}

describe("PlainTextParser", () => {
  const parser = new PlainTextParser();

  it("supports text/plain", () => {
    expect(parser.supports("text/plain")).toBe(true);
    expect(parser.supports("text/plain; charset=utf-8")).toBe(true);
    expect(parser.supports("application/json")).toBe(false);
  });

  it("parses valid text", async () => {
    const result = await parser.parse({ bytes: bytesOf("Hello world"), mimeType: "text/plain" });
    expect(result.text).toBe("Hello world");
  });

  it("parses empty input to empty text", async () => {
    const result = await parser.parse({ bytes: new Uint8Array(), mimeType: "text/plain" });
    expect(result.text).toBe("");
  });

  it("preserves unicode content", async () => {
    const result = await parser.parse({
      bytes: bytesOf("héllo wörld — 日本語"),
      mimeType: "text/plain",
    });
    expect(result.text).toBe("héllo wörld — 日本語");
  });

  it("rejects bad utf-8 bytes as malformed", async () => {
    await expect(
      parser.parse({ bytes: new Uint8Array([0xff, 0xfe, 0x41]), mimeType: "text/plain" }),
    ).rejects.toBeInstanceOf(DocumentMalformed);
  });
});

describe("MarkdownParser", () => {
  const parser = new MarkdownParser();

  it("supports markdown mime and .md fallback", () => {
    expect(parser.supports("text/markdown")).toBe(true);
    expect(parser.supports("", "notes.md")).toBe(true);
    expect(parser.supports("text/plain")).toBe(false);
  });

  it("preserves code fences and extracts the first ATX heading as title", async () => {
    const md = "# Hello\n\n```ts\nconst x = 1;\n```\n\nBody text.";
    const result = await parser.parse({ bytes: bytesOf(md), mimeType: "text/markdown" });
    expect(result.text).toContain("```ts");
    expect(result.title).toBe("Hello");
  });

  it("parses markdown without headings (no title)", async () => {
    const result = await parser.parse({ bytes: bytesOf("Just text."), mimeType: "text/markdown" });
    expect(result.text).toBe("Just text.");
    expect(result.title).toBeUndefined();
  });

  it("rejects bad utf-8 bytes as malformed", async () => {
    await expect(
      parser.parse({ bytes: new Uint8Array([0xff]), mimeType: "text/markdown" }),
    ).rejects.toBeInstanceOf(DocumentMalformed);
  });
});

describe("JsonParser", () => {
  const parser = new JsonParser();

  it("supports application/json and .json fallback", () => {
    expect(parser.supports("application/json")).toBe(true);
    expect(parser.supports("application/hal+json")).toBe(true);
    expect(parser.supports("", "data.json")).toBe(true);
    expect(parser.supports("text/plain")).toBe(false);
  });

  it("joins text-ish fields for arrays of objects", async () => {
    const raw = JSON.stringify([
      { title: "Doc A", text: "First body" },
      { title: "Doc B", content: "Second body" },
    ]);
    const result = await parser.parse({ bytes: bytesOf(raw), mimeType: "application/json" });
    expect(result.text).toContain("Doc A");
    expect(result.text).toContain("First body");
    expect(result.text).toContain("Second body");
  });

  it("stringifies objects without text-ish fields", async () => {
    const result = await parser.parse({
      bytes: bytesOf(JSON.stringify({ a: 1, b: [1, 2] })),
      mimeType: "application/json",
    });
    expect(result.text).toContain('"a": 1');
  });

  it("rejects malformed JSON", async () => {
    await expect(
      parser.parse({ bytes: bytesOf("{not json"), mimeType: "application/json" }),
    ).rejects.toBeInstanceOf(DocumentMalformed);
  });

  it("rejects empty JSON documents", async () => {
    await expect(
      parser.parse({ bytes: bytesOf("   "), mimeType: "application/json" }),
    ).rejects.toBeInstanceOf(DocumentMalformed);
  });
});

describe("CsvParser", () => {
  const parser = new CsvParser();

  it("supports text/csv and .csv fallback", () => {
    expect(parser.supports("text/csv")).toBe(true);
    expect(parser.supports("", "rows.csv")).toBe(true);
    expect(parser.supports("text/plain")).toBe(false);
  });

  it("emits header: value lines per row", async () => {
    const result = await parser.parse({
      bytes: bytesOf("name,age\nAda,36\nGrace,85"),
      mimeType: "text/csv",
    });
    expect(result.text).toBe("name: Ada\nage: 36\nname: Grace\nage: 85");
  });

  it("handles quoted fields with commas and escaped quotes", async () => {
    const result = await parser.parse({
      bytes: bytesOf('name,note\n"Ada, L.","Said ""hi""."\n'),
      mimeType: "text/csv",
    });
    expect(result.text).toContain("name: Ada, L.");
    expect(result.text).toContain('note: Said "hi".');
  });

  it("handles header-only input", async () => {
    const result = await parser.parse({ bytes: bytesOf("a,b,c"), mimeType: "text/csv" });
    expect(result.text).toContain("a:");
  });

  it("parses empty input to empty text", async () => {
    const result = await parser.parse({ bytes: bytesOf(""), mimeType: "text/csv" });
    expect(result.text).toBe("");
  });
});

describe("PdfParser", () => {
  const parser = new PdfParser();

  it("supports application/pdf and .pdf fallback", () => {
    expect(parser.supports("application/pdf")).toBe(true);
    expect(parser.supports("", "scan.pdf")).toBe(true);
    expect(parser.supports("text/plain")).toBe(false);
  });

  it("extracts text from Tj operators", async () => {
    const result = await parser.parse({
      bytes: minimalPdf(["Hello PDF"]),
      mimeType: "application/pdf",
    });
    expect(result.text).toContain("Hello PDF");
    expect(result.pageCount).toBe(1);
  });

  it("extracts text from TJ arrays and hex strings", async () => {
    const raw =
      "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< >>\nstream\nBT [(He) 120 (llo)] TJ ET\nBT <576F726C64> Tj ET\nendstream\nendobj\n%%EOF";
    const result = await parser.parse({ bytes: enc.encode(raw), mimeType: "application/pdf" });
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World");
  });

  it("handles escaped parens inside literal strings", async () => {
    const raw =
      "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\nBT (a \\(b\\) c) Tj ET\nendstream\n%%EOF";
    const result = await parser.parse({ bytes: enc.encode(raw), mimeType: "application/pdf" });
    expect(result.text).toContain("a (b) c");
  });

  it("rejects input without a %PDF- header", async () => {
    await expect(
      parser.parse({ bytes: bytesOf("BT (hi) Tj ET"), mimeType: "application/pdf" }),
    ).rejects.toBeInstanceOf(DocumentMalformed);
  });

  it("returns empty text with pageCount 0 when no text is found", async () => {
    const raw = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF";
    const result = await parser.parse({ bytes: enc.encode(raw), mimeType: "application/pdf" });
    expect(result.text).toBe("");
    expect(result.pageCount).toBe(0);
  });

  it("reconstructs page boundaries via /Type /Page markers", async () => {
    const result = await parser.parse({
      bytes: minimalPdf(["First page", "Second page"]),
      mimeType: "application/pdf",
    });
    expect(result.pages).toHaveLength(2);
    expect(result.pages?.[0]?.pageNumber).toBe(1);
    expect(result.pages?.[1]?.text).toContain("Second page");
  });

  it("throws DocumentCancelled when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parser.parse({ bytes: minimalPdf(["Hi"]), mimeType: "application/pdf" }, controller.signal),
    ).rejects.toBeInstanceOf(DocumentCancelled);
  });
});

describe("DocumentParserRegistry", () => {
  it("routes by mime type through the default registry", async () => {
    const registry = createDefaultDocumentParserRegistry();
    const result = await registry.parse("text/plain", "a.txt", bytesOf("hi"));
    expect(result.text).toBe("hi");
  });

  it("throws DocumentUnsupportedFormat for unknown input", () => {
    const registry = new DocumentParserRegistry();
    registry.register(new PlainTextParser());
    expect(() => registry.parse("image/png", "a.png", bytesOf("x"))).toThrow(
      DocumentUnsupportedFormat,
    );
  });
});
