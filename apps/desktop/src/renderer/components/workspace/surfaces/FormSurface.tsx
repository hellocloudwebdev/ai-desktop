// PR33.6: renderer — Form Surface (field inputs + submit)
//
// Renders backend-owned form fields with local per-field state. Submit
// emits onAction("submit", values) after renderer-side validation; native
// `required` attributes provide browser validation and the main process
// revalidates on receipt.

import React from "react";
import { validateFormValues, type FormFieldDef } from "./surface-guards.js";

export type FormFieldType = FormFieldDef["type"];

export type FormFieldView = FormFieldDef;

export interface FormSurfaceData {
  readonly fields: FormFieldView[];
  readonly submitLabel?: string;
}

const FIELD_TYPES: readonly string[] = ["text", "number", "boolean", "select", "textarea"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalizes unknown surface data into fields (invalid fields dropped). */
export function normalizeFormData(data: unknown): FormSurfaceData {
  if (!isRecord(data) || !Array.isArray(data.fields)) return { fields: [] };
  const fields: FormFieldView[] = [];
  for (const entry of data.fields) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (typeof entry.label !== "string" || entry.label.length === 0) continue;
    if (typeof entry.type !== "string" || !FIELD_TYPES.includes(entry.type)) continue;
    const type = entry.type as FormFieldType;
    const options =
      type === "select" &&
      Array.isArray(entry.options) &&
      entry.options.every((o): o is string => typeof o === "string")
        ? (entry.options as string[])
        : undefined;
    fields.push({
      id: entry.id,
      label: entry.label,
      type,
      required: entry.required === true,
      ...(options ? { options } : {}),
    });
  }
  return {
    fields,
    submitLabel: typeof data.submitLabel === "string" ? data.submitLabel : undefined,
  };
}

function defaultValueFor(field: FormFieldView): string | boolean {
  if (field.type === "boolean") return false;
  return "";
}

export interface FormSurfaceProps {
  readonly data: unknown;
  onAction(actionId: string, input: unknown): void;
}

export function FormSurface({ data, onAction }: FormSurfaceProps): React.ReactElement {
  const normalized = React.useMemo(() => normalizeFormData(data), [data]);
  const [values, setValues] = React.useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const field of normalized.fields) initial[field.id] = defaultValueFor(field);
    return initial;
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  if (normalized.fields.length === 0) {
    return <p className="text-xs text-slate-500">This form has no fields to display.</p>;
  }

  const setValue = (id: string, value: string | boolean): void => {
    setValues((prev) => ({ ...prev, [id]: value }));
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const validation = validateFormValues(normalized.fields, values);
    setErrors(validation.errors);
    if (!validation.ok) return;
    onAction("submit", { ...values });
  };

  const inputClass =
    "w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-xl">
      {normalized.fields.map((field) => (
        <div key={field.id}>
          <label
            htmlFor={`surface-field-${field.id}`}
            className="block text-xs font-medium text-slate-300 mb-1"
          >
            {field.label}
            {field.required && <span className="text-rose-400 ml-0.5">*</span>}
          </label>
          {field.type === "textarea" ? (
            <textarea
              id={`surface-field-${field.id}`}
              value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
              onChange={(e) => setValue(field.id, e.target.value)}
              required={field.required}
              rows={4}
              className={inputClass}
            />
          ) : field.type === "select" ? (
            <select
              id={`surface-field-${field.id}`}
              value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
              onChange={(e) => setValue(field.id, e.target.value)}
              required={field.required}
              className={inputClass}
            >
              <option value="">Select…</option>
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.type === "boolean" ? (
            <input
              id={`surface-field-${field.id}`}
              type="checkbox"
              checked={values[field.id] === true}
              onChange={(e) => setValue(field.id, e.target.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
          ) : (
            <input
              id={`surface-field-${field.id}`}
              type={field.type === "number" ? "number" : "text"}
              value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
              onChange={(e) => setValue(field.id, e.target.value)}
              required={field.required}
              className={inputClass}
            />
          )}
          {errors[field.id] && <p className="mt-1 text-[11px] text-rose-300">{errors[field.id]}</p>}
        </div>
      ))}
      <button
        type="submit"
        className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus:ring-1 focus:ring-indigo-400 transition-colors"
      >
        {normalized.submitLabel ?? "Submit"}
      </button>
    </form>
  );
}
