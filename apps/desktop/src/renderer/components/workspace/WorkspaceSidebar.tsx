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
];

export function WorkspaceSidebar({
  activeSurface,
  activeProjectId,
  conversationId,
  agentActiveCount,
  codingActiveCount,
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
}: SidebarProps): React.ReactElement {
  return (
    <nav
      aria-label="Workspace navigation"
      className="flex h-full flex-col px-3 py-4 space-y-4 overflow-y-auto"
    >
      <div>
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 px-1">
          Project
        </p>
        <input
          type="text"
          value={activeProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
          aria-label="Active project id"
          className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <p className="text-[10px] text-slate-500 font-mono mt-1 px-1">
          {conversationId.slice(0, 10)}…
        </p>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 px-1">
          Surface
        </p>
        <ul className="space-y-1" role="list">
          {SURFACE_TABS.map((tab) => {
            const active = activeSurface === tab.id;
            const badge =
              tab.id === "coding" && codingActiveCount > 0
                ? ` (${codingActiveCount})`
                : tab.id === "tasks" && agentActiveCount + codingActiveCount > 0
                  ? ` (${agentActiveCount + codingActiveCount})`
                  : "";
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => onSelectSurface(tab.id)}
                  aria-pressed={active}
                  className={`w-full text-left rounded-lg px-2.5 py-1.5 text-xs transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                    active
                      ? "bg-indigo-700 text-white font-medium"
                      : "text-slate-300 hover:bg-slate-800"
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
          className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 px-1 block"
        >
          Model
        </label>
        <select
          id="workspace-model-select"
          value={selectedModelId}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={isStreaming}
          className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
        >
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} ({m.providerId})
            </option>
          ))}
        </select>
      </div>

      <div className="mt-auto space-y-3 pt-2 border-t border-slate-800">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 px-1">
            Skills ({skills.filter((s) => s.enabled).length}/{skills.length})
          </p>
          {skills.length === 0 ? (
            <p className="text-[11px] text-slate-500 px-1">No skills installed.</p>
          ) : (
            <ul className="space-y-1">
              {skills.map((s) => (
                <li key={s.id} className="flex items-center justify-between text-[11px] px-1">
                  <span className="text-slate-300 truncate" title={s.name}>
                    {s.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleSkill(s.id, s.enabled)}
                    aria-pressed={s.enabled}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0 ml-1 ${
                      s.enabled
                        ? "bg-emerald-800 hover:bg-emerald-700 text-emerald-100"
                        : "bg-slate-800 hover:bg-slate-700 text-slate-300"
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
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 px-1">
            Memory ({memories.length})
          </p>
          {memories.length === 0 ? (
            <p className="text-[11px] text-slate-500 px-1">No facts stored.</p>
          ) : (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {memories.slice(0, 20).map((m) => (
                <li key={m.id} className="rounded bg-slate-800/60 px-1.5 py-1 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 font-mono text-[10px]">
                      {m.scopeLevel === "project" ? `project:${m.projectId ?? "?"}` : "global"}/
                      {m.category}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDeleteMemory(m.id)}
                      aria-label={`Delete memory: ${m.content.slice(0, 40)}`}
                      className="rounded px-1 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200 ml-1 shrink-0"
                    >
                      ×
                    </button>
                  </div>
                  <p className="text-slate-300 leading-snug mt-0.5 break-words">{m.content}</p>
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
