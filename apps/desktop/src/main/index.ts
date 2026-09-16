// PR12: apps/desktop — Electron Main Process
//
// Invariants (Step 35):
//   1. Electron imports strictly confined to apps/desktop.
//   2. BrowserWindow enforces contextIsolation: true, nodeIntegration: false.
//   3. Preload script is the single controlled boundary.
//   4. Dev mode loads Vite dev server (e.g. localhost:5173); production loads local dist/index.html.
//   5. Standard lifecycle: handles window-all-closed, activate, single-instance.
//   6. Zero typed IPC or chat services implemented in PR12 (deferred to PR13/16).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { EventBus } from "@ai-desktop/agent-runtime";
import type { AIEvent } from "@ai-desktop/ai-core";
import {
  AnthropicAdapter,
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  AnthropicRealtimeProvider,
  GeminiAdapter,
  GEMINI_MODELS,
  GEMINI_PROVIDER_ID,
  createGeminiLiveProviderFromEnv,
  ProviderRegistry,
} from "@ai-desktop/providers";
import { RealtimeService } from "./realtime/index.js";
import {
  DuplicateSequenceError,
  StorageDatabase,
  PrismaAttachmentRepository,
  PrismaEventRepository,
  PrismaProviderProfileRepository,
  PrismaConversationModelRepository,
  PrismaPermissionRepository,
  PrismaSkillRepository,
  PrismaMemoryRepository,
  PrismaDocumentRepository,
  PrismaExtensionRepository,
  PrismaExtensionProjectBindingRepository,
  type AttachmentRepository,
  type EventRepository,
  type ProviderProfileRepository,
  type ConversationModelRepository,
  type PermissionRepository,
  type SkillRepository,
  type MemoryRepository,
  type ExtensionRepository,
  type ExtensionProjectBindingRepository,
} from "@ai-desktop/storage";
import { DefaultPermissionManager, type PermissionManager } from "@ai-desktop/permissions";
import { SkillInstaller, SkillManager, SkillToolRegistry } from "@ai-desktop/skills";
import { MemoryService } from "@ai-desktop/memory";
import { DefaultExecutionManager, LocalProcessSandboxProvider } from "@ai-desktop/execution";
import { ActiveStreamRegistry, ChatService, ModelSelectionService } from "./chat/index.js";
import { MediaArtifactStore } from "./chat/media-artifacts.js";
import type { AttachmentsIpcDependencies } from "./chat/attachments-ipc.js";
import { AgentService } from "./agent/index.js";
import { CodingAgentService, CodingToolExecutor } from "./agent/index.js";
import { ExtensionService, PluginToolRegistry } from "./extensions/index.js";
import { SurfaceService } from "./surfaces/surface-service.js";
import { DesktopToolRouter } from "./agent/index.js";
import {
  type BrowserManager,
  BrowserService,
  BrowserToolExecutor,
  DefaultBrowserManager,
  PuppeteerAdapter,
} from "./browser/index.js";
import {
  GithubResearchAdapter,
  ResearchCache,
  ResearchProviderHealth,
  ResearchRouter,
  ResearchService,
  ResearchToolExecutor,
  RssResearchAdapter,
  SearchAdapter,
  StaticWebReaderAdapter,
  YoutubeResearchAdapter,
} from "./research/index.js";
import { DocumentService, DocumentsToolExecutor } from "./documents/index.js";
import { IpcBatcher } from "./ipc/batcher.js";
import { IpcRegistry, registerIpcHandlers } from "./ipc/index.js";

