// PR31.7/31.11: renderer — Workspace Inspector (selection-driven context)
//
// Responds to selection: selected task → task graph + nodes; otherwise
// conversation/project context + recent activity + touched files. Derives
// from props; duplicates no backend state.

import React from "react";
import type { InspectorProps } from "./surfaces/surface-props.js";
import { TaskNodeChecklist, isTaskRunning } from "./surfaces/CodingSurface.js";

export function WorkspaceInspector({
  activeTask,
  activeConversationId,
  activeProjectId,
  files,
  activity,
  onCancelTask,
}: InspectorProps): React.ReactElement {
  return (
    <aside
      aria-label="Context inspector"
      className="flex h-full flex-col px-3 py-4 space-y-4 overflow-y-auto text-xs"
    >
      <section aria-label="Selected task">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
          Task
        </p>
        {!activeTask ? (
          <p className="text-slate-500">No task selected. Select one in Tasks.</p>
        ) : (
          <div className="rounded-lg bg-slate-800/60 p-2">
            <div className="flex items-center justify-between mb-1">
              <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 font-mono">
                {activeTask.kind} · {activeTask.taskId.slice(0, 8)}… · {activeTask.status}
              </span>
              {isTaskRunning(activeTask.status) && (
                <button
                  type="button"
                  onClick={() => onCancelTask(activeTask.kind, activeTask.taskId)}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200"
                >
                  Cancel
                </button>
              )}
            </div>
            <TaskNodeChecklist nodes={activeTask.nodes} />
          </div>
        )}
      </section>

      <section aria-label="Conversation context">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
          Conversation
        </p>
        <p className="text-slate-300 font-mono text-[11px] break-all">
          {activeConversationId ?? "none"}
        </p>
        <p className="text-slate-500 mt-1">
          Project: <span className="font-mono text-slate-300">{activeProjectId}</span>
        </p>
      </section>

      <section aria-label="Recent activity">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
          Recent activity
        </p>
        {activity.length === 0 ? (
          <p className="text-slate-500">No activity yet.</p>
        ) : (
          <ul className="space-y-1">
            {activity.slice(-8).map((e) => (
              <li key={e.key} className="flex items-baseline space-x-2">
                <span className="text-slate-500 font-mono text-[10px] shrink-0">{e.time}</span>
                <span className="text-slate-300">{e.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Touched files">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
          Files
        </p>
        {files.length === 0 ? (
          <p className="text-slate-500">No files touched yet.</p>
        ) : (
          <ul className="space-y-1">
            {files.slice(-8).map((f) => (
              <li key={f.path} className="font-mono text-slate-300 break-all">
                {f.path}
                {f.detail && <span className="text-slate-500 ml-1">{f.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
