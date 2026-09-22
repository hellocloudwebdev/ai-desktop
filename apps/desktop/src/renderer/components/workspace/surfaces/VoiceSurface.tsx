// PR40: renderer — Voice/Realtime Surface
//
// Status + transcript view over App-owned realtime state. Owns no domain
// behavior: session lifecycle, microphone capture, and playback stay behind
// the realtime:* preload commands and arrive here as handler props. The
// microphone indicator mirrors session state (visible capture = active
// session in listening/speaking).

import React from "react";
import type { VoiceSurfaceProps, VoiceSessionView } from "./surface-props.js";

const STATE_STYLES: Record<VoiceSessionView["state"], string> = {
  idle: "bg-slate-700 text-slate-300",
  "requesting-permission": "bg-amber-800 text-amber-100",
  starting: "bg-amber-800 text-amber-100",
  active: "bg-indigo-800 text-indigo-100",
  listening: "bg-emerald-800 text-emerald-100",
  thinking: "bg-indigo-800 text-indigo-100",
  speaking: "bg-violet-800 text-violet-100",
  interrupted: "bg-amber-800 text-amber-100",
  stopping: "bg-slate-700 text-slate-300",
  stopped: "bg-slate-800 text-slate-500",
  failed: "bg-red-800 text-red-100",
  cancelled: "bg-slate-800 text-slate-500",
};

export function VoiceSurface({
  activeProjectId,
  session,
  partialTranscript,
  finalTranscripts,
  isWorking,
  error,
  onStart,
  onInterrupt,
  onStop,
}: VoiceSurfaceProps): React.ReactElement {
  const live = session !== null && !["stopped", "failed", "cancelled"].includes(session.state);
  const micOn = session !== null && ["listening", "speaking"].includes(session.state);

  return (
    <div className="flex h-full flex-col px-6 py-5 overflow-y-auto text-xs max-w-4xl">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800/80">
        <p className="text-slate-400">
          Project: <span className="font-mono text-slate-200 font-medium">{activeProjectId}</span>
        </p>
        <div className="flex items-center gap-2.5">
          <span
            aria-label={micOn ? "Microphone active" : "Microphone off"}
            className={`inline-block h-2.5 w-2.5 rounded-full transition-all ${
              micOn ? "bg-rose-500 shadow-sm shadow-rose-500/80 animate-pulse" : "bg-slate-600"
            }`}
          />
          <span className="font-mono text-[11px] text-slate-400">
            {micOn ? "mic on" : "mic off"}
          </span>
          {session && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium border ${STATE_STYLES[session.state]}`}
            >
              {session.state}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-800/60 bg-rose-950/40 p-3 text-rose-300">
          <p>{error}</p>
        </div>
      )}

      <div className="flex items-center gap-2.5 mb-5">
        {!live ? (
          <button
            type="button"
            disabled={isWorking}
            onClick={() => onStart()}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-emerald-600/30 active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            {isWorking ? "Starting…" : "Start voice session"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onInterrupt()}
              className="rounded-xl bg-amber-600 hover:bg-amber-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-amber-600/30 active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              Interrupt
            </button>
            <button
              type="button"
              onClick={() => onStop()}
              className="rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700/80 px-4 py-2 text-xs font-medium text-slate-200 transition-all focus:outline-none"
            >
              Stop
            </button>
          </>
        )}
      </div>

      {partialTranscript && (
        <div className="mb-4 rounded-xl border border-indigo-500/40 bg-indigo-950/20 p-3.5 shadow-sm">
          <p
            className="text-slate-300 italic text-xs leading-relaxed"
            aria-label="Partial transcript"
          >
            {partialTranscript}…
          </p>
        </div>
      )}

      {finalTranscripts.length === 0 && !partialTranscript ? (
        <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500 italic">
          <p>No transcript yet. Start a session and speak.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {finalTranscripts.map((t) => (
            <li
              key={t.turnId}
              className="rounded-xl bg-slate-900/70 border border-slate-800/80 p-3.5 shadow-sm"
            >
              <span className="text-slate-200 break-words leading-relaxed">{t.text}</span>
            </li>
          ))}
        </ul>
      )}

      {session && (
        <p className="mt-4 font-mono text-[11px] text-slate-500">
          {session.sessionId} · {session.modelId} via {session.providerId}
        </p>
      )}
    </div>
  );
}
