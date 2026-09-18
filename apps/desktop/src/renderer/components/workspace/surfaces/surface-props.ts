// PR31.6: renderer — Shared surface prop types
//
// Surfaces receive backend-owned data + existing handlers as props.
// They own no domain behavior: ChatService, AgentService, CodingAgentService,
// IPC, and projections stay the single owners.

import type { ContentPart, Message, ModelDefinition, PermissionRequest } from "@ai-desktop/ai-core";
import type { WorkspaceSurface } from "../../../workspace/types.js";
import type { BackgroundTasksCommands } from "../../../workspace/background-tasks.js";

export interface TaskNodeView {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
}

export interface TaskView {
  readonly taskId: string;
  readonly status: string;
  readonly nodes: TaskNodeView[];
}

export interface ChatSurfaceProps {
  readonly messages: Message[];
  readonly errorMessage: string | null;
  readonly pendingPermissions: PermissionRequest[];
  readonly messagesEndRef: React.RefObject<HTMLDivElement | null>;
  renderMessageText(parts: readonly ContentPart[]): string;
  onResolvePermission(
    requestId: string,
    decision: "granted" | "denied",
    mode: "allow_once" | "allow_session" | "allow_project" | "deny",
  ): void;
}

export interface CodingSurfaceProps {
  readonly codingTasks: TaskView[];
  readonly codingPrompt: string;
  readonly codingProjectId: string;
  readonly codingRunning: boolean;
  onPromptChange(value: string): void;
  onProjectChange(value: string): void;
  onStart(): void;
  onCancel(taskId: string): void;
}

// PR41: renderer — coding workspace views (explorer, tabs, search,
// diagnostics, terminal, diff as plain data; operations via bridge).
export interface WorkspaceFileNode {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly children?: WorkspaceFileNode[];
}

export interface WorkspaceTab {
  readonly path: string;
  readonly content: string;
  readonly dirty: boolean;
  readonly conflict: boolean;
  readonly mtimeMs?: number;
}

export interface WorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface WorkspaceSearchView {
  readonly matches: WorkspaceSearchMatch[];
  readonly truncated: boolean;
}

export interface WorkspaceDiagnosticView {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly message: string;
}

export interface WorkspaceTerminalView {
  readonly id: string;
  readonly state: string;
  readonly command: string;
}

export interface WorkspaceDiffView {
  readonly path: string;
  readonly hunks: Array<{
    readonly lines: Array<{ readonly kind: "context" | "add" | "del"; readonly text: string }>;
  }>;
}

export interface CodingWorkspaceProps {
  readonly activeProjectId: string;
  readonly files: WorkspaceFileNode[];
  readonly tabs: WorkspaceTab[];
  readonly activeTabPath: string | null;
  readonly search: WorkspaceSearchView | null;
  readonly diagnostics: WorkspaceDiagnosticView[];
  readonly terminals: WorkspaceTerminalView[];
  readonly terminalOutput: string | null;
  readonly diff: WorkspaceDiffView | null;
  readonly codingTasks: TaskView[];
  readonly codingPrompt: string;
  readonly codingRunning: boolean;
  readonly workspaceError: string | null;
  onRefreshFiles(): void;
  onOpenFile(path: string): void;
  onCloseTab(path: string): void;
  onSelectTab(path: string): void;
  onEditTab(path: string, content: string): void;
  onSaveFile(path: string): void;
  onSaveAllFiles(): void;
  onRevertFile(path: string): void;
  onSearch(query: string): void;
  onTerminalCreate(command: string): void;
  onTerminalStop(id: string): void;
  onPromptChange(value: string): void;
  onProjectChange(value: string): void;
  onStartTask(): void;
  onCancelTask(taskId: string): void;
}

