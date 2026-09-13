// PR31.7: renderer — Coding Surface (verbatim extraction)
//
// Node checklist rendering shared with tasks; run/cancel behavior unchanged.

import React from "react";
import type { CodingSurfaceProps, TaskNodeView } from "./surface-props.js";

function nodeDotClass(status: string): string {
  if (status === "completed") return "bg-emerald-400";
  if (status === "failed") return "bg-rose-400";
  if (status === "active") return "bg-amber-400 animate-pulse";
  if (status === "blocked") return "bg-orange-400";
  return "bg-slate-500";
}

export function TaskNodeChecklist({ nodes }: { nodes: TaskNodeView[] }): React.ReactElement | null {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-1 mt-1">
      {nodes.map((n) => (
        <li key={n.id} className="flex items-center space-x-1.5 text-[11px] text-slate-300">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${nodeDotClass(n.status)}`} />
          <span className="truncate">{n.goal}</span>
          <span className="text-slate-500 font-mono">[{n.status}]</span>
        </li>
      ))}
    </ul>
  );
}

export function isTaskRunning(status: string): boolean {
  return status === "active" || status === "blocked";
}

export function CodingSurface({
  codingTasks,
  codingPrompt,
  codingProjectId,
  codingRunning,
  onPromptChange,
  onProjectChange,
  onStart,
  onCancel,
}: CodingSurfaceProps): React.ReactElement {
  return (
    <div className="flex h-full flex-col px-6 py-4 overflow-y-auto">
      <div className="flex items-center space-x-2 mb-4">
        <input
          type="text"
          value={codingProjectId}
          onChange={(e) => onProjectChange(e.target.value)}
          placeholder="project id"
          disabled={codingRunning}
          aria-label="Coding project id"
          className="w-36 rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        <input
          type="text"
          value={codingPrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onStart();
          }}
          placeholder="Describe the coding goal…"
          disabled={codingRunning}
          aria-label="Coding goal"
          className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onStart}
          disabled={codingRunning || !codingPrompt.trim()}
          className="rounded-lg bg-indigo-700 hover:bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
        >
          {codingRunning ? "Starting…" : "Run"}
        </button>
      </div>
      {codingTasks.length === 0 ? (
        <p className="text-xs text-slate-500 py-2">No coding tasks yet.</p>
      ) : (
        <ul className="space-y-2">
          {codingTasks.map((t) => (
            <li key={t.taskId} className="rounded-lg bg-slate-800/60 p-2 text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 font-mono">
                  {t.taskId.slice(0, 8)}… · {t.status}
                </span>
                {isTaskRunning(t.status) && (
                  <button
                    type="button"
                    onClick={() => onCancel(t.taskId)}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <TaskNodeChecklist nodes={t.nodes} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