export { ActiveStreamRegistry, ChatService, ModelSelectionService } from "./chat/index.js";
export { IpcBatcher, type ChatStreamBatch } from "./ipc/batcher.js";
export * from "./browser/index.js";
export * from "./research/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global references prevent resources from being garbage collected
let mainWindow: BrowserWindow | null = null;
let ipcRegistry: IpcRegistry | null = null;
let activeStreamRegistry: ActiveStreamRegistry | null = null;
let ipcBatcher: IpcBatcher | null = null;
let eventBus: EventBus | null = null;
let storage: EventRepository | null = null;
let database: StorageDatabase | null = null;
let chatService: ChatService | null = null;
let providerRegistry: ProviderRegistry | null = null;
let profileRepository: ProviderProfileRepository | null = null;
let conversationModelRepository: ConversationModelRepository | null = null;
let modelSelectionService: ModelSelectionService | null = null;
let permissionRepository: PermissionRepository | null = null;
let permissionManager: PermissionManager | null = null;
let skillRepository: SkillRepository | null = null;
let skillToolRegistry: SkillToolRegistry | null = null;
let skillManager: SkillManager | null = null;
let skillInstaller: SkillInstaller | null = null;
let agentService: AgentService | null = null;
let codingToolExecutor: CodingToolExecutor | null = null;
let codingAgentService: CodingAgentService | null = null;
let extensionRepository: ExtensionRepository | null = null;
let extensionBindingRepository: ExtensionProjectBindingRepository | null = null;
let extensionToolRegistry: PluginToolRegistry | null = null;
let extensionService: ExtensionService | null = null;
let surfaceService: SurfaceService | null = null;
let browserManager: BrowserManager | null = null;
let browserService: BrowserService | null = null;
let browserToolExecutor: BrowserToolExecutor | null = null;
let researchRouter: ResearchRouter | null = null;
let researchService: ResearchService | null = null;
let researchToolExecutor: ResearchToolExecutor | null = null;
let documentService: DocumentService | null = null;
let documentsToolExecutor: DocumentsToolExecutor | null = null;
let mediaArtifactStore: MediaArtifactStore | null = null;
let attachmentRepository: AttachmentRepository | null = null;
let realtimeService: RealtimeService | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!providerRegistry) {
    providerRegistry = new ProviderRegistry();
    // Register Anthropic adapter & models
    const anthropicAdapter = new AnthropicAdapter();
    providerRegistry.registerProvider({
      providerId: ANTHROPIC_PROVIDER_ID,
      adapter: anthropicAdapter,
    });
    for (const model of ANTHROPIC_MODELS) {
      providerRegistry.registerModel({ model });
    }

    // Register Gemini adapter & models
    const geminiAdapter = new GeminiAdapter();
    providerRegistry.registerProvider({
      providerId: GEMINI_PROVIDER_ID,
      adapter: geminiAdapter,
    });
    for (const model of GEMINI_MODELS) {
      providerRegistry.registerModel({ model });
    }
  }
  return providerRegistry;
}

export function getProfileRepository(): ProviderProfileRepository {
  if (!profileRepository) {
    const { database: db } = getStorage();
    profileRepository = new PrismaProviderProfileRepository(db);
  }
  return profileRepository;
}

export function getConversationModelRepository(): ConversationModelRepository {
  if (!conversationModelRepository) {
    const { database: db } = getStorage();
    conversationModelRepository = new PrismaConversationModelRepository(db);
  }
  return conversationModelRepository;
}

export function getModelSelectionService(): ModelSelectionService {
  if (!modelSelectionService) {
    modelSelectionService = new ModelSelectionService({
      registry: getProviderRegistry(),
      profileRepo: getProfileRepository(),
      conversationModelRepo: getConversationModelRepository(),
      defaultFallbackModelId: ANTHROPIC_MODELS[0].id,
    });
  }
  return modelSelectionService;
}

export function getActiveStreamRegistry(): ActiveStreamRegistry {
  if (!activeStreamRegistry) {
    activeStreamRegistry = new ActiveStreamRegistry();
  }
  return activeStreamRegistry;
}

export function getIpcBatcher(): IpcBatcher {
  if (!ipcBatcher) {
    ipcBatcher = new IpcBatcher();
  }
  return ipcBatcher;
}

export function getStorage(): { database: StorageDatabase; repository: EventRepository } {
  if (!database || !storage) {
    database = new StorageDatabase();
    storage = new PrismaEventRepository(database);
  }
  return { database, repository: storage };
}

