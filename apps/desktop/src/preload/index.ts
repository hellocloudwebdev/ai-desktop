// PR13: apps/desktop — Preload Typed Application Bridge
//
// Invariants (Step 36):
//   1. Exposes window.api as a typed application bridge.
//   2. Commands use invoke with typed inputs/outputs.
//   3. Subscriptions return an idempotent Unsubscribe function.
//   4. NEVER exposes ipcRenderer, ipcMain, BrowserWindow, app, shell, fs, or process.
//   5. Pure application-owned interface.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  type ChatCancelCommand,
  type ChatSendCommand,
  type ChatStreamEvent,
  type IpcResponseEnvelope,
} from "@ai-desktop/shared";

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
    ): Promise<IpcResponseEnvelope<{ accepted: boolean; messageId?: string }>>;
    cancelChat(command: ChatCancelCommand): Promise<IpcResponseEnvelope<{ cancelled: boolean }>>;
  };

  /**
   * Subscriptions (Main -> Renderer event streams)
   */
  events: {
    subscribeToConversation(
      conversationId: string,
      listener: (event: ChatStreamEvent) => void,
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
    },

    events: {
      async subscribeToConversation(
        conversationId: string,
        listener: (event: ChatStreamEvent) => void,
      ): Promise<Unsubscribe> {
        // 1. Tell main process to register this WebContents for conversation events
        await ipcRenderer.invoke(IPC_CHANNELS.CHAT_SUBSCRIBE, { conversationId });

        // 2. Attach filtered listener
        const ipcListener = (_event: IpcRendererEvent, streamEvent: ChatStreamEvent) => {
          if (streamEvent.conversationId === conversationId) {
            listener(streamEvent);
          }
        };

        ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_EVENT, ipcListener);

        // 3. Return idempotent unsubscribe function
        let unsubscribed = false;
        return () => {
          if (!unsubscribed) {
            unsubscribed = true;
            ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_EVENT, ipcListener);
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
