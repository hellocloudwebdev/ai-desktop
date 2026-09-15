// PR37: apps/desktop — Pure Document Parsers
//
// Hand-rolled, dependency-free parsing from raw bytes to text. Every parser is
// pure: no Node fs, no network, no native modules. Cancellation propagates via
// AbortSignal; malformed input raises DocumentMalformed; unknown input raises
// DocumentUnsupportedFormat from the registry.

import {
  DocumentCancelled,
  DocumentMalformed,
  DocumentUnsupportedFormat,
} from "./document-errors.js";

export interface DocumentParsePage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface DocumentParseResult {
  readonly text: string;
  readonly pages?: DocumentParsePage[];
  readonly title?: string;
  readonly author?: string;
  readonly pageCount?: number;
}

export interface DocumentParserInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface DocumentParser {
  supports(mimeType: string, filename?: string): boolean;
  parse(input: DocumentParserInput, signal?: AbortSignal): Promise<DocumentParseResult>;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DocumentCancelled();
  }
}

function decodeUtf8Fatal(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentMalformed(`${label} is not valid UTF-8`);
  }
}

function filenameOf(filename?: string): string {
  return (filename ?? "").toLowerCase();
}

function baseName(filename?: string): string {
  const lower = filenameOf(filename);
  const slash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

export class PlainTextParser implements DocumentParser {
  supports(mimeType: string, filename?: string): boolean {
    const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (mime === "text/plain") {
      return true;
    }
    return mime === "" && filenameOf(filename).endsWith(".txt");
  }

  async parse(input: DocumentParserInput, signal?: AbortSignal): Promise<DocumentParseResult> {
    checkCancelled(signal);
    const text = decodeUtf8Fatal(input.bytes, input.filename ?? "Plain text document");
    return { text };
  }
}

// ---------------------------------------------------------------------------
// Markdown (text preserved verbatim; ATX headings noted via title)
// ---------------------------------------------------------------------------

export class MarkdownParser implements DocumentParser {
  supports(mimeType: string, filename?: string): boolean {
    const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (mime === "text/markdown" || mime === "text/x-markdown") {
      return true;
    }
    return filenameOf(filename).endsWith(".md") || filenameOf(filename).endsWith(".markdown");
  }

  async parse(input: DocumentParserInput, signal?: AbortSignal): Promise<DocumentParseResult> {
    checkCancelled(signal);
    const text = decodeUtf8Fatal(input.bytes, input.filename ?? "Markdown document");
    let title: string | undefined;
    for (const line of text.split("\n")) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
      if (match?.[2]) {
        title = match[2];
        break;
      }
    }
    return title ? { text, title } : { text };
  }
}

// ---------------------------------------------------------------------------
// JSON (pretty-extract text-ish fields, else stable stringify)
// ---------------------------------------------------------------------------

const TEXTISH_KEYS = new Set([
  "text",
  "content",
  "body",
  "title",
  "heading",
  "caption",
  "description",
  "summary",
  "excerpt",
  "message",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTextish(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextish(item, out);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (TEXTISH_KEYS.has(key.toLowerCase()) && typeof entry === "string") {
        if (entry.trim()) {
          out.push(entry);
        }
      } else {
        collectTextish(entry, out);
      }
    }
  }
}

export class JsonParser implements DocumentParser {
  supports(mimeType: string, filename?: string): boolean {
    const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (mime === "application/json" || mime.endsWith("+json")) {
      return true;
    }
    return mime === "" && filenameOf(filename).endsWith(".json");
  }

  async parse(input: DocumentParserInput, signal?: AbortSignal): Promise<DocumentParseResult> {
    checkCancelled(signal);
    const raw = decodeUtf8Fatal(input.bytes, input.filename ?? "JSON document");
    if (!raw.trim()) {
      throw new DocumentMalformed("JSON document is empty");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new DocumentMalformed("JSON document is malformed");
    }
    if (typeof value === "string") {
      return { text: value };
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
      const parts: string[] = [];
      collectTextish(value, parts);
      if (parts.length > 0) {
        return { text: parts.join("\n") };
      }
    }
    if (isRecord(value)) {
      const parts: string[] = [];
      collectTextish(value, parts);
      if (parts.length > 0 && parts.join("").length >= Math.min(raw.trim().length, 1)) {
        return {
          text: parts.join("\n"),
          title: typeof value["title"] === "string" ? value["title"] : undefined,
        };
      }
    }
    return { text: JSON.stringify(value, null, 2) ?? "" };
  }
}

