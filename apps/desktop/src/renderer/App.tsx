import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ConversationId, MessageId, Timestamp } from "@ai-desktop/shared";
import type { AIEvent, Message, ContentPart, ModelDefinition } from "@ai-desktop/ai-core";

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
