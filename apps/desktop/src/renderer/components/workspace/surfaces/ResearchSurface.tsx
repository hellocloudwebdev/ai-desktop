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
  deepPackage = null,
  isDeepResearching = false,
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
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800/80 bg-slate-900/60 px-5 py-3 backdrop-blur-md gap-3 shadow-sm">
        <form onSubmit={handleSubmit} className="flex flex-1 items-center gap-2.5 max-w-2xl">
          <div className="relative flex-1">
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search the web…"
              aria-label="Research query"
              className="w-full rounded-xl bg-slate-950/90 border border-slate-700/80 px-3.5 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 transition-all"
            />
          </div>
          <button
            type="submit"
            disabled={isSearching}
            className="rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-400 shrink-0"
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </form>

        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-800/80 border border-slate-700/60 px-3 py-0.5 text-[11px] font-mono text-slate-400">
            project: <strong className="text-slate-200 font-medium">{activeProjectId}</strong>
          </span>
          <span className="rounded-full bg-slate-800/80 border border-slate-700/60 px-3 py-0.5 text-[11px] font-mono text-slate-400">
            results: <strong className="text-slate-200 font-medium">{results.length}</strong>
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

        {/* PR36: deep-research package — sources, evidence, conflicts, citations, synthesis */}
        {(deepPackage || isDeepResearching) && (
          <div className="mt-4 rounded-lg border border-indigo-900/60 bg-indigo-950/20 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-indigo-200">Deep research</p>
              <p className="font-mono text-[10px] text-slate-500">
                {isDeepResearching ? "running…" : `status: ${deepPackage?.status ?? "unknown"}`}
              </p>
            </div>
            {deepPackage && (
              <>
                <p className="mt-1 font-mono text-[10px] text-slate-400">
                  sources: {deepPackage.sourcesCount} · evidence: {deepPackage.evidenceCount} ·
                  conflicts: {deepPackage.conflictsCount}
                </p>
                {deepPackage.synthesisSummary && (
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">
                    {deepPackage.synthesisSummary}
                  </p>
                )}
                {deepPackage.evidence.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {deepPackage.evidence.slice(0, 10).map((item, index) => (
                      <li
                        key={`${item.sourceUrl}-${index}`}
                        className="rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5"
                      >
                        <p className="text-[11px] leading-relaxed text-slate-300">{item.excerpt}</p>
                        <button
                          type="button"
                          onClick={() => onOpenResult(item.sourceUrl)}
                          className="mt-1 font-mono text-[10px] text-indigo-400 hover:text-indigo-300"
                        >
                          {item.sourceTitle || item.sourceUrl} →
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {deepPackage.conflicts.length > 0 && (
                  <div className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/20 px-2 py-1.5">
                    <p className="text-[11px] font-medium text-amber-300">
                      {deepPackage.conflicts.length} conflicting claim
                      {deepPackage.conflicts.length === 1 ? "" : "s"}
                    </p>
                    {deepPackage.conflicts.slice(0, 5).map((conflict, index) => (
                      <div key={`${conflict.topic}-${index}`} className="mt-1">
                        <p className="font-mono text-[10px] text-amber-200/80">{conflict.topic}</p>
                        <p className="text-[11px] text-slate-300">A: {conflict.sideA}</p>
                        <p className="text-[11px] text-slate-300">B: {conflict.sideB}</p>
                      </div>
                    ))}
                  </div>
                )}
                {deepPackage.citations.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {deepPackage.citations.slice(0, 10).map((citation, index) => (
                      <li
                        key={`${citation.url}-${index}`}
                        className="truncate font-mono text-[10px] text-slate-500"
                      >
                        [{index + 1}] {citation.title || citation.url} — {citation.url}
                      </li>
                    ))}
                  </ul>
                )}
              </>
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