export function getPermissionRepository(): PermissionRepository {
  if (!permissionRepository) {
    const { database: db } = getStorage();
    permissionRepository = new PrismaPermissionRepository(db);
  }
  return permissionRepository;
}

export function getPermissionManager(): PermissionManager {
  if (!permissionManager) {
    permissionManager = new DefaultPermissionManager({
      storage: getPermissionRepository(),
      eventSink: (event) => {
        getEventBus().publish(event);
      },
    });
  }
  return permissionManager;
}

export function getSkillRepository(): SkillRepository {
  if (!skillRepository) {
    const { database: db } = getStorage();
    skillRepository = new PrismaSkillRepository(db);
  }
  return skillRepository;
}

export function getSkillToolRegistry(): SkillToolRegistry {
  if (!skillToolRegistry) {
    skillToolRegistry = new SkillToolRegistry();
  }
  return skillToolRegistry;
}

export function getSkillManager(): SkillManager {
  if (!skillManager) {
    skillManager = new SkillManager({
      repository: getSkillRepository(),
      toolRegistry: getSkillToolRegistry(),
    });
  }
  return skillManager;
}

export function getSkillInstaller(): SkillInstaller {
  if (!skillInstaller) {
    const baseDir =
      app && typeof app.getPath === "function"
        ? path.join(app.getPath("userData"), "skills")
        : path.resolve(process.cwd(), ".ai-desktop/skills");

    skillInstaller = new SkillInstaller({
      installBaseDir: baseDir,
      repository: getSkillRepository(),
      onUninstall: (skillId) => {
        getSkillToolRegistry().unregisterSkillTools(skillId);
      },
    });
  }
  return skillInstaller;
}

export function getMemoryRepository(): MemoryRepository {
  return getMemoryRepositoryInternal();
}

function getMemoryRepositoryInternal(): MemoryRepository {
  const existing = (globalThis as unknown as { __aiDesktopMemoryRepo?: MemoryRepository })
    .__aiDesktopMemoryRepo;
  if (existing) {
    return existing;
  }
  const { database: db } = getStorage();
  const repo = new PrismaMemoryRepository(db);
  (globalThis as unknown as { __aiDesktopMemoryRepo?: MemoryRepository }).__aiDesktopMemoryRepo =
    repo;
  return repo;
}

export function getMemoryService(): MemoryService {
  const existing = (globalThis as unknown as { __aiDesktopMemoryService?: MemoryService })
    .__aiDesktopMemoryService;
  if (existing) {
    return existing;
  }
  const service = new MemoryService({ repository: getMemoryRepository() });
  (globalThis as unknown as { __aiDesktopMemoryService?: MemoryService }).__aiDesktopMemoryService =
    service;
  return service;
}

/**
 * Attaches storage as a consumer on EventBus (§40.6, §40.18).
 * Ensures any canonical events published to EventBus are durably stored in SQLite WAL.
 */
export function attachStorageConsumer(
  bus: EventBus,
  eventStorage: EventRepository,
  options?: { onError?: (err: unknown, event: Readonly<AIEvent>) => void },
): () => void {
  return bus.subscribe(async (event) => {
    try {
      await eventStorage.append(event);
    } catch (err: unknown) {
      if (err instanceof DuplicateSequenceError) {
        // Event was already appended by producer (persistence-before-delivery §40.16)
        return;
      }
      options?.onError?.(err, event);
    }
  });
}

export function getEventBus(): EventBus {
  if (!eventBus) {
    eventBus = new EventBus();
    const batcher = getIpcBatcher();
    // 1. Wire EventBus -> IPC Batcher (§39.1, §39.3, §39.28)
    eventBus.subscribe((event) => {
      batcher.enqueue(event);
    });
    // 2. Wire EventBus -> Storage (§40.1, §40.6, §40.18)
    const { repository } = getStorage();
    attachStorageConsumer(eventBus, repository);
  }
  return eventBus;
}

