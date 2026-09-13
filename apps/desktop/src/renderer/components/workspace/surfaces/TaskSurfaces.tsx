// PR31.8: renderer — Tasks, Activity, Files Surfaces
//
// TasksSurface consumes the PR29 task projection (status + nodes) without a
// second state machine. ActivitySurface renders canonical events as a bounded
// view. FilesSurface is read-only context; edits stay behind PR30 tools.

import React from "react";
import type {
  ActivitySurfaceProps,
  FilesSurfaceProps,
  TasksSurfaceProps,
} from "./surface-props.js";
import { isTaskRunning, TaskNodeChecklist } from "./CodingSurface.js";

const MAX_ACTIVITY_ITEMS = 200;

export function TasksSurface({
  agentTasks,
  codingTasks,
  activeTaskId,
  agentGoal,
  agentRunning,
  onSelectTask,
  onCancelAgent,
  onCancelCoding,
  onAgentGoalChange,
  onStartAgent,
}: TasksSurfaceProps): React.ReactElement {
  const all = [
    ...agentTasks.map((t) => ({ ...t, kind: "agent" as const })),
    ...codingTasks.map((t) => ({ ...t, kind: "coding" as const })),
  ];
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center space-x-2 px-6 pt-4">
        <input
          type="text"
          value={agentGoal}
          onChange={(e) => onAgentGoalChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onStartAgent();
          }}
          placeholder="Describe a multi-step agent goal…"
          disabled={agentRunning}
          aria-label="Agent goal"
          className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onStartAgent}
          disabled={agentRunning || !agentGoal.trim()}
          className="rounded-lg bg-indigo-700 hover:bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
        >
          {agentRunning ? "Starting…" : "Run"}
        </button>
      </div>
      {all.length === 0 ? (
        <p className="text-xs text-slate-500 px-6 py-4">No tasks yet.</p>
      ) : (
        <ul className="space-y-2 px-6 py-4">
          {all.map((t) => (
            <li
              key={`${t.kind}:${t.taskId}`}
              className={`rounded-lg p-2 text-xs border ${
                activeTaskId === t.taskId
                  ? "bg-slate-800 border-indigo-600"
                  : "bg-slate-800/60 border-transparent"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectTask(activeTaskId === t.taskId ? null : t.taskId)}
                aria-pressed={activeTaskId === t.taskId}
                className="w-full text-left focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 font-mono">
                    {t.kind} · {t.taskId.slice(0, 8)}… · {t.status}
                  </span>
                  {isTaskRunning(t.status) && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.kind === "agent") onCancelAgent(t.taskId);
                        else onCancelCoding(t.taskId);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          if (t.kind === "agent") onCancelAgent(t.taskId);
                          else onCancelCoding(t.taskId);
                        }
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200 cursor-pointer"
                    >
                      Cancel
                    </span>
                  )}
                </div>
                <TaskNodeChecklist nodes={t.nodes} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ACTIVITY_KIND_STYLES: Record<string, string> = {
  task: "text-indigo-300",
  tool: "text-emerald-300",
  execution: "text-amber-300",
  permission: "text-orange-300",
  message: "text-slate-300",
};

export function ActivitySurface({ events }: ActivitySurfaceProps): React.ReactElement {
  const visible = events.slice(-MAX_ACTIVITY_ITEMS);
  if (visible.length === 0) {
    return <p className="text-xs text-slate-500 px-6 py-4">No activity yet.</p>;
  }
  return (
    <ul aria-label="Workspace activity" className="space-y-1 px-6 py-4 overflow-y-auto text-xs">
      {visible.map((e) => (
        <li key={e.key} className="flex items-baseline space-x-2">
          <span className="text-slate-500 font-mono text-[10px] shrink-0">{e.time}</span>
          <span className={ACTIVITY_KIND_STYLES[e.kind] ?? "text-slate-300"}>{e.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function FilesSurface({
  activeProjectId,
  touchedFiles,
}: FilesSurfaceProps): React.ReactElement {
  return (
    <div className="px-6 py-4 overflow-y-auto text-xs">
      <p className="text-slate-400 mb-2">
        Project: <span className="font-mono text-slate-200">{activeProjectId}</span>
      </p>
      {touchedFiles.length === 0 ? (
        <p className="text-slate-500">
          No files touched yet. File changes from coding tasks appear here.
        </p>
      ) : (
        <ul className="space-y-1">
          {touchedFiles.map((f) => (
            <li key={f.path} className="rounded bg-slate-800/60 px-2 py-1.5">
              <span className="font-mono text-slate-200 break-all">{f.path}</span>
              {f.detail && <span className="text-slate-400 ml-2">{f.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[10px] text-slate-500">
        Read-only context. Editing uses the coding tools.
      </p>
    </div>
  );
}
