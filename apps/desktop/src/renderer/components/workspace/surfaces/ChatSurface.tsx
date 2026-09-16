// PR31.6: renderer — Chat Surface (verbatim extraction from App.tsx)
//
// Existing conversation UI: message bubbles, permission banner, error banner.
// Behavior unchanged: ChatService + IPC + projections remain the owners.
//
// PR39: bounded inline-image rendering for image message parts. Only parts
// whose payload stays under the cap render as thumbnails; larger payloads
// (provider-bound main-side bytes) render as a placeholder card.
// Audio/video parts render as metadata cards, never as embedded media.

import React from "react";
import type { ChatSurfaceProps } from "./surface-props.js";

const CHAT_IMAGE_RENDER_BYTES = 500_000;

function imagePayloadLength(data: string): number {
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    return comma >= 0 ? data.length - comma - 1 : data.length;
  }
  // Raw base64 payload (chat-service image parts carry bare base64).
  return data.length;
}

function toImageSrc(mimeType: string, data: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

export function ChatSurface({
  messages,
  errorMessage,
  pendingPermissions,
  messagesEndRef,
  renderMessageText,
  onResolvePermission,
}: ChatSurfaceProps): React.ReactElement {
  return (
    <div className="flex h-full flex-col">
      <section
        aria-label="Conversation messages"
        className="flex-1 overflow-y-auto px-6 py-4 space-y-4"
      >
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
            const mediaParts = msg.content.filter(
              (p): p is Extract<typeof p, { type: "image" | "audio" | "video" }> =>
                p.type === "image" || p.type === "audio" || p.type === "video",
            );

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
                  {mediaParts.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {mediaParts.map((part, index) => {
                        const key = `${msg.id}-media-${index}`;
                        if (part.type === "image") {
                          if (imagePayloadLength(part.data) >= CHAT_IMAGE_RENDER_BYTES) {
                            return (
                              <p key={key} className="text-xs text-slate-400">
                                [image attachment: {part.mimeType} — preview too large]
                              </p>
                            );
                          }
                          return (
                            <img
                              key={key}
                              src={toImageSrc(part.mimeType, part.data)}
                              alt={part.alt ?? "Attached image"}
                              className="max-h-48 rounded-lg"
                            />
                          );
                        }
                        return (
                          <p key={key} className="text-xs text-slate-400">
                            [{part.type} attachment: {part.mimeType}]
                          </p>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </section>

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
              onClick={() => onResolvePermission(pendingPermissions[0].id, "granted", "allow_once")}
              className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() =>
                onResolvePermission(pendingPermissions[0].id, "granted", "allow_session")
              }
              className="rounded-lg bg-emerald-800 hover:bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Allow for session
            </button>
            <button
              type="button"
              onClick={() =>
                onResolvePermission(pendingPermissions[0].id, "granted", "allow_project")
              }
              className="rounded-lg bg-indigo-700 hover:bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Allow for project
            </button>
            <button
              type="button"
              onClick={() => onResolvePermission(pendingPermissions[0].id, "denied", "deny")}
              className="rounded-lg bg-rose-800 hover:bg-rose-700 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="mx-6 mb-2 rounded-lg bg-rose-950/80 border border-rose-800 px-4 py-2 text-xs text-rose-200">
          Error: {errorMessage}
        </div>
      )}
    </div>
  );
}
