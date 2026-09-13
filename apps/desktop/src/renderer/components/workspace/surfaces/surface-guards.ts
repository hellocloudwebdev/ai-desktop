// PR33.3: renderer — Pure guards for rich surfaces (node-safe)
//
// Security + data shaping helpers shared by the document/table/form
// surfaces. Pure functions only: no React, no DOM, no window, no IPC.
// Unit-tested in rich-surface-host.test.ts.

export const MAX_TABLE_COLUMNS = 50;
export const MAX_TABLE_ROWS = 500;

/** Schemes that must never become clickable links in rendered surfaces. */
const UNSAFE_SCHEMES = ["javascript", "data", "vbscript", "file", "blob"];

function hasUnsafeScheme(candidate: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(candidate.trim());
  if (!match || !match[1]) return false;
  return UNSAFE_SCHEMES.includes(match[1].toLowerCase());
}

/**
 * Returns true for links the renderer may render as <a href>:
 * http/https absolute URLs, #fragments, and relative URLs starting with
 * "/" or ".". Everything else (including javascript:/data:/vbscript:/
 * file:/blob: and bare unknown schemes) renders as plain text.
 */
export function isSafeHref(href: unknown): boolean {
  if (typeof href !== "string") return false;
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith(".")) {
    return !hasUnsafeScheme(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) return !hasUnsafeScheme(trimmed);
  return false;
}

export type TableCellValue = string | number | boolean | null;

/** Coerces a cell to display text: primitives as-is, objects via JSON. */
export function coerceCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export interface TruncatedRows<T> {
  readonly rows: readonly T[];
  /** True when rows were dropped from the display (cap applied). */
  readonly truncated: boolean;
  readonly total: number;
}

/** Caps displayed rows at `max` (default 500), reporting truncation. */
export function truncateRows<T>(
  rows: readonly T[],
  max: number = MAX_TABLE_ROWS,
): TruncatedRows<T> {
  const total = rows.length;
  if (rows.length <= max) return { rows, truncated: false, total };
  return { rows: rows.slice(0, max), truncated: true, total };
}

/** Caps displayed columns at 50, reporting truncation. */
export function truncateColumns(columns: readonly string[]): TruncatedRows<string> {
  return truncateRows(columns, MAX_TABLE_COLUMNS);
}

export interface FormFieldDef {
  readonly id: string;
  readonly label: string;
  readonly type: "text" | "number" | "boolean" | "select" | "textarea";
  readonly required?: boolean;
  readonly options?: string[];
}

export interface FormValidation {
  readonly ok: boolean;
  readonly errors: Record<string, string>;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

/**
 * Renderer-side validation for form surfaces. Checks required fields and
 * select-membership only; the main process revalidates on submit.
 */
export function validateFormValues(
  fields: readonly FormFieldDef[],
  values: Record<string, unknown>,
): FormValidation {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.id];
    if (field.required && isEmptyValue(value)) {
      errors[field.id] = `${field.label} is required.`;
      continue;
    }
    if (isEmptyValue(value)) continue;
    if (field.type === "number" && typeof value !== "number") {
      const parsed = typeof value === "string" ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed)) errors[field.id] = `${field.label} must be a number.`;
    }
    if (field.type === "select" && Array.isArray(field.options) && field.options.length > 0) {
      if (typeof value !== "string" || !field.options.includes(value)) {
        errors[field.id] = `${field.label} must be one of the provided options.`;
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
