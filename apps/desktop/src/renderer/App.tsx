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
import { WorkspaceShell } from "./components/workspace/Workspace.js";
import type {
  ActivityEventView,
  FileEntryView,
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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <WorkspaceShell
      store={workspace}
      conversationId={conversationId}
      healthStatus={healthStatus}
      isStreaming={isStreaming}
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
