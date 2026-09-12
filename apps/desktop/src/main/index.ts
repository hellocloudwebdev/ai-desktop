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
  GeminiAdapter,
  GEMINI_MODELS,
  GEMINI_PROVIDER_ID,
  ProviderRegistry,
} from "@ai-desktop/providers";
import {
  DuplicateSequenceError,
  StorageDatabase,
  PrismaEventRepository,
  PrismaProviderProfileRepository,
  PrismaConversationModelRepository,
  PrismaPermissionRepository,
  PrismaSkillRepository,
  type EventRepository,
  type ProviderProfileRepository,
  type ConversationModelRepository,
  type PermissionRepository,
  type SkillRepository,
} from "@ai-desktop/storage";
import { DefaultPermissionManager, type PermissionManager } from "@ai-desktop/permissions";
import { SkillInstaller, SkillManager, SkillToolRegistry } from "@ai-desktop/skills";
import { ActiveStreamRegistry, ChatService, ModelSelectionService } from "./chat/index.js";
import { IpcBatcher } from "./ipc/batcher.js";
import { IpcRegistry, registerIpcHandlers } from "./ipc/index.js";

export { ActiveStreamRegistry, ChatService, ModelSelectionService } from "./chat/index.js";
export { IpcBatcher, type ChatStreamBatch } from "./ipc/batcher.js";

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
  storage?: EventRepository;
  eventBus?: EventBus;
  streamRegistry?: ActiveStreamRegistry;
}): ChatService {
  if (!chatService || options) {
    const bus = options?.eventBus ?? getEventBus();
    const store = options?.storage ?? getStorage().repository;
    const registry = options?.streamRegistry ?? getActiveStreamRegistry();
    const modelSelection = options?.modelSelectionService ?? getModelSelectionService();

    const service = new ChatService({
      modelSelectionService: modelSelection,
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

    registerIpcHandlers(ipcRegistry, {
      streamRegistry,
      batcher,
      chatService: chat,
      modelSelectionService: modelSelection,
      permissionManager: permissions,
      skillManager: skills,
      skillInstaller: installer,
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
