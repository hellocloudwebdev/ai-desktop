// PR31.4/31.6: renderer — Workspace Shell
//
// Three-column composition: Sidebar | Main surface | Inspector, plus header
// and composer. Owns layout only; all domain behavior arrives via props.

import React from "react";
import type { WorkspaceStore } from "../../workspace/store.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { WorkspaceMain } from "./WorkspaceMain.js";
import { WorkspaceInspector } from "./WorkspaceInspector.js";
import { WorkspaceComposer } from "./WorkspaceComposer.js";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle.js";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary.js";
import type {
  ChatSurfaceProps,
  CodingSurfaceProps,
  CodingWorkspaceProps,
  ComposerProps,
  AttachmentFileView,
  DocumentFileView,
  ExtensionsSurfaceProps,
  BrowserSurfaceProps,
  McpServersSurfaceProps,
  ResearchSurfaceProps,
  InspectorProps,
  SelectedAttachmentPreview,
  SelectedDocumentView,
  SidebarProps,
  SurfaceHostProps,
  TasksSurfaceProps,
  VoiceSurfaceProps,
  ActivityEventView,
  FileEntryView,
} from "./surfaces/surface-props.js";

export interface WorkspaceShellProps {
  readonly store: WorkspaceStore;
  readonly conversationId: string;
  readonly healthStatus: string;
  readonly isStreaming: boolean;
  readonly sidebar: SidebarProps;
  readonly chat: ChatSurfaceProps;
  readonly coding: CodingSurfaceProps;
  readonly codingWorkspace?: CodingWorkspaceProps;
  readonly tasks: TasksSurfaceProps;
  readonly activity: ActivityEventView[];
  readonly files: FileEntryView[];
  readonly documents?: DocumentFileView[];
  readonly selectedDocument?: SelectedDocumentView | null;
  readonly onSelectDocument?: (documentId: string | null) => void;
  readonly documentsError?: string | null;
  readonly attachments?: AttachmentFileView[];
  readonly selectedAttachmentPreview?: SelectedAttachmentPreview | null;
  readonly onPreviewAttachment?: (attachmentId: string | null) => void;
  readonly attachmentsError?: string | null;
  readonly onUploadAttachment?: (file: {
    name: string;
    mimeType: string;
    dataBase64: string;
  }) => void;
  readonly onDeleteAttachment?: (attachmentId: string) => void;
  readonly extensions: ExtensionsSurfaceProps;
  readonly browser: BrowserSurfaceProps;
  readonly research: ResearchSurfaceProps;
  readonly mcp?: McpServersSurfaceProps;
  readonly voice?: VoiceSurfaceProps;
  readonly inspector: InspectorProps;
  readonly composer: ComposerProps;
  // PR33.8: renderer — rich-surface host view (additive pass-through).
  readonly surfaceHost?: SurfaceHostProps;
}

export function WorkspaceShell({
  store,
  conversationId,
  healthStatus,
  isStreaming,
  sidebar,
  chat,
  coding,
  codingWorkspace,
  tasks,
  activity,
  files,
  documents,
  selectedDocument,
  onSelectDocument,
  documentsError,
  attachments,
  selectedAttachmentPreview,
  onPreviewAttachment,
  attachmentsError,
  onUploadAttachment,
  onDeleteAttachment,
  extensions,
  browser,
  research,
  mcp,
  voice,
  inspector,
  composer,
  surfaceHost,
}: WorkspaceShellProps): React.ReactElement {
  const { state } = store;

  return (
    <main className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 font-sans">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/60 px-6 backdrop-blur-sm">
        <div className="flex items-center space-x-3">
          <div className="h-3 w-3 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
          <h1 className="text-base font-semibold text-white">AI Desktop</h1>
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-400 font-mono">
            {conversationId.slice(0, 10)}…
          </span>
        </div>

        <div className="flex items-center space-x-3 text-xs text-slate-400 font-mono">
          <button
            type="button"
            onClick={() => store.togglePanel("left")}
            aria-pressed={state.leftPanel.visible}
            className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors"
          >
            {state.leftPanel.visible ? "Hide nav" : "Show nav"}
          </button>
          <button
            type="button"
            onClick={() => store.togglePanel("right")}
            aria-pressed={state.rightPanel.visible}
            className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors"
          >
            {state.rightPanel.visible ? "Hide inspector" : "Show inspector"}
          </button>
          <span>IPC: {healthStatus}</span>
          {isStreaming && (
            <span className="inline-flex items-center text-amber-400 animate-pulse">
              ● streaming
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {state.leftPanel.visible && (
          <>
            <div
              className="shrink-0 border-r border-slate-800 bg-slate-900/40"
              style={{ width: state.leftPanel.width }}
            >
              <WorkspaceErrorBoundary surfaceName="Navigation">
                <WorkspaceSidebar {...sidebar} />
              </WorkspaceErrorBoundary>
            </div>
            <WorkspaceResizeHandle
              panel="left"
              width={state.leftPanel.width}
              onResize={(width) => store.setPanelWidth("left", width)}
              onReset={() => store.setPanelWidth("left", 248)}
            />
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceErrorBoundary surfaceName={state.activeSurface}>
            <WorkspaceMain
              store={store}
              chat={chat}
              coding={coding}
              codingWorkspace={codingWorkspace}
              tasks={tasks}
              activity={activity}
              files={files}
              documents={documents}
              selectedDocument={selectedDocument}
              onSelectDocument={onSelectDocument}
              documentsError={documentsError}
              attachments={attachments}
              selectedAttachmentPreview={selectedAttachmentPreview}
              onPreviewAttachment={onPreviewAttachment}
              attachmentsError={attachmentsError}
              onUploadAttachment={onUploadAttachment}
              onDeleteAttachment={onDeleteAttachment}
              extensions={extensions}
              browser={browser}
              research={research}
              mcp={mcp}
              voice={voice}
              surfaceHost={surfaceHost}
            />
          </WorkspaceErrorBoundary>
        </div>

        {state.rightPanel.visible && (
          <>
            <WorkspaceResizeHandle
              panel="right"
              width={state.rightPanel.width}
              onResize={(width) => store.setPanelWidth("right", width)}
              onReset={() => store.setPanelWidth("right", 320)}
            />
            <div
              className="shrink-0 border-l border-slate-800 bg-slate-900/40"
              style={{ width: state.rightPanel.width }}
            >
              <WorkspaceErrorBoundary surfaceName="Inspector">
                <WorkspaceInspector {...inspector} />
              </WorkspaceErrorBoundary>
            </div>
          </>
        )}
      </div>

      <WorkspaceErrorBoundary surfaceName="Composer">
        <WorkspaceComposer {...composer} />
      </WorkspaceErrorBoundary>
    </main>
  );
}