export function getChatService(options?: {
  modelSelectionService?: ModelSelectionService;
  memoryService?: MemoryService;
  storage?: EventRepository;
  eventBus?: EventBus;
  streamRegistry?: ActiveStreamRegistry;
}): ChatService {
  if (!chatService || options) {
    const bus = options?.eventBus ?? getEventBus();
    const store = options?.storage ?? getStorage().repository;
    const registry = options?.streamRegistry ?? getActiveStreamRegistry();
    const modelSelection = options?.modelSelectionService ?? getModelSelectionService();
    const memory = options?.memoryService ?? getMemoryService();

    const service = new ChatService({
      modelSelectionService: modelSelection,
      memoryService: memory,
      streamRegistry: registry,
      eventBus: bus,
      storage: store,
    });
    if (!options) {
      chatService = service;
    }
    return service;
  }
  return chatService;
}

/**
 * Desktop AgentService singleton (PR29.16): one AgentRuntime wired to the
 * proven desktop foundations. MCP/Skill executors attach lazily when their
 * hosts are available; without them, tool calls fail closed with a clear
 * "no executor" error rather than executing blindly.
 */
export function getAgentService(options?: {
  mcpExecutor?: ConstructorParameters<typeof AgentService>[0]["mcpExecutor"];
  skillExecutor?: ConstructorParameters<typeof AgentService>[0]["skillExecutor"];
  builtinExecutor?: ConstructorParameters<typeof AgentService>[0]["builtinExecutor"];
  browserExecutor?: ConstructorParameters<typeof AgentService>[0]["browserExecutor"];
  researchExecutor?: ConstructorParameters<typeof AgentService>[0]["researchExecutor"];
  documentsExecutor?: ConstructorParameters<typeof AgentService>[0]["documentsExecutor"];
  pluginExecutor?: ConstructorParameters<typeof AgentService>[0]["pluginExecutor"];
}): AgentService {
  if (!agentService || options) {
    const pluginExecutor = options?.pluginExecutor ?? getExtensionService().pluginExecutor;
    const service = new AgentService({
      modelSelectionService: getModelSelectionService(),
      permissionManager: getPermissionManager(),
      memoryService: getMemoryService(),
      eventBus: getEventBus(),
      storage: getStorage().repository,
      ...(options?.mcpExecutor ? { mcpExecutor: options.mcpExecutor } : {}),
      ...(options?.skillExecutor ? { skillExecutor: options.skillExecutor } : {}),
      ...(options?.builtinExecutor ? { builtinExecutor: options.builtinExecutor } : {}),
      ...(options?.browserExecutor
        ? { browserExecutor: options.browserExecutor }
        : { browserExecutor: getBrowserToolExecutor() }),
      ...(options?.researchExecutor
        ? { researchExecutor: options.researchExecutor }
        : { researchExecutor: getResearchToolExecutor() }),
      ...(options?.documentsExecutor
        ? { documentsExecutor: options.documentsExecutor }
        : { documentsExecutor: getDocumentsToolExecutor() }),
      pluginExecutor,
    });
    if (!options) {
      agentService = service;
    }
    return service;
  }
  return agentService;
}

/**
 * Coding builtin executor singleton (PR30.7): validate -> permission ->
 * backend, backed by LocalProcessSandboxProvider through DefaultExecutionManager.
 * Workspace resolution delegates to the CodingAgentService registry so tasks
 * stay project-bound (unregistered projects fail closed).
 */
export function getCodingToolExecutor(): CodingToolExecutor {
  if (!codingToolExecutor) {
    codingToolExecutor = new CodingToolExecutor({
      permissionManager: getPermissionManager(),
      executionManager: new DefaultExecutionManager({
        sandboxProvider: new LocalProcessSandboxProvider(),
      }),
      resolveWorkspace: (projectId?: string) =>
        projectId ? codingAgentService?.resolveWorkspace(projectId) : undefined,
    });
  }
  return codingToolExecutor;
}

/**
 * CodingAgentService singleton (PR30.9): desktop composition of the PR29
 * runtime for coding tasks. Never implements its own ReAct loop.
 */