// ---------------------------------------------------------------------------
// CSV (RFC4180-ish quoted-field state machine; first row = header)
// ---------------------------------------------------------------------------

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === "") {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      field = "";
      fieldStarted = false;
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (inQuotes) {
    throw new DocumentMalformed("CSV document has an unterminated quoted field");
  }
  row.push(field);
  const isTrailingEmpty = row.length === 1 && row[0] === "" && rows.length > 0;
  if (!isTrailingEmpty) {
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export class CsvParser implements DocumentParser {
  supports(mimeType: string, filename?: string): boolean {
    const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (mime === "text/csv" || mime === "application/csv" || mime === "text/x-csv") {
      return true;
    }
    return mime === "" && filenameOf(filename).endsWith(".csv");
  }

  async parse(input: DocumentParserInput, signal?: AbortSignal): Promise<DocumentParseResult> {
    checkCancelled(signal);
    const raw = decodeUtf8Fatal(input.bytes, input.filename ?? "CSV document");
    if (!raw.trim()) {
      return { text: "" };
    }
    const rows = parseCsvRows(raw);
    if (rows.length === 0) {
      return { text: "" };
    }
    const header = rows[0] as string[];
    const lines: string[] = [];
    for (const dataRow of rows.slice(1)) {
      for (let col = 0; col < header.length; col += 1) {
        const name = (header[col] ?? "").trim() || `column-${col + 1}`;
        const value = (dataRow[col] ?? "").trim();
        if (value) {
          lines.push(`${name}: ${value}`);
        }
      }
    }
    if (rows.length === 1) {
      for (const name of header) {
        if (name.trim()) {
          lines.push(`${name.trim()}:`);
        }
      }
    }
    return { text: lines.join("\n") };
  }
}

// ---------------------------------------------------------------------------
// PDF (minimal hand-rolled extractor: BT...ET blocks, Tj / TJ operators)
// ---------------------------------------------------------------------------

function latin1ToText(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}

function winAnsiDecode(bytes: number[]): string {
  const extras: Record<number, string> = {
    0x82: "‚",
    0x83: "ƒ",
    0x84: "„",
    0x85: "…",
    0x86: "†",
    0x87: "‡",
    0x88: "ˆ",
    0x89: "‰",
    0x8a: "Š",
    0x8b: "‹",
    0x8c: "Œ",
    0x91: "‘",
    0x92: "’",
    0x93: "“",
    0x94: "”",
    0x95: "•",
    0x96: "–",
    0x97: "—",
    0x98: "˜",
    0x99: "™",
    0x9a: "š",
    0x9b: "›",
    0x9c: "œ",
  };
  return bytes
    .map((b) => {
      if (b < 0x80 || b >= 0xa0) {
        return String.fromCharCode(b);
      }
      return extras[b] ?? String.fromCharCode(b);
    })
    .join("");
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const pair = clean.slice(i, i + 2);
    const value = Number.parseInt(pair.length === 1 ? `${pair}0` : pair, 16);
    if (Number.isNaN(value)) {
      continue;
    }
    bytes.push(value);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
    }
    return out;
  }
  return winAnsiDecode(bytes);
}

