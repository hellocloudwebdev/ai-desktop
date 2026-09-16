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
    <div className="flex h-full flex-col px-6 py-4 overflow-y-auto text-xs">
      <div className="flex items-center justify-between mb-2">
        <p className="text-slate-400">
          Project: <span className="font-mono text-slate-200">{activeProjectId}</span>
        </p>
        <p className="flex items-center gap-2">
          <span
            aria-label={micOn ? "Microphone active" : "Microphone off"}
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              micOn ? "bg-red-500 shadow-sm shadow-red-500/50" : "bg-slate-600"
            }`}
          />
          <span className="font-mono text-[10px] text-slate-500">
            {micOn ? "mic on" : "mic off"}
          </span>
          {session && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_STYLES[session.state]}`}
            >
              {session.state}
            </span>
          )}
        </p>
      </div>

      {error && <p className="text-red-400 mb-2">{error}</p>}

      <div className="flex items-center gap-2 mb-4">
        {!live ? (
          <button
            type="button"
            disabled={isWorking}
            onClick={() => onStart()}
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-white transition-colors"
          >
            {isWorking ? "Starting…" : "Start voice session"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onInterrupt()}
              className="rounded-lg bg-amber-700 hover:bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
            >
              Interrupt
            </button>
            <button
              type="button"
              onClick={() => onStop()}
              className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors"
            >
              Stop
            </button>
          </>
        )}
      </div>

      {partialTranscript && (
        <p className="text-slate-400 italic mb-2" aria-label="Partial transcript">
          {partialTranscript}…
        </p>
      )}

      {finalTranscripts.length === 0 && !partialTranscript ? (
        <p className="text-slate-500">No transcript yet. Start a session and speak.</p>
      ) : (
        <ul className="space-y-1">
          {finalTranscripts.map((t) => (
            <li key={t.turnId} className="rounded bg-slate-800/60 px-2 py-1.5">
              <span className="text-slate-200 break-words">{t.text}</span>
            </li>
          ))}
        </ul>
      )}

      {session && (
        <p className="mt-3 font-mono text-[10px] text-slate-600">
          {session.sessionId} · {session.modelId} via {session.providerId}
        </p>
      )}
    </div>
  );
}