export interface TasksSurfaceProps {
  readonly agentTasks: TaskView[];
  readonly codingTasks: TaskView[];
  readonly activeTaskId: string | null;
  readonly agentGoal: string;
  readonly agentRunning: boolean;
  onSelectTask(taskId: string | null): void;
  onCancelAgent(taskId: string): void;
  onCancelCoding(taskId: string): void;
  onAgentGoalChange(value: string): void;
  onStartAgent(): void;
  // PR43: renderer — optional background Task Center wiring. When absent,
  // the Task Center self-renders over the background bridge (or the local
  // stub before the sibling IPC lands); App may pass these to bind the
  // center to workspace state and the existing permission UI path.
  readonly background?: BackgroundTaskCenterProps;
}

// PR43: renderer — Background Task Center contract (long-running agents).
//
// The center renders `BackgroundTaskProjection`-shaped views only: task
// name, bound project, status, timing, current node, permission/input
// state, bounded errors/outputs, and a timeline sliced from the existing
// EventBus/activity projections (`task.background.*`). Approvals always
// flow through the existing permission UI path (`pendingPermissions` +
// `onResolvePermission`, same shape as ChatSurface); the center never
// auto-approves. `respond` carries free-text answers for `waiting_input`
// tasks only — never permission decisions.
export interface BackgroundTaskCenterProps {
  /** Bound-project scope hint; rows always show each task's own projectId. */
  readonly activeProjectId?: string;
  readonly selectedTaskId?: string | null;
  onSelectTask?(taskId: string | null): void;
  /** False (default) scopes to `activeProjectId`; true lists all projects. */
  readonly scopeAllProjects?: boolean;
  onToggleScope?(all: boolean): void;
  /** Existing activity projections (`task.background.*` transitions). */
  readonly taskActivity?: ActivityEventView[];
  /** Existing pending permission requests for the approval affordance. */
  readonly pendingPermissions?: PermissionRequest[];
  onResolvePermission?(
    requestId: string,
    decision: "granted" | "denied",
    mode: "allow_once" | "allow_session" | "allow_project" | "deny",
  ): Promise<void> | void;
  readonly pollIntervalMs?: number;
  /**
   * Injectable bridge (tests/embeddings). Defaults to the
   * `window.api.backgroundTasks` probe with a local-stub fallback.
   */
  readonly commands?: BackgroundTasksCommands | null;
}

export interface ActivityEventView {
  readonly key: string;
  readonly time: string;
  readonly label: string;
  readonly kind: string;
}

export interface ActivitySurfaceProps {
  readonly events: ActivityEventView[];
}

export interface FileEntryView {
  readonly path: string;
  readonly detail?: string;
}

export interface FilesSurfaceProps {
  readonly activeProjectId: string;
  readonly touchedFiles: FileEntryView[];
  readonly documents?: DocumentFileView[];
  readonly selectedDocument?: SelectedDocumentView | null;
  readonly onSelectDocument?: (documentId: string | null) => void;
  readonly documentsError?: string | null;
  // PR39: project attachments (metadata + bounded image-only preview).
  // Bytes travel upload-side as base64 through attachments:* IPC; previews
  // arrive as small data: thumbnails (images) or metadata cards (audio/video).
  readonly attachments?: AttachmentFileView[];
  readonly selectedAttachmentPreview?: SelectedAttachmentPreview | null;
  readonly attachmentsError?: string | null;
  readonly onUploadAttachment?: (file: {
    name: string;
    mimeType: string;
    dataBase64: string;
  }) => void;
  readonly onDeleteAttachment?: (attachmentId: string) => void;
  readonly onPreviewAttachment?: (attachmentId: string | null) => void;
}

// PR39: renderer — project attachment views (metadata as plain data;
// image thumbnails as bounded data: URLs; audio/video render as a
// metadata card without bytes).
export interface AttachmentFileView {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: string;
}

export interface SelectedAttachmentPreview {
  readonly attachmentId: string;
  readonly kind: "image" | "card";
  readonly mimeType: string;
  readonly dataBase64: string | null;
}

// PR37: renderer — project document views (metadata + bounded preview as
// plain text; citations reference chunk locators, never raw paths).
export interface DocumentFileView {
  readonly documentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly updatedAt: string;
}

export interface SelectedDocumentView {
  readonly documentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly status: string;
  readonly pageCount: number | null;
  readonly preview: string | null;
  readonly error: string | null;
}

