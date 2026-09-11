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
  ConversationLoadCommandSchema,
  ProviderProfilesListCommandSchema,
  ProviderProfileCreateCommandSchema,
  ProviderProfileUpdateCommandSchema,
  ProviderProfileDeleteCommandSchema,
  ProviderModelsListCommandSchema,
  ConversationModelSetCommandSchema,
  ConversationModelGetCommandSchema,
  PermissionCheckCommandSchema,
  PermissionRequestsListCommandSchema,
  PermissionResolveCommandSchema,
  PermissionRevokeCommandSchema,
  PermissionPoliciesListCommandSchema,
  type ChatCancelCommand,
  type ChatSendCommand,
  type ChatStreamEvent,
  type ConversationLoadCommand,
  type ProviderProfilesListCommand,
  type ProviderProfileCreateCommand,
  type ProviderProfileUpdateCommand,
  type ProviderProfileDeleteCommand,
  type ProviderModelsListCommand,
  type ConversationModelSetCommand,
  type ConversationModelGetCommand,
  type PermissionCheckCommand,
  type PermissionRequestsListCommand,
  type PermissionResolveCommand,
  type PermissionRevokeCommand,
  type PermissionPoliciesListCommand,
  type IpcResponseEnvelope,
} from "@ai-desktop/shared";
import { asModelId, asProviderId, type AIEvent } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { ActiveStreamRegistry, ChatService, ModelSelectionService } from "../chat/index.js";
import type { IpcBatcher } from "./batcher.js";

export type CommandHandler<TInput, TOutput> = (
  input: TInput,
  event: IpcMainInvokeEvent,
) => Promise<TOutput> | TOutput;

export interface RegisteredCommands {
  onChatSend?: CommandHandler<
    ChatSendCommand,
    { accepted: boolean; messageId?: string; conversationId?: string }
  >;
  onChatCancel?: CommandHandler<ChatCancelCommand, { cancelled: boolean }>;
  onConversationLoad?: CommandHandler<ConversationLoadCommand, { conversation: unknown }>;
  onProviderProfilesList?: CommandHandler<ProviderProfilesListCommand, { profiles: unknown[] }>;
  onProviderProfileCreate?: CommandHandler<ProviderProfileCreateCommand, { profile: unknown }>;
  onProviderProfileUpdate?: CommandHandler<ProviderProfileUpdateCommand, { profile: unknown }>;
  onProviderProfileDelete?: CommandHandler<
    ProviderProfileDeleteCommand,
    { deleted: boolean; id: string }
  >;
  onProviderModelsList?: CommandHandler<ProviderModelsListCommand, { models: unknown[] }>;
  onConversationModelSet?: CommandHandler<ConversationModelSetCommand, { modelSelection: unknown }>;
  onConversationModelGet?: CommandHandler<ConversationModelGetCommand, { modelSelection: unknown }>;
  onPermissionCheck?: CommandHandler<PermissionCheckCommand, { result: unknown }>;
  onPermissionRequestsList?: CommandHandler<PermissionRequestsListCommand, { requests: unknown[] }>;
  onPermissionResolve?: CommandHandler<PermissionResolveCommand, { resolved: boolean }>;
  onPermissionRevoke?: CommandHandler<PermissionRevokeCommand, { revokedCount: number }>;
  onPermissionPoliciesList?: CommandHandler<PermissionPoliciesListCommand, { policies: unknown[] }>;
}

export interface RegisterIpcOptions {
  callbacks?: RegisteredCommands;
  streamRegistry?: ActiveStreamRegistry;
  batcher?: IpcBatcher;
  chatService?: ChatService;
  modelSelectionService?: ModelSelectionService;
  permissionManager?: PermissionManager;
}

export class IpcRegistry {
  private readonly _registeredChannels = new Set<string>();
  private readonly _handlers = new Map<
    string,
    (rawInput: unknown, event: IpcMainInvokeEvent) => Promise<IpcResponseEnvelope<unknown>>
  >();
  private readonly _subscriptions = new Map<string, Set<WebContents>>();
  private _batcher: IpcBatcher | null = null;

  /**
   * Attaches the IPC event batcher (PR15). Once attached, `publishEvent`
   * routes canonical AIEvents through batched renderer delivery, and
   * `destroy()` tears the batcher down with the registry.
   */
  attachBatcher(batcher: IpcBatcher): void {
    this._batcher = batcher;
  }

  get batcher(): IpcBatcher | null {
    return this._batcher;
  }

