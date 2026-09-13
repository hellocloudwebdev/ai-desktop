// PR33.5: renderer — Table Surface (read-only grid + row select)
//
// Renders backend-owned tabular data with column/row caps (50/500).
// Row selection (when `selectable`) emits onAction("select", { row }) where
// row is the zero-based index into the full (uncapped) row list.

import React from "react";
import { coerceCell, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, truncateRows } from "./surface-guards.js";

export type TableCell = string | number | boolean | null;

export interface TableSurfaceData {
  readonly columns: string[];
  readonly rows: TableCell[][];
  readonly selectable?: boolean;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isCell(value: unknown): value is TableCell {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Normalizes unknown surface data into columns + rows (non-cells coerced). */
export function normalizeTableData(data: unknown): TableSurfaceData {
  if (typeof data !== "object" || data === null) return { columns: [], rows: [] };
  const record = data as Record<string, unknown>;
  const columns = asStringArray(record.columns);
  const rows: TableCell[][] = [];
  if (Array.isArray(record.rows)) {
    for (const entry of record.rows) {
      if (!Array.isArray(entry)) continue;
      rows.push(entry.map((cell) => (isCell(cell) ? cell : coerceCell(cell))));
    }
  }
  return {
    columns,
    rows,
    selectable: record.selectable === true,
  };
}

export interface TableSurfaceProps {
  readonly data: unknown;
  onAction(actionId: string, input: unknown): void;
}

export function TableSurface({ data, onAction }: TableSurfaceProps): React.ReactElement {
  const normalized = normalizeTableData(data);
  const columnView = truncateRows(normalized.columns, MAX_TABLE_COLUMNS);
  const rowView = truncateRows(normalized.rows, MAX_TABLE_ROWS);
  const [selectedRows, setSelectedRows] = React.useState<ReadonlySet<number>>(new Set());

  if (columnView.rows.length === 0) {
    return <p className="text-xs text-slate-500">This table has no columns to display.</p>;
  }

  const toggleRow = (rowIndex: number): void => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
    onAction("select", { row: rowIndex });
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-900/80">
              {normalized.selectable && (
                <th scope="col" className="px-2 py-1.5 text-left font-semibold text-slate-400">
                  <span className="sr-only">Select row</span>
                </th>
              )}
              {columnView.rows.map((column, index) => (
                <th
                  key={index}
                  scope="col"
                  className="px-2.5 py-1.5 text-left font-semibold text-slate-300 whitespace-nowrap"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowView.rows.map((row, rowIndex) => {
              const selected = selectedRows.has(rowIndex);
              return (
                <tr
                  key={rowIndex}
                  className={`border-t border-slate-800 ${selected ? "bg-indigo-950/50" : "bg-slate-900/30"}`}
                >
                  {normalized.selectable && (
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRow(rowIndex)}
                        aria-label={`Select row ${rowIndex + 1}`}
                        className="h-3.5 w-3.5 accent-indigo-500"
                      />
                    </td>
                  )}
                  {columnView.rows.map((_, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="px-2.5 py-1.5 text-slate-300 whitespace-nowrap max-w-64 overflow-hidden text-ellipsis"
                    >
                      {coerceCell(row[cellIndex])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(columnView.truncated || rowView.truncated) && (
        <p className="text-[11px] text-slate-500">
          Showing {rowView.rows.length} of {rowView.total} rows
          {columnView.truncated
            ? ` and ${columnView.rows.length} of ${columnView.total} columns`
            : ""}
          . Narrow the query to see more.
        </p>
      )}
    </div>
  );
}
