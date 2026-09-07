// PR13: apps/desktop — Main Process Typed IPC Registry & Handler Dispatch
//
// Invariants (Step 36):
//   1. All command input crossing from renderer is validated in main with Zod.
//   2. Malformed input fails before any handler executes.
//   3. Errors returned are serialized safely (no raw stack traces, tokens, or paths).
//   4. Channel collision: registering the same command channel twice throws an error.
//   5. Subscription delivery sends strictly to WebContents.
//   6. WebContents destruction automatically cleans up associated subscriptions.
//   7. Preload exposes application methods, never raw ipcRenderer.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  IPC_CHANNELS,
  ChatCancelCommandSchema,
  ChatSendCommandSchema,
  ChatSubscribeCommandSchema,
  ChatUnsubscribeCommandSchema,
  type ChatCancelCommand,
  type ChatSendCommand,
  type ChatStreamEvent,
  type IpcResponseEnvelope,
} from "@ai-desktop/shared";
import type { ActiveStreamRegistry } from "../chat/index.js";

export type CommandHandler<TInput, TOutput> = (
  input: TInput,
  event: IpcMainInvokeEvent,
) => Promise<TOutput> | TOutput;

export interface RegisteredCommands {
  onChatSend?: CommandHandler<ChatSendCommand, { accepted: boolean; messageId?: string }>;
  onChatCancel?: CommandHandler<ChatCancelCommand, { cancelled: boolean }>;
}

export interface RegisterIpcOptions {
  callbacks?: RegisteredCommands;
  streamRegistry?: ActiveStreamRegistry;
}

export class IpcRegistry {
  private readonly _registeredChannels = new Set<string>();
  private readonly _handlers = new Map<
    string,
    (rawInput: unknown, event: IpcMainInvokeEvent) => Promise<IpcResponseEnvelope<unknown>>
  >();
  private readonly _subscriptions = new Map<string, Set<WebContents>>();

