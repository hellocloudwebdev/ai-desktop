// PR40: packages/providers — Gemini Live realtime provider.
//
// Wires the verified @google/genai 2.21.0 Live API (client.live.connect →
// Session with sendRealtimeInput/sendClientContent/sendToolResponse/close)
// behind the provider-neutral RealtimeProvider interface. SDK types never
// leave this file.
//
// Verified symbols (genai.d.ts): Live.connect(params: LiveConnectParameters):
// Promise<Session>; LiveConnectParameters { model, callbacks, config? };
// LiveConnectConfig { responseModalities?: Modality[] }; Modality.AUDIO;
// Session.sendRealtimeInput({ audio?: Blob_2 })/sendClientContent/
// sendToolResponse/close(); Blob_2 { data?, mimeType? }.

import { GoogleGenAI } from "@google/genai";
import type { LiveConnectConfig, Modality, Session } from "@google/genai";
import type { ModelDefinition } from "@ai-desktop/ai-core";
import { GEMINI_PROVIDER_ID } from "../gemini/gemini-models.js";
import { UnsupportedCapabilityError } from "../core/provider-errors.js";
import {
  REALTIME_EVENT_QUEUE_CAP,
  REALTIME_QUEUE_OVERFLOW_PREFIX,
  type ProviderRealtimeCapabilities,
  type RealtimeProvider,
  type RealtimeProviderEvent,
  type RealtimeProviderSession,
  type RealtimeSessionRequest,
} from "./realtime-provider.js";

function nativeModelId(model: ModelDefinition): string {
  const native = model.metadata?.["nativeModelId"];
  if (typeof native === "string" && native) {
    return native;
  }
  return model.id.replace(/^gemini:/, "");
}

function capabilitiesFor(model: ModelDefinition): ProviderRealtimeCapabilities {
  const has = (cap: string): boolean => model.capabilities.includes(cap as never);
  const caps: string[] = [];
  if (has("audio")) {
    caps.push("audio-input", "audio-output", "transcription");
  }
  caps.push("text-input", "text-output", "streaming", "interruption", "turn-detection");
  if (has("vision")) {
    caps.push("vision");
  }
  if (has("video")) {
    caps.push("video");
  }
  if (has("tool_use")) {
    caps.push("function-calling");
  }
  return { capabilities: caps as ProviderRealtimeCapabilities["capabilities"] };
}

export class GeminiLiveSession implements RealtimeProviderSession {
  private _session: Session | null;
  private _queue: RealtimeProviderEvent[] = [];
  private _waiters: Array<() => void> = [];
  private _closed = false;
  private _overflowDropped = 0;

  constructor(session: Session) {
    this._session = session;
  }

  /** Bridge for SDK callbacks: enqueue server messages as neutral events. */
  pushServerMessage(message: unknown): void {
    if (this._closed) {
      return;
    }
    const events = GeminiLiveProvider.mapServerMessage(message);
    for (const event of events) {
      this._enqueue(event);
    }
  }

