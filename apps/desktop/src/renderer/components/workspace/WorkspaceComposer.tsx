// PR31.12: renderer — Workspace Composer (surface-aware routing)
//
// Routes to the existing paths only: chat surface → sendChatMessage,
// coding surface → startCodingTask. No new backend path.

import React from "react";
import type { ComposerProps } from "./surfaces/surface-props.js";

export function WorkspaceComposer({
  activeSurface,
  inputText,
  codingPrompt,
  isStreaming,
  codingRunning,
  activeProjectId,
  onInputChange,
  onCodingPromptChange,
  onSend,
  onCancel,
  onStartCoding,
}: ComposerProps): React.ReactElement {
  if (activeSurface === "coding") {
    return (
      <footer className="border-t border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onStartCoding();
          }}
          className="mx-auto flex max-w-4xl items-center space-x-3"
        >
          <span className="rounded bg-slate-800 px-2 py-1 text-[10px] font-mono text-slate-400 shrink-0">
            {activeProjectId}
          </span>
          <input
            type="text"
            value={codingPrompt}
            onChange={(e) => onCodingPromptChange(e.target.value)}
            placeholder="Describe the coding goal…"
            disabled={codingRunning}
            aria-label="Coding goal"
            className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!codingPrompt.trim() || codingRunning}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-md hover:bg-indigo-500 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {codingRunning ? "Starting…" : "Run task"}
          </button>
        </form>
      </footer>
    );
  }

  return (
    <footer className="border-t border-slate-800 bg-slate-900/60 p-4 backdrop-blur-sm">
      <form onSubmit={onSend} className="mx-auto flex max-w-4xl items-center space-x-3">
        <input
          type="text"
          value={inputText}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={isStreaming ? "Assistant is streaming..." : "Type your message..."}
          disabled={isStreaming}
          aria-label="Chat message"
          className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={onCancel}
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
  );
}