function parseLiteralString(raw: string, index: number): { text: string; next: number } {
  const bytes: number[] = [];
  let i = index + 1;
  let depth = 1;
  while (i < raw.length && depth > 0) {
    const ch = raw[i] as string;
    if (ch === "\\") {
      const nextCh = raw[i + 1] ?? "";
      if (nextCh === "n") {
        bytes.push(0x0a);
        i += 2;
      } else if (nextCh === "r") {
        bytes.push(0x0d);
        i += 2;
      } else if (nextCh === "t") {
        bytes.push(0x09);
        i += 2;
      } else if (nextCh === "b") {
        bytes.push(0x08);
        i += 2;
      } else if (nextCh === "f") {
        bytes.push(0x0c);
        i += 2;
      } else if (nextCh === "(" || nextCh === ")" || nextCh === "\\") {
        bytes.push(nextCh.charCodeAt(0));
        i += 2;
      } else if (nextCh >= "0" && nextCh <= "7") {
        const octal = (raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/) ?? [""])[0] as string;
        bytes.push(Number.parseInt(octal, 8));
        i += 1 + octal.length;
      } else if (nextCh === "\r" || nextCh === "\n") {
        i += nextCh === "\r" && raw[i + 2] === "\n" ? 3 : 2;
      } else {
        bytes.push(nextCh.charCodeAt(0));
        i += 2;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      bytes.push(0x28);
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
      bytes.push(0x29);
      i += 1;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i += 1;
  }
  return { text: winAnsiDecode(bytes), next: i };
}

function extractTextFromContentBlock(block: string): string {
  const pieces: string[] = [];
  let i = 0;
  while (i < block.length) {
    const ch = block[i] as string;
    if (ch === "(") {
      const parsed = parseLiteralString(block, i);
      i = parsed.next;
      let j = i;
      while (j < block.length && /[\s]/.test(block[j] as string)) {
        j += 1;
      }
      const op = block.slice(j, j + 3);
      if (op === "Tj " || op === "Tj\n" || op === "Tj\r" || block.slice(j, j + 2) === "Tj") {
        pieces.push(parsed.text);
      } else if (block.slice(j, j + 2) === "TJ" || block.slice(j, j + 2) === "Tj") {
        pieces.push(parsed.text);
      }
      continue;
    }
    if (ch === "<" && block[i + 1] !== "<") {
      const end = block.indexOf(">", i + 1);
      if (end > i) {
        const decoded = decodeHexString(block.slice(i + 1, end));
        let j = end + 1;
        while (j < block.length && /[\s]/.test(block[j] as string)) {
          j += 1;
        }
        if (block.slice(j, j + 2) === "Tj" || block.slice(j, j + 2) === "TJ") {
          pieces.push(decoded);
        }
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const end = block.indexOf("]", i + 1);
      if (end > i) {
        const segment = block.slice(i + 1, end);
        const arrayPieces: string[] = [];
        let k = 0;
        while (k < segment.length) {
          const c = segment[k] as string;
          if (c === "(") {
            const parsed = parseLiteralString(segment, k);
            arrayPieces.push(parsed.text);
            k = parsed.next;
            continue;
          }
          if (c === "<" && segment[k + 1] !== "<") {
            const close = segment.indexOf(">", k + 1);
            if (close > k) {
              arrayPieces.push(decodeHexString(segment.slice(k + 1, close)));
              k = close + 1;
              continue;
            }
          }
          k += 1;
        }
        let j = end + 1;
        while (j < block.length && /[\s]/.test(block[j] as string)) {
          j += 1;
        }
        if (block.slice(j, j + 2) === "TJ") {
          pieces.push(arrayPieces.join(""));
        }
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
  return pieces.join("");
}

function countPageMarkers(raw: string): number {
  const matches = raw.match(/\/Type\s*\/Page(?!s)/g);
  return matches?.length ?? 0;
}

function splitIntoPageRanges(raw: string): Array<{ start: number; end: number }> {
  const marker = /\/Type\s*\/Page(?!s)/g;
  const positions: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(raw)) !== null) {
    positions.push(match.index);
  }
  if (positions.length === 0) {
    return [{ start: 0, end: raw.length }];
  }
  return positions.map((start, index) => ({
    start,
    end: index + 1 < positions.length ? (positions[index + 1] as number) : raw.length,
  }));
}

export class PdfParser implements DocumentParser {
  supports(mimeType: string, filename?: string): boolean {
    const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (mime === "application/pdf" || mime === "application/x-pdf") {
      return true;
    }
    return filenameOf(filename).endsWith(".pdf");
  }

  async parse(input: DocumentParserInput, signal?: AbortSignal): Promise<DocumentParseResult> {
    checkCancelled(signal);
    const raw = latin1ToText(input.bytes);
    if (!raw.startsWith("%PDF-")) {
      throw new DocumentMalformed("PDF document is missing its %PDF- header");
    }
    const pageRanges = splitIntoPageRanges(raw);
    const pageCount = countPageMarkers(raw);
    const pages: DocumentParsePage[] = [];
    const allPieces: string[] = [];
    let pageNumber = 0;
    for (const range of pageRanges) {
      checkCancelled(signal);
      const segment = raw.slice(range.start, range.end);
      const blocks = segment.match(/BT([\s\S]*?)ET/g) ?? [];
      const pieces: string[] = [];
      for (const block of blocks) {
        checkCancelled(signal);
        const inner = block.replace(/^BT/, "").replace(/ET$/, "");
        const text = extractTextFromContentBlock(inner);
        if (text) {
          pieces.push(text);
        }
      }
      const pageText = pieces.join(" ").replace(/\s+/g, " ").trim();
      if (pageText) {
        pageNumber += 1;
        pages.push({ pageNumber, text: pageText });
        allPieces.push(pageText);
      }
    }
    const text = allPieces.join("\n\n");
    if (!text) {
      return { text: "", pageCount: 0 };
    }
    const title = baseName(input.filename) || undefined;
    return {
      text,
      pages: pages.length > 0 ? pages : undefined,
      title,
      pageCount: pageCount > 0 ? pageCount : pages.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class DocumentParserRegistry {
  private readonly _parsers: DocumentParser[] = [];

  register(parser: DocumentParser): void {
    this._parsers.push(parser);
  }

  parse(
    mimeType: string,
    filename: string | undefined,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DocumentParseResult> {
    const parser = this._parsers.find((candidate) => {
      try {
        return candidate.supports(mimeType, filename);
      } catch {
        return false;
      }
    });
    if (!parser) {
      throw new DocumentUnsupportedFormat(
        mimeType || filename,
        `No parser supports${mimeType ? ` MIME "${mimeType}"` : ""}${filename ? ` file "${filename}"` : ""}`,
      );
    }
    return parser.parse({ bytes, mimeType, filename }, signal);
  }
}

export function createDefaultDocumentParserRegistry(): DocumentParserRegistry {
  const registry = new DocumentParserRegistry();
  registry.register(new PlainTextParser());
  registry.register(new MarkdownParser());
  registry.register(new JsonParser());
  registry.register(new CsvParser());
  registry.register(new PdfParser());
  return registry;
}
