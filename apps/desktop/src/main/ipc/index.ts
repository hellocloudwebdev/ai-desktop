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
  SkillsListCommandSchema,
  SkillsInstallCommandSchema,
  SkillsUninstallCommandSchema,
  SkillsEnableCommandSchema,
  SkillsDisableCommandSchema,
  SkillsGetCommandSchema,
  SkillsReferencesLoadCommandSchema,
  MemoryListCommandSchema,
  MemoryGetCommandSchema,
  MemoryUpdateCommandSchema,
  MemoryDeleteCommandSchema,
  MemorySearchCommandSchema,
  MemorySupersedeCommandSchema,
  AgentStartCommandSchema,
  AgentCancelCommandSchema,
  AgentGetCommandSchema,
  AgentListCommandSchema,
  CodingStartCommandSchema,
  CodingCancelCommandSchema,
  CodingGetCommandSchema,
  CodingListCommandSchema,
  ExtensionListCommandSchema,
  ExtensionGetCommandSchema,
  ExtensionInstallCommandSchema,
  ExtensionUninstallCommandSchema,
  ExtensionEnableCommandSchema,
  ExtensionDisableCommandSchema,
  ExtensionProjectEnableCommandSchema,
  ExtensionProjectDisableCommandSchema,
  SurfaceGetCommandSchema,
  SurfaceActionCommandSchema,
  SurfaceDisposeCommandSchema,
  SurfaceListCommandSchema,
  BrowserSessionCreateCommandSchema,
  BrowserSessionGetCommandSchema,
  BrowserSessionCloseCommandSchema,
  BrowserPageOpenCommandSchema,
  BrowserPageListCommandSchema,
  BrowserPageGetCommandSchema,
  BrowserPageCloseCommandSchema,
  BrowserScreenshotCommandSchema,
  ResearchOpenCommandSchema,
  ResearchSearchCommandSchema,
  ResearchStatusCommandSchema,
  createToolCallId,
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
  type ExtensionProjectEnableCommand,
  type ExtensionProjectDisableCommand,
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
  type ResearchStatusCommand,
} from "@ai-desktop/shared";
import {
  asModelId,
  asProviderId,
  asSkillId,
  asMemoryFactId,
  type AIEvent,
} from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { SkillInstaller, SkillManager } from "@ai-desktop/skills";
import type { MemoryService } from "@ai-desktop/memory";
import type { AgentService } from "../agent/index.js";
import type { CodingAgentService } from "../agent/index.js";
import type { ExtensionService } from "../extensions/index.js";
import type { SurfaceService } from "../surfaces/surface-service.js";
import type { BrowserService } from "../browser/index.js";
import type { ResearchService } from "../research/index.js";
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
  onSkillsList?: CommandHandler<SkillsListCommand, { skills: unknown[] }>;
  onSkillsInstall?: CommandHandler<SkillsInstallCommand, { skill: unknown }>;
  onSkillsUninstall?: CommandHandler<SkillsUninstallCommand, { uninstalled: boolean }>;
  onSkillsEnable?: CommandHandler<SkillsEnableCommand, { enabled: boolean }>;
  onSkillsDisable?: CommandHandler<SkillsDisableCommand, { disabled: boolean }>;
  onSkillsGet?: CommandHandler<SkillsGetCommand, { skill: unknown }>;
  onSkillsReferencesLoad?: CommandHandler<SkillsReferencesLoadCommand, { content: string }>;
  onMemoryList?: CommandHandler<MemoryListCommand, { facts: unknown[] }>;
  onMemoryGet?: CommandHandler<MemoryGetCommand, { fact: unknown }>;
  onMemoryUpdate?: CommandHandler<MemoryUpdateCommand, { fact: unknown }>;
  onMemoryDelete?: CommandHandler<MemoryDeleteCommand, { deleted: boolean }>;
  onMemorySearch?: CommandHandler<MemorySearchCommand, { facts: unknown[] }>;
  onMemorySupersede?: CommandHandler<MemorySupersedeCommand, { fact: unknown }>;
  onAgentStart?: CommandHandler<AgentStartCommand, { result: unknown }>;
  onAgentCancel?: CommandHandler<AgentCancelCommand, { cancelled: boolean }>;
  onAgentGet?: CommandHandler<AgentGetCommand, { task: unknown }>;
  onAgentList?: CommandHandler<AgentListCommand, { taskIds: string[] }>;
  onCodingStart?: CommandHandler<CodingStartCommand, { outcome: unknown }>;
  onCodingCancel?: CommandHandler<CodingCancelCommand, { cancelled: boolean }>;
  onCodingGet?: CommandHandler<CodingGetCommand, { task: unknown }>;
  onCodingList?: CommandHandler<CodingListCommand, { taskIds: string[] }>;
  onExtensionList?: CommandHandler<ExtensionListCommand, { extensions: unknown[] }>;
  onExtensionGet?: CommandHandler<ExtensionGetCommand, { extension: unknown }>;
  onExtensionInstall?: CommandHandler<ExtensionInstallCommand, { extension: unknown }>;
  onExtensionUninstall?: CommandHandler<ExtensionUninstallCommand, { uninstalled: boolean }>;
  onExtensionEnable?: CommandHandler<ExtensionEnableCommand, { extension: unknown }>;
  onExtensionDisable?: CommandHandler<ExtensionDisableCommand, { extension: unknown }>;
  onExtensionProjectEnable?: CommandHandler<ExtensionProjectEnableCommand, { extension: unknown }>;
  onExtensionProjectDisable?: CommandHandler<
    ExtensionProjectDisableCommand,
    { extension: unknown }
  >;
  onSurfaceGet?: CommandHandler<SurfaceGetCommand, { surface: unknown }>;
  onSurfaceAction?: CommandHandler<SurfaceActionCommand, { result: unknown }>;
  onSurfaceDispose?: CommandHandler<SurfaceDisposeCommand, { disposed: boolean }>;
  onSurfaceList?: CommandHandler<SurfaceListCommand, { surfaces: unknown[] }>;
  onBrowserSessionCreate?: CommandHandler<BrowserSessionCreateCommand, { session: unknown }>;
  onBrowserSessionGet?: CommandHandler<BrowserSessionGetCommand, { session: unknown }>;
  onBrowserSessionClose?: CommandHandler<BrowserSessionCloseCommand, { closed: boolean }>;
  onBrowserPageOpen?: CommandHandler<BrowserPageOpenCommand, { page: unknown }>;
  onBrowserPageList?: CommandHandler<BrowserPageListCommand, { pages: unknown[] }>;
  onBrowserPageGet?: CommandHandler<BrowserPageGetCommand, { page: unknown }>;
  onBrowserPageClose?: CommandHandler<BrowserPageCloseCommand, { closed: boolean }>;
  onBrowserScreenshot?: CommandHandler<BrowserScreenshotCommand, { screenshot: unknown }>;
  onResearchSearch?: CommandHandler<ResearchSearchCommand, { results: unknown[] }>;
  onResearchOpen?: CommandHandler<ResearchOpenCommand, { result: unknown }>;
  onResearchStatus?: CommandHandler<ResearchStatusCommand, { providers: unknown[] }>;
}