export function getCodingAgentService(): CodingAgentService {
  if (!codingAgentService) {
    const executor = getCodingToolExecutor();
    codingAgentService = new CodingAgentService({
      agentService: getAgentService({ builtinExecutor: executor }),
      codingToolExecutor: executor,
    });
  }
  return codingAgentService;
}

export function getExtensionRepository(): ExtensionRepository {
  if (!extensionRepository) {
    const { database: db } = getStorage();
    extensionRepository = new PrismaExtensionRepository(db);
  }
  return extensionRepository;
}

export function getExtensionBindingRepository(): ExtensionProjectBindingRepository {
  if (!extensionBindingRepository) {
    const { database: db } = getStorage();
    extensionBindingRepository = new PrismaExtensionProjectBindingRepository(db);
  }
  return extensionBindingRepository;
}

export function getExtensionToolRegistry(): PluginToolRegistry {
  if (!extensionToolRegistry) {
    extensionToolRegistry = new PluginToolRegistry();
  }
  return extensionToolRegistry;
}

/**
 * Desktop ExtensionService singleton (PR32): owns the local plugin adapters,
 * durable extension repos, and the host tool-handler map. Restores prior
 * installations from the same StorageDatabase on first construction.
 */
export function getExtensionService(): ExtensionService {
  if (!extensionService) {
    const baseDir =
      app && typeof app.getPath === "function"
        ? path.join(app.getPath("userData"), "extensions")
        : path.resolve(process.cwd(), ".ai-desktop/extensions");

    extensionService = new ExtensionService({
      repository: getExtensionRepository(),
      bindingRepository: getExtensionBindingRepository(),
      permissionManager: getPermissionManager(),
      installBaseDir: baseDir,
      toolRegistry: getExtensionToolRegistry(),
    });
    void extensionService.restore().catch(() => {
      // Restore is best-effort at startup; failures surface on first use.
    });
  }
  return extensionService;
}

/**
 * SurfaceService singleton (PR33.9): permission-gated surface lifecycle over
 * the universal ToolExecutor path. The tool router reuses the coding + plugin
 * executors already composed in this file; MCP/skill prefixes fail closed
 * here (their executors attach in the agent runtime path, not the surface
 * action path).
 */
export function getSurfaceService(): SurfaceService {
  if (!surfaceService) {
    const extensions = getExtensionService();
    const router = new DesktopToolRouter({
      permissionManager: getPermissionManager(),
      builtinExecutor: getCodingToolExecutor(),
      pluginExecutor: extensions.pluginExecutor,
    });
    surfaceService = new SurfaceService({
      permissionManager: getPermissionManager(),
      toolRouter: router,
      extensionGate: {
        isActive: async (extensionId: string) => {
          const info = await extensions.getExtension(extensionId);
          return info?.lifecycle === "active";
        },
        isEnabledForProject: (extensionId: string, projectId: string) =>
          extensions.isEnabledForProject(extensionId, projectId),
      },
    });
  }
  return surfaceService;
}

export function getBrowserManager(): BrowserManager {
  if (!browserManager) {
    browserManager = new DefaultBrowserManager({
      engineAdapter: new PuppeteerAdapter(),
    });
  }
  return browserManager;
}

export function getBrowserService(): BrowserService {
  if (!browserService) {
    browserService = new BrowserService({
      browserManager: getBrowserManager(),
    });
  }
  return browserService;
}

export function getBrowserToolExecutor(): BrowserToolExecutor {
  if (!browserToolExecutor) {
    browserToolExecutor = new BrowserToolExecutor({
      permissionManager: getPermissionManager(),
      browserService: getBrowserService(),
    });
  }
  return browserToolExecutor;
}

/**
 * Research router singleton (PR35): host-registered channel adapters.
 * The static web reader is primary; search ships unconfigured (fails
 * closed); GitHub/RSS/YouTube use public endpoints. Providers can be
 * extended by registering additional host adapters here.
 */