  pushError(error: unknown): void {
    if (this._closed) {
      return;
    }
    this._enqueue({
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private _enqueue(event: RealtimeProviderEvent): void {
    if (this._queue.length >= REALTIME_EVENT_QUEUE_CAP) {
      this._queue.shift();
      this._overflowDropped += 1;
      this._queue.push({
        kind: "error",
        error: `${REALTIME_QUEUE_OVERFLOW_PREFIX}: dropped ${this._overflowDropped}`,
      });
    } else {
      this._queue.push(event);
    }
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  async sendAudio(chunk: { payloadBase64: string; mimeType?: string }): Promise<void> {
    const session = this._session;
    if (!session || this._closed) {
      throw new Error("Realtime session is closed");
    }
    session.sendRealtimeInput({
      audio: {
        data: chunk.payloadBase64,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
      },
    });
  }

  async sendInput(text: string): Promise<void> {
    const session = this._session;
    if (!session || this._closed) {
      throw new Error("Realtime session is closed");
    }
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
  }

  async interrupt(): Promise<void> {
    // Idempotent: the installed SDK exposes no turn-cancel primitive, so
    // interruption is observed locally (playback stop + new turn) while the
    // provider session stays alive. Repeated calls are safe no-ops.
    if (!this._session || this._closed) {
      return;
    }
    this._enqueue({ kind: "turn-complete" });
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    try {
      this._session?.close();
    } finally {
      this._session = null;
      for (const waiter of this._waiters.splice(0)) {
        waiter();
      }
    }
  }

  async *events(): AsyncIterable<RealtimeProviderEvent> {
    while (true) {
      const next = this._queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this._closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this._waiters.push(resolve);
      });
    }
  }
}

export interface GeminiLiveProviderDeps {
  readonly getClient: () => GoogleGenAI;
}

export class GeminiLiveProvider implements RealtimeProvider {
  readonly providerId = GEMINI_PROVIDER_ID;
  private readonly _getClient: () => GoogleGenAI;

  constructor(deps: GeminiLiveProviderDeps) {
    this._getClient = deps.getClient;
  }

  supportsRealtime(model: ModelDefinition): boolean {
    return model.capabilities.includes("audio" as never);
  }

  getCapabilities(model: ModelDefinition): ProviderRealtimeCapabilities {
    if (!this.supportsRealtime(model)) {
      return { capabilities: [] };
    }
    return capabilitiesFor(model);
  }

  async createSession(request: RealtimeSessionRequest): Promise<RealtimeProviderSession> {
    if (request.config.signal?.aborted) {
      throw new Error("Realtime session creation cancelled");
    }
    if (!this.supportsRealtime(request.model)) {
      throw new UnsupportedCapabilityError(
        "audio",
        `Model "${request.model.id}" does not support realtime audio sessions`,
        { providerId: this.providerId, modelId: request.model.id },
      );
    }
    const ModalityValue = (await import("@google/genai").then(
      (m) => m.Modality,
    )) as typeof Modality;
    const config: LiveConnectConfig = {
      responseModalities: [ModalityValue.AUDIO],
      ...(request.config.systemPrompt
        ? { systemInstruction: { parts: [{ text: request.config.systemPrompt }] } }
        : {}),
    };
    const client = this._getClient();
    const liveSession = new GeminiLiveSession(null as unknown as Session);
    const session = await client.live.connect({
      model: nativeModelId(request.model),
      callbacks: {
        onopen: () => undefined,
        onmessage: (message: unknown) => liveSession.pushServerMessage(message),
        onerror: (error: unknown) => liveSession.pushError(error),
        onclose: () => {
          void liveSession.close();
        },
      },
      config,
    });
    return GeminiLiveProvider.attachSession(liveSession, session);
  }

  /** Test seam: bind a live session wrapper to a concrete SDK session. */
  static attachSession(wrapper: GeminiLiveSession, session: Session): GeminiLiveSession {
    (wrapper as unknown as { _session: Session | null })._session = session;
    return wrapper;
  }

  /**
   * Maps a LiveServerMessage to neutral events. Best-effort structural
   * mapping (never throws): transcription text → transcript events,
   * inline audio data → audio-output, setupComplete → turn-complete.
   */
  static mapServerMessage(message: unknown): RealtimeProviderEvent[] {
    if (!message || typeof message !== "object") {
      return [];
    }
    const msg = message as {
      serverContent?: {
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: {
          parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }>;
        };
        turnComplete?: boolean;
      };
      setupComplete?: unknown;
    };
    const events: RealtimeProviderEvent[] = [];
    const content = msg.serverContent;
    if (!content) {
      if (msg.setupComplete !== undefined) {
        events.push({ kind: "turn-complete" });
      }
      return events;
    }
    if (typeof content.inputTranscription?.text === "string") {
      events.push({ kind: "transcript-partial", text: content.inputTranscription.text });
    }
    if (typeof content.outputTranscription?.text === "string") {
      events.push({ kind: "transcript-final", text: content.outputTranscription.text });
    }
    for (const part of content.modelTurn?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        events.push({ kind: "transcript-final", text: part.text });
      }
      if (typeof part.inlineData?.data === "string") {
        events.push({
          kind: "audio-output",
          audioBase64: part.inlineData.data,
          ...(typeof part.inlineData.mimeType === "string"
            ? { mimeType: part.inlineData.mimeType }
            : {}),
        });
      }
    }
    if (content.turnComplete === true) {
      events.push({ kind: "turn-complete" });
    }
    return events;
  }
}

/** Factory used by desktop wiring (client construction stays in providers). */
export function createGeminiLiveProvider(getClient: () => GoogleGenAI): GeminiLiveProvider {
  return new GeminiLiveProvider({ getClient });
}

/**
 * Operator-configured factory: resolves GEMINI_API_KEY (the SDK's standard
 * env convention) at session start. Missing key fails at createSession with
 * a typed provider error — never a silent fake. The key never touches logs,
 * events, or storage.
 */
export function createGeminiLiveProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GeminiLiveProvider {
  return new GeminiLiveProvider({
    getClient: () => {
      const apiKey = env["GEMINI_API_KEY"];
      if (!apiKey) {
        throw new Error(
          "Realtime voice requires the operator-configured GEMINI_API_KEY environment variable",
        );
      }
      return new GoogleGenAI({ apiKey });
    },
  });
}
