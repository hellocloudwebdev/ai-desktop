// PR13/PR15: apps/desktop — Preload Typed Application Bridge
//
// Invariants (Step 36 / Step 38):
//   1. Exposes window.api as a typed application bridge.
//   2. Commands use invoke with typed inputs/outputs.
//   3. Subscriptions return an idempotent Unsubscribe function.
//   4. NEVER exposes ipcRenderer, ipcMain, BrowserWindow, app, shell, fs, or process.
//   5. Pure application-owned interface.
//   6. Stream events cross the IPC boundary in ~32 ms batches (terminal events
//      flush immediately) and are unpacked here before reaching the renderer.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  type ChatCancelCommand,
  type ChatSendCommand,
  type ConversationLoadCommand,
  type ProviderProfileCreateCommand,
  type ProviderProfileUpdateCommand,
  type ProviderProfileDeleteCommand,
  type ConversationModelSetCommand,
  type ConversationModelGetCommand,
  type PermissionCheckCommand,
  type PermissionResolveCommand,
  type PermissionRevokeCommand,
  type PermissionPoliciesListCommand,
  type SkillsListCommand,
  type SkillsInstallCommand,
  type SkillsUninstallCommand,
  type SkillsEnableCommand,
  type SkillsDisableCommand,
  type SkillsGetCommand,
  type SkillsReferencesLoadCommand,
  type MemoryListCommand,
  type MemoryGetCommand,
  type MemoryUpdateCommand,
  type MemoryDeleteCommand,
  type MemorySearchCommand,
  type MemorySupersedeCommand,
  type AgentStartCommand,
  type AgentCancelCommand,
  type AgentGetCommand,
  type AgentListCommand,
  type CodingStartCommand,
  type CodingCancelCommand,
  type CodingGetCommand,
  type CodingListCommand,
  type ExtensionListCommand,
  type ExtensionGetCommand,
  type ExtensionInstallCommand,
  type ExtensionUninstallCommand,
  type ExtensionEnableCommand,
  type ExtensionDisableCommand,
  type SurfaceGetCommand,
  type SurfaceActionCommand,
  type SurfaceDisposeCommand,
  type SurfaceListCommand,
  type BrowserSessionCreateCommand,
  type BrowserSessionGetCommand,
  type BrowserSessionCloseCommand,
  type BrowserPageOpenCommand,
  type BrowserPageListCommand,
  type BrowserPageGetCommand,
  type BrowserPageCloseCommand,
  type BrowserScreenshotCommand,
  type IpcResponseEnvelope,
  type ResearchOpenCommand,
  type ResearchSearchCommand,
  type DocumentsListCommand,
  type DocumentsGetCommand,
  type DocumentsSearchCommand,
  type DocumentsIngestCommand,
  type DocumentsDeleteCommand,
  type AttachmentsListCommand,
  type AttachmentsGetCommand,
  type AttachmentsUploadCommand,
  type AttachmentsDeleteCommand,
  type AttachmentsPreviewCommand,
  type McpServerListCommand,
  type McpServerGetCommand,
  type McpServerConnectCommand,
  type McpServerDisconnectCommand,
  type McpCapabilitiesCommand,
  type McpResourcesCommand,
  type McpResourceReadCommand,
  type McpPromptsCommand,
  type McpPromptGetCommand,
  type McpSubscribeCommand,
  type McpUnsubscribeCommand,
  type RealtimeCapabilitiesCommand,
  type RealtimeSessionCreateCommand,
  type RealtimeSessionStartCommand,
  type RealtimeSessionInterruptCommand,
  type RealtimeSessionStopCommand,
  type RealtimeSessionGetCommand,
  type RealtimeSessionListCommand,
  type RealtimeTranscriptCommand,
  type RealtimeAudioCommand,
  type WorkspaceFilesListCommand,
  type WorkspaceFilesReadCommand,
  type WorkspaceFilesWriteCommand,
  type WorkspaceFilesCreateCommand,
  type WorkspaceFilesRenameCommand,
  type WorkspaceFilesDeleteCommand,
  type WorkspaceSearchCommand,
  type WorkspaceDiagnosticsReportCommand,
  type WorkspaceDiagnosticsListCommand,
  type WorkspaceDiagnosticsClearCommand,
  type TerminalListCommand,
  type TerminalCreateCommand,
  type TerminalWriteCommand,
  type TerminalResizeCommand,
  type TerminalStopCommand,
  type TerminalOutputCommand,
  type GitDetectCommand,
  type GitStatusCommand,
  type GitDiffCommand,
  type GitLogCommand,
  type GitBranchesCommand,
  type GitStageCommand,
  type GitUnstageCommand,
  type GitCommitCommand,
  type BackgroundTasksListCommand,
  type BackgroundTasksGetCommand,
  type BackgroundTasksStartCommand,
  type BackgroundTasksPauseCommand,
  type BackgroundTasksResumeCommand,
  type BackgroundTasksCancelCommand,
  type BackgroundTasksRespondCommand,
  type SchedulesListCommand,
  type SchedulesGetCommand,
  type SchedulesCreateCommand,
  type SchedulesUpdateCommand,
  type SchedulesEnableCommand,
  type SchedulesDisableCommand,
  type SchedulesDeleteCommand,
  type SchedulesRunNowCommand,
  type SchedulesRunsCommand,
} from "@ai-desktop/shared";
import type {
  AIEvent,
  Conversation,
  ModelDefinition,
  PermissionRequest,
} from "@ai-desktop/ai-core";
import type { ChatStreamBatch } from "../main/ipc/batcher.js";

