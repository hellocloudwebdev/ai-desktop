// PR41: renderer — Coding Workspace (explorer + editor + search + terminal)
//
// IDE-like project workspace over App-owned backend state. Owns no domain
// behavior: file/search/terminal/diagnostics operations arrive as handler
// props over the workspace:*/terminal:* preload bridge. Editor is a
// dependency-free textarea with gutter (no Monaco — zero new deps); dirty
// tracking is local, saves go through onSave with expectedMtimeMs conflict
// detection main-side.

import React, { useState } from "react";
import type { CodingWorkspaceProps, WorkspaceFileNode, WorkspaceTab } from "./surface-props.js";
import { TaskNodeChecklist } from "./CodingSurface.js";

function FileTree({
  nodes,
  depth,
  onOpen,
  activePath,
}: {
  nodes: WorkspaceFileNode[];
  depth: number;
  onOpen: (path: string) => void;
  activePath: string | null;
}): React.ReactElement {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <ul className={depth === 0 ? "space-y-0.5" : "ml-3 mt-0.5 space-y-0.5"}>
      {nodes.map((node) => {
        const isOpen = expanded[node.path] ?? depth < 1;
        if (node.kind === "directory") {
          return (
            <li key={node.path}>
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [node.path]: !isOpen }))}
                className="w-full text-left truncate rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                {isOpen ? "▾" : "▸"} {node.name}/
              </button>
              {isOpen && node.children && (
                <FileTree
                  nodes={node.children}
                  depth={depth + 1}
                  onOpen={onOpen}
                  activePath={activePath}
                />
              )}
            </li>
          );
        }
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => onOpen(node.path)}
              className={`w-full text-left truncate rounded px-1.5 py-0.5 text-[11px] ${
                node.path === activePath
                  ? "bg-indigo-700 text-white"
                  : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              {node.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EditorPane({
  tab,
  onChange,
  onSave,
  onRevert,
}: {
  tab: WorkspaceTab;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onRevert: (path: string) => void;
}): React.ReactElement {
  const lines = tab.content.split("\n").length;
  const gutter = Array.from({ length: lines }, (_, i) => i + 1);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
        <p className="truncate font-mono text-[11px] text-slate-300">
          {tab.path}
          {tab.dirty && <span className="ml-1 text-amber-400">●</span>}
          {tab.conflict && <span className="ml-1 text-red-400">[external change]</span>}
        </p>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => onRevert(tab.path)}
            disabled={!tab.dirty}
            className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 disabled:opacity-40"
          >
            Revert
          </button>
          <button
            type="button"
            onClick={() => onSave(tab.path)}
            disabled={!tab.dirty}
            className="rounded bg-indigo-700 px-2 py-0.5 text-[11px] text-white hover:bg-indigo-600 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
      {tab.conflict && (
        <p className="border-b border-red-900/50 bg-red-950/30 px-3 py-1 text-[11px] text-red-300">
          Changed on disk by agent or terminal. Save overwrites, Revert keeps disk content.
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <pre
          aria-hidden="true"
          className="select-none overflow-hidden bg-slate-900/60 px-2 py-2 text-right font-mono text-[11px] leading-5 text-slate-600"
        >
          {gutter.join("\n")}
        </pre>
        <textarea
          value={tab.content}
          onChange={(e) => onChange(tab.path, e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              onSave(tab.path);
            }
          }}
          spellCheck={false}
          aria-label={`Editor for ${tab.path}`}
          className="min-h-0 flex-1 resize-none bg-transparent px-2 py-2 font-mono text-[11px] leading-5 text-slate-200 focus:outline-none"
        />
      </div>
    </div>
  );
}

export function CodingWorkspace({
  activeProjectId,
  files,
  tabs,
  activeTabPath,
  search,
  diagnostics,
  terminals,
  terminalOutput,
  diff,
  codingTasks,
  codingPrompt,
  codingRunning,
  workspaceError,
  onRefreshFiles,
  onOpenFile,
  onCloseTab,
  onSelectTab,
  onEditTab,
  onSaveFile,
  onSaveAllFiles,
  onRevertFile,
  onSearch,
  onTerminalCreate,
  onTerminalStop,
  onPromptChange,
  onProjectChange,
  onStartTask,
  onCancelTask,
}: CodingWorkspaceProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("");
  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;

  return (
    <div className="flex h-full min-h-0 text-xs">
      {/* Explorer */}
      <div className="flex w-56 shrink-0 flex-col border-r border-slate-800 overflow-y-auto px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            Explorer
          </p>
          <button
            type="button"
            onClick={onRefreshFiles}
            className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
          >
            Refresh
          </button>
        </div>
        <FileTree nodes={files} depth={0} onOpen={onOpenFile} activePath={activeTabPath} />
        {/* Diagnostics */}
        <p className="mt-4 mb-1 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Problems ({diagnostics.length})
        </p>
        {diagnostics.length === 0 ? (
          <p className="text-[11px] text-slate-600">No diagnostics.</p>
        ) : (
          <ul className="space-y-0.5">
            {diagnostics.slice(0, 50).map((d, i) => (
              <li key={`${d.path}:${d.line}:${i}`} className="truncate text-[11px]">
                <span
                  className={
                    d.severity === "error"
                      ? "text-red-400"
                      : d.severity === "warning"
                        ? "text-amber-400"
                        : "text-slate-400"
                  }
                >
                  [{d.severity}]
                </span>{" "}
                <button
                  type="button"
                  onClick={() => onOpenFile(d.path)}
                  className="font-mono text-slate-300 hover:text-white"
                >
                  {d.path}:{d.line}
                </button>{" "}
                <span className="text-slate-500">{d.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor + tabs */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1">
          {tabs.length === 0 && <span className="text-[11px] text-slate-600">No open files.</span>}
          {tabs.map((tab) => (
            <span
              key={tab.path}
              className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                tab.path === activeTabPath
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/60"
              }`}
            >
              <button type="button" onClick={() => onSelectTab(tab.path)} className="truncate">
                {tab.path.split("/").pop()}
                {tab.dirty && <span className="ml-0.5 text-amber-400">●</span>}
              </button>
              <button
                type="button"
                onClick={() => onCloseTab(tab.path)}
                aria-label={`Close ${tab.path}`}
                className="text-slate-500 hover:text-slate-200"
              >
                ×
              </button>
            </span>
          ))}
          {tabs.some((t) => t.dirty) && (
            <button
              type="button"
              onClick={onSaveAllFiles}
              className="ml-auto shrink-0 rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700"
            >
              Save all
            </button>
          )}
        </div>
        {workspaceError && (
          <p className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-3 py-1 text-[11px] text-red-300">
            {workspaceError}
          </p>
        )}
        {activeTab ? (
          <EditorPane
            tab={activeTab}
            onChange={onEditTab}
            onSave={onSaveFile}
            onRevert={onRevertFile}
          />
        ) : (
          <p className="p-4 text-[11px] text-slate-600">
            Open a file from the explorer to edit. Project: {activeProjectId}
          </p>
        )}
        {/* Search */}
        <div className="shrink-0 border-t border-slate-800 px-3 py-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (searchQuery.trim()) {
                onSearch(searchQuery.trim());
              }
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search project…"
              aria-label="Project search"
              className="flex-1 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
            >
              Search
            </button>
          </form>
          {search && (
            <ul className="mt-1 max-h-24 overflow-y-auto space-y-0.5">
              {search.matches.slice(0, 30).map((m, i) => (
                <li key={`${m.path}:${m.line}:${i}`} className="truncate text-[11px]">
                  <button
                    type="button"
                    onClick={() => onOpenFile(m.path)}
                    className="font-mono text-indigo-300 hover:text-indigo-200"
                  >
                    {m.path}:{m.line}
                  </button>{" "}
                  <span className="text-slate-500">{m.text}</span>
                </li>
              ))}
              {search.truncated && <li className="text-[10px] text-slate-600">…truncated</li>}
            </ul>
          )}
        </div>
        {/* Terminal */}
        <div className="shrink-0 border-t border-slate-800 px-3 py-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (terminalCommand.trim()) {
                onTerminalCreate(terminalCommand.trim());
                setTerminalCommand("");
              }
            }}
            className="flex items-center gap-2"
          >
            <span className="font-mono text-[11px] text-emerald-400">$</span>
            <input
              type="text"
              value={terminalCommand}
              onChange={(e) => setTerminalCommand(e.target.value)}
              placeholder="Run sandboxed command…"
              aria-label="Terminal command"
              className="flex-1 rounded bg-slate-950 border border-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
            >
              Run
            </button>
          </form>
          {terminals.length > 0 && (
            <ul className="mt-1 max-h-20 overflow-y-auto space-y-0.5">
              {terminals.map((t) => (
                <li key={t.id} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-slate-500">
                    {t.id.slice(0, 8)} [{t.state}]
                  </span>
                  <span className="truncate text-slate-300">{t.command}</span>
                  {!["stopped", "failed", "cancelled"].includes(t.state) && (
                    <button
                      type="button"
                      onClick={() => onTerminalStop(t.id)}
                      className="text-rose-300 hover:text-rose-200"
                    >
                      stop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {terminalOutput && (
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-400">
              {terminalOutput}
            </pre>
          )}
        </div>
        {/* Diff */}
        {diff && diff.hunks.length > 0 && (
          <div className="shrink-0 border-t border-slate-800 px-3 py-2">
            <p className="mb-1 font-mono text-[10px] text-slate-500">Diff: {diff.path}</p>
            <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-4">
              {diff.hunks.slice(0, 5).map((hunk, hi) => (
                <span key={hi}>
                  {hunk.lines.map((line, li) => (
                    <span
                      key={li}
                      className={`block ${
                        line.kind === "add"
                          ? "bg-emerald-950/50 text-emerald-300"
                          : line.kind === "del"
                            ? "bg-red-950/50 text-red-300"
                            : "text-slate-500"
                      }`}
                    >
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                      {line.text}
                    </span>
                  ))}
                </span>
              ))}
            </pre>
          </div>
        )}
      </div>

      {/* Agent tasks */}
      <div className="hidden w-64 shrink-0 flex-col border-l border-slate-800 overflow-y-auto px-3 py-3 xl:flex">
        <input
          type="text"
          value={activeProjectId}
          onChange={(e) => onProjectChange(e.target.value)}
          placeholder="project id"
          aria-label="Coding project id"
          className="mb-2 rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <input
          type="text"
          value={codingPrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onStartTask();
          }}
          placeholder="Coding goal…"
          aria-label="Coding goal"
          className="mb-2 rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="button"
          onClick={onStartTask}
          disabled={codingRunning || !codingPrompt.trim()}
          className="mb-3 rounded-lg bg-indigo-700 hover:bg-indigo-600 px-2 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
        >
          {codingRunning ? "Starting…" : "Run agent"}
        </button>
        {codingTasks.map((t) => (
          <div key={t.taskId} className="mb-2 rounded-lg bg-slate-800/60 p-2">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] text-slate-400">
                {t.taskId.slice(0, 8)}… · {t.status}
              </p>
              {(t.status === "active" || t.status === "blocked") && (
                <button
                  type="button"
                  onClick={() => onCancelTask(t.taskId)}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200"
                >
                  Cancel
                </button>
              )}
            </div>
            <TaskNodeChecklist nodes={t.nodes} />
          </div>
        ))}
      </div>
    </div>
  );
}
