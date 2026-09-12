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
  type IpcResponseEnvelope,
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