export type Unsubscribe = () => void;

/**
 * Typed application API exposed to the React renderer via window.api.
 */
export interface DesktopApplicationApi {
  readonly platform: string;
  readonly isPackaged: boolean;
  ping(): string;

  /**
   * Commands (Renderer -> Main -> Output)
   */
  commands: {
    checkHealth(): Promise<IpcResponseEnvelope<{ status: string; timestamp: string }>>;
    sendChatMessage(
      command: ChatSendCommand,
    ): Promise<
      IpcResponseEnvelope<{ accepted: boolean; messageId?: string; conversationId?: string }>
    >;
    cancelChat(command: ChatCancelCommand): Promise<IpcResponseEnvelope<{ cancelled: boolean }>>;
    loadConversation(
      command: ConversationLoadCommand,
    ): Promise<IpcResponseEnvelope<{ conversation: Conversation }>>;

    // PR22: Provider profile and model selection commands
    listProviderProfiles(): Promise<IpcResponseEnvelope<{ profiles: unknown[] }>>;
    createProviderProfile(
      command: ProviderProfileCreateCommand,
    ): Promise<IpcResponseEnvelope<{ profile: unknown }>>;
    updateProviderProfile(
      command: ProviderProfileUpdateCommand,
    ): Promise<IpcResponseEnvelope<{ profile: unknown }>>;
    deleteProviderProfile(
      command: ProviderProfileDeleteCommand,
    ): Promise<IpcResponseEnvelope<{ deleted: boolean; id: string }>>;
    listProviderModels(): Promise<IpcResponseEnvelope<{ models: ModelDefinition[] }>>;
    setConversationModel(
      command: ConversationModelSetCommand,
    ): Promise<IpcResponseEnvelope<{ modelSelection: unknown }>>;
    getConversationModel(
      command: ConversationModelGetCommand,
    ): Promise<IpcResponseEnvelope<{ modelSelection: unknown }>>;

    // PR24: Permission management commands
    checkPermission(
      command: PermissionCheckCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    listPendingPermissionRequests(): Promise<
      IpcResponseEnvelope<{ requests: PermissionRequest[] }>
    >;
    resolvePermission(
      command: PermissionResolveCommand,
    ): Promise<IpcResponseEnvelope<{ resolved: boolean }>>;
    revokePermission(
      command: PermissionRevokeCommand,
    ): Promise<IpcResponseEnvelope<{ revokedCount: number }>>;
    listPermissionPolicies(
      command?: PermissionPoliciesListCommand,
    ): Promise<IpcResponseEnvelope<{ policies: unknown[] }>>;

    // PR26: Skill management commands
    listSkills(command?: SkillsListCommand): Promise<IpcResponseEnvelope<{ skills: unknown[] }>>;
    installSkill(command: SkillsInstallCommand): Promise<IpcResponseEnvelope<{ skill: unknown }>>;
    uninstallSkill(
      command: SkillsUninstallCommand,
    ): Promise<IpcResponseEnvelope<{ uninstalled: boolean }>>;
    enableSkill(command: SkillsEnableCommand): Promise<IpcResponseEnvelope<{ enabled: boolean }>>;
    disableSkill(
      command: SkillsDisableCommand,
    ): Promise<IpcResponseEnvelope<{ disabled: boolean }>>;
    getSkill(command: SkillsGetCommand): Promise<IpcResponseEnvelope<{ skill: unknown }>>;
    loadSkillReference(
      command: SkillsReferencesLoadCommand,
    ): Promise<IpcResponseEnvelope<{ content: string }>>;

    // PR28: Memory management commands
    listMemories(command?: MemoryListCommand): Promise<IpcResponseEnvelope<{ facts: unknown[] }>>;
    getMemory(command: MemoryGetCommand): Promise<IpcResponseEnvelope<{ fact: unknown }>>;
    updateMemory(command: MemoryUpdateCommand): Promise<IpcResponseEnvelope<{ fact: unknown }>>;
    deleteMemory(command: MemoryDeleteCommand): Promise<IpcResponseEnvelope<{ deleted: boolean }>>;
    searchMemories(
      command: MemorySearchCommand,
    ): Promise<IpcResponseEnvelope<{ facts: unknown[] }>>;
    supersedeMemory(
      command: MemorySupersedeCommand,
    ): Promise<IpcResponseEnvelope<{ fact: unknown }>>;

    // PR29: Agent runtime commands
    startAgentTask(command: AgentStartCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    cancelAgentTask(
      command: AgentCancelCommand,
    ): Promise<IpcResponseEnvelope<{ cancelled: boolean }>>;
    getAgentTask(command: AgentGetCommand): Promise<IpcResponseEnvelope<{ task: unknown }>>;
    listAgentTasks(command?: AgentListCommand): Promise<IpcResponseEnvelope<{ taskIds: string[] }>>;

    // PR30: Coding agent commands (workspace-bound, project-scoped)
    startCodingTask(
      command: CodingStartCommand,
    ): Promise<IpcResponseEnvelope<{ outcome: unknown }>>;
    cancelCodingTask(
      command: CodingCancelCommand,
    ): Promise<IpcResponseEnvelope<{ cancelled: boolean }>>;
    getCodingTask(command: CodingGetCommand): Promise<IpcResponseEnvelope<{ task: unknown }>>;
    listCodingTasks(
      command?: CodingListCommand,
    ): Promise<IpcResponseEnvelope<{ taskIds: string[] }>>;

    // PR32: Extension management commands (no extension:execute channel —
    // execution flows through the agent tool router, never through IPC)
    listExtensions(
      command?: ExtensionListCommand,
    ): Promise<IpcResponseEnvelope<{ extensions: unknown[] }>>;
    getExtension(
      command: ExtensionGetCommand,
    ): Promise<IpcResponseEnvelope<{ extension: unknown }>>;
    installExtension(
      command: ExtensionInstallCommand,
    ): Promise<IpcResponseEnvelope<{ extension: unknown }>>;
    uninstallExtension(
      command: ExtensionUninstallCommand,
    ): Promise<IpcResponseEnvelope<{ uninstalled: boolean }>>;
    enableExtension(
      command: ExtensionEnableCommand,
    ): Promise<IpcResponseEnvelope<{ extension: unknown }>>;
    disableExtension(
      command: ExtensionDisableCommand,
    ): Promise<IpcResponseEnvelope<{ extension: unknown }>>;
    setExtensionProjectEnabled(command: {
      extensionId: string;
      projectId: string;
      enabled: boolean;
    }): Promise<IpcResponseEnvelope<{ extension: unknown }>>;

    // PR33: rich surface lifecycle (state queries + structured actions only;
    // execution flows through the agent tool router, never through IPC).
    listSurfaces(
      command: SurfaceListCommand,
    ): Promise<IpcResponseEnvelope<{ surfaces: unknown[] }>>;
    getSurface(command: SurfaceGetCommand): Promise<IpcResponseEnvelope<{ surface: unknown }>>;
    invokeSurfaceAction(
      command: SurfaceActionCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    disposeSurface(
      command: SurfaceDisposeCommand,
    ): Promise<IpcResponseEnvelope<{ disposed: boolean }>>;

    // PR34.5: Browser automation commands (isolated session + page lifecycle;
    // execution flows through agent tool router, never through arbitrary IPC).
    createBrowserSession(
      command: BrowserSessionCreateCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    getBrowserSession(
      command: BrowserSessionGetCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    closeBrowserSession(
      command: BrowserSessionCloseCommand,
    ): Promise<IpcResponseEnvelope<{ closed: boolean }>>;
    openBrowserPage(
      command: BrowserPageOpenCommand,
    ): Promise<IpcResponseEnvelope<{ page: unknown }>>;
    listBrowserPages(
      command?: BrowserPageListCommand,
    ): Promise<IpcResponseEnvelope<{ pages: unknown[] }>>;
    getBrowserPage(command: BrowserPageGetCommand): Promise<IpcResponseEnvelope<{ page: unknown }>>;
    closeBrowserPage(
      command: BrowserPageCloseCommand,
    ): Promise<IpcResponseEnvelope<{ closed: boolean }>>;
    captureBrowserScreenshot(
      command: BrowserScreenshotCommand,
    ): Promise<IpcResponseEnvelope<{ screenshot: unknown }>>;

    // PR35: web research commands (query/open/status snapshots; execution
    // flows through the agent tool router, never through arbitrary IPC).
    searchWeb(command: ResearchSearchCommand): Promise<IpcResponseEnvelope<{ results: unknown[] }>>;
    openWebResearch(
      command: ResearchOpenCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    getResearchStatus(): Promise<IpcResponseEnvelope<{ providers: unknown[] }>>;

    // PR37: project document commands (list/get/search/ingest/delete;
    // execution flows through the agent tool router, never raw IPC).
    listDocuments(
      command: DocumentsListCommand,
    ): Promise<IpcResponseEnvelope<{ documents: unknown[] }>>;
    getDocument(command: DocumentsGetCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    searchDocuments(
      command: DocumentsSearchCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    ingestDocument(
      command: DocumentsIngestCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    deleteDocument(
      command: DocumentsDeleteCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;

    // PR39: project attachment commands (list/get/upload/delete + bounded
    // image-only preview; no read-path channel — bytes stay main-side).
    listAttachments(
      command: AttachmentsListCommand,
    ): Promise<IpcResponseEnvelope<{ attachments: unknown[] }>>;
    getAttachment(
      command: AttachmentsGetCommand,
    ): Promise<IpcResponseEnvelope<{ attachment: unknown }>>;
    uploadAttachment(
      command: AttachmentsUploadCommand,
    ): Promise<IpcResponseEnvelope<{ attachment: unknown }>>;
    deleteAttachment(
      command: AttachmentsDeleteCommand,
    ): Promise<IpcResponseEnvelope<{ deleted: boolean }>>;
    previewAttachment(
      command: AttachmentsPreviewCommand,
    ): Promise<IpcResponseEnvelope<{ preview: unknown }>>;

    // PR38: MCP server commands (status/capabilities/resources/prompts/
    // subscriptions; execution flows through the agent tool router).
    listMcpServers(
      command: McpServerListCommand,
    ): Promise<IpcResponseEnvelope<{ servers: unknown[] }>>;
    getMcpServer(command: McpServerGetCommand): Promise<IpcResponseEnvelope<{ server: unknown }>>;
    connectMcpServer(
      command: McpServerConnectCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    disconnectMcpServer(
      command: McpServerDisconnectCommand,
    ): Promise<IpcResponseEnvelope<{ disconnected: boolean }>>;
    listMcpCapabilities(
      command: McpCapabilitiesCommand,
    ): Promise<IpcResponseEnvelope<{ health: unknown }>>;
    listMcpResources(
      command: McpResourcesCommand,
    ): Promise<IpcResponseEnvelope<{ resources: unknown[] }>>;
    readMcpResource(
      command: McpResourceReadCommand,
    ): Promise<IpcResponseEnvelope<{ content: unknown }>>;
    listMcpPrompts(
      command: McpPromptsCommand,
    ): Promise<IpcResponseEnvelope<{ prompts: unknown[] }>>;
    getMcpPrompt(command: McpPromptGetCommand): Promise<IpcResponseEnvelope<{ prompt: unknown }>>;
    subscribeMcp(
      command: McpSubscribeCommand,
    ): Promise<IpcResponseEnvelope<{ subscription: unknown }>>;
    unsubscribeMcp(
      command: McpUnsubscribeCommand,
    ): Promise<IpcResponseEnvelope<{ unsubscribed: boolean }>>;

    // PR40: realtime voice commands (session lifecycle + bounded audio
    // chunks; no execute channel, no microphone/provider handles).
    getRealtimeCapabilities(
      command: RealtimeCapabilitiesCommand,
    ): Promise<IpcResponseEnvelope<{ providers: unknown[] }>>;
    createRealtimeSession(
      command: RealtimeSessionCreateCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    startRealtimeSession(
      command: RealtimeSessionStartCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    interruptRealtimeSession(
      command: RealtimeSessionInterruptCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    stopRealtimeSession(
      command: RealtimeSessionStopCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    getRealtimeSession(
      command: RealtimeSessionGetCommand,
    ): Promise<IpcResponseEnvelope<{ session: unknown }>>;
    listRealtimeSessions(
      command: RealtimeSessionListCommand,
    ): Promise<IpcResponseEnvelope<{ sessions: unknown[] }>>;
    getRealtimeTranscript(
      command: RealtimeTranscriptCommand,
    ): Promise<IpcResponseEnvelope<{ transcript: unknown }>>;
    sendRealtimeAudio(
      command: RealtimeAudioCommand,
    ): Promise<IpcResponseEnvelope<{ accepted: boolean }>>;

    // PR41: desktop workspace commands (project-scoped files/search/
    // diagnostics; no execute channel — execution stays agent-side).
    listWorkspaceFiles(
      command: WorkspaceFilesListCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    readWorkspaceFile(
      command: WorkspaceFilesReadCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    writeWorkspaceFile(
      command: WorkspaceFilesWriteCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    createWorkspaceEntry(
      command: WorkspaceFilesCreateCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    renameWorkspaceEntry(
      command: WorkspaceFilesRenameCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    deleteWorkspaceEntry(
      command: WorkspaceFilesDeleteCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    searchWorkspace(
      command: WorkspaceSearchCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    reportWorkspaceDiagnostics(
      command: WorkspaceDiagnosticsReportCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    listWorkspaceDiagnostics(
      command: WorkspaceDiagnosticsListCommand,
    ): Promise<IpcResponseEnvelope<{ diagnostics: unknown[] }>>;
    clearWorkspaceDiagnostics(
      command: WorkspaceDiagnosticsClearCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    listTerminals(command: TerminalListCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    createTerminal(
      command: TerminalCreateCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    writeTerminal(command: TerminalWriteCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    resizeTerminal(
      command: TerminalResizeCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    stopTerminal(command: TerminalStopCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    readTerminalOutput(
      command: TerminalOutputCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;

    // PR42: git commands (project-scoped detect/status/diff/log/branches/
    // stage/unstage/commit; no execute channel — execution stays agent-side).
    detectGitRepository(
      command: GitDetectCommand,
    ): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    getGitStatus(command: GitStatusCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    getGitDiff(command: GitDiffCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    getGitLog(command: GitLogCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    getGitBranches(command: GitBranchesCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    stageGitPaths(command: GitStageCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    unstageGitPaths(command: GitUnstageCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;
    commitGitStaged(command: GitCommitCommand): Promise<IpcResponseEnvelope<{ result: unknown }>>;

    // PR43: background task commands (project-scoped list/get/start/pause/
    // resume/cancel/respond returning normalized projections; no execute
    // channel — execution stays agent-side).
    listBackgroundTasks(
      command: BackgroundTasksListCommand,
    ): Promise<IpcResponseEnvelope<{ tasks: unknown[] }>>;
    getBackgroundTask(
      command: BackgroundTasksGetCommand,
    ): Promise<IpcResponseEnvelope<{ task: unknown }>>;
    startBackgroundTask(
      command: BackgroundTasksStartCommand,
    ): Promise<IpcResponseEnvelope<{ task: unknown }>>;
    pauseBackgroundTask(
      command: BackgroundTasksPauseCommand,
    ): Promise<IpcResponseEnvelope<{ task: unknown }>>;
    resumeBackgroundTask(
      command: BackgroundTasksResumeCommand,
    ): Promise<IpcResponseEnvelope<{ task: unknown }>>;
    cancelBackgroundTask(
      command: BackgroundTasksCancelCommand,
    ): Promise<IpcResponseEnvelope<{ task: unknown; cancelled: boolean }>>;
    respondBackgroundTask(
      command: BackgroundTasksRespondCommand,
    ): Promise<IpcResponseEnvelope<{ task: unknown }>>;
  };

  /**
   * PR44: narrow schedules bridge (no execute channel — execution stays
   * agent-side behind the background-task path with permission mediation).
   */
  schedules: {
    list(command: SchedulesListCommand): Promise<IpcResponseEnvelope<{ schedules: unknown[] }>>;
    get(command: SchedulesGetCommand): Promise<IpcResponseEnvelope<{ schedule: unknown }>>;
    create(command: SchedulesCreateCommand): Promise<IpcResponseEnvelope<{ schedule: unknown }>>;
    update(command: SchedulesUpdateCommand): Promise<IpcResponseEnvelope<{ schedule: unknown }>>;
    enable(command: SchedulesEnableCommand): Promise<IpcResponseEnvelope<{ schedule: unknown }>>;
    disable(command: SchedulesDisableCommand): Promise<IpcResponseEnvelope<{ schedule: unknown }>>;
    delete(
      command: SchedulesDeleteCommand,
    ): Promise<IpcResponseEnvelope<{ deleted: boolean; scheduleId: string }>>;
    runNow(
      command: SchedulesRunNowCommand,
    ): Promise<IpcResponseEnvelope<{ schedule: unknown; run: unknown }>>;
    runs(command: SchedulesRunsCommand): Promise<IpcResponseEnvelope<{ runs: unknown[] }>>;
  };

  /**
   * Subscriptions (Main -> Renderer event streams).
   * Canonical AIEvents are transported in batches and delivered individually.
   */
  events: {
    subscribeToConversation(
      conversationId: string,
      listener: (event: AIEvent) => void,
    ): Promise<Unsubscribe>;
  };
}

export function createDesktopApi(): DesktopApplicationApi {
  return {
    platform: process.platform,
    isPackaged: process.env.NODE_ENV === "production",
    ping: () => "pong",

    commands: {
      async checkHealth() {
        return ipcRenderer.invoke(IPC_CHANNELS.APP_HEALTH_CHECK, {});
      },
      async sendChatMessage(command: ChatSendCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, command);
      },
      async cancelChat(command: ChatCancelCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CHAT_CANCEL, command);
      },
      async loadConversation(command: ConversationLoadCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LOAD, command);
      },
      async listProviderProfiles() {
        return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_PROFILES_LIST, {});
      },
      async createProviderProfile(command: ProviderProfileCreateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_PROFILE_CREATE, command);
      },
      async updateProviderProfile(command: ProviderProfileUpdateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_PROFILE_UPDATE, command);
      },
      async deleteProviderProfile(command: ProviderProfileDeleteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_PROFILE_DELETE, command);
      },
      async listProviderModels() {
        return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_MODELS_LIST, {});
      },
      async setConversationModel(command: ConversationModelSetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_MODEL_SET, command);
      },
      async getConversationModel(command: ConversationModelGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_MODEL_GET, command);
      },
      async checkPermission(command: PermissionCheckCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_CHECK, command);
      },
      async listPendingPermissionRequests() {
        return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_REQUESTS_LIST, {});
      },
      async resolvePermission(command: PermissionResolveCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RESOLVE, command);
      },
      async revokePermission(command: PermissionRevokeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_REVOKE, command);
      },
      async listPermissionPolicies(command?: PermissionPoliciesListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_POLICIES_LIST, command ?? {});
      },
      async listSkills(command?: SkillsListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST, command ?? {});
      },
      async installSkill(command: SkillsInstallCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_INSTALL, command);
      },
      async uninstallSkill(command: SkillsUninstallCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_UNINSTALL, command);
      },
      async enableSkill(command: SkillsEnableCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_ENABLE, command);
      },
      async disableSkill(command: SkillsDisableCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DISABLE, command);
      },
      async getSkill(command: SkillsGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_GET, command);
      },
      async loadSkillReference(command: SkillsReferencesLoadCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_REFERENCES_LOAD, command);
      },
      async listMemories(command?: MemoryListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, command ?? {});
      },
      async getMemory(command: MemoryGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET, command);
      },
      async updateMemory(command: MemoryUpdateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE, command);
      },
      async deleteMemory(command: MemoryDeleteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, command);
      },
      async searchMemories(command: MemorySearchCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH, command);
      },
      async supersedeMemory(command: MemorySupersedeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SUPERSEDE, command);
      },
      async startAgentTask(command: AgentStartCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_START, command);
      },
      async cancelAgentTask(command: AgentCancelCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_CANCEL, command);
      },
      async getAgentTask(command: AgentGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET, command);
      },
      async listAgentTasks(command?: AgentListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST, command ?? {});
      },
      async startCodingTask(command: CodingStartCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CODING_START, command);
      },
      async cancelCodingTask(command: CodingCancelCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CODING_CANCEL, command);
      },
      async getCodingTask(command: CodingGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CODING_GET, command);
      },
      async listCodingTasks(command?: CodingListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.CODING_LIST, command ?? {});
      },
      async listExtensions(command?: ExtensionListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_LIST, command ?? {});
      },
      async getExtension(command: ExtensionGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_GET, command);
      },
      async installExtension(command: ExtensionInstallCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_INSTALL, command);
      },
      async uninstallExtension(command: ExtensionUninstallCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_UNINSTALL, command);
      },
      async enableExtension(command: ExtensionEnableCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_ENABLE, command);
      },
      async disableExtension(command: ExtensionDisableCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_DISABLE, command);
      },
      async setExtensionProjectEnabled(command: {
        extensionId: string;
        projectId: string;
        enabled: boolean;
      }) {
        return ipcRenderer.invoke(
          command.enabled
            ? IPC_CHANNELS.EXTENSION_PROJECT_ENABLE
            : IPC_CHANNELS.EXTENSION_PROJECT_DISABLE,
          { extensionId: command.extensionId, projectId: command.projectId },
        );
      },
      async getSurface(command: SurfaceGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SURFACE_GET, command);
      },
      async listSurfaces(command?: SurfaceListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SURFACE_LIST, command ?? {});
      },
      async invokeSurfaceAction(command: SurfaceActionCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SURFACE_ACTION, command);
      },
      async disposeSurface(command: SurfaceDisposeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SURFACE_DISPOSE, command);
      },
      async createBrowserSession(command: BrowserSessionCreateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SESSION_CREATE, command);
      },
      async getBrowserSession(command: BrowserSessionGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SESSION_GET, command);
      },
      async closeBrowserSession(command: BrowserSessionCloseCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SESSION_CLOSE, command);
      },
      async openBrowserPage(command: BrowserPageOpenCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PAGE_OPEN, command);
      },
      async listBrowserPages(command?: BrowserPageListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PAGE_LIST, command ?? {});
      },
      async getBrowserPage(command: BrowserPageGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PAGE_GET, command);
      },
      async closeBrowserPage(command: BrowserPageCloseCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PAGE_CLOSE, command);
      },
      async captureBrowserScreenshot(command: BrowserScreenshotCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SCREENSHOT, command);
      },
      async searchWeb(command: ResearchSearchCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_SEARCH, command);
      },
      async openWebResearch(command: ResearchOpenCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_OPEN, command);
      },
      async getResearchStatus() {
        return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_STATUS, {});
      },
      async listDocuments(command: DocumentsListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_LIST, command);
      },
      async getDocument(command: DocumentsGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_GET, command);
      },
      async searchDocuments(command: DocumentsSearchCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_SEARCH, command);
      },
      async ingestDocument(command: DocumentsIngestCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_INGEST, command);
      },
      async deleteDocument(command: DocumentsDeleteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_DELETE, command);
      },
      async listAttachments(command: AttachmentsListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENTS_LIST, command);
      },
      async getAttachment(command: AttachmentsGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENTS_GET, command);
      },
      async uploadAttachment(command: AttachmentsUploadCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENTS_UPLOAD, command);
      },
      async deleteAttachment(command: AttachmentsDeleteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENTS_DELETE, command);
      },
      async previewAttachment(command: AttachmentsPreviewCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENTS_PREVIEW, command);
      },
      async listMcpServers(command: McpServerListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_LIST, command);
      },
      async getMcpServer(command: McpServerGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_GET, command);
      },
      async connectMcpServer(command: McpServerConnectCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_CONNECT, command);
      },
      async disconnectMcpServer(command: McpServerDisconnectCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_DISCONNECT, command);
      },
      async listMcpCapabilities(command: McpCapabilitiesCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_CAPABILITIES, command);
      },
      async listMcpResources(command: McpResourcesCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_RESOURCES, command);
      },
      async readMcpResource(command: McpResourceReadCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_RESOURCE_READ, command);
      },
      async listMcpPrompts(command: McpPromptsCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_PROMPTS, command);
      },
      async getMcpPrompt(command: McpPromptGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_PROMPT_GET, command);
      },
      async subscribeMcp(command: McpSubscribeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_SUBSCRIBE, command);
      },
      async unsubscribeMcp(command: McpUnsubscribeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.MCP_UNSUBSCRIBE, command);
      },
      async getRealtimeCapabilities(command: RealtimeCapabilitiesCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_CAPABILITIES, command);
      },
      async createRealtimeSession(command: RealtimeSessionCreateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SESSION_CREATE, command);
      },
      async startRealtimeSession(command: RealtimeSessionStartCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SESSION_START, command);
      },
      async interruptRealtimeSession(command: RealtimeSessionInterruptCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SESSION_INTERRUPT, command);
      },
      async stopRealtimeSession(command: RealtimeSessionStopCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SESSION_STOP, command);
      },
      async getRealtimeSession(command: RealtimeSessionGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SESSION_GET, command);
      },
      async listRealtimeSessions(command: RealtimeSessionListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SESSION_LIST, command);
      },
      async getRealtimeTranscript(command: RealtimeTranscriptCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_TRANSCRIPT, command);
      },
      async sendRealtimeAudio(command: RealtimeAudioCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.REALTIME_AUDIO, command);
      },
      async listWorkspaceFiles(command: WorkspaceFilesListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FILES_LIST, command);
      },
      async readWorkspaceFile(command: WorkspaceFilesReadCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FILES_READ, command);
      },
      async writeWorkspaceFile(command: WorkspaceFilesWriteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FILES_WRITE, command);
      },
      async createWorkspaceEntry(command: WorkspaceFilesCreateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FILES_CREATE, command);
      },
      async renameWorkspaceEntry(command: WorkspaceFilesRenameCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FILES_RENAME, command);
      },
      async deleteWorkspaceEntry(command: WorkspaceFilesDeleteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FILES_DELETE, command);
      },
      async searchWorkspace(command: WorkspaceSearchCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEARCH, command);
      },
      async reportWorkspaceDiagnostics(command: WorkspaceDiagnosticsReportCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_REPORT, command);
      },
      async listWorkspaceDiagnostics(command: WorkspaceDiagnosticsListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_LIST, command);
      },
      async clearWorkspaceDiagnostics(command: WorkspaceDiagnosticsClearCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DIAGNOSTICS_CLEAR, command);
      },
      async listTerminals(command: TerminalListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST, command);
      },
      async createTerminal(command: TerminalCreateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, command);
      },
      async writeTerminal(command: TerminalWriteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, command);
      },
      async resizeTerminal(command: TerminalResizeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, command);
      },
      async stopTerminal(command: TerminalStopCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_STOP, command);
      },
      async readTerminalOutput(command: TerminalOutputCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_OUTPUT, command);
      },
      async detectGitRepository(command: GitDetectCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_DETECT, command);
      },
      async getGitStatus(command: GitStatusCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, command);
      },
      async getGitDiff(command: GitDiffCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, command);
      },
      async getGitLog(command: GitLogCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_LOG, command);
      },
      async getGitBranches(command: GitBranchesCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCHES, command);
      },
      async stageGitPaths(command: GitStageCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE, command);
      },
      async unstageGitPaths(command: GitUnstageCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE, command);
      },
      async commitGitStaged(command: GitCommitCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, command);
      },
      async listBackgroundTasks(command: BackgroundTasksListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_LIST, command);
      },
      async getBackgroundTask(command: BackgroundTasksGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_GET, command);
      },
      async startBackgroundTask(command: BackgroundTasksStartCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_START, command);
      },
      async pauseBackgroundTask(command: BackgroundTasksPauseCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_PAUSE, command);
      },
      async resumeBackgroundTask(command: BackgroundTasksResumeCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_RESUME, command);
      },
      async cancelBackgroundTask(command: BackgroundTasksCancelCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_CANCEL, command);
      },
      async respondBackgroundTask(command: BackgroundTasksRespondCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_TASKS_RESPOND, command);
      },
    },

    schedules: {
      async list(command: SchedulesListCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_LIST, command);
      },
      async get(command: SchedulesGetCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_GET, command);
      },
      async create(command: SchedulesCreateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_CREATE, command);
      },
      async update(command: SchedulesUpdateCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_UPDATE, command);
      },
      async enable(command: SchedulesEnableCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_ENABLE, command);
      },
      async disable(command: SchedulesDisableCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_DISABLE, command);
      },
      async delete(command: SchedulesDeleteCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_DELETE, command);
      },
      async runNow(command: SchedulesRunNowCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_RUN_NOW, command);
      },
      async runs(command: SchedulesRunsCommand) {
        return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULES_RUNS, command);
      },
    },

    events: {
      async subscribeToConversation(
        conversationId: string,
        listener: (event: AIEvent) => void,
      ): Promise<Unsubscribe> {
        // 1. Tell main process to register this WebContents for conversation events
        await ipcRenderer.invoke(IPC_CHANNELS.CHAT_SUBSCRIBE, { conversationId });

        // 2. Attach batch listener: unpack the batch and deliver each canonical
        //    event individually, preserving batch order.
        const ipcListener = (_event: IpcRendererEvent, batch: ChatStreamBatch) => {
          if (batch.conversationId === conversationId) {
            for (const event of batch.events) {
              listener(event);
            }
          }
        };

        ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_BATCH, ipcListener);

        // 3. Return idempotent unsubscribe function
        let unsubscribed = false;
        return () => {
          if (!unsubscribed) {
            unsubscribed = true;
            ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_BATCH, ipcListener);
            void ipcRenderer.invoke(IPC_CHANNELS.CHAT_UNSUBSCRIBE, { conversationId });
          }
        };
      },
    },
  };
}

export const desktopApi = createDesktopApi();

// Expose safe, narrow application API to the renderer's window object
if (contextBridge && typeof contextBridge.exposeInMainWorld === "function") {
  contextBridge.exposeInMainWorld("api", desktopApi);
}