export interface RegisterIpcOptions {
  callbacks?: RegisteredCommands;
  streamRegistry?: ActiveStreamRegistry;
  batcher?: IpcBatcher;
  chatService?: ChatService;
  modelSelectionService?: ModelSelectionService;
  permissionManager?: PermissionManager;
  skillManager?: SkillManager;
  skillInstaller?: SkillInstaller;
  memoryService?: MemoryService;
  agentService?: AgentService;
  codingAgentService?: CodingAgentService;
  extensionService?: ExtensionService;
  surfaceService?: SurfaceService;
  browserService?: BrowserService;
  researchService?: ResearchService;
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
  const skillManager: SkillManager | undefined =
    options && "skillManager" in options ? options.skillManager : undefined;
  const skillInstaller: SkillInstaller | undefined =
    options && "skillInstaller" in options ? options.skillInstaller : undefined;
  const memoryService: MemoryService | undefined =
    options && "memoryService" in options ? options.memoryService : undefined;
  const agentService: AgentService | undefined =
    options && "agentService" in options ? options.agentService : undefined;
  const codingAgentService: CodingAgentService | undefined =
    options && "codingAgentService" in options ? options.codingAgentService : undefined;
  const extensionService: ExtensionService | undefined =
    options && "extensionService" in options ? options.extensionService : undefined;
  const surfaceService: SurfaceService | undefined =
    options && "surfaceService" in options ? options.surfaceService : undefined;
  const browserService: BrowserService | undefined =
    options && "browserService" in options ? options.browserService : undefined;
  const researchService: ResearchService | undefined =
    options && "researchService" in options ? options.researchService : undefined;
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

