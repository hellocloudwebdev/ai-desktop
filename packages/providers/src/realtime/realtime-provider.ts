// PR40: packages/providers — Provider-neutral realtime contracts.
//
// Canonical realtime vocabulary (branded IDs, audio format, session states,
// capability strings, transcripts, events, errors, bounds) lives in
// @ai-desktop/ai-core (realtime.ts). This module adds the provider-side
// session interfaces whose implementations keep SDK types internal.
// No SDK imports here.

import type { ModelDefinition, RealtimeCapability } from "@ai-desktop/ai-core";

export {
  negotiateRealtimeCapabilities,
  createRealtimeError,
  validateAudioChunk,
  REALTIME_MAX_CHUNK_BYTES,
  REALTIME_MAX_QUEUE_CHUNKS,
  REALTIME_MAX_SESSIONS_PER_PROJECT,
  REALTIME_MAX_SESSION_DURATION_MS,
  REALTIME_MAX_TRANSCRIPT_CHARS,
  REALTIME_CHUNK_TIMEOUT_MS,
  DEFAULT_REALTIME_AUDIO_FORMAT,
} from "@ai-desktop/ai-core";
export type {
  AudioChunk,
  RealtimeCapability,
  RealtimeSessionConfig,
  RealtimeTranscript,
} from "@ai-desktop/ai-core";

/** Maximum number of provider events buffered per session (drop-oldest). */
export const REALTIME_EVENT_QUEUE_CAP = 256;

/** Default audio MIME type used when the caller does not specify one. */
export const REALTIME_DEFAULT_AUDIO_MIME_TYPE = "audio/pcm;rate=16000";

/** Prefix identifying coalesced queue-overflow error events. Exported for tests. */
export const REALTIME_QUEUE_OVERFLOW_PREFIX = "realtime event queue overflow";

/** Builds the PCM MIME type for a sample rate. */
export function realtimeAudioMimeType(sampleRate: number): string {
  return `audio/pcm;rate=${sampleRate}`;
}

/**
 * Provider-side capability record: which ai-core capability strings a
 * given model offers through this provider's realtime API.
 */
export interface ProviderRealtimeCapabilities {
  readonly capabilities: readonly RealtimeCapability[];
}

/** Empty capability record for providers with no realtime support. */
export function unsupportedRealtimeCapabilities(): ProviderRealtimeCapabilities {
  return { capabilities: [] };
}

/** Capability strings this provider layer requests by default. */
export const DEFAULT_REALTIME_REQUESTED: readonly RealtimeCapability[] = [
  "audio-input",
  "audio-output",
  "text-input",
  "text-output",
  "streaming",
  "interruption",
  "transcription",
  "turn-detection",
];

// ---------------------------------------------------------------------------
// Session request / session / events (provider-neutral, SDK-free)
// ---------------------------------------------------------------------------

export interface RealtimeSessionRequest {
  readonly model: ModelDefinition;
  readonly config: {
    readonly audioFormat?: {
      readonly sampleRate?: number;
      readonly channels?: number;
    };
    readonly turnDetection?: "provider" | "client" | "manual";
    readonly systemPrompt?: string;
    readonly signal?: AbortSignal;
  };
}

export interface RealtimeProviderSession {
  sendAudio(chunk: { payloadBase64: string; mimeType?: string }): Promise<void>;
  sendInput(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  events(): AsyncIterable<RealtimeProviderEvent>;
}

export interface RealtimeProviderEvent {
  readonly kind:
    "transcript-partial" | "transcript-final" | "audio-output" | "turn-complete" | "error";
  readonly text?: string;
  readonly audioBase64?: string;
  readonly mimeType?: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// RealtimeProvider interface
// ---------------------------------------------------------------------------

export interface RealtimeProvider {
  readonly providerId: string;
  supportsRealtime(model: ModelDefinition): boolean;
  getCapabilities(model: ModelDefinition): ProviderRealtimeCapabilities;
  createSession(request: RealtimeSessionRequest): Promise<RealtimeProviderSession>;
}
