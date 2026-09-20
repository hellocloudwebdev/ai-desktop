// PR31.5/31.9: renderer — Workspace Sidebar (navigation only)
//
// Exposes surface + project selection. No backend state duplicated: counts
// and models come in as props from App-owned backend state.

import React from "react";
import type { SidebarProps } from "./surfaces/surface-props.js";
import type { WorkspaceSurface } from "../../workspace/types.js";

const SURFACE_TABS: Array<{ id: WorkspaceSurface; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "coding", label: "Coding" },
  { id: "tasks", label: "Tasks" },
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files" },
  { id: "extensions", label: "Extensions" },
  { id: "browser", label: "Browser" },
  { id: "research", label: "Research" },
  { id: "mcp", label: "MCP" },
  { id: "voice", label: "Voice" },
  { id: "git", label: "Source Control" },
  { id: "account", label: "Account" },
];

export function WorkspaceSidebar({
  activeSurface,
  activeProjectId,
  conversationId,
  agentActiveCount,
  codingActiveCount,
  backgroundActiveCount = 0,
  schedulesEnabledCount = 0,
  syncNeedsAttention = false,
  leftVisible,
  rightVisible,
  onSelectSurface,
  onSelectProject,
  onToggleLeft,
  onToggleRight,
  availableModels,
  selectedModelId,
  isStreaming,
  onModelChange,
  skills,
  memories,
  onToggleSkill,
  onDeleteMemory,
  extensionsSummary,
}: SidebarProps): React.ReactElement {
  return (
    <nav
      aria-label="Workspace navigation"
      className="flex h-full flex-col px-3 py-4 space-y-4 overflow-y-auto text-slate-200"
    >
      <div>
        <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5 px-1">
          Project
        </p>
        <input
          type="text"
          value={activeProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
          aria-label="Active project id"
          className="w-full rounded-md bg-slate-900/90 border border-slate-700/80 px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-slate-500"
        />
        <p className="text-[10px] text-slate-400 font-mono mt-1 px-1">
          {conversationId.slice(0, 10)}…
        </p>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5 px-1">
          Surface
        </p>
        <ul className="space-y-1" role="list">
          {SURFACE_TABS.map((tab) => {
            const active = activeSurface === tab.id;
            const tasksTotal =
              agentActiveCount + codingActiveCount + backgroundActiveCount + schedulesEnabledCount;
            const badge =
              tab.id === "coding" && codingActiveCount > 0
                ? ` (${codingActiveCount})`
                : tab.id === "tasks" && tasksTotal > 0
                  ? ` (${tasksTotal})`
                  : tab.id === "extensions" && extensionsSummary.active > 0
                    ? ` (${extensionsSummary.active})`
                    : tab.id === "account" && syncNeedsAttention
                      ? " ●"
                      : "";
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => onSelectSurface(tab.id)}
                  aria-pressed={active}
                  className={`w-full text-left rounded-md px-2.5 py-1.5 text-xs transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    active
                      ? "bg-indigo-700 text-white font-medium shadow-sm shadow-indigo-600/30"
                      : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
                  }`}
                >
                  {tab.label}
                  {badge}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <label
          htmlFor="workspace-model-select"
          className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5 px-1 block"
        >
          Model
        </label>
        <select
          id="workspace-model-select"
          value={selectedModelId}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={isStreaming}
          className="w-full rounded-md bg-slate-900/90 border border-slate-700/80 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer transition-all"
        >
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} ({m.providerId})
            </option>
          ))}
        </select>
      </div>

      <div className="mt-auto space-y-3 pt-3 border-t border-slate-800/80">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5 px-1">
            Skills ({skills.filter((s) => s.enabled).length}/{skills.length})
          </p>
          {skills.length === 0 ? (
            <p className="text-[11px] text-slate-500 px-1 italic">No skills installed.</p>
          ) : (
            <ul className="space-y-1">
              {skills.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between text-[11px] px-1 py-0.5 rounded hover:bg-slate-800/40"
                >
                  <span className="text-slate-300 truncate" title={s.name}>
                    {s.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleSkill(s.id, s.enabled)}
                    aria-pressed={s.enabled}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium shrink-0 ml-1.5 transition-colors ${
                      s.enabled
                        ? "bg-emerald-700 hover:bg-emerald-600 text-emerald-50"
                        : "bg-slate-800 hover:bg-slate-700 text-slate-400"
                    }`}
                  >
                    {s.enabled ? "On" : "Off"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5 px-1">
            Memory ({memories.length})
          </p>
          {memories.length === 0 ? (
            <p className="text-[11px] text-slate-500 px-1 italic">No facts stored.</p>
          ) : (
            <ul className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
              {memories.slice(0, 20).map((m) => (
                <li
                  key={m.id}
                  className="rounded-md bg-slate-800/50 border border-slate-700/40 px-2 py-1.5 text-[11px] transition-colors hover:border-slate-600/60"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 font-mono text-[10px]">
                      {m.scopeLevel === "project" ? `project:${m.projectId ?? "?"}` : "global"}/
                      {m.category}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDeleteMemory(m.id)}
                      aria-label={`Delete memory: ${m.content.slice(0, 40)}`}
                      className="rounded px-1.5 py-0.2 text-[10px] font-medium bg-rose-950/60 hover:bg-rose-900 border border-rose-800/40 text-rose-300 ml-1 shrink-0 transition-colors"
                    >
                      ×
                    </button>
                  </div>
                  <p className="text-slate-300 leading-snug mt-1 break-words">{m.content}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1">
          <button
            type="button"
            onClick={onToggleLeft}
            aria-pressed={leftVisible}
            className="w-full text-left rounded-lg px-2.5 py-1.5 text-[11px] text-slate-400 hover:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {leftVisible ? "Hide navigation" : "Show navigation"}
          </button>
          <button
            type="button"
            onClick={onToggleRight}
            aria-pressed={rightVisible}
            className="w-full text-left rounded-lg px-2.5 py-1.5 text-[11px] text-slate-400 hover:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {rightVisible ? "Hide inspector" : "Show inspector"}
          </button>
        </div>
      </div>
    </nav>
  );
}