export interface InspectorProps {
  readonly activeTask: (TaskView & { kind: "agent" | "coding" }) | null;
  readonly activeConversationId: string | null;
  readonly activeProjectId: string;
  readonly files: FileEntryView[];
  readonly activity: ActivityEventView[];
  onCancelTask(kind: "agent" | "coding", taskId: string): void;
  // PR33.1: renderer — optional rich-surface selection (additive).
  readonly surfaces?: SurfaceView[];
  readonly selectedSurfaceId?: string | null;
  onSelectSurface?(id: string | null): void;
}

export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly active?: boolean;
}

export interface MemoryView {
  readonly id: string;
  readonly content: string;
  readonly category: string;
  readonly scopeLevel: string;
  readonly projectId?: string | null;
}

export interface ExtensionView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly capabilities: string[];
  readonly lifecycle: "installed" | "enabled" | "active" | "disabled";
  readonly trust: string;
  readonly manifestHash: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly enabledProjects: string[];
}

export interface ExtensionsSurfaceProps {
  readonly extensions: ExtensionView[];
  readonly activeProjectId: string;
  readonly selectedExtensionId?: string | null;
  onSelectExtension(extensionId: string | null): void;
  onEnable(extensionId: string): void;
  onDisable(extensionId: string): void;
  onProjectToggle(extensionId: string, enabled: boolean): void;
}

// PR38: renderer — MCP server views (status/capabilities/counts as plain
// data; connect/disconnect arrive as handler props).
export interface McpServerView {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly state:
    "configured" | "connecting" | "ready" | "degraded" | "disconnected" | "failed" | "stopped";
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly capabilities: string[];
}

export interface McpServersSurfaceProps {
  readonly servers: McpServerView[];
  readonly activeProjectId: string;
  readonly selectedServerId?: string | null;
  onSelectServer(serverId: string | null): void;
  onDisconnect(serverId: string): void;
}

// PR40: renderer — voice/realtime surface views (session status +
// transcripts as plain data; capture/playback stay main-side).
export interface VoiceSessionView {
  readonly sessionId: string;
  readonly state:
    | "idle"
    | "requesting-permission"
    | "starting"
    | "active"
    | "listening"
    | "thinking"
    | "speaking"
    | "interrupted"
    | "stopping"
    | "stopped"
    | "failed"
    | "cancelled";
  readonly modelId: string;
  readonly providerId: string;
}

export interface VoiceTranscriptView {
  readonly turnId: string;
  readonly text: string;
}

export interface VoiceSurfaceProps {
  readonly activeProjectId: string;
  readonly session: VoiceSessionView | null;
  readonly partialTranscript: string | null;
  readonly finalTranscripts: VoiceTranscriptView[];
  readonly isWorking: boolean;
  readonly error: string | null;
  onStart(): void;
  onInterrupt(): void;
  onStop(): void;
}

export interface ExtensionsSummary {
  readonly total: number;
  readonly active: number;
}

// PR34.5: renderer — Browser automation surface contract
export interface BrowserPageView {
  readonly id: string;
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
  readonly status: string;
}

export interface BrowserSurfaceProps {
  readonly activeProjectId: string;
  readonly pages: BrowserPageView[];
  readonly activePageId: string | null;
  readonly onSelectPage: (pageId: string | null) => void;
  readonly onOpenPage: (url: string) => void;
  readonly onClosePage: (pageId: string) => void;
  readonly onTakeScreenshot: (pageId: string) => void;
  readonly screenshotArtifact?: { artifactRef: string; bytes: number } | null;
}

// PR35: renderer — Web research surface contract
export interface ResearchResultView {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly domain: string;
  readonly provider: string;
}

export interface ResearchDocumentView {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
  readonly provider: string;
  readonly truncated: boolean;
}

export interface ResearchProviderStatusView {
  readonly provider: string;
  readonly status: string;
}