export function getResearchRouter(): ResearchRouter {
  if (!researchRouter) {
    researchRouter = new ResearchRouter();
    researchRouter.register(new StaticWebReaderAdapter());
    researchRouter.register(new SearchAdapter());
    researchRouter.register(new GithubResearchAdapter());
    researchRouter.register(new YoutubeResearchAdapter());
    researchRouter.register(new RssResearchAdapter());
  }
  return researchRouter;
}

/**
 * ResearchService singleton (PR35): cache + router + health, with the
 * PR34 BrowserService as the controlled browser-fallback boundary.
 */
export function getResearchService(): ResearchService {
  if (!researchService) {
    researchService = new ResearchService({
      router: getResearchRouter(),
      cache: new ResearchCache<unknown>(),
      health: new ResearchProviderHealth(),
      browserService: getBrowserService(),
    });
  }
  return researchService;
}

/**
 * ResearchToolExecutor singleton (PR35): universal resolve -> validate ->
 * permission -> execute lifecycle over the ResearchService.
 */
export function getResearchToolExecutor(): ResearchToolExecutor {
  if (!researchToolExecutor) {
    researchToolExecutor = new ResearchToolExecutor({
      permissionManager: getPermissionManager(),
      researchService: getResearchService(),
    });
  }
  return researchToolExecutor;
}

/**
 * DocumentService singleton (PR37): project-scoped ingestion, lexical
 * retrieval, and bounded open backed by PrismaDocumentRepository.
 */
export function getDocumentService(): DocumentService {
  if (!documentService) {
    const { database: db } = getStorage();
    documentService = new DocumentService({
      repository: new PrismaDocumentRepository(db),
    });
  }
  return documentService;
}

/**
 * DocumentsToolExecutor singleton (PR37): universal resolve -> validate ->
 * permission -> execute lifecycle over the DocumentService.
 */
export function getDocumentsToolExecutor(): DocumentsToolExecutor {
  if (!documentsToolExecutor) {
    documentsToolExecutor = new DocumentsToolExecutor({
      permissionManager: getPermissionManager(),
      documentService: getDocumentService(),
    });
  }
  return documentsToolExecutor;
}

/**
 * MediaArtifactStore singleton (PR39): filesystem-backed binary store for
 * chat attachments, rooted under the Electron userData dir (mirroring the
 * skills/extensions singleton root resolution below). Bytes never cross IPC
 * except as a bounded image-only preview.
 */
export function getMediaArtifactStore(): MediaArtifactStore {
  if (!mediaArtifactStore) {
    const rootDir =
      app && typeof app.getPath === "function"
        ? path.join(app.getPath("userData"), "media-artifacts")
        : path.resolve(process.cwd(), ".ai-desktop/media-artifacts");
    mediaArtifactStore = new MediaArtifactStore({ rootDir });
  }
  return mediaArtifactStore;
}

/**
 * AttachmentRepository singleton (PR39): Prisma-backed attachment metadata
 * over the shared StorageDatabase (bytes stay in MediaArtifactStore).
 */
export function getAttachmentRepository(): AttachmentRepository {
  if (!attachmentRepository) {
    const { database: db } = getStorage();
    attachmentRepository = new PrismaAttachmentRepository(db);
  }
  return attachmentRepository;
}

/**
 * RealtimeService singleton (PR40): voice session lifecycle over the
 * provider realtime adapters. The Gemini Live client resolves its API key
 * from the operator-configured GEMINI_API_KEY environment variable at
 * session start (the SDK's standard convention); without a key, session
 * creation fails with a typed provider error. Keys never touch logs,
 * events, or storage. Anthropic exposes realtime: unsupported.
 */
export function getRealtimeService(): RealtimeService {
  if (!realtimeService) {
    realtimeService = new RealtimeService({
      permissionManager: getPermissionManager(),
      eventBus: getEventBus(),
      providers: [new AnthropicRealtimeProvider(), createGeminiLiveProviderFromEnv()],
      chatHandoff: async (input) => {
        await getChatService().sendMessage({
          conversationId: input.conversationId,
          content: input.content,
          projectId: input.projectId,
        });
      },
    });
  }
  return realtimeService;
}

