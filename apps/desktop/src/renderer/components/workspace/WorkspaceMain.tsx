// PR31.6: renderer — Workspace Main (surface switch)
//
// Renders the active surface. Switching surfaces never restarts or cancels
// work: surfaces are pure views over App-owned backend state.

import React from "react";
import type { WorkspaceStore } from "../../workspace/store.js";
import { ChatSurface } from "./surfaces/ChatSurface.js";
import { CodingSurface } from "./surfaces/CodingSurface.js";
import { CodingWorkspace } from "./surfaces/CodingWorkspace.js";
import { ExtensionsSurface } from "./surfaces/ExtensionsSurface.js";
import { McpServersSurface } from "./surfaces/McpServersSurface.js";
import { VoiceSurface } from "./surfaces/VoiceSurface.js";
import { GitReviewSurface } from "./surfaces/GitReviewSurface.js";
import { BrowserSurface } from "./surfaces/BrowserSurface.js";
import { ResearchSurface } from "./surfaces/ResearchSurface.js";
import { RichSurfaceHost } from "./surfaces/RichSurfaceHost.js";
import { ActivitySurface, FilesSurface, TasksSurface } from "./surfaces/TaskSurfaces.js";
import { AccountSurface } from "./surfaces/AccountSurface.js";
import type {
  AccountSurfaceProps,
  ActivityEventView,
  AttachmentFileView,
  BrowserSurfaceProps,
  ChatSurfaceProps,
  CodingSurfaceProps,
  CodingWorkspaceProps,
  DocumentFileView,
  ExtensionsSurfaceProps,
  FileEntryView,
  McpServersSurfaceProps,
  ResearchSurfaceProps,
  SelectedAttachmentPreview,
  SelectedDocumentView,
  SurfaceHostProps,
  TasksSurfaceProps,
  VoiceSurfaceProps,
} from "./surfaces/surface-props.js";

interface WorkspaceMainProps {
  readonly store: WorkspaceStore;
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
  // PR45: renderer — optional Account & Sync surface wiring (additive).
  // When absent, the surface self-renders over the account/sync bridges
  // (or the local stub before the sibling IPC lands).
  readonly account?: AccountSurfaceProps;
  // PR33.8: renderer — optional rich-surface branch (additive).
  readonly surfaceHost?: SurfaceHostProps;
}

export function WorkspaceMain({
  store,
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
  account,
  surfaceHost,
}: WorkspaceMainProps): React.ReactElement {
  const surface = store.state.activeSurface;
  // PR33.8: renderer — a selected rich-surface instance takes over the main
  // area. Missing view for a selection renders a placeholder, never crashes.
  if (store.state.selectedSurfaceId) {
    if (!surfaceHost || !surfaceHost.surfaceView) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-xs text-slate-500">Surface unavailable.</p>
        </div>
      );
    }
    return (
      <RichSurfaceHost
        surface={surfaceHost.surfaceView}
        onAction={surfaceHost.onSurfaceAction}
        onDispose={surfaceHost.onSurfaceDispose}
      />
    );
  }
  if (surface === "coding") {
    if (codingWorkspace) {
      return <CodingWorkspace {...codingWorkspace} />;
    }
    return <CodingSurface {...coding} />;
  }
  if (surface === "tasks") {
    return <TasksSurface {...tasks} />;
  }
  if (surface === "activity") {
    return <ActivitySurface events={activity} />;
  }
  if (surface === "files") {
    return (
      <FilesSurface
        activeProjectId={store.state.activeProjectId}
        touchedFiles={files}
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
      />
    );
  }
  if (surface === "extensions") {
    return <ExtensionsSurface {...extensions} />;
  }
  if (surface === "browser") {
    return <BrowserSurface {...browser} />;
  }
  if (surface === "research") {
    return <ResearchSurface {...research} />;
  }
  if (surface === "mcp") {
    if (!mcp) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-xs text-slate-500">MCP unavailable.</p>
        </div>
      );
    }
    return <McpServersSurface {...mcp} />;
  }
  if (surface === "voice") {
    if (!voice) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-xs text-slate-500">Voice unavailable.</p>
        </div>
      );
    }
    return <VoiceSurface {...voice} />;
  }
  if (surface === "git") {
    return <GitReviewSurface projectId={store.state.activeProjectId} />;
  }
  // PR45: renderer — Account & Sync surface (self-sufficient when unwired).
  if (surface === "account") {
    return <AccountSurface {...account} />;
  }
  return <ChatSurface {...chat} />;
}
