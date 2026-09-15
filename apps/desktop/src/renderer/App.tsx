import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ConversationId, MessageId, Timestamp } from "@ai-desktop/shared";
import type {
  AIEvent,
  Message,
  ContentPart,
  ModelDefinition,
  PermissionRequest,
} from "@ai-desktop/ai-core";
import { useWorkspaceStore } from "./workspace/store.js";
import { fetchExtensionList, getExtensionCommands } from "./workspace/extensions.js";
import {
  disposeSurfaceInstance,
  fetchSurfaceList,
  invokeSurfaceAction,
} from "./workspace/surfaces.js";
import { WorkspaceShell } from "./components/workspace/Workspace.js";
import type {
  ActivityEventView,
  BrowserPageView,
  ExtensionView,
  FileEntryView,
  ResearchResultView,
  SurfaceView,
} from "./components/workspace/surfaces/surface-props.js";

const DEFAULT_CONVERSATION_ID = "01JM0000000000000000000001";

export function App(): React.ReactElement {
  const workspace = useWorkspaceStore();
  const [conversationId] = useState<string>(DEFAULT_CONVERSATION_ID);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<string>("checking...");
  const [availableModels, setAvailableModels] = useState<ModelDefinition[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [skills, setSkills] = useState<
    Array<{ id: string; name: string; state: string; enabled: boolean; active?: boolean }>
  >([]);
  const [memories, setMemories] = useState<
    Array<{
      id: string;
      content: string;
      category: string;
      scopeLevel: string;
      projectId?: string | null;
    }>
  >([]);
  const [agentTasks, setAgentTasks] = useState<
    Array<{
      taskId: string;
      status: string;
      nodes: Array<{ id: string; goal: string; status: string }>;
    }>
  >([]);
  const [agentGoal, setAgentGoal] = useState<string>("");
  const [agentRunning, setAgentRunning] = useState<boolean>(false);
  const [codingTasks, setCodingTasks] = useState<
    Array<{
      taskId: string;
      status: string;
      nodes: Array<{ id: string; goal: string; status: string }>;
    }>
  >([]);
  const [codingPrompt, setCodingPrompt] = useState<string>("");
  const [codingProjectId, setCodingProjectId] = useState<string>("sample-project");
  const [codingRunning, setCodingRunning] = useState<boolean>(false);
  // Activity feed: bounded view over subscribed conversation events (PR31.11).
  const [activityEvents, setActivityEvents] = useState<ActivityEventView[]>([]);
  // Touched files derive from tool results in canonical events (PR31.11).
  const [touchedFiles, setTouchedFiles] = useState<FileEntryView[]>([]);
  // PR32: extensions list + selection (App-owned backend state, surface is a
  // pure view; commands arrive via the preload bridge).
  const [extensions, setExtensions] = useState<ExtensionView[]>([]);
  const [selectedExtensionId, setSelectedExtensionId] = useState<string | null>(null);
  // PR33: rich surfaces list (App-owned backend state, surface is a pure
  // view; actions/dispose arrive via the preload bridge when present).
  const [surfaces, setSurfaces] = useState<SurfaceView[]>([]);
  // PR34.5: browser pages list + active page + latest screenshot artifact
  const [browserPages, setBrowserPages] = useState<BrowserPageView[]>([]);
  const [activeBrowserPageId, setActiveBrowserPageId] = useState<string | null>(null);
  const [browserScreenshot, setBrowserScreenshot] = useState<{
    artifactRef: string;
    bytes: number;
  } | null>(null);
  // PR35: research query + results + opened document (App-owned backend
  // state; the surface is a pure view over the research:* IPC affordances).
  const [researchQuery, setResearchQuery] = useState<string>("");
  const [researchSearching, setResearchSearching] = useState<boolean>(false);
  const [researchResults, setResearchResults] = useState<ResearchResultView[]>([]);
  const [researchOpened, setResearchOpened] = useState<ResearchResultView | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // PR34.5: load browser pages through the preload bridge
  const refreshBrowserPages = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listBrowserPages({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok && Array.isArray(res.value.pages)) {
        const pages = (res.value.pages as BrowserPageView[]).filter(
          (p) => p && typeof p.id === "string",
        );
        setBrowserPages(pages);
      }
    } catch (err) {
      console.warn("Failed to list browser pages:", err);
    }
  }, [workspace.state.activeProjectId]);

  useEffect(() => {
    void refreshBrowserPages();
  }, [refreshBrowserPages]);

  const handleOpenBrowserPage = useCallback(
    async (url: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        const res = await window.api.commands.openBrowserPage({
          projectId: workspace.state.activeProjectId,
          url,
        });
        if (res.ok && res.value.page) {
          const page = res.value.page as BrowserPageView;
          setActiveBrowserPageId(page.id);
          await refreshBrowserPages();
        }
      } catch (err) {
        console.warn("Failed to open browser page:", err);
      }
    },
    [refreshBrowserPages, workspace.state.activeProjectId],
  );

  const handleCloseBrowserPage = useCallback(
    async (pageId: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        await window.api.commands.closeBrowserPage({
          pageId: pageId as unknown as import("@ai-desktop/shared").BrowserPageId,
        });
        if (activeBrowserPageId === pageId) {
          setActiveBrowserPageId(null);
        }
        await refreshBrowserPages();
      } catch (err) {
        console.warn("Failed to close browser page:", err);
      }
    },
    [activeBrowserPageId, refreshBrowserPages],
  );

  const handleTakeScreenshot = useCallback(async (pageId: string) => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.captureBrowserScreenshot({
        pageId: pageId as unknown as import("@ai-desktop/shared").BrowserPageId,
      });
      if (res.ok && res.value.screenshot) {
        setBrowserScreenshot(res.value.screenshot as { artifactRef: string; bytes: number });
      }
    } catch (err) {
      console.warn("Failed to take screenshot:", err);
    }
  }, []);

  // PR35: research search/open through the preload bridge. No-ops when the
  // bridge is absent (preload not yet updated, or non-Electron hosts).
  const handleResearchSearch = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    const query = researchQuery.trim();
    if (!query) return;
    setResearchSearching(true);
    setResearchError(null);
    setResearchOpened(null);
    try {
      const commands = window.api.commands as unknown as {
        searchResearch?: (command: {
          query: string;
          projectId: string;
        }) => Promise<{ ok: boolean; value?: { result: unknown }; error?: { message: string } }>;
      };
      if (typeof commands.searchResearch !== "function") return;
      const res = await commands.searchResearch({
        query,
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok && res.value?.result) {
        const result = res.value.result as {
          metadata?: { results?: unknown };
          source?: { provider?: string; channel?: string };
          retrievedAt?: string;
          requestId?: string;
          title?: string;
        };
        const hits = Array.isArray(result.metadata?.results) ? result.metadata.results : [];
        setResearchResults(
          hits.map((hit, index) => {
            const h = hit as Record<string, unknown>;
            return {
              id: `${result.requestId ?? "search"}:${index}`,
              title: typeof h.title === "string" ? h.title : undefined,
              url: typeof h.url === "string" ? h.url : undefined,
              excerpt: typeof h.snippet === "string" ? h.snippet : undefined,
              provider: String(result.source?.provider ?? "unknown"),
              channel: String(result.source?.channel ?? "search"),
              retrievedAt: String(result.retrievedAt ?? ""),
              truncated: false,
            };
          }),
        );
      } else if (!res.ok) {
        setResearchError(res.error?.message ?? "Research search failed");
      }
    } catch (err) {
      setResearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setResearchSearching(false);
    }
  }, [researchQuery, workspace.state.activeProjectId]);

  const handleResearchOpen = useCallback(
    async (url: string) => {
      if (typeof window === "undefined" || !window.api) return;
      setResearchError(null);
      try {
        const commands = window.api.commands as unknown as {
          openResearch?: (command: {
            url: string;
            projectId: string;
          }) => Promise<{ ok: boolean; value?: { result: unknown }; error?: { message: string } }>;
        };
        if (typeof commands.openResearch !== "function") return;
        const res = await commands.openResearch({
          url,
          projectId: workspace.state.activeProjectId,
        });
        if (res.ok && res.value?.result) {
          const result = res.value.result as Record<string, unknown>;
          const source = result.source as Record<string, unknown> | undefined;
          setResearchOpened({
            id: String(result.id ?? url),
            title: typeof result.title === "string" ? result.title : undefined,
            url: typeof result.url === "string" ? result.url : url,
            excerpt: typeof result.excerpt === "string" ? result.excerpt : undefined,
            content: typeof result.content === "string" ? result.content : undefined,
            provider: String(source?.provider ?? "unknown"),
            channel: String(source?.channel ?? "web"),
            retrievedAt: String(result.retrievedAt ?? ""),
            truncated: result.truncated === true,
          });
        } else if (!res.ok) {
          setResearchError(res.error?.message ?? "Research open failed");
        }
      } catch (err) {
        setResearchError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  // PR32: load the extension list through the preload bridge. No-ops when
  // the bridge is absent (preload not yet updated, or non-Electron hosts).
  const refreshExtensions = useCallback(async () => {
    try {
      const commands = getExtensionCommands();
      if (!commands) return;
      setExtensions(await fetchExtensionList(commands));
    } catch (err) {
      console.warn("Failed to list extensions:", err);
    }
  }, []);

  useEffect(() => {
    void refreshExtensions();
  }, [refreshExtensions]);

  // PR32: extension mutation handlers (mutate via bridge, then refresh).
  const handleEnableExtension = useCallback(
    async (extensionId: string) => {
      const commands = getExtensionCommands();
      if (!commands) return;
      try {
        await commands.enableExtension({ extensionId });
        await refreshExtensions();
      } catch (err) {
        console.warn("Failed to enable extension:", err);
      }
    },
    [refreshExtensions],
  );

  const handleDisableExtension = useCallback(
    async (extensionId: string) => {
      const commands = getExtensionCommands();
      if (!commands) return;
      try {
        await commands.disableExtension({ extensionId });
        await refreshExtensions();
      } catch (err) {
        console.warn("Failed to disable extension:", err);
      }
    },
    [refreshExtensions],
  );

  const handleExtensionProjectToggle = useCallback(
    async (extensionId: string, enabled: boolean) => {
      const commands = getExtensionCommands();
      if (!commands) return;
      try {
        await commands.setExtensionProjectEnabled({
          extensionId,
          projectId: workspace.state.activeProjectId,
          enabled,
        });
        await refreshExtensions();
      } catch (err) {
        console.warn("Failed to toggle extension project:", err);
      }
    },
    [refreshExtensions, workspace.state.activeProjectId],
  );

  const handleSelectExtension = useCallback((extensionId: string | null) => {
    setSelectedExtensionId(extensionId);
  }, []);

  // PR33: load the rich-surface list through window.api.commands. Scoped to
  // the active project; absent bridge (non-Electron hosts) yields [].
  const refreshSurfaces = useCallback(async () => {
    try {
      setSurfaces(await fetchSurfaceList(workspace.state.activeProjectId));
    } catch (err) {
      console.warn("Failed to list surfaces:", err);
    }
  }, [workspace.state.activeProjectId]);

  useEffect(() => {
    void refreshSurfaces();
  }, [refreshSurfaces]);

  // PR33: surface action/dispose handlers (invoke via bridge, then refresh).
  const handleSurfaceAction = useCallback(
    async (actionId: string, input: unknown) => {
      const instanceId = surfaces.find(
        (s) => s.instanceId === workspace.state.selectedSurfaceId,
      )?.instanceId;
      if (!instanceId) return;
      try {
        await invokeSurfaceAction(instanceId, actionId, input, workspace.state.activeProjectId);
        await refreshSurfaces();
      } catch (err) {
        console.warn("Failed to invoke surface action:", err);
      }
    },
    [refreshSurfaces, surfaces, workspace.state.activeProjectId, workspace.state.selectedSurfaceId],
  );

  const handleSurfaceDispose = useCallback(
    async (instanceId: string) => {
      try {
        await disposeSurfaceInstance(instanceId);
        workspace.selectSurfaceInstance(null);
        await refreshSurfaces();
      } catch (err) {
        console.warn("Failed to dispose surface:", err);
      }
    },
    [refreshSurfaces, workspace],
  );

  // Auto-scroll to latest message
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle incoming stream events incrementally (§39.29, §39.33)
  // Also appends a bounded activity entry per event (PR31.11 activity view).
  const handleStreamEvent = useCallback((event: AIEvent) => {
    const eventType = (event as { type?: string }).type ?? "unknown";
    if (eventType !== "message.delta") {
      setActivityEvents((prev) => {
        const entry: ActivityEventView = {
          key: `${eventType}:${event.sequence}:${prev.length}`,
          time: new Date(event.timestamp as string).toLocaleTimeString(),
          label: describeActivityEvent(eventType, event as Record<string, unknown>),
          kind: activityKindFor(eventType),
        };
        const next = [...prev, entry];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    }
    // Touched files: tool results carry JSON with "path" for filesystem ops.
    if (eventType === "tool.call.completed") {
      const result = (event as { result?: unknown }).result;
      if (typeof result === "string") {
        const match = /"path"\s*:\s*"([^"]+)"/.exec(result);
        if (match) {
          const filePath = match[1];
          setTouchedFiles((prev) => {
            if (prev.some((f) => f.path === filePath)) return prev;
            const next = [...prev, { path: filePath }];
            return next.length > 100 ? next.slice(next.length - 100) : next;
          });
        }
      }
    }
    setMessages((prevMessages) => {
      const updated = [...prevMessages];
      const anyEvent = event as {
        type: string;
        messageId?: string;
        role?: "system" | "user" | "assistant" | "tool";
        content?: readonly ContentPart[];
        deltaText?: string;
        error?: string;
      };

      const msgId = anyEvent.messageId;
      if (!msgId) {
        return updated;
      }

      const existingIndex = updated.findIndex((m) => m.id === msgId);

      switch (anyEvent.type) {
        case "message.started": {
          setIsStreaming(true);
          setActiveMessageId(msgId);
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "streaming",
              updatedAt: event.timestamp as Timestamp,
            };
          } else {
            updated.push({
              id: msgId as MessageId,
              conversationId: event.conversationId as ConversationId,
              role: anyEvent.role ?? "assistant",
              content: anyEvent.content ?? [],
              status: "streaming",
              createdAt: event.timestamp as Timestamp,
              updatedAt: event.timestamp as Timestamp,
            });
          }
          break;
        }

        case "message.created": {
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              role: anyEvent.role ?? updated[existingIndex].role,
              content: anyEvent.content ?? updated[existingIndex].content,
              status: "completed",
              updatedAt: event.timestamp as Timestamp,
            };
          } else {
            updated.push({
              id: msgId as MessageId,
              conversationId: event.conversationId as ConversationId,
              role: anyEvent.role ?? "user",
              content: anyEvent.content ?? [],
              status: "completed",
              createdAt: event.timestamp as Timestamp,
              updatedAt: event.timestamp as Timestamp,
            });
          }
          break;
        }

        case "message.delta": {
          if (existingIndex >= 0 && anyEvent.deltaText) {
            const currentMsg = updated[existingIndex];
            const contentParts = [...currentMsg.content];
            const lastPart = contentParts[contentParts.length - 1];

            if (lastPart && lastPart.type === "text") {
              contentParts[contentParts.length - 1] = {
                ...lastPart,
                text: lastPart.text + anyEvent.deltaText,
              };
            } else {
              contentParts.push({ type: "text", text: anyEvent.deltaText });
            }

            updated[existingIndex] = {
              ...currentMsg,
              content: contentParts,
              status: "streaming",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          break;
        }

        case "message.completed": {
          setIsStreaming(false);
          setActiveMessageId(null);
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "completed",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          break;
        }

        case "message.cancelled": {
          setIsStreaming(false);
          setActiveMessageId(null);
          if (existingIndex >= 0) {
            // Partial transcript preserved upon cancellation (§39.23, §39.34)
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "cancelled",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          break;
        }

        case "message.failed": {
          setIsStreaming(false);
          setActiveMessageId(null);
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "failed",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          setErrorMessage(anyEvent.error ?? "Generation failed");
          break;
        }
      }

      return updated;
    });
  }, []);

  // PR31 subscription-identity correction: the event subscription depends only
  // on the conversation/subscription lifecycle inputs it consumes. Model
  // selection must not tear down and recreate the subscription.
  // (Effect deps updated below: [conversationId, handleStreamEvent].)

  // Initial load and event subscription lifecycle (§39.37, §39.38)
  useEffect(() => {
    if (typeof window === "undefined" || !window.api) {
      return;
    }

    // Check IPC health
    window.api.commands.checkHealth().then((res) => {
      setHealthStatus(res.ok ? "healthy" : "offline");
    });

    // PR22: Load available models across providers
    window.api.commands.listProviderModels().then((res) => {
      if (res.ok && res.value.models) {
        setAvailableModels(res.value.models);
        if (res.value.models.length > 0 && !selectedModelId) {
          setSelectedModelId(res.value.models[0].id);
        }
      }
    });

    // PR22: Load persisted conversation model
    window.api.commands
      .getConversationModel({ conversationId: conversationId as ConversationId })
      .then((res) => {
        if (res.ok && res.value.modelSelection) {
          const selection = res.value.modelSelection as { modelId: string };
          setSelectedModelId(selection.modelId);
        }
      });

    // PR24: Load any pending permission requests
    window.api.commands.listPendingPermissionRequests().then((res) => {
      if (res.ok && res.value.requests) {
        setPendingPermissions(res.value.requests);
      }
    });

    // PR26: Load installed skills
    window.api.commands.listSkills().then((res) => {
      if (res.ok && res.value.skills) {
        setSkills(
          res.value.skills as Array<{ id: string; name: string; state: string; enabled: boolean }>,
        );
      }
    });

    // PR28: Load durable memories
    window.api.commands.listMemories().then((res) => {
      if (res.ok && res.value.facts) {
        setMemories(
          res.value.facts as Array<{
            id: string;
            content: string;
            category: string;
            scopeLevel: string;
            projectId?: string | null;
          }>,
        );
      }
    });

    // PR29: Load known agent tasks (in-process registry snapshot)
    window.api.commands.listAgentTasks().then(() => {
      void refreshAgentTasks();
    });

    // PR30: Load known coding tasks (in-process registry snapshot)
    window.api.commands.listCodingTasks().then(() => {
      void refreshCodingTasks();
    });

    // 1. Restart recovery: reload historical conversation state from SQLite WAL events
    window.api.commands
      .loadConversation({ conversationId: conversationId as ConversationId })
      .then((res) => {
        if (res.ok && res.value.conversation) {
          setMessages([...res.value.conversation.messages]);
        }
      })
      .catch((err) => {
        console.warn("Failed to load historical conversation:", err);
      });

    // 2. Subscribe to streaming events via typed IPC batcher
    let unsubscribeFn: (() => void) | null = null;
    window.api.events.subscribeToConversation(conversationId, handleStreamEvent).then((unsub) => {
      unsubscribeFn = unsub;
    });

    return () => {
      if (unsubscribeFn) {
        unsubscribeFn();
      }
    };
  }, [conversationId, handleStreamEvent]);

  // Model selection change handler (§42 / PR22.10)
  const handleModelChange = async (newModelId: string) => {
    setSelectedModelId(newModelId);
    if (!window.api) {
      return;
    }
    const model = availableModels.find((m) => m.id === newModelId);
    if (model) {
      try {
        await window.api.commands.setConversationModel({
          conversationId: conversationId as ConversationId,
          providerId: model.providerId,
          modelId: model.id,
        });
      } catch (err) {
        console.warn("Failed to set conversation model:", err);
      }
    }
  };

  // PR24: Permission resolution handler (Allow once, session, project, deny)
  const handleResolvePermission = async (
    requestId: string,
    decision: "granted" | "denied",
    mode: "allow_once" | "allow_session" | "allow_project" | "deny",
  ) => {
    if (!window.api) {
      return;
    }
    try {
      await window.api.commands.resolvePermission({
        requestId: requestId as unknown as import("@ai-desktop/ai-core").PermissionRequestId,
        decision,
        mode,
      });
      setPendingPermissions((prev) => prev.filter((p) => p.id !== requestId));
    } catch (err) {
      console.warn("Failed to resolve permission request:", err);
    }
  };

  // PR26: Skill toggle enable/disable handler
  const handleToggleSkill = async (skillId: string, currentlyEnabled: boolean) => {
    if (!window.api) return;
    try {
      if (currentlyEnabled) {
        await window.api.commands.disableSkill({ skillId });
      } else {
        await window.api.commands.enableSkill({ skillId });
      }
      const res = await window.api.commands.listSkills();
      if (res.ok && res.value.skills) {
        setSkills(
          res.value.skills as Array<{ id: string; name: string; state: string; enabled: boolean }>,
        );
      }
    } catch (err) {
      console.warn("Failed to toggle skill:", err);
    }
  };

  // PR29: Agent task handlers (TaskGraph + per-node ReAct orchestration mode)
  const refreshAgentTasks = useCallback(async () => {
    const api = window.api;
    if (!api) return;
    try {
      const res = await api.commands.listAgentTasks();
      if (res.ok && res.value.taskIds) {
        const snapshots = await Promise.all(
          res.value.taskIds.map(async (taskId: string) => {
            try {
              const got = await api.commands.getAgentTask({
                taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
              });
              if (got.ok) {
                const task = got.value.task as {
                  taskId: string;
                  status: string;
                  graph: { nodes: Array<{ id: string; goal: string; status: string }> } | null;
                };
                return { taskId: task.taskId, status: task.status, nodes: task.graph?.nodes ?? [] };
              }
            } catch {
              // Task may have settled between list and get; skip it
            }
            return null;
          }),
        );
        setAgentTasks(
          snapshots.filter(
            (
              t,
            ): t is {
              taskId: string;
              status: string;
              nodes: Array<{ id: string; goal: string; status: string }>;
            } => t !== null,
          ),
        );
      }
    } catch (err) {
      console.warn("Failed to list agent tasks:", err);
    }
  }, []);

  const handleStartAgentTask = async () => {
    if (!window.api) return;
    const goal = agentGoal.trim();
    if (!goal || agentRunning) return;
    setAgentRunning(true);
    try {
      const res = await window.api.commands.startAgentTask({
        conversationId: conversationId as ConversationId,
        goal,
      });
      if (!res.ok) {
        setErrorMessage(res.error.message);
      } else {
        setAgentGoal("");
        await refreshAgentTasks();
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start agent task");
    } finally {
      setAgentRunning(false);
    }
  };

  const handleCancelAgentTask = async (taskId: string) => {
    if (!window.api) return;
    try {
      await window.api.commands.cancelAgentTask({
        taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
      });
      await refreshAgentTasks();
    } catch (err) {
      console.warn("Failed to cancel agent task:", err);
    }
  };

  // PR30: Coding task handlers (workspace-bound, project-scoped)
  const refreshCodingTasks = useCallback(async () => {
    const api = window.api;
    if (!api) return;
    try {
      const res = await api.commands.listCodingTasks();
      if (res.ok && res.value.taskIds) {
        const snapshots = await Promise.all(
          res.value.taskIds.map(async (taskId: string) => {
            try {
              const got = await api.commands.getCodingTask({
                taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
              });
              if (got.ok) {
                const task = got.value.task as {
                  taskId: string;
                  status: string;
                  graph: { nodes: Array<{ id: string; goal: string; status: string }> } | null;
                };
                return { taskId: task.taskId, status: task.status, nodes: task.graph?.nodes ?? [] };
              }
            } catch {
              // Task may have settled between list and get; skip it
            }
            return null;
          }),
        );
        setCodingTasks(
          snapshots.filter(
            (
              t,
            ): t is {
              taskId: string;
              status: string;
              nodes: Array<{ id: string; goal: string; status: string }>;
            } => t !== null,
          ),
        );
      }
    } catch (err) {
      console.warn("Failed to list coding tasks:", err);
    }
  }, []);

  const handleStartCodingTask = async () => {
    if (!window.api) return;
    const prompt = codingPrompt.trim();
    if (!prompt || codingRunning) return;
    setCodingRunning(true);
    try {
      const res = await window.api.commands.startCodingTask({
        projectId: codingProjectId.trim() || "sample-project",
        prompt,
      });
      if (!res.ok) {
        setErrorMessage(res.error.message);
      } else {
        setCodingPrompt("");
        await refreshCodingTasks();
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start coding task");
    } finally {
      setCodingRunning(false);
    }
  };

  const handleCancelCodingTask = async (taskId: string) => {
    if (!window.api) return;
    try {
      await window.api.commands.cancelCodingTask({
        taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
      });
      await refreshCodingTasks();
    } catch (err) {
      console.warn("Failed to cancel coding task:", err);
    }
  };

  // PR28: Memory delete handler
  const handleDeleteMemory = async (factId: string) => {
    if (!window.api) return;
    try {
      await window.api.commands.deleteMemory({ id: factId });
      setMemories((prev) => prev.filter((m) => m.id !== factId));
    } catch (err) {
      console.warn("Failed to delete import_guard fact:", err);
    }
  };

  // Send message handler (§39.7, §39.35, §42)
  const handleSend = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    const text = inputText.trim();
    if (!text || isStreaming || !window.api) {
      return;
    }

    setInputText("");
    setErrorMessage(null);

    try {
      const res = await window.api.commands.sendChatMessage({
        conversationId: conversationId as ConversationId,
        content: text,
        modelId: selectedModelId || undefined,
      });

      if (!res.ok) {
        setErrorMessage(res.error.message);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  // Cancel active stream handler (§39.8, §39.26, §39.34)
  const handleCancel = async () => {
    if (!activeMessageId || !window.api) {
      return;
    }

    try {
      await window.api.commands.cancelChat({
        conversationId: conversationId as ConversationId,
        messageId: activeMessageId as MessageId,
      });
    } catch (err: unknown) {
      console.warn("Failed to cancel message:", err);
    }
  };

  function renderMessageText(parts: readonly ContentPart[]): string {
    return parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }

  // PR31: derived workspace views (presentation derivations, not backend state).
  const activeTaskEntry = (() => {
    const selected = workspace.state.activeTaskId;
    if (selected) {
      const agent = agentTasks.find((t) => t.taskId === selected);
      if (agent) return { ...agent, kind: "agent" as const };
      const coding = codingTasks.find((t) => t.taskId === selected);
      if (coding) return { ...coding, kind: "coding" as const };
    }
    return null;
  })();

  // PR33: selected rich-surface view derives from store selection.
  const selectedSurfaceView =
    workspace.state.selectedSurfaceId !== null
      ? (surfaces.find((s) => s.instanceId === workspace.state.selectedSurfaceId) ?? null)
      : null;

  return (
    <WorkspaceShell
      store={workspace}
      conversationId={conversationId}
      healthStatus={healthStatus}
      isStreaming={isStreaming}
      surfaceHost={{
        surfaceView: selectedSurfaceView,
        onSurfaceAction: (actionId, input) => void handleSurfaceAction(actionId, input),
        onSurfaceDispose: (instanceId) => void handleSurfaceDispose(instanceId),
      }}
      sidebar={{
        activeSurface: workspace.state.activeSurface,
        activeProjectId: workspace.state.activeProjectId,
        conversationId,
        agentActiveCount: agentTasks.filter((t) => t.status === "active" || t.status === "blocked")
          .length,
        codingActiveCount: codingTasks.filter(
          (t) => t.status === "active" || t.status === "blocked",
        ).length,
        leftVisible: workspace.state.leftPanel.visible,
        rightVisible: workspace.state.rightPanel.visible,
        onSelectSurface: workspace.selectSurface,
        onSelectProject: (projectId) => {
          workspace.selectProject(projectId);
          setCodingProjectId(projectId);
        },
        onToggleLeft: () => workspace.togglePanel("left"),
        onToggleRight: () => workspace.togglePanel("right"),
        availableModels,
        selectedModelId,
        isStreaming,
        onModelChange: (modelId) => void handleModelChange(modelId),
        skills,
        memories,
        onToggleSkill: (skillId, enabled) => void handleToggleSkill(skillId, enabled),
        onDeleteMemory: (factId) => void handleDeleteMemory(factId),
        extensionsSummary: {
          total: extensions.length,
          active: extensions.filter((e) => e.lifecycle === "enabled" || e.lifecycle === "active")
            .length,
        },
      }}
      chat={{
        messages,
        errorMessage,
        pendingPermissions,
        messagesEndRef,
        renderMessageText,
        onResolvePermission: (requestId, decision, mode) =>
          void handleResolvePermission(requestId, decision, mode),
      }}
      coding={{
        codingTasks,
        codingPrompt,
        codingProjectId,
        codingRunning,
        onPromptChange: setCodingPrompt,
        onProjectChange: (projectId) => {
          setCodingProjectId(projectId);
          workspace.selectProject(projectId);
        },
        onStart: () => void handleStartCodingTask(),
        onCancel: (taskId) => void handleCancelCodingTask(taskId),
      }}
      tasks={{
        agentTasks,
        codingTasks,
        activeTaskId: workspace.state.activeTaskId,
        agentGoal,
        agentRunning,
        onSelectTask: workspace.selectTask,
        onCancelAgent: (taskId) => void handleCancelAgentTask(taskId),
        onCancelCoding: (taskId) => void handleCancelCodingTask(taskId),
        onAgentGoalChange: setAgentGoal,
        onStartAgent: () => void handleStartAgentTask(),
      }}
      activity={activityEvents}
      files={touchedFiles}
      extensions={{
        extensions,
        activeProjectId: workspace.state.activeProjectId,
        selectedExtensionId,
        onSelectExtension: handleSelectExtension,
        onEnable: (extensionId) => void handleEnableExtension(extensionId),
        onDisable: (extensionId) => void handleDisableExtension(extensionId),
        onProjectToggle: (extensionId, enabled) =>
          void handleExtensionProjectToggle(extensionId, enabled),
      }}
      browser={{
        activeProjectId: workspace.state.activeProjectId,
        pages: browserPages,
        activePageId: activeBrowserPageId,
        onSelectPage: setActiveBrowserPageId,
        onOpenPage: (url) => void handleOpenBrowserPage(url),
        onClosePage: (pageId) => void handleCloseBrowserPage(pageId),
        onTakeScreenshot: (pageId) => void handleTakeScreenshot(pageId),
        screenshotArtifact: browserScreenshot,
      }}
      research={{
        activeProjectId: workspace.state.activeProjectId,
        query: researchQuery,
        searching: researchSearching,
        results: researchResults,
        opened: researchOpened,
        error: researchError,
        onQueryChange: setResearchQuery,
        onSearch: () => void handleResearchSearch(),
        onOpen: (url) => void handleResearchOpen(url),
        onOpenInBrowser: (url) => {
          workspace.selectSurface("browser");
          void handleOpenBrowserPage(url);
        },
        onClearOpened: () => setResearchOpened(null),
      }}
      inspector={{
        activeTask: activeTaskEntry,
        activeConversationId: conversationId,
        activeProjectId: workspace.state.activeProjectId,
        files: touchedFiles,
        activity: activityEvents,
        onCancelTask: (kind, taskId) => {
          if (kind === "agent") void handleCancelAgentTask(taskId);
          else void handleCancelCodingTask(taskId);
        },
        surfaces,
        selectedSurfaceId: workspace.state.selectedSurfaceId,
        onSelectSurface: (id) => workspace.selectSurfaceInstance(id),
      }}
      composer={{
        activeSurface: workspace.state.activeSurface,
        inputText,
        codingPrompt,
        isStreaming,
        codingRunning,
        activeProjectId: workspace.state.activeProjectId,
        onInputChange: setInputText,
        onCodingPromptChange: setCodingPrompt,
        onSend: (e) => void handleSend(e),
        onCancel: () => void handleCancel(),
        onStartCoding: () => void handleStartCodingTask(),
      }}
    />
  );
}

// PR31.11: canonical-event → human-readable activity labels (view only).
function activityKindFor(eventType: string): string {
  if (eventType.startsWith("task.")) return "task";
  if (eventType.startsWith("tool.")) return "tool";
  if (eventType.startsWith("execution.")) return "execution";
  if (eventType.startsWith("permission.")) return "permission";
  if (eventType.startsWith("message.")) return "message";
  return "message";
}

function describeActivityEvent(eventType: string, event: Record<string, unknown>): string {
  const toolName = typeof event.toolName === "string" ? event.toolName : null;
  const nodeId = typeof event.taskNodeId === "string" ? event.taskNodeId.slice(0, 8) : null;
  switch (eventType) {
    case "task.created":
      return "Task started";
    case "task.completed":
      return "Task completed";
    case "task.failed":
      return `Task failed: ${typeof event.error === "string" ? event.error.slice(0, 120) : "error"}`;
    case "task.cancelled":
      return "Task cancelled";
    case "task.blocked":
      return "Task blocked: approval required";
    case "task.replan":
      return "Plan revised";
    case "task.node.started":
      return nodeId ? `Node started (${nodeId}…)` : "Node started";
    case "task.node.completed":
      return nodeId ? `Node completed (${nodeId}…)` : "Node completed";
    case "task.node.failed":
      return "Node failed";
    case "tool.call.started":
      return toolName ? `Tool started: ${toolName}` : "Tool started";
    case "tool.call.completed":
      return toolName ? `Tool completed: ${toolName}` : "Tool completed";
    case "tool.call.failed":
      return toolName ? `Tool failed: ${toolName}` : "Tool failed";
    case "message.started":
      return "Assistant responding";
    case "message.completed":
      return "Message completed";
    case "message.cancelled":
      return "Message cancelled";
    case "message.failed":
      return "Message failed";
    case "permission.requested":
      return "Permission requested";
    default:
      return eventType;
  }
}
