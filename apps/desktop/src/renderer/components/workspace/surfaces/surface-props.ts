// PR31.6: renderer — Shared surface prop types
//
// Surfaces receive backend-owned data + existing handlers as props.
// They own no domain behavior: ChatService, AgentService, CodingAgentService,
// IPC, and projections stay the single owners.

import type { ContentPart, Message, ModelDefinition, PermissionRequest } from "@ai-desktop/ai-core";

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

export interface ExtensionsSummary {
  readonly total: number;
  readonly active: number;
}

export interface SidebarProps {
  readonly activeSurface: string;
  readonly activeProjectId: string;
  readonly conversationId: string;
  readonly agentActiveCount: number;
  readonly codingActiveCount: number;
  readonly leftVisible: boolean;
  readonly rightVisible: boolean;
  onSelectSurface(surface: "chat" | "coding" | "tasks" | "activity" | "files" | "extensions"): void;
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
