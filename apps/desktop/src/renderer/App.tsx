import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ConversationId, MessageId, Timestamp } from "@ai-desktop/shared";
import type {
  AIEvent,
  Message,
  ContentPart,
  ModelDefinition,
  PermissionRequest,
} from "@ai-desktop/ai-core";

const DEFAULT_CONVERSATION_ID = "01JM0000000000000000000001";

export function App(): React.ReactElement {
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
  const [showSkills, setShowSkills] = useState<boolean>(false);
  const [memories, setMemories] = useState<
    Array<{
      id: string;
      content: string;
      category: string;
      scopeLevel: string;
      projectId?: string | null;
    }>
  >([]);
  const [showMemories, setShowMemories] = useState<boolean>(false);
  const [agentTasks, setAgentTasks] = useState<
    Array<{
      taskId: string;
      status: string;
      nodes: Array<{ id: string; goal: string; status: string }>;
    }>
  >([]);
  const [showAgentTasks, setShowAgentTasks] = useState<boolean>(false);
  const [agentGoal, setAgentGoal] = useState<string>("");
  const [agentRunning, setAgentRunning] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to latest message
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle incoming stream events incrementally (§39.29, §39.33)
  const handleStreamEvent = useCallback((event: AIEvent) => {
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
  }, [conversationId, handleStreamEvent, selectedModelId]);

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

  return (
    <main className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 font-sans">
      {/* Top Header */}
      <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-900/60 px-6 backdrop-blur-sm">
        <div className="flex items-center space-x-3">
          <div className="h-3 w-3 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
          <h1 className="text-base font-semibold text-white">AI Desktop</h1>
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-400 font-mono">
            {conversationId.slice(0, 10)}…
          </span>
        </div>

        <div className="flex items-center space-x-4">
          {/* Provider & Model Selector (PR22.10) */}
          <div className="flex items-center space-x-2">
            <label htmlFor="model-select" className="text-xs text-slate-400 font-medium">
              Model:
            </label>
            <select
              id="model-select"
              value={selectedModelId}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={isStreaming}
              className="rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} ({m.providerId})
                </option>
              ))}
            </select>
          </div>

          {/* Skills Management Trigger (PR26.17) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSkills((v) => !v)}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none transition-colors"
            >
              Skills ({skills.filter((s) => s.enabled).length})
            </button>
            {showSkills && (
              <div className="absolute right-0 mt-2 w-64 rounded-xl bg-slate-900 border border-slate-700 p-3 shadow-xl z-50">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
                  <span className="font-semibold text-xs text-white">Installed Skills</span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {skills.length} packages
                  </span>
                </div>
                {skills.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">No skills installed.</p>
                ) : (
                  <ul className="space-y-2">
                    {skills.map((s) => (
                      <li key={s.id} className="flex items-center justify-between text-xs">
                        <div>
                          <div className="font-medium text-slate-200">{s.name}</div>
                          <div className="text-[10px] text-slate-400">
                            {s.active ? "Active" : s.enabled ? "Enabled" : "Disabled"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleSkill(s.id, s.enabled)}
                          className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                            s.enabled
                              ? "bg-emerald-800 hover:bg-emerald-700 text-emerald-100"
                              : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                          }`}
                        >
                          {s.enabled ? "Enabled" : "Enable"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Memory Management Trigger (PR28.13) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMemories((v) => !v)}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none transition-colors"
            >
              Memory ({memories.length})
            </button>
            {showMemories && (
              <div className="absolute right-0 mt-2 w-80 rounded-xl bg-slate-900 border border-slate-700 p-3 shadow-xl z-50 max-h-96 overflow-y-auto">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
                  <span className="font-semibold text-xs text-white">Durable Memory</span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {memories.length} facts
                  </span>
                </div>
                {memories.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">No import_guard facts stored yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {memories.map((m) => (
                      <li key={m.id} className="rounded-lg bg-slate-800/60 p-2 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 font-mono">
                            {m.scopeLevel === "project"
                              ? `project:${m.projectId ?? "?"}`
                              : "global"}
                            /{m.category}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleDeleteMemory(m.id)}
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200"
                          >
                            Delete
                          </button>
                        </div>
                        <div className="text-slate-200 leading-relaxed">{m.content}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Agent Tasks Trigger (PR29.17): TaskGraph progress + Cancel */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowAgentTasks((v) => !v);
                void refreshAgentTasks();
              }}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs text-slate-200 focus:outline-none transition-colors"
            >
              Agent (
              {agentTasks.filter((t) => t.status === "active" || t.status === "blocked").length})
            </button>
            {showAgentTasks && (
              <div className="absolute right-0 mt-2 w-96 rounded-xl bg-slate-900 border border-slate-700 p-3 shadow-xl z-50 max-h-96 overflow-y-auto">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
                  <span className="font-semibold text-xs text-white">Agent Tasks</span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {agentTasks.length} tasks
                  </span>
                </div>
                <div className="flex items-center space-x-2 mb-3">
                  <input
                    type="text"
                    value={agentGoal}
                    onChange={(e) => setAgentGoal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleStartAgentTask();
                    }}
                    placeholder="Describe a multi-step goal…"
                    disabled={agentRunning}
                    className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void handleStartAgentTask()}
                    disabled={agentRunning || !agentGoal.trim()}
                    className="rounded-lg bg-indigo-700 hover:bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                  >
                    {agentRunning ? "Starting…" : "Run"}
                  </button>
                </div>
                {agentTasks.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">No agent tasks yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {agentTasks.map((t) => (
                      <li key={t.taskId} className="rounded-lg bg-slate-800/60 p-2 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 font-mono">
                            {t.taskId.slice(0, 8)}… · {t.status}
                          </span>
                          {(t.status === "active" || t.status === "blocked") && (
                            <button
                              type="button"
                              onClick={() => void handleCancelAgentTask(t.taskId)}
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                        {t.nodes.length > 0 && (
                          <ul className="space-y-1 mt-1">
                            {t.nodes.map((n) => (
                              <li
                                key={n.id}
                                className="flex items-center space-x-1.5 text-[11px] text-slate-300"
                              >
                                <span
                                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                                    n.status === "completed"
                                      ? "bg-emerald-400"
                                      : n.status === "failed"
                                        ? "bg-rose-400"
                                        : n.status === "active"
                                          ? "bg-amber-400 animate-pulse"
                                          : n.status === "blocked"
                                            ? "bg-orange-400"
                                            : "bg-slate-500"
                                  }`}
                                />
                                <span className="truncate">{n.goal}</span>
                                <span className="text-slate-500 font-mono">[{n.status}]</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center space-x-3 text-xs text-slate-400 font-mono">
            <span>IPC: {healthStatus}</span>
            {isStreaming && (
              <span className="inline-flex items-center text-amber-400 animate-pulse">
                ● streaming
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Messages List Area */}
      <section className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
            <p className="text-sm">No messages yet in this conversation.</p>
            <p className="text-xs mt-1">
              Send a message below to start streaming with Claude 3.5 Sonnet.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === "user";
            const text = renderMessageText(msg.content);

            return (
              <div key={msg.id} className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
                <div
                  className={`max-w-2xl rounded-2xl px-4 py-3 shadow-md ${
                    isUser
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-900 border border-slate-800 text-slate-100"
                  }`}
                >
                  <div className="flex items-center space-x-2 mb-1.5 text-xs">
                    <span className="font-semibold uppercase tracking-wider text-slate-300">
                      {isUser ? "You" : "Assistant"}
                    </span>
                    {msg.status === "streaming" && (
                      <span className="text-amber-400 text-[10px] animate-pulse">
                        [generating…]
                      </span>
                    )}
                    {msg.status === "cancelled" && (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300 font-medium">
                        cancelled
                      </span>
                    )}
                    {msg.status === "failed" && (
                      <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300 font-medium">
                        failed
                      </span>
                    )}
                  </div>

                  <div className="text-sm leading-relaxed whitespace-pre-wrap">
                    {text || (msg.status === "streaming" ? "…" : "")}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </section>

      {/* Pending Permission Requests Prompt (PR24.9) */}
      {pendingPermissions.length > 0 && (
        <div className="mx-6 mb-3 rounded-xl bg-amber-950/80 border border-amber-700/60 p-4 text-xs text-amber-100 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-amber-300 uppercase tracking-wider text-[11px]">
              Permission Request: {pendingPermissions[0].capability}
            </span>
            <span className="rounded bg-amber-900/60 px-2 py-0.5 text-[10px] text-amber-300 font-mono">
              Risk: {pendingPermissions[0].risk}
            </span>
          </div>
          <p className="mb-3 text-slate-200">
            Action: <span className="font-mono text-amber-200">{pendingPermissions[0].action}</span>{" "}
            on resource:{" "}
            <span className="font-mono text-amber-200">{pendingPermissions[0].resource}</span>
          </p>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() =>
                handleResolvePermission(pendingPermissions[0].id, "granted", "allow_once")
              }
              className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() =>
                handleResolvePermission(pendingPermissions[0].id, "granted", "allow_session")
              }
              className="rounded-lg bg-emerald-800 hover:bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Allow for session
            </button>
            <button
              type="button"
              onClick={() =>
                handleResolvePermission(pendingPermissions[0].id, "granted", "allow_project")
              }
              className="rounded-lg bg-indigo-700 hover:bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Allow for project
            </button>
            <button
              type="button"
              onClick={() => handleResolvePermission(pendingPermissions[0].id, "denied", "deny")}
              className="rounded-lg bg-rose-800 hover:bg-rose-700 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {errorMessage && (
        <div className="mx-6 mb-2 rounded-lg bg-rose-950/80 border border-rose-800 px-4 py-2 text-xs text-rose-200">
          Error: {errorMessage}
        </div>
      )}

      {/* Bottom Input & Control Area */}
      <footer className="border-t border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
        <form onSubmit={handleSend} className="mx-auto flex max-w-4xl items-center space-x-3">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={isStreaming ? "Assistant is streaming..." : "Type your message..."}
            disabled={isStreaming}
            className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          />

          {isStreaming ? (
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-md hover:bg-rose-500 active:scale-95 transition-all"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputText.trim()}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-md hover:bg-indigo-500 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Send
            </button>
          )}
        </form>
      </footer>
    </main>
  );
}
