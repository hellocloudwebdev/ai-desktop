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

export interface SidebarProps {
  readonly activeSurface: string;
  readonly activeProjectId: string;
  readonly conversationId: string;
  readonly agentActiveCount: number;
  readonly codingActiveCount: number;
  readonly leftVisible: boolean;
  readonly rightVisible: boolean;
  onSelectSurface(surface: "chat" | "coding" | "tasks" | "activity" | "files"): void;
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