/**
 * Attachments IPC dependencies (PR39): thin-handler bundle passed into the
 * IPC handler registration (mirrors how documentService is passed).
 */
export function getAttachmentsIpcDependencies(): AttachmentsIpcDependencies {
  return {
    artifactStore: getMediaArtifactStore(),
    attachmentRepository: getAttachmentRepository(),
  };
}

export function getSecureWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const preloadPath = path.join(__dirname, "../dist-electron/preload.js");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "AI Desktop",
    webPreferences: getSecureWebPreferences(preloadPath),
  });

  // Development vs. Production renderer loading
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    await mainWindow.loadFile(indexPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Application Lifecycle
// ---------------------------------------------------------------------------

export function initIpc(options?: {
  activeStreamRegistry?: ActiveStreamRegistry;
  batcher?: IpcBatcher;
  chatService?: ChatService;
  permissionManager?: PermissionManager;
  modelSelectionService?: ModelSelectionService;
  skillManager?: SkillManager;
  skillInstaller?: SkillInstaller;
  memoryService?: MemoryService;
  agentService?: AgentService;
  codingAgentService?: CodingAgentService;
  extensionService?: ExtensionService;
  surfaceService?: SurfaceService;
  browserService?: BrowserService;
  researchService?: ResearchService;
  documentService?: DocumentService;
  attachments?: AttachmentsIpcDependencies;
}): IpcRegistry {
  if (!ipcRegistry) {
    ipcRegistry = new IpcRegistry();
    const streamRegistry = options?.activeStreamRegistry ?? getActiveStreamRegistry();
    const batcher = options?.batcher ?? getIpcBatcher();
    const chat = options?.chatService ?? getChatService({ streamRegistry });
    const modelSelection = options?.modelSelectionService ?? getModelSelectionService();
    const permissions = options?.permissionManager ?? getPermissionManager();
    const skills = options?.skillManager ?? getSkillManager();
    const installer = options?.skillInstaller ?? getSkillInstaller();
    const memory = options?.memoryService ?? getMemoryService();
    const agent = options?.agentService ?? getAgentService();
    const coding = options?.codingAgentService ?? getCodingAgentService();
    const extensions = options?.extensionService ?? getExtensionService();
    const surfaces = options?.surfaceService ?? getSurfaceService();
    const browser = options?.browserService ?? getBrowserService();
    const research = options?.researchService ?? getResearchService();
    const documents = options?.documentService ?? getDocumentService();
    const attachmentsDeps = options?.attachments ?? getAttachmentsIpcDependencies();

    registerIpcHandlers(ipcRegistry, {
      streamRegistry,
      batcher,
      chatService: chat,
      modelSelectionService: modelSelection,
      permissionManager: permissions,
      skillManager: skills,
      skillInstaller: installer,
      memoryService: memory,
      agentService: agent,
      codingAgentService: coding,
      extensionService: extensions,
      surfaceService: surfaces,
      browserService: browser,
      researchService: research,
      documentService: documents,
      attachments: attachmentsDeps,
      realtimeService: getRealtimeService(),
    });
  }
  return ipcRegistry;
}

if (app) {
  app.whenReady().then(async () => {
    initIpc();
    await createMainWindow();

    app.on("activate", async () => {
      if (BrowserWindow && BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    // Respect platform conventions: macOS applications typically stay open until Cmd+Q
    if (process.platform !== "darwin") {
      if (activeStreamRegistry) {
        activeStreamRegistry.clear();
        activeStreamRegistry = null;
      }
      if (ipcRegistry) {
        // Also destroys the attached IPC batcher and its timers.
        ipcRegistry.destroy();
        ipcRegistry = null;
      }
      if (database) {
        void database.close();
        database = null;
      }
      ipcBatcher = null;
      chatService = null;
      eventBus = null;
      storage = null;
      app.quit();
    }
  });
}