export interface ResearchSurfaceProps {
  readonly activeProjectId: string;
  readonly results: ResearchResultView[];
  readonly activeResultUrl: string | null;
  readonly openedDocument: ResearchDocumentView | null;
  readonly providerStatuses: ResearchProviderStatusView[];
  readonly isSearching: boolean;
  readonly searchError: string | null;
  readonly onSearch: (query: string) => void;
  readonly onOpenResult: (url: string) => void;
  readonly onOpenInBrowser: (url: string) => void;
  readonly deepPackage?: ResearchPackageView | null;
  readonly isDeepResearching?: boolean;
}

// PR36: renderer — deep-research package view contract (evidence -> source
// chain with conflicts, citations, and extractive synthesis). Rendered by the
// existing ResearchSurface; no new surface kind or IPC channel.
export interface ResearchPackageSourceView {
  readonly title: string;
  readonly url: string;
  readonly providers: string[];
}

export interface ResearchPackageEvidenceView {
  readonly excerpt: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
}

export interface ResearchPackageConflictView {
  readonly topic: string;
  readonly sideA: string;
  readonly sideB: string;
}

export interface ResearchPackageCitationView {
  readonly title: string;
  readonly url: string;
}

export interface ResearchPackageView {
  readonly status: string;
  readonly sourcesCount: number;
  readonly evidenceCount: number;
  readonly conflictsCount: number;
  readonly sources: ResearchPackageSourceView[];
  readonly evidence: ResearchPackageEvidenceView[];
  readonly conflicts: ResearchPackageConflictView[];
  readonly citations: ResearchPackageCitationView[];
  readonly synthesisSummary: string | null;
}

export interface SidebarProps {
  readonly activeSurface: string;
  readonly activeProjectId: string;
  readonly conversationId: string;
  readonly agentActiveCount: number;
  readonly codingActiveCount: number;
  /** PR43: active background tasks (Task Center); defaults to 0. */
  readonly backgroundActiveCount?: number;
  readonly leftVisible: boolean;
  readonly rightVisible: boolean;
  onSelectSurface(surface: WorkspaceSurface): void;
  onSelectProject(projectId: string): void;
  onToggleLeft(): void;
  onToggleRight(): void;
  readonly availableModels: ModelDefinition[];
  readonly selectedModelId: string;
  readonly isStreaming: boolean;
  onModelChange(modelId: string): void;
  readonly skills: SkillView[];
  readonly memories: MemoryView[];
  onToggleSkill(skillId: string, currentlyEnabled: boolean): void;
  onDeleteMemory(factId: string): void;
  readonly extensionsSummary: ExtensionsSummary;
}

export interface ComposerProps {
  readonly activeSurface: string;
  readonly inputText: string;
  readonly codingPrompt: string;
  readonly isStreaming: boolean;
  readonly codingRunning: boolean;
  readonly activeProjectId: string;
  onInputChange(value: string): void;
  onCodingPromptChange(value: string): void;
  onSend(e?: React.FormEvent): void;
  onCancel(): void;
  onStartCoding(): void;
}

// PR33.1: renderer — Rich surface contract (ai-core parallel module)
//
// SurfaceView is the presentation projection of a backend-owned surface
// instance. Surfaces own no domain behavior: data arrives via props and
// user intent leaves via onAction/onDispose callbacks (App owns the
// preload bridge).

export type SurfaceKind = "document" | "table" | "form" | "chart" | "application";

export interface SurfaceActionView {
  readonly actionId: string;
  readonly type: string;
  readonly toolName: string;
  readonly title?: string;
}

export interface SurfaceView {
  readonly instanceId: string;
  readonly kind: string;
  readonly title?: string;
  readonly status: string;
  readonly provenance: {
    readonly source: string;
    readonly originId: string;
    readonly projectId?: string;
  };
  readonly data: unknown;
  readonly actions: SurfaceActionView[];
}

export interface SurfaceHostProps {
  readonly surfaceView: SurfaceView | null;
  onSurfaceAction(actionId: string, input: unknown): void;
  onSurfaceDispose(instanceId: string): void;
}

export interface InspectorSurfaceSelection {
  readonly surfaces: SurfaceView[];
  readonly selectedSurfaceId: string | null;
  onSelectSurface(id: string | null): void;
}