  /**
   * Canonical event publication path: enqueues an AIEvent for batched delivery
   * to subscribed renderers (~32 ms window, terminal events flush immediately).
   */
  publishEvent(event: Readonly<AIEvent>): void {
    this._batcher?.enqueue(event);
  }

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
   * Cleans up all registered handlers, subscriptions, and the attached batcher.
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
    this._batcher?.destroy();
    this._batcher = null;
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
  const batcher: IpcBatcher | undefined =
    options && "batcher" in options ? options.batcher : undefined;
  const chatService: ChatService | undefined =
    options && "chatService" in options ? options.chatService : undefined;
  const modelSelectionService: ModelSelectionService | undefined =
    options && "modelSelectionService" in options
      ? options.modelSelectionService
      : chatService?.modelSelectionService;
  const permissionManager: PermissionManager | undefined =
    options && "permissionManager" in options ? options.permissionManager : undefined;
  if (batcher) {
    registry.attachBatcher(batcher);
  }

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
    if (chatService) {
      const res = await chatService.sendMessage({
        conversationId: input.conversationId,
        content: input.content,
        clientMessageId: input.clientMessageId,
        modelId: input.modelId,
      });
      return {
        accepted: true,
        messageId: res.assistantMessageId,
        conversationId: res.conversationId,
      };
    }
    return {
      accepted: true,
      messageId: input.clientMessageId,
      conversationId: input.conversationId,
    };
  });

  // 3. Chat Cancel command
  registry.registerCommand(
    IPC_CHANNELS.CHAT_CANCEL,
    ChatCancelCommandSchema,
    async (input, event) => {
      if (callbacks?.onChatCancel) {
        return callbacks.onChatCancel(input, event);
      }
      if (chatService && input.messageId) {
        const cancelled = chatService.cancel(input.messageId);
        return { cancelled };
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
      batcher?.subscribe(input.conversationId, event.sender);
      return { subscribed: true, conversationId: input.conversationId };
    },
  );

  // 5. Chat Unsubscribe command
  registry.registerCommand(
    IPC_CHANNELS.CHAT_UNSUBSCRIBE,
    ChatUnsubscribeCommandSchema,
    (input, event) => {
      registry.unsubscribe(input.conversationId, event.sender);
      batcher?.unsubscribe(input.conversationId, event.sender);
      return { unsubscribed: true, conversationId: input.conversationId };
    },
  );

  // 6. Conversation Load command (§39.37, §39.38)
  registry.registerCommand(
    IPC_CHANNELS.CONVERSATION_LOAD,
    ConversationLoadCommandSchema,
    async (input, event) => {
      if (callbacks?.onConversationLoad) {
        return callbacks.onConversationLoad(input, event);
      }
      if (chatService) {
        const conv = await chatService.getConversation(input.conversationId);
        return { conversation: conv };
      }
      return {
        conversation: {
          id: input.conversationId,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          lastSequence: 0,
        },
      };
    },
  );

  // 7. Provider Profiles List command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.PROVIDER_PROFILES_LIST,
    ProviderProfilesListCommandSchema,
    async (input, event) => {
      if (callbacks?.onProviderProfilesList) {
        return callbacks.onProviderProfilesList(input, event);
      }
      if (modelSelectionService) {
        const profiles = await modelSelectionService.listProfiles();
        return { profiles };
      }
      return { profiles: [] };
    },
  );

  // 8. Provider Profile Create command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.PROVIDER_PROFILE_CREATE,
    ProviderProfileCreateCommandSchema,
    async (input, event) => {
      if (callbacks?.onProviderProfileCreate) {
        return callbacks.onProviderProfileCreate(input, event);
      }
      if (modelSelectionService) {
        const profile = await modelSelectionService.createProfile({
          providerId: asProviderId(input.providerId),
          name: input.name,
          credentialRef: input.credentialRef,
          endpointUrl: input.endpointUrl,
          organizationId: input.organizationId,
          defaultModelId: input.defaultModelId ? asModelId(input.defaultModelId) : undefined,
          enabled: input.enabled,
        });
        return { profile };
      }
      throw new Error("ModelSelectionService is not available");
    },
  );

  // 9. Provider Profile Update command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.PROVIDER_PROFILE_UPDATE,
    ProviderProfileUpdateCommandSchema,
    async (input, event) => {
      if (callbacks?.onProviderProfileUpdate) {
        return callbacks.onProviderProfileUpdate(input, event);
      }
      if (modelSelectionService) {
        const profile = await modelSelectionService.updateProfile(input.id, {
          name: input.name,
          credentialRef: input.credentialRef,
          endpointUrl: input.endpointUrl,
          organizationId: input.organizationId,
          defaultModelId: input.defaultModelId ? asModelId(input.defaultModelId) : undefined,
          enabled: input.enabled,
          updatedAt: Date.now(),
        });
        return { profile };
      }
      throw new Error("ModelSelectionService is not available");
    },
  );

  // 10. Provider Profile Delete command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.PROVIDER_PROFILE_DELETE,
    ProviderProfileDeleteCommandSchema,
    async (input, event) => {
      if (callbacks?.onProviderProfileDelete) {
        return callbacks.onProviderProfileDelete(input, event);
      }
      if (modelSelectionService) {
        await modelSelectionService.deleteProfile(input.id);
        return { deleted: true, id: input.id };
      }
      return { deleted: true, id: input.id };
    },
  );

  // 11. Provider Models List command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.PROVIDER_MODELS_LIST,
    ProviderModelsListCommandSchema,
    async (input, event) => {
      if (callbacks?.onProviderModelsList) {
        return callbacks.onProviderModelsList(input, event);
      }
      if (modelSelectionService) {
        const models = modelSelectionService.listAvailableModels();
        return { models };
      }
      return { models: [] };
    },
  );

  // 12. Conversation Model Set command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.CONVERSATION_MODEL_SET,
    ConversationModelSetCommandSchema,
    async (input, event) => {
      if (callbacks?.onConversationModelSet) {
        return callbacks.onConversationModelSet(input, event);
      }
      if (modelSelectionService) {
        const modelSelection = await modelSelectionService.setConversationModel(
          input.conversationId,
          {
            providerId: asProviderId(input.providerId),
            modelId: asModelId(input.modelId),
          },
          input.profileId,
        );
        return { modelSelection };
      }
      throw new Error("ModelSelectionService is not available");
    },
  );

  // 13. Conversation Model Get command (PR22)
  registry.registerCommand(
    IPC_CHANNELS.CONVERSATION_MODEL_GET,
    ConversationModelGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onConversationModelGet) {
        return callbacks.onConversationModelGet(input, event);
      }
      if (modelSelectionService) {
        const modelSelection = await modelSelectionService.getConversationModel(
          input.conversationId,
        );
        return { modelSelection };
      }
      return { modelSelection: null };
    },
  );

  // 14. Permission Check command (PR24)
  registry.registerCommand(
    IPC_CHANNELS.PERMISSION_CHECK,
    PermissionCheckCommandSchema,
    async (input, event) => {
      if (callbacks?.onPermissionCheck) {
        return callbacks.onPermissionCheck(input, event);
      }
      if (permissionManager) {
        const result = await permissionManager.check(
          {
            capability: input.capability,
            action: input.action,
            resource: input.resource,
            scope: input.scope,
            risk: input.risk,
            relatedToolCallIds: input.relatedToolCallIds,
            reason: input.reason,
          },
          {
            projectId: input.projectId,
            conversationId: input.conversationId,
            batchId: input.batchId,
          },
        );
        return { result };
      }
      return { result: { kind: "allow" } };
    },
  );

  // 15. Permission Requests List command (PR24)
  registry.registerCommand(
    IPC_CHANNELS.PERMISSION_REQUESTS_LIST,
    PermissionRequestsListCommandSchema,
    async (input, event) => {
      if (callbacks?.onPermissionRequestsList) {
        return callbacks.onPermissionRequestsList(input, event);
      }
      if (permissionManager) {
        const requests = permissionManager.listPendingRequests();
        return { requests: [...requests] };
      }
      return { requests: [] };
    },
  );

  // 16. Permission Resolve command (PR24)
  registry.registerCommand(
    IPC_CHANNELS.PERMISSION_RESOLVE,
    PermissionResolveCommandSchema,
    async (input, event) => {
      if (callbacks?.onPermissionResolve) {
        return callbacks.onPermissionResolve(input, event);
      }
      if (permissionManager) {
        const resolved = await permissionManager.resolve({
          requestId: input.requestId,
          decision: input.decision,
          mode: input.mode,
          reason: input.reason,
        });
        return { resolved };
      }
      throw new Error("PermissionManager is not available");
    },
  );

  // 17. Permission Revoke command (PR24)
  registry.registerCommand(
    IPC_CHANNELS.PERMISSION_REVOKE,
    PermissionRevokeCommandSchema,
    async (input, event) => {
      if (callbacks?.onPermissionRevoke) {
        return callbacks.onPermissionRevoke(input, event);
      }
      if (permissionManager) {
        const revokedCount = await permissionManager.revoke({
          capability: input.capability,
          projectId: input.projectId,
          resourcePattern: input.resourcePattern,
          scope: input.scope,
        });
        return { revokedCount };
      }
      return { revokedCount: 0 };
    },
  );

  // 18. Permission Policies List command (PR24)
  registry.registerCommand(
    IPC_CHANNELS.PERMISSION_POLICIES_LIST,
    PermissionPoliciesListCommandSchema,
    async (input, event) => {
      if (callbacks?.onPermissionPoliciesList) {
        return callbacks.onPermissionPoliciesList(input, event);
      }
      if (permissionManager) {
        const policies = await permissionManager.listActivePolicies(input.projectId);
        return { policies: [...policies] };
      }
      return { policies: [] };
    },
  );
}
