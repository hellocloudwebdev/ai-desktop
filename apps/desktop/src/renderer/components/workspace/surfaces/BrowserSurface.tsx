// PR34.5: renderer — Browser Automation Surface
//
// Interactive browser management surface: page navigation, tabs/list,
// status inspection, and screenshot capture. Owns no domain behavior:
// actions dispatch through props to App-owned IPC bridge.

import React, { useState } from "react";
import type { BrowserSurfaceProps } from "./surface-props.js";

export function BrowserSurface({
  activeProjectId,
  pages,
  activePageId,
  onSelectPage,
  onOpenPage,
  onClosePage,
  onTakeScreenshot,
  screenshotArtifact,
}: BrowserSurfaceProps): React.ReactElement {
  const [urlInput, setUrlInput] = useState<string>("https://");

  const activePage =
    pages.find((p) => p.id === activePageId) ?? (pages.length > 0 ? pages[0] : null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (trimmed && trimmed !== "https://" && trimmed !== "http://") {
      onOpenPage(trimmed);
    }
  };

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-200">
      {/* Header / Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800/80 bg-slate-900/60 px-5 py-3 backdrop-blur-md gap-3 shadow-sm">
        <form onSubmit={handleSubmit} className="flex flex-1 items-center gap-2.5 max-w-2xl">
          <div className="relative flex-1">
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com"
              aria-label="Browser URL"
              className="w-full rounded-xl bg-slate-950/90 border border-slate-700/80 px-3.5 py-2 text-xs text-slate-100 font-mono placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 transition-all"
            />
          </div>
          <button
            type="submit"
            className="rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-400 shrink-0"
          >
            Open Page
          </button>
        </form>

        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-800/80 border border-slate-700/60 px-3 py-0.5 text-[11px] font-mono text-slate-400">
            project: <strong className="text-slate-200 font-medium">{activeProjectId}</strong>
          </span>
          <span className="rounded-full bg-slate-800/80 border border-slate-700/60 px-3 py-0.5 text-[11px] font-mono text-slate-400">
            pages: <strong className="text-slate-200 font-medium">{pages.length}</strong>
          </span>
        </div>
      </div>

      {/* Page Tabs */}
      {pages.length > 0 && (
        <div className="flex shrink-0 items-center overflow-x-auto border-b border-slate-800 bg-slate-900/40 px-2 py-1 gap-1">
          {pages.map((page) => {
            const isCurrent = activePage?.id === page.id;
            return (
              <div
                key={page.id}
                className={`group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                  isCurrent
                    ? "bg-slate-800 text-white font-medium shadow-sm border border-slate-700"
                    : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectPage(page.id)}
                  className="truncate max-w-[160px] text-left focus:outline-none"
                  title={page.title || page.url || "Untitled"}
                >
                  {page.title || page.url || "Untitled"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClosePage(page.id);
                  }}
                  aria-label={`Close page ${page.title || page.id}`}
                  className="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-white transition-colors"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Main Viewport Area */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto p-6">
        {activePage ? (
          <div className="space-y-6 max-w-3xl">
            {/* Page Metadata Card */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-white">
                    {activePage.title || "Untitled Page"}
                  </h2>
                  <p className="text-xs font-mono text-indigo-400 break-all">
                    {activePage.url || "about:blank"}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    activePage.status === "ready"
                      ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                      : "bg-slate-800 text-slate-400 border border-slate-700"
                  }`}
                >
                  {activePage.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-slate-800/80 pt-4 text-xs">
                <div>
                  <span className="text-[10px] uppercase font-semibold text-slate-500 block">
                    Page ID
                  </span>
                  <span className="font-mono text-slate-300 text-[11px] break-all">
                    {activePage.id}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-semibold text-slate-500 block">
                    Context ID
                  </span>
                  <span className="font-mono text-slate-300 text-[11px] break-all">
                    {activePage.contextId}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 border-t border-slate-800/80 pt-4">
                <button
                  type="button"
                  onClick={() => onTakeScreenshot(activePage.id)}
                  className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  Capture Screenshot
                </button>
                <button
                  type="button"
                  onClick={() => onClosePage(activePage.id)}
                  className="rounded-lg bg-slate-800 hover:bg-rose-900/40 border border-slate-700 hover:border-rose-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-rose-200 transition-colors focus:outline-none"
                >
                  Close Page
                </button>
              </div>
            </div>

            {/* Screenshot Artifact Card */}
            {screenshotArtifact && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Latest Screenshot Artifact
                  </h3>
                  <span className="text-xs font-mono text-emerald-400">
                    {(screenshotArtifact.bytes / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                  <p className="text-[11px] font-mono text-slate-300 break-all">
                    {screenshotArtifact.artifactRef}
                  </p>
                </div>
              </div>
            )}
          </div>
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
                  d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                />
              </svg>
            </div>
            <h2 className="text-sm font-medium text-slate-200">No active browser page</h2>
            <p className="mt-1.5 max-w-sm text-xs text-slate-400 leading-relaxed">
              Enter a URL above and click Open Page, or launch a browser agent task to automate web
              interaction.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
