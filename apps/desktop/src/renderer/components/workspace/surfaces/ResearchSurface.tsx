// PR35: renderer — Web Research Surface
//
// Query/result/open/status surface over the preload research bridge.
// Owns no domain behavior: search, open, and status dispatch through props
// to App-owned IPC handlers.

import React, { useState } from "react";
import type { ResearchSurfaceProps } from "./surface-props.js";

export function ResearchSurface({
  activeProjectId,
  results,
  activeResultUrl,
  openedDocument,
  providerStatuses,
  isSearching,
  searchError,
  onSearch,
  onOpenResult,
  onOpenInBrowser,
}: ResearchSurfaceProps): React.ReactElement {
  const [queryInput, setQueryInput] = useState<string>("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = queryInput.trim();
    if (trimmed) {
      onSearch(trimmed);
    }
  };

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-200">
      {/* Header / Search bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-2.5 backdrop-blur-sm gap-3">
        <form onSubmit={handleSubmit} className="flex flex-1 items-center gap-2 max-w-2xl">
          <div className="relative flex-1">
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search the web…"
              aria-label="Research query"
              className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <button
            type="submit"
            disabled={isSearching}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-white transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-400 shrink-0"
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </form>

        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-[11px] font-mono text-slate-400">
            project: <strong className="text-slate-200">{activeProjectId}</strong>
          </span>
          <span className="rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-[11px] font-mono text-slate-400">
            results: <strong className="text-slate-200">{results.length}</strong>
          </span>
        </div>
      </div>

      {/* Error banner */}
      {searchError && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-300">
          {searchError}
        </div>
      )}

      {/* Results list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {results.length === 0 && !isSearching && (
          <p className="text-xs text-slate-500">
            No results yet. Run a search to see provenance-bearing web results here.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {results.map((result) => {
            const isActive = activeResultUrl === result.url;
            return (
              <li
                key={result.url}
                className={`rounded-lg border px-3 py-2 transition-colors ${
                  isActive
                    ? "border-indigo-500 bg-slate-800 text-white"
                    : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{result.title || result.url}</p>
                    <p className="truncate font-mono text-[11px] text-slate-500">{result.url}</p>
                    {result.snippet && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">
                        {result.snippet}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-slate-600">
                      {result.domain && <span>{result.domain} · </span>}
                      <span>via {result.provider}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenResult(result.url)}
                      className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenInBrowser(result.url)}
                      className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                    >
                      Browser
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Opened document */}
        {openedDocument && (
          <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
            <p className="text-xs font-medium text-slate-100">
              {openedDocument.title || openedDocument.url}
            </p>
            <p className="truncate font-mono text-[11px] text-slate-500">{openedDocument.url}</p>
            <p className="mt-1 font-mono text-[10px] text-slate-600">
              via {openedDocument.provider}
              {openedDocument.truncated ? " · truncated" : ""}
            </p>
            {openedDocument.excerpt && (
              <p className="mt-2 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">
                {openedDocument.excerpt}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Provider status footer */}
      {providerStatuses.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-slate-800 bg-slate-900/40 px-4 py-1.5">
          {providerStatuses.map((status) => (
            <span
              key={status.provider}
              className="rounded-full bg-slate-800 border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-400"
            >
              {status.provider}: {status.status}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