  // 19. Skills List command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_LIST,
    SkillsListCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsList) {
        return callbacks.onSkillsList(input, event);
      }
      if (skillManager) {
        const skills = await skillManager.listSkills(input.projectId);
        return { skills: [...skills] };
      }
      return { skills: [] };
    },
  );

  // 20. Skills Install command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_INSTALL,
    SkillsInstallCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsInstall) {
        return callbacks.onSkillsInstall(input, event);
      }
      if (skillInstaller) {
        const res = await skillInstaller.install(input.sourceDir, { projectId: input.projectId });
        if (!res.ok) {
          throw res.error;
        }
        return { skill: res.value };
      }
      throw new Error("SkillInstaller is not available");
    },
  );

  // 21. Skills Uninstall command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_UNINSTALL,
    SkillsUninstallCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsUninstall) {
        return callbacks.onSkillsUninstall(input, event);
      }
      if (skillInstaller) {
        await skillInstaller.uninstall(asSkillId(input.skillId));
        return { uninstalled: true };
      }
      return { uninstalled: true };
    },
  );

  // 22. Skills Enable command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_ENABLE,
    SkillsEnableCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsEnable) {
        return callbacks.onSkillsEnable(input, event);
      }
      if (skillManager) {
        await skillManager.enable(asSkillId(input.skillId), input.projectId);
        return { enabled: true };
      }
      throw new Error("SkillManager is not available");
    },
  );

  // 23. Skills Disable command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_DISABLE,
    SkillsDisableCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsDisable) {
        return callbacks.onSkillsDisable(input, event);
      }
      if (skillManager) {
        await skillManager.disable(asSkillId(input.skillId), input.projectId);
        return { disabled: true };
      }
      throw new Error("SkillManager is not available");
    },
  );

  // 24. Skills Get command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_GET,
    SkillsGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsGet) {
        return callbacks.onSkillsGet(input, event);
      }
      if (skillManager) {
        const skill = await skillManager.getSkillInfo(asSkillId(input.skillId));
        return { skill: skill ?? null };
      }
      return { skill: null };
    },
  );

  // 25. Skills References Load command (PR26)
  registry.registerCommand(
    IPC_CHANNELS.SKILLS_REFERENCES_LOAD,
    SkillsReferencesLoadCommandSchema,
    async (input, event) => {
      if (callbacks?.onSkillsReferencesLoad) {
        return callbacks.onSkillsReferencesLoad(input, event);
      }
      if (skillManager) {
        const content = await skillManager.loadReference(
          asSkillId(input.skillId),
          input.relativePath,
        );
        return { content };
      }
      throw new Error("SkillManager is not available");
    },
  );

  // 26. Memory List command (PR28)
  registry.registerCommand(
    IPC_CHANNELS.MEMORY_LIST,
    MemoryListCommandSchema,
    async (input, event) => {
      if (callbacks?.onMemoryList) {
        return callbacks.onMemoryList(input, event);
      }
      if (memoryService) {
        const facts = await memoryService.searchMemories({
          projectId: input.projectId,
          category: input.category,
          includeSuperseded: input.includeSuperseded,
        });
        return { facts: [...facts] };
      }
      return { facts: [] };
    },
  );

  // 27. Memory Get command (PR28)
  registry.registerCommand(
    IPC_CHANNELS.MEMORY_GET,
    MemoryGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onMemoryGet) {
        return callbacks.onMemoryGet(input, event);
      }
      if (memoryService) {
        const fact = await memoryService.getFactById(asMemoryFactId(input.id));
        return { fact: fact ?? null };
      }
      return { fact: null };
    },
  );

  // 28. Memory Update command (PR28)
  registry.registerCommand(
    IPC_CHANNELS.MEMORY_UPDATE,
    MemoryUpdateCommandSchema,
    async (input, event) => {
      if (callbacks?.onMemoryUpdate) {
        return callbacks.onMemoryUpdate(input, event);
      }
      if (memoryService) {
        const fact = await memoryService.updateFact(asMemoryFactId(input.id), {
          content: input.content,
          category: input.category,
          sensitivity: input.sensitivity,
          confidence: input.confidence,
        });
        return { fact };
      }
      throw new Error("MemoryService is not available");
    },
  );

  // 29. Memory Delete command (PR28)
  registry.registerCommand(
    IPC_CHANNELS.MEMORY_DELETE,
    MemoryDeleteCommandSchema,
    async (input, event) => {
      if (callbacks?.onMemoryDelete) {
        return callbacks.onMemoryDelete(input, event);
      }
      if (memoryService) {
        await memoryService.deleteFact(asMemoryFactId(input.id));
        return { deleted: true };
      }
      return { deleted: true };
    },
  );

  // 30. Memory Search command (PR28)
  registry.registerCommand(
    IPC_CHANNELS.MEMORY_SEARCH,
    MemorySearchCommandSchema,
    async (input, event) => {
      if (callbacks?.onMemorySearch) {
        return callbacks.onMemorySearch(input, event);
      }
      if (memoryService) {
        const facts = await memoryService.searchMemories({
          projectId: input.projectId,
          query: input.query,
          category: input.category,
          limit: input.limit,
        });
        return { facts: [...facts] };
      }
      return { facts: [] };
    },
  );

  // 31. Memory Supersede command (PR28)
  registry.registerCommand(
    IPC_CHANNELS.MEMORY_SUPERSEDE,
    MemorySupersedeCommandSchema,
    async (input, event) => {
      if (callbacks?.onMemorySupersede) {
        return callbacks.onMemorySupersede(input, event);
      }
      if (memoryService) {
        const fact = await memoryService.supersedeFact(
          asMemoryFactId(input.id),
          asMemoryFactId(input.supersededBy),
        );
        return { fact };
      }
      throw new Error("MemoryService is not available");
    },
  );

  // 32. Agent Start command (PR29): runs a task to a single terminal state.
  // Task.* events flow through EventBus -> batched renderer delivery + storage.
  registry.registerCommand(
    IPC_CHANNELS.AGENT_START,
    AgentStartCommandSchema,
    async (input, event) => {
      if (callbacks?.onAgentStart) {
        return callbacks.onAgentStart(input, event);
      }
      if (agentService) {
        const result = await agentService.startTask({
          conversationId: input.conversationId,
          goal: input.goal,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.maxNodeIterations ? { maxNodeIterations: input.maxNodeIterations } : {}),
        });
        return { result };
      }
      throw new Error("AgentService is not available");
    },
  );

  // 33. Agent Cancel command (PR29): downward-only cancellation.
  registry.registerCommand(
    IPC_CHANNELS.AGENT_CANCEL,
    AgentCancelCommandSchema,
    async (input, event) => {
      if (callbacks?.onAgentCancel) {
        return callbacks.onAgentCancel(input, event);
      }
      if (agentService) {
        const cancelled = agentService.cancelTask(input.taskId, input.reason);
        return { cancelled };
      }
      throw new Error("AgentService is not available");
    },
  );

  // 34. Agent Get command (PR29): status snapshot + node checklist.
  registry.registerCommand(IPC_CHANNELS.AGENT_GET, AgentGetCommandSchema, async (input, event) => {
    if (callbacks?.onAgentGet) {
      return callbacks.onAgentGet(input, event);
    }
    if (agentService) {
      const status = agentService.getTaskStatus(input.taskId);
      if (status === undefined) {
        throw new Error(`Unknown agent task "${input.taskId}"`);
      }
      return {
        task: {
          taskId: input.taskId,
          status,
          graph: agentService.getTaskGraph(input.taskId) ?? null,
        },
      };
    }
    throw new Error("AgentService is not available");
  });

  // 35. Agent List command (PR29): known in-process task ids.
  registry.registerCommand(
    IPC_CHANNELS.AGENT_LIST,
    AgentListCommandSchema,
    async (input, event) => {
      if (callbacks?.onAgentList) {
        return callbacks.onAgentList(input, event);
      }
      if (agentService) {
        return { taskIds: agentService.listTasks() };
      }
      throw new Error("AgentService is not available");
    },
  );

  // 36. Coding Start command (PR30): workspace-bound project-scoped coding task.
  registry.registerCommand(
    IPC_CHANNELS.CODING_START,
    CodingStartCommandSchema,
    async (input, event) => {
      if (callbacks?.onCodingStart) {
        return callbacks.onCodingStart(input, event);
      }
      if (codingAgentService) {
        const outcome = await codingAgentService.startCodingTask({
          projectId: input.projectId,
          ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          prompt: input.prompt,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.maxNodeIterations ? { maxNodeIterations: input.maxNodeIterations } : {}),
        });
        return { outcome };
      }
      throw new Error("CodingAgentService is not available");
    },
  );

  // 37. Coding Cancel command (PR30): downward-only cancellation.
  registry.registerCommand(
    IPC_CHANNELS.CODING_CANCEL,
    CodingCancelCommandSchema,
    async (input, event) => {
      if (callbacks?.onCodingCancel) {
        return callbacks.onCodingCancel(input, event);
      }
      if (codingAgentService) {
        const cancelled = codingAgentService.cancelCodingTask(input.taskId, input.reason);
        return { cancelled };
      }
      throw new Error("CodingAgentService is not available");
    },
  );

  // 38. Coding Get command (PR30): status snapshot + node checklist.
  registry.registerCommand(
    IPC_CHANNELS.CODING_GET,
    CodingGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onCodingGet) {
        return callbacks.onCodingGet(input, event);
      }
      if (codingAgentService) {
        const status = codingAgentService.getCodingTaskStatus(input.taskId);
        if (status === undefined) {
          throw new Error(`Unknown coding task "${input.taskId}"`);
        }
        return {
          task: {
            taskId: input.taskId,
            status,
            graph: codingAgentService.getCodingTaskGraph(input.taskId) ?? null,
          },
        };
      }
      throw new Error("CodingAgentService is not available");
    },
  );

  // 39. Coding List command (PR30): known in-process coding task ids.
  registry.registerCommand(
    IPC_CHANNELS.CODING_LIST,
    CodingListCommandSchema,
    async (input, event) => {
      if (callbacks?.onCodingList) {
        return callbacks.onCodingList(input, event);
      }
      if (codingAgentService) {
        return { taskIds: codingAgentService.listCodingTasks() };
      }
      throw new Error("CodingAgentService is not available");
    },
  );

  // 40. Extension List command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_LIST,
    ExtensionListCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionList) {
        return callbacks.onExtensionList(input, event);
      }
      if (extensionService) {
        const extensions = await extensionService.listExtensions(input.projectId);
        return { extensions: [...extensions] };
      }
      return { extensions: [] };
    },
  );

  // 41. Extension Get command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_GET,
    ExtensionGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionGet) {
        return callbacks.onExtensionGet(input, event);
      }
      if (extensionService) {
        const extension = await extensionService.getExtension(input.extensionId);
        return { extension: extension ?? null };
      }
      return { extension: null };
    },
  );

  // 42. Extension Install command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_INSTALL,
    ExtensionInstallCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionInstall) {
        return callbacks.onExtensionInstall(input, event);
      }
      if (extensionService) {
        const extension = await extensionService.installExtension(input.sourceDir, {
          ...(input.projectId ? { projectId: input.projectId } : {}),
        });
        return { extension };
      }
      throw new Error("ExtensionService is not available");
    },
  );

  // 43. Extension Uninstall command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_UNINSTALL,
    ExtensionUninstallCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionUninstall) {
        return callbacks.onExtensionUninstall(input, event);
      }
      if (extensionService) {
        await extensionService.uninstallExtension(input.extensionId);
        return { uninstalled: true };
      }
      return { uninstalled: true };
    },
  );

  // 44. Extension Enable command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_ENABLE,
    ExtensionEnableCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionEnable) {
        return callbacks.onExtensionEnable(input, event);
      }
      if (extensionService) {
        const extension = await extensionService.enableExtension(input.extensionId);
        return { extension };
      }
      throw new Error("ExtensionService is not available");
    },
  );

  // 45. Extension Disable command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_DISABLE,
    ExtensionDisableCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionDisable) {
        return callbacks.onExtensionDisable(input, event);
      }
      if (extensionService) {
        const extension = await extensionService.disableExtension(input.extensionId);
        return { extension };
      }
      throw new Error("ExtensionService is not available");
    },
  );

  // 46. Extension Project Enable command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_PROJECT_ENABLE,
    ExtensionProjectEnableCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionProjectEnable) {
        return callbacks.onExtensionProjectEnable(input, event);
      }
      if (extensionService) {
        const extension = await extensionService.setProjectEnabled(
          input.extensionId,
          input.projectId,
          true,
        );
        return { extension };
      }
      throw new Error("ExtensionService is not available");
    },
  );

  // 47. Extension Project Disable command (PR32)
  registry.registerCommand(
    IPC_CHANNELS.EXTENSION_PROJECT_DISABLE,
    ExtensionProjectDisableCommandSchema,
    async (input, event) => {
      if (callbacks?.onExtensionProjectDisable) {
        return callbacks.onExtensionProjectDisable(input, event);
      }
      if (extensionService) {
        const extension = await extensionService.setProjectEnabled(
          input.extensionId,
          input.projectId,
          false,
        );
        return { extension };
      }
      throw new Error("ExtensionService is not available");
    },
  );

  // 48. Surface List command (PR33): scoped instance snapshots for the
  // workspace host. Project filter is optional; unscoped callers see only
  // unscoped instances (registry is already per-task capped).
  registry.registerCommand(
    IPC_CHANNELS.SURFACE_LIST,
    SurfaceListCommandSchema,
    async (input, event) => {
      if (callbacks?.onSurfaceList) {
        return callbacks.onSurfaceList(input, event);
      }
      if (surfaceService) {
        const surfaces = input.projectId
          ? surfaceService.listByProject(input.projectId)
          : surfaceService.listAll();
        return { surfaces };
      }
      throw new Error("SurfaceService is not available");
    },
  );

  // 49. Surface Get command (PR33): instance snapshot; unknown ids return
  // null (renderer polls) rather than throwing.
  registry.registerCommand(
    IPC_CHANNELS.SURFACE_GET,
    SurfaceGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onSurfaceGet) {
        return callbacks.onSurfaceGet(input, event);
      }
      if (surfaceService) {
        const surface = surfaceService.getInstance(
          input.instanceId as unknown as import("@ai-desktop/ai-core").SurfaceInstanceId,
        );
        return { surface: surface ?? null };
      }
      throw new Error("SurfaceService is not available");
    },
  );

  // 49. Surface Action command (PR33): structured action → permission →
  // existing ToolExecutor path. The channel itself never executes anything.
  registry.registerCommand(
    IPC_CHANNELS.SURFACE_ACTION,
    SurfaceActionCommandSchema,
    async (input, event) => {
      if (callbacks?.onSurfaceAction) {
        return callbacks.onSurfaceAction(input, event);
      }
      if (surfaceService) {
        const result = await surfaceService.invokeAction(
          input.instanceId as unknown as import("@ai-desktop/ai-core").SurfaceInstanceId,
          input.actionId,
          input.input,
          { ...(input.projectId ? { projectId: input.projectId } : {}) },
        );
        return { result };
      }
      throw new Error("SurfaceService is not available");
    },
  );

  // 50. Surface Dispose command (PR33): idempotent cleanup.
  registry.registerCommand(
    IPC_CHANNELS.SURFACE_DISPOSE,
    SurfaceDisposeCommandSchema,
    async (input, event) => {
      if (callbacks?.onSurfaceDispose) {
        return callbacks.onSurfaceDispose(input, event);
      }
      if (surfaceService) {
        const disposed = surfaceService.dispose(
          input.instanceId as unknown as import("@ai-desktop/ai-core").SurfaceInstanceId,
        );
        return { disposed };
      }
      throw new Error("SurfaceService is not available");
    },
  );

  // 51. Browser Session Create command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_SESSION_CREATE,
    BrowserSessionCreateCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserSessionCreate) {
        return callbacks.onBrowserSessionCreate(input, event);
      }
      if (browserService) {
        const session = await browserService.manager.createSession({
          projectId: input.projectId,
          ...(input.mode ? { mode: input.mode } : {}),
        });
        return { session };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 52. Browser Session Get command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_SESSION_GET,
    BrowserSessionGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserSessionGet) {
        return callbacks.onBrowserSessionGet(input, event);
      }
      if (browserService) {
        const session = browserService.manager.getSession(
          input.sessionId as unknown as import("@ai-desktop/ai-core").BrowserSessionId,
        );
        return { session: session ?? null };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 53. Browser Session Close command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_SESSION_CLOSE,
    BrowserSessionCloseCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserSessionClose) {
        return callbacks.onBrowserSessionClose(input, event);
      }
      if (browserService) {
        await browserService.manager.closeSession(
          input.sessionId as unknown as import("@ai-desktop/ai-core").BrowserSessionId,
        );
        return { closed: true };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 54. Browser Page Open command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_PAGE_OPEN,
    BrowserPageOpenCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserPageOpen) {
        return callbacks.onBrowserPageOpen(input, event);
      }
      if (browserService) {
        let sessionId = input.sessionId as unknown as
          import("@ai-desktop/ai-core").BrowserSessionId | undefined;
        if (!sessionId) {
          const session = await browserService.getOrCreateSession(
            input.projectId ?? "sample-project",
          );
          sessionId = session.id;
        }
        const page = await browserService.manager.openPage(sessionId, {
          ...(input.url ? { url: input.url } : {}),
          ...(input.name ? { name: input.name } : {}),
        });
        return { page };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 55. Browser Page List command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_PAGE_LIST,
    BrowserPageListCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserPageList) {
        return callbacks.onBrowserPageList(input, event);
      }
      if (browserService) {
        if (input?.sessionId) {
          const pages = browserService.manager.listPages(
            input.sessionId as unknown as import("@ai-desktop/ai-core").BrowserSessionId,
          );
          return { pages };
        }
        if (input?.projectId) {
          const sessions = browserService.manager.listSessions(input.projectId);
          const pages = sessions.flatMap((s) => browserService.manager.listPages(s.id));
          return { pages };
        }
        const pages = browserService.manager.listPages();
        return { pages };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 56. Browser Page Get command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_PAGE_GET,
    BrowserPageGetCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserPageGet) {
        return callbacks.onBrowserPageGet(input, event);
      }
      if (browserService) {
        const page = browserService.manager.getPage(
          input.pageId as unknown as import("@ai-desktop/ai-core").BrowserPageId,
        );
        return { page: page ?? null };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 57. Browser Page Close command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_PAGE_CLOSE,
    BrowserPageCloseCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserPageClose) {
        return callbacks.onBrowserPageClose(input, event);
      }
      if (browserService) {
        await browserService.manager.closePage(
          input.pageId as unknown as import("@ai-desktop/ai-core").BrowserPageId,
        );
        return { closed: true };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 58. Browser Screenshot command (PR34.5)
  registry.registerCommand(
    IPC_CHANNELS.BROWSER_SCREENSHOT,
    BrowserScreenshotCommandSchema,
    async (input, event) => {
      if (callbacks?.onBrowserScreenshot) {
        return callbacks.onBrowserScreenshot(input, event);
      }
      if (browserService) {
        const screenshot = await browserService.executeAction(
          "screenshot",
          { pageId: input.pageId, fullPage: input.fullPage },
          {
            projectId: "default",
            toolCallId: createToolCallId(),
          },
        );
        return { screenshot };
      }
      throw new Error("BrowserService is not available");
    },
  );

  // 59. Research Search command (PR35): query -> ResearchService.search.
  // Renderer supplies query/limit only; permission + SSRF + bounds enforced
  // in main through the ResearchToolExecutor path.
  registry.registerCommand(
    IPC_CHANNELS.RESEARCH_SEARCH,
    ResearchSearchCommandSchema,
    async (input, event) => {
      if (callbacks?.onResearchSearch) {
        return callbacks.onResearchSearch(input, event);
      }
      if (researchService) {
        const results = await researchService.search(
          input.query,
          { ...(input.limit !== undefined ? { limit: input.limit } : {}) },
          {
            projectId: input.projectId ?? "default",
            toolCallId: createToolCallId(),
          },
        );
        return { results };
      }
      throw new Error("ResearchService is not available");
    },
  );

  // 60. Research Open command (PR35): url -> ResearchService.open with
  // static reader first and controlled browser fallback second.
  registry.registerCommand(
    IPC_CHANNELS.RESEARCH_OPEN,
    ResearchOpenCommandSchema,
    async (input, event) => {
      if (callbacks?.onResearchOpen) {
        return callbacks.onResearchOpen(input, event);
      }
      if (researchService) {
        const result = await researchService.open(
          input.url,
          {
            ...(input.fallbackToBrowser !== undefined
              ? { fallbackToBrowser: input.fallbackToBrowser }
              : {}),
          },
          {
            projectId: input.projectId ?? "default",
            toolCallId: createToolCallId(),
          },
        );
        return { result };
      }
      throw new Error("ResearchService is not available");
    },
  );

  // 61. Research Status command (PR35): host-side provider health snapshot.
  registry.registerCommand(
    IPC_CHANNELS.RESEARCH_STATUS,
    ResearchStatusCommandSchema,
    async (input, event) => {
      if (callbacks?.onResearchStatus) {
        return callbacks.onResearchStatus(input, event);
      }
      if (researchService) {
        return { providers: researchService.health.snapshot() };
      }
      throw new Error("ResearchService is not available");
    },
  );
}
