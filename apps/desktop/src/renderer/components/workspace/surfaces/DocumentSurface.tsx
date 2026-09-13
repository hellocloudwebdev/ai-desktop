// PR33.4: renderer — Document Surface (read-only rich text)
//
// Renders backend-owned document blocks as plain React elements. Text is
// always interpolated (never inner HTML); links render as <a> only when
// isSafeHref accepts the href, otherwise as plain text.

import React from "react";
import { isSafeHref } from "./surface-guards.js";

export interface DocumentBlock {
  readonly type: "heading" | "paragraph" | "code" | "list" | "link";
  readonly text?: string;
  readonly level?: 1 | 2 | 3;
  readonly items?: string[];
  readonly language?: string;
  readonly href?: string;
}

export interface DocumentSurfaceData {
  readonly blocks: DocumentBlock[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Normalizes unknown surface data into renderable blocks (unknown dropped). */
export function normalizeDocumentData(data: unknown): DocumentBlock[] {
  if (!isRecord(data) || !Array.isArray(data.blocks)) return [];
  const blocks: DocumentBlock[] = [];
  for (const entry of data.blocks) {
    if (!isRecord(entry)) continue;
    switch (entry.type) {
      case "heading": {
        const level = entry.level === 2 || entry.level === 3 ? entry.level : 1;
        blocks.push({ type: "heading", text: asString(entry.text), level });
        break;
      }
      case "paragraph":
        blocks.push({ type: "paragraph", text: asString(entry.text) });
        break;
      case "code":
        blocks.push({
          type: "code",
          text: asString(entry.text),
          language: typeof entry.language === "string" ? entry.language : undefined,
        });
        break;
      case "list":
        blocks.push({ type: "list", items: asStringArray(entry.items) });
        break;
      case "link":
        blocks.push({
          type: "link",
          text: asString(entry.text),
          href: typeof entry.href === "string" ? entry.href : undefined,
        });
        break;
      default:
        // Unknown block types are skipped silently per the PR33 contract.
        break;
    }
  }
  return blocks;
}

export interface DocumentSurfaceProps {
  readonly data: unknown;
  readonly actions?: ReadonlyArray<{ actionId: string; title?: string; type: string }>;
  onAction(actionId: string, input: unknown): void;
}

export function DocumentSurface({
  data,
  actions,
  onAction,
}: DocumentSurfaceProps): React.ReactElement {
  const blocks = normalizeDocumentData(data);
  if (blocks.length === 0) {
    return <p className="text-xs text-slate-500">This document has no renderable content.</p>;
  }
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => (
        <DocumentBlockView key={index} block={block} />
      ))}
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {actions.map((action) => (
            <button
              key={action.actionId}
              type="button"
              onClick={() => onAction(action.actionId, null)}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors"
            >
              {action.title ?? action.type}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentBlockView({
  block,
}: {
  readonly block: DocumentBlock;
}): React.ReactElement | null {
  switch (block.type) {
    case "heading":
      if (block.level === 2) {
        return <h2 className="text-base font-semibold text-white">{block.text}</h2>;
      }
      if (block.level === 3) {
        return <h3 className="text-sm font-semibold text-white">{block.text}</h3>;
      }
      return <h1 className="text-lg font-semibold text-white">{block.text}</h1>;
    case "paragraph":
      return <p className="text-sm text-slate-300 whitespace-pre-wrap">{block.text}</p>;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg bg-slate-950 border border-slate-800 p-2.5 text-xs font-mono text-slate-200">
          {block.language && (
            <span className="block text-[10px] text-slate-500 mb-1">{block.language}</span>
          )}
          <code>{block.text}</code>
        </pre>
      );
    case "list":
      return (
        <ul className="list-disc pl-5 space-y-1 text-sm text-slate-300">
          {block.items?.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "link": {
      const label = block.text && block.text.length > 0 ? block.text : (block.href ?? "");
      if (block.href && isSafeHref(block.href)) {
        return (
          <p className="text-sm">
            <a
              href={block.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-indigo-300 hover:text-indigo-200 underline break-all"
            >
              {label}
            </a>
          </p>
        );
      }
      // Unsafe or missing href: render as plain text, never a link.
      return <p className="text-sm text-slate-300 break-all">{label}</p>;
    }
    default:
      return null;
  }
}
