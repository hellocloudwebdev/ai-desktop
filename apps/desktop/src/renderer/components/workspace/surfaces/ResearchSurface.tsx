// PR35: renderer — Web Research Surface
//
// Query + result list + read-only page view over the research:* IPC
// affordances. Owns no domain behavior: search/open dispatch through props
// to App-owned IPC bridge. Opening a result can hand off its URL to the
// existing BrowserSurface for interactive inspection.

import React from "react";
import type { ResearchSurfaceProps } from "./surface-props.js";

export function ResearchSurface({
  activeProjectId,
  query,
  searching,
  results,
  opened,
  error,
  onQueryChange,
  onSearch,
  onOpen,
  onOpenInBrowser,
  onClearOpened,
}: ResearchSurfaceProps): React.ReactElement {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() && !searching) {
      onSearch();
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
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search the web: latest open-source LLM frameworks"
              aria-label="Research query"
              className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-400 px-3 py-1.5 text-xs font-medium text-white transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-400 shrink-0"
          >
            {searching ? "Searching…" : "Search"}
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

      {error && (
        <div className="shrink-0 border-b border-rose-800 bg-rose-950/50 px-4 py-2">
          <p className="text-xs text-rose-200" role="alert">
            {error}
          </p>
        </div>
      )}

      {/* Results + reader */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto p-6">
        {opened ? (
          <div className="space-y-4 max-w-3xl">
            <button
              type="button"
              onClick={onClearOpened}
              className="text-xs text-indigo-400 hover:text-indigo-300 focus:outline-none"
            >
              ← Back to results
            </button>
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-white">
                    {opened.title || "Untitled result"}
                  </h2>
                  {opened.url && (
                    <p className="text-xs font-mono text-indigo-400 break-all">{opened.url}</p>
                  )}
                </div>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-slate-800 text-slate-300 border border-slate-700">
                  {opened.provider}
                </span>
              </div>
              <p className="text-[11px] font-mono text-slate-500">
                channel: {opened.channel} · retrieved: {opened.retrievedAt}
                {opened.truncated ? " · truncated" : ""}
              </p>
              <div className="border-t border-slate-800/80 pt-3">
                <p className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">
                  {opened.content || opened.excerpt || "No content."}
                </p>
              </div>
              {opened.url && onOpenInBrowser && (
                <div className="border-t border-slate-800/80 pt-3">
                  <button
                    type="button"
                    onClick={() => onOpenInBrowser(opened.url as string)}
                    className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors focus:outline-none"
                  >
                    Open in Browser surface
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : results.length > 0 ? (
          <ol className="space-y-3 max-w-3xl">
            {results.map((result, index) => (
              <li
                key={result.id}
                className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-2 hover:border-slate-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      <span className="text-slate-500 font-mono mr-2">{index + 1}.</span>
                      {result.title || result.url || "Untitled"}
                    </p>
                    {result.url && (
                      <p className="text-[11px] font-mono text-indigo-400 break-all">
                        {result.url}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-slate-800 text-slate-300 border border-slate-700">
                    {result.provider}
                  </span>
                </div>
                {result.excerpt && (
                  <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">
                    {result.excerpt}
                  </p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  {result.url && (
                    <button
                      type="button"
                      onClick={() => onOpen(result.url as string)}
                      className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors focus:outline-none"
                    >
                      Open
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center p-8">
            <div className="h-12 w-12 rounded-2xl bg-indigo-950/60 border border-indigo-800/50 flex items-center justify-center text-indigo-400 mb-4 shadow-inner">
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z"
                />
              </svg>
            </div>
            <h2 className="text-sm font-medium text-slate-200">No research results yet</h2>
            <p className="mt-1.5 max-w-sm text-xs text-slate-400 leading-relaxed">
              Enter a query above to search the web. Select a result to read the page with
              provenance.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
