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
  type IpcResponseEnvelope,
} from "@ai-desktop/shared";
import type { AIEvent, Conversation, ModelDefinition } from "@ai-desktop/ai-core";
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
