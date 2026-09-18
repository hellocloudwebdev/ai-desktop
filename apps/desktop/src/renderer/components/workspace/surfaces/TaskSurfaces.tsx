// PR31.8: renderer — Tasks, Activity, Files Surfaces
//
// TasksSurface consumes the PR29 task projection (status + nodes) without a
// second state machine. ActivitySurface renders canonical events as a bounded
// view. FilesSurface is read-only context; edits stay behind PR30 tools.
//
// PR43: renderer — TasksSurface is extended into the Task Center. The
// existing foreground list (agent + coding tasks) renders first, unchanged;
// the BackgroundTaskCenter renders below it over background projections
// (Active: Running / Waiting for approval / Waiting for input / Queued /
// Paused; Completed: Completed / Failed / Cancelled) with a Task Detail
// view. Foreground props stay required and backward compatible; background
// wiring is optional and self-sufficient when absent.

import React from "react";
import type {
  ActivitySurfaceProps,
  FilesSurfaceProps,
  TasksSurfaceProps,
} from "./surface-props.js";
import { BackgroundTaskCenter } from "./BackgroundTaskCenter.js";
import { ScheduleCenter } from "./ScheduleCenter.js";
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
  background,
  schedules,
}: TasksSurfaceProps): React.ReactElement {
  const all = [
    ...agentTasks.map((t) => ({ ...t, kind: "agent" as const })),
    ...codingTasks.map((t) => ({ ...t, kind: "coding" as const })),
  ];
  // PR43: background center falls back to a self-sufficient instance bound
  // to the workspace selection when App has not wired it explicitly.
  const backgroundProps = {
    selectedTaskId: activeTaskId,
    onSelectTask,
    ...background,
  };
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
      {/* PR43: Background Task Center (Active + Completed + Detail). */}
      <div className="border-t border-slate-800 mt-2">
        <BackgroundTaskCenter {...backgroundProps} />
      </div>
      {/* PR44: Schedule Center (Enabled + Disabled + Detail + run history). */}
      <div className="border-t border-slate-800 mt-2">
        <ScheduleCenter {...schedules} />
      </div>
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
  documents = [],
  selectedDocument = null,
  onSelectDocument,
  documentsError = null,
  attachments = [],
  selectedAttachmentPreview = null,
  attachmentsError = null,
  onUploadAttachment,
  onDeleteAttachment,
  onPreviewAttachment,
}: FilesSurfaceProps): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const handlePickedFile = (file: File): void => {
    if (!onUploadAttachment) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        return;
      }
      // FileReader data: URL → strip the prefix, keep bounded base64 only.
      const comma = result.indexOf(",");
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      onUploadAttachment({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64,
      });
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="px-6 py-4 overflow-y-auto text-xs">
      <p className="text-slate-400 mb-2">
        Project: <span className="font-mono text-slate-200">{activeProjectId}</span>
      </p>
      {documentsError && <p className="text-red-400 mb-2">{documentsError}</p>}
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
      {/* PR37: project documents (ingested source material with status). */}
      <p className="mt-4 mb-2 text-slate-400">
        Documents: <span className="font-mono text-slate-200">{documents.length}</span>
      </p>
      {documents.length === 0 ? (
        <p className="text-slate-500">No documents ingested in this project yet.</p>
      ) : (
        <ul className="space-y-1">
          {documents.map((d) => (
            <li key={d.documentId} className="rounded bg-slate-800/60 px-2 py-1.5">
              <button
                type="button"
                onClick={() => onSelectDocument?.(d.documentId)}
                className="font-mono text-slate-200 break-all hover:text-white text-left"
              >
                {d.name}
              </button>
              <span className="text-slate-400 ml-2">
                {d.mimeType} · {d.sizeBytes} bytes · {d.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {selectedDocument && (
        <div className="mt-3 rounded bg-slate-800/60 px-2 py-1.5">
          <p className="font-mono text-slate-200 break-all">{selectedDocument.name}</p>
          <p className="text-slate-400 mt-1">
            {selectedDocument.mimeType} · {selectedDocument.status}
            {selectedDocument.pageCount !== null && ` · ${selectedDocument.pageCount} pages`}
          </p>
          {selectedDocument.error && <p className="text-red-400 mt-1">{selectedDocument.error}</p>}
          {selectedDocument.preview && (
            <p className="text-slate-300 mt-2 whitespace-pre-wrap break-words">
              {selectedDocument.preview}
            </p>
          )}
          <button
            type="button"
            onClick={() => onSelectDocument?.(null)}
            className="text-slate-400 hover:text-slate-200 mt-2"
          >
            Close preview
          </button>
        </div>
      )}
      <p className="mt-3 text-[10px] text-slate-500">
        Read-only context. Editing uses the coding tools.
      </p>
      {/* PR39: project attachments (upload + list + delete + preview). */}
      <p className="mt-4 mb-2 text-slate-400">
        Attachments: <span className="font-mono text-slate-200">{attachments.length}</span>
      </p>
      {attachmentsError && <p className="text-red-400 mb-2">{attachmentsError}</p>}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        aria-label="Upload attachment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            handlePickedFile(file);
          }
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={!onUploadAttachment}
        className="rounded-lg bg-indigo-700 hover:bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50 mb-2"
      >
        Upload attachment
      </button>
      {attachments.length === 0 ? (
        <p className="text-slate-500">No attachments uploaded in this project yet.</p>
      ) : (
        <ul className="space-y-1">
          {attachments.map((a) => (
            <li key={a.attachmentId} className="rounded bg-slate-800/60 px-2 py-1.5">
              <button
                type="button"
                onClick={() => onPreviewAttachment?.(a.attachmentId)}
                className="font-mono text-slate-200 break-all hover:text-white text-left"
              >
                {a.filename}
              </button>
              <span className="text-slate-400 ml-2">
                {a.mimeType} · {a.sizeBytes} bytes · {a.status}
              </span>
              <button
                type="button"
                onClick={() => onDeleteAttachment?.(a.attachmentId)}
                aria-label={`Delete attachment ${a.filename}`}
                className="ml-2 text-rose-300 hover:text-rose-100"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedAttachmentPreview && (
        <div className="mt-3 rounded bg-slate-800/60 px-2 py-1.5">
          {selectedAttachmentPreview.kind === "image" && selectedAttachmentPreview.dataBase64 ? (
            <img
              src={`data:${selectedAttachmentPreview.mimeType};base64,${selectedAttachmentPreview.dataBase64}`}
              alt="Attachment preview"
              className="max-h-48 rounded"
            />
          ) : (
            <p className="text-slate-300">
              {selectedAttachmentPreview.mimeType} preview unavailable as an image; metadata card
              only.
            </p>
          )}
          <button
            type="button"
            onClick={() => onPreviewAttachment?.(null)}
            className="text-slate-400 hover:text-slate-200 mt-2"
          >
            Close preview
          </button>
        </div>
      )}
    </div>
  );
}