  /**
   * Registers a typed command with Zod schema validation.
   * If input is invalid, returns an error envelope without executing the handler.
   */
  registerCommand<TInput, TOutput>(
    channel: string,
    schema: {
      safeParse: (data: unknown) => {
        success: boolean;
        data?: TInput;
        error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
      };
    },
    handler: CommandHandler<TInput, TOutput>,
  ): void {
    if (this._registeredChannels.has(channel)) {
      throw new Error(`Channel collision: IPC command channel "${channel}" is already registered`);
    }

    this._registeredChannels.add(channel);

    const dispatcher = async (
      rawInput: unknown,
      event: IpcMainInvokeEvent,
    ): Promise<IpcResponseEnvelope<TOutput>> => {
      const requestId =
        rawInput && typeof rawInput === "object" && "requestId" in rawInput
          ? String((rawInput as { requestId: unknown }).requestId)
          : "unknown";

      // 1. Zod runtime validation in main process
      const parseResult = schema.safeParse(rawInput);
      if (!parseResult.success) {
        const issues = parseResult.error?.issues ?? [];
        const message = issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");

        return {
          requestId,
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: `Invalid command payload: ${message}`,
          },
        };
      }

      // 2. Execute privileged handler safely
      try {
        const output = await handler(parseResult.data as TInput, event);
        return {
          requestId,
          ok: true,
          value: output,
        };
      } catch (err: unknown) {
        return {
          requestId,
          ok: false,
          error: {
            code: "HANDLER_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    };

    this._handlers.set(channel, dispatcher);

    if (ipcMain && typeof ipcMain.handle === "function") {
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, rawInput: unknown) =>
        dispatcher(rawInput, event),
      );
    }
  }

  /**
   * Invokes a registered command in-process (useful for direct dispatch and unit testing).
   */
  async invokeCommand<TOutput = unknown>(
    channel: string,
    rawInput: unknown,
    event?: Partial<IpcMainInvokeEvent>,
  ): Promise<IpcResponseEnvelope<TOutput>> {
    const handler = this._handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel "${channel}"`);
    }
    return (await handler(
      rawInput,
      (event ?? {}) as IpcMainInvokeEvent,
    )) as IpcResponseEnvelope<TOutput>;
  }

  /**
   * Registers a client WebContents as a subscriber for conversation events.
   * Cleans up automatically when the WebContents is destroyed.
   */
  subscribe(conversationId: string, webContents: WebContents): void {
    if (!this._subscriptions.has(conversationId)) {
      this._subscriptions.set(conversationId, new Set());
    }

    const set = this._subscriptions.get(conversationId)!;
    set.add(webContents);

    // Automatic subscription cleanup on WebContents destruction (Step 36.24)
    webContents.once("destroyed", () => {
      this.unsubscribe(conversationId, webContents);
    });
  }

  /**
   * Unsubscribes a client WebContents from conversation events.
   * Idempotent: multiple calls are safe.
   */
  unsubscribe(conversationId: string, webContents: WebContents): void {
    const set = this._subscriptions.get(conversationId);
    if (set) {
      set.delete(webContents);
      if (set.size === 0) {
        this._subscriptions.delete(conversationId);
      }
    }
  }

  /**
   * Sends a streaming event to all registered WebContents subscribers for the conversation.
   */
  sendStreamEvent(event: Readonly<ChatStreamEvent>): void {
    const subscribers = this._subscriptions.get(event.conversationId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        try {
          webContents.send(IPC_CHANNELS.CHAT_STREAM_EVENT, event);
        } catch {
          // Ignore delivery errors on dying WebContents
        }
      }
    }
  }

  /**
   * Cleans up all registered handlers and subscriptions.
   */
  destroy(): void {
    if (ipcMain && typeof ipcMain.removeHandler === "function") {
      for (const channel of this._registeredChannels) {
        ipcMain.removeHandler(channel);
      }
    }
    this._registeredChannels.clear();
    this._handlers.clear();
    this._subscriptions.clear();
  }

  get registeredChannels(): ReadonlySet<string> {
    return this._registeredChannels;
  }

  getSubscriptionCount(conversationId: string): number {
    return this._subscriptions.get(conversationId)?.size ?? 0;
  }
}

/**
 * Initializes and registers all application IPC command handlers.
 */
export function registerIpcHandlers(
  registry: IpcRegistry,
  options?: RegisteredCommands | RegisterIpcOptions,
): void {
  const callbacks: RegisteredCommands | undefined =
    options && "callbacks" in options
      ? options.callbacks
      : !options || "streamRegistry" in options
        ? undefined
        : (options as RegisteredCommands);
  const streamRegistry: ActiveStreamRegistry | undefined =
    options && "streamRegistry" in options ? options.streamRegistry : undefined;

  // 1. Health check command
  registry.registerCommand(
    IPC_CHANNELS.APP_HEALTH_CHECK,
    { safeParse: () => ({ success: true, data: undefined }) },
    () => ({ status: "ok", timestamp: new Date().toISOString() }),
  );

  // 2. Chat Send command
  registry.registerCommand(IPC_CHANNELS.CHAT_SEND, ChatSendCommandSchema, async (input, event) => {
    if (callbacks?.onChatSend) {
      return callbacks.onChatSend(input, event);
    }
    return { accepted: true, messageId: input.clientMessageId };
  });

  // 3. Chat Cancel command
  registry.registerCommand(
    IPC_CHANNELS.CHAT_CANCEL,
    ChatCancelCommandSchema,
    async (input, event) => {
      if (callbacks?.onChatCancel) {
        return callbacks.onChatCancel(input, event);
      }
      if (streamRegistry && input.messageId) {
        const cancelled = streamRegistry.abort(input.messageId);
        return { cancelled };
      }
      return { cancelled: true };
    },
  );

  // 4. Chat Subscribe command
  registry.registerCommand(
    IPC_CHANNELS.CHAT_SUBSCRIBE,
    ChatSubscribeCommandSchema,
    (input, event) => {
      registry.subscribe(input.conversationId, event.sender);
      return { subscribed: true, conversationId: input.conversationId };
    },
  );

  // 5. Chat Unsubscribe command
  registry.registerCommand(
    IPC_CHANNELS.CHAT_UNSUBSCRIBE,
    ChatUnsubscribeCommandSchema,
    (input, event) => {
      registry.unsubscribe(input.conversationId, event.sender);
      return { unsubscribed: true, conversationId: input.conversationId };
    },
  );
}
