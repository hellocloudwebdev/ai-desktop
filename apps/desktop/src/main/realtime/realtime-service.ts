// PR40: apps/desktop — Realtime Service
//
// Voice interaction mode over the existing runtime (NOT a second agent
// loop). Owns session lifecycle, bounded audio queues, interruption,
// idempotent cleanup, and chat handoff. Provider SDKs stay behind the
// RealtimeProvider interface; microphone/audio hardware stays behind the
// AudioCapture/AudioPlayback interfaces (renderer capture/playback via
// typed IPC events).
//
// Audio privacy: raw chunks stay in bounded memory, flow to the provider,
// and are discarded. Only session.* + transcript.final + turn.completed
// reach the durable EventBus; partials and audio chunks are ephemeral.

import {
  createRealtimeSessionId,
  createRealtimeTurnId,
  REALTIME_MAX_QUEUE_CHUNKS,
  REALTIME_MAX_SESSIONS_PER_PROJECT,
  realtimeRiskFor,
  validateAudioChunk,
  validateRealtimeTransition,
  type AudioChunk,
  type RealtimeSessionState,
} from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import { createEventId, type EventId } from "@ai-desktop/ai-core";
import { createToolCallId, now, type ConversationId, type ToolCallId } from "@ai-desktop/shared";
import type { IEventBus } from "@ai-desktop/agent-runtime";
import type { RealtimeProvider, RealtimeProviderSession } from "@ai-desktop/providers";
import {
  RealtimeCancelledError,
  RealtimeCapabilityError,
  RealtimePermissionError,
  RealtimeProviderError,
  RealtimeSessionStateError,
  toCanonicalRealtimeError,
} from "./realtime-errors.js";

export interface AudioCapture {
  start(): Promise<void>;
  stop(): Promise<void>;
  release(): void;
  readonly released: boolean;
  onChunk: ((chunk: { payloadBase64: string }) => void) | null;
}

export interface AudioPlayback {
  enqueue(audioBase64: string): void;
  stop(): void;
  clear(): void;
  readonly queued: number;
}

/** Null capture for CI/headless: no physical microphone required. */
export class NullAudioCapture implements AudioCapture {
  onChunk: ((chunk: { payloadBase64: string }) => void) | null = null;
  private _released = false;

  get released(): boolean {
    return this._released;
  }

  async start(): Promise<void> {
    if (this._released) {
      throw new Error("Capture released");
    }
  }

  async stop(): Promise<void> {}

  release(): void {
    this._released = true;
    this.onChunk = null;
  }
}

/** In-memory playback queue (tests + headless): renderer plays via IPC events. */
export class BufferedPlayback implements AudioPlayback {
  private _queue: string[] = [];

  get queued(): number {
    return this._queue.length;
  }

  enqueue(audioBase64: string): void {
    if (this._queue.length >= REALTIME_MAX_QUEUE_CHUNKS) {
      this._queue.shift();
    }
    this._queue.push(audioBase64);
  }

  stop(): void {
    this._queue = [];
  }

  clear(): void {
    this._queue = [];
  }
}

export interface EphemeralRealtimeEvent {
  readonly sessionId: string;
  readonly kind: "audio-input" | "audio-output" | "transcript-partial" | "state" | "turn";
  readonly payload: unknown;
}

export interface RealtimeServiceDeps {
  readonly permissionManager: PermissionManager;
  readonly eventBus: IEventBus;
  readonly providers: readonly RealtimeProvider[];
  readonly captureFactory?: () => AudioCapture;
  readonly playbackFactory?: () => AudioPlayback;
  readonly chatHandoff?: (input: {
    conversationId: string;
    content: string;
    projectId: string;
  }) => Promise<void>;
  readonly toolInvoker?: (
    toolName: string,
    input: unknown,
    context: { toolCallId: ToolCallId; projectId?: string },
    signal?: AbortSignal,
  ) => Promise<{ isError: boolean; result: unknown }>;
  readonly clock?: () => number;
}

export interface CreateSessionInput {
  readonly projectId: string;
  readonly modelId: string;
  readonly providerId?: string;
  readonly conversationId?: string;
  readonly turnDetection?: "provider" | "client" | "manual";
  readonly toolCallId?: ToolCallId;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly projectId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly state: RealtimeSessionState;
  readonly turnId: string | null;
  readonly startedAt: number;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly projectId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly conversationId?: string;
  state: RealtimeSessionState;
  turnId: string | null;
  readonly startedAt: number;
  providerSession: RealtimeProviderSession | null;
  capture: AudioCapture | null;
  playback: AudioPlayback;
  controller: AbortController | null;
  pumpPromise: Promise<void> | null;
  audioQueue: AudioChunk[];
  cleanedUp: boolean;
  /** Bounded retained transcripts (in-memory only, cleared on cleanup). */
  retainedPartials: Array<{ turnId: string; text: string }>;
  retainedFinals: Array<{ turnId: string; text: string }>;
}

const TERMINAL_STATES: readonly RealtimeSessionState[] = ["stopped", "failed", "cancelled"];

export class RealtimeService {
  private readonly _permissionManager: PermissionManager;
  private readonly _eventBus: IEventBus;
  private readonly _providers: readonly RealtimeProvider[];
  private readonly _captureFactory: () => AudioCapture;
  private readonly _playbackFactory: () => AudioPlayback;
  private readonly _chatHandoff?: RealtimeServiceDeps["chatHandoff"];
  private readonly _toolInvoker?: RealtimeServiceDeps["toolInvoker"];
  private readonly _clock: () => number;
  private readonly _sessions = new Map<string, SessionRecord>();
  private readonly _ephemeral = new Map<string, Set<(event: EphemeralRealtimeEvent) => void>>();
  private _sequence = 0;

  constructor(deps: RealtimeServiceDeps) {
    this._permissionManager = deps.permissionManager;
    this._eventBus = deps.eventBus;
    this._providers = deps.providers;
    this._captureFactory = deps.captureFactory ?? (() => new NullAudioCapture());
    this._playbackFactory = deps.playbackFactory ?? (() => new BufferedPlayback());
    this._chatHandoff = deps.chatHandoff;
    this._toolInvoker = deps.toolInvoker;
    this._clock = deps.clock ?? Date.now;
  }

  /** Ephemeral subscription: partials + audio chunks (never persisted). */
  subscribe(sessionId: string, listener: (event: EphemeralRealtimeEvent) => void): () => void {
    let set = this._ephemeral.get(sessionId);
    if (!set) {
      set = new Set();
      this._ephemeral.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private _emitEphemeral(
    sessionId: string,
    kind: EphemeralRealtimeEvent["kind"],
    payload: unknown,
  ): void {
    const set = this._ephemeral.get(sessionId);
    if (!set) {
      return;
    }
    for (const listener of [...set]) {
      try {
        listener({ sessionId, kind, payload });
      } catch {
        // Listener errors never break the session.
      }
    }
  }

  private _nextSequence(): number {
    this._sequence += 1;
    return this._sequence;
  }

  private async _publishDurable(input: {
    conversationId: string;
    type: string;
    sessionId: string;
    projectId: string;
    extra?: Record<string, unknown>;
  }): Promise<void> {
    await this._eventBus.publish({
      eventId: createEventId() as EventId,
      conversationId: input.conversationId as ConversationId,
      sequence: this._nextSequence(),
      schemaVersion: 1,
      timestamp: now(),
      type: input.type,
      category: "extension",
      sessionId: input.sessionId,
      projectId: input.projectId,
      ...(input.extra ?? {}),
    } as never);
  }

  private _get(sessionId: string): SessionRecord {
    const record = this._sessions.get(sessionId);
    if (!record) {
      throw new RealtimeSessionStateError(`Unknown realtime session "${sessionId}"`);
    }
    return record;
  }

  private _setState(record: SessionRecord, next: RealtimeSessionState): void {
    if (!validateRealtimeTransition(record.state, next)) {
      throw new RealtimeSessionStateError(`Illegal realtime transition: ${record.state} → ${next}`);
    }
    record.state = next;
    this._emitEphemeral(record.sessionId, "state", { state: next });
  }

  private _activeForProject(projectId: string): SessionRecord | undefined {
    for (const record of this._sessions.values()) {
      if (record.projectId === projectId && !TERMINAL_STATES.includes(record.state)) {
        return record;
      }
    }
    return undefined;
  }

  private _countForProject(projectId: string): number {
    let count = 0;
    for (const record of this._sessions.values()) {
      if (record.projectId === projectId && !TERMINAL_STATES.includes(record.state)) {
        count += 1;
      }
    }
    return count;
  }

  private async _check(
    capability: string,
    action: string,
    resource: string,
    projectId: string | undefined,
    toolCallId: ToolCallId,
  ): Promise<void> {
    const decision = await this._permissionManager.check(
      {
        capability,
        action,
        resource,
        scope: "once",
        risk: realtimeRiskFor(action as never),
        relatedToolCallIds: [toolCallId],
      },
      ...(projectId ? [{ projectId } as { projectId: string }] : []),
    );
    if (decision.kind !== "allow") {
      throw new RealtimePermissionError(
        decision.kind === "deny"
          ? `Permission denied: ${decision.reason ?? "Denied by permission policy"}`
          : "Requires user permission confirmation",
      );
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    const toolCallId = input.toolCallId ?? createToolCallId();
    await this._check(
      "realtime",
      "session-create",
      `realtime:session:${input.projectId}`,
      input.projectId,
      toolCallId,
    );
    if (this._activeForProject(input.projectId)) {
      throw new RealtimeSessionStateError(
        `Project "${input.projectId}" already has an active realtime session`,
      );
    }
    if (this._countForProject(input.projectId) >= REALTIME_MAX_SESSIONS_PER_PROJECT) {
      throw new RealtimeSessionStateError("Project session budget exhausted");
    }
    const sessionId = createRealtimeSessionId();
    const record: SessionRecord = {
      sessionId,
      projectId: input.projectId,
      modelId: input.modelId,
      providerId: input.providerId ?? "gemini",
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      state: "idle",
      turnId: null,
      startedAt: this._clock(),
      providerSession: null,
      capture: null,
      playback: this._playbackFactory(),
      controller: null,
      pumpPromise: null,
      audioQueue: [],
      cleanedUp: false,
      retainedPartials: [],
      retainedFinals: [],
    };
    this._sessions.set(sessionId, record);
    await this._publishDurable({
      conversationId: (input.conversationId ?? sessionId) as string,
      type: "session.created",
      sessionId,
      projectId: input.projectId,
    });
    return this.snapshot(sessionId);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const record = this._get(sessionId);
    return {
      sessionId: record.sessionId,
      projectId: record.projectId,
      modelId: record.modelId,
      providerId: record.providerId,
      state: record.state,
      turnId: record.turnId,
      startedAt: record.startedAt,
    };
  }

  listSessions(projectId?: string): SessionSnapshot[] {
    const out: SessionSnapshot[] = [];
    for (const record of this._sessions.values()) {
      if (projectId && record.projectId !== projectId) {
        continue;
      }
      out.push(this.snapshot(record.sessionId));
    }
    return out;
  }

  /**
   * Provider capability overview for model selection UI. Never exposes
   * credentials — provider ids and capability strings only.
   */
  providerCapabilities(): Array<{ providerId: string; realtime: boolean }> {
    return this._providers.map((provider) => ({
      providerId: provider.providerId,
      realtime: provider.supportsRealtime({ capabilities: ["audio"] } as never),
    }));
  }

  private _resolveProvider(record: SessionRecord): RealtimeProvider {
    const provider =
      this._providers.find((p) => p.providerId === record.providerId) ?? this._providers[0];
    if (!provider) {
      throw new RealtimeProviderError("No realtime provider available");
    }
    return provider;
  }

  async startSession(
    sessionId: string,
    opts?: { toolCallId?: ToolCallId },
  ): Promise<SessionSnapshot> {
    const record = this._get(sessionId);
    const toolCallId = opts?.toolCallId ?? createToolCallId();
    await this._check(
      "realtime",
      "capture-start",
      `realtime:capture:${record.projectId}`,
      record.projectId,
      toolCallId,
    );
    this._setState(record, "requesting-permission");
    await this._check(
      "realtime",
      "session-start",
      `realtime:session:${record.projectId}`,
      record.projectId,
      toolCallId,
    );
    this._setState(record, "starting");

    const provider = this._resolveProvider(record);
    const model = { id: record.modelId, capabilities: [] as string[] };
    if (!provider.supportsRealtime(model as never)) {
      this._setState(record, "failed");
      throw new RealtimeCapabilityError(
        `Provider "${provider.providerId}" does not support realtime for model "${record.modelId}"`,
      );
    }
    const controller = new AbortController();
    record.controller = controller;
    try {
      const providerSession = await provider.createSession({
        model: model as never,
        config: { signal: controller.signal },
      });
      record.providerSession = providerSession;
      const capture = this._captureFactory();
      record.capture = capture;
      capture.onChunk = (chunk) => {
        void this.ingestAudio(sessionId, chunk.payloadBase64).catch(() => undefined);
      };
      await capture.start();
      this._setState(record, "active");
      this._setState(record, "listening");
      record.pumpPromise = this._pump(record, controller.signal).catch(() => undefined);
      await this._publishDurable({
        conversationId: (record.conversationId ?? sessionId) as string,
        type: "session.started",
        sessionId,
        projectId: record.projectId,
      });
      return this.snapshot(sessionId);
    } catch (err) {
      if (controller.signal.aborted) {
        await this._cleanup(record, "cancelled");
        throw new RealtimeCancelledError();
      }
      await this._cleanup(record, "failed");
      throw toCanonicalRealtimeError(err);
    }
  }

  private async _pump(record: SessionRecord, signal: AbortSignal): Promise<void> {
    const session = record.providerSession;
    if (!session) {
      return;
    }
    try {
      for await (const event of session.events()) {
        if (signal.aborted) {
          return;
        }
        await this._handleProviderEvent(record, event);
      }
    } catch {
      if (!signal.aborted && !record.cleanedUp) {
        await this._cleanup(record, "failed").catch(() => undefined);
      }
    }
  }

  private async _handleProviderEvent(
    record: SessionRecord,
    event: { kind: string; text?: string; audioBase64?: string; mimeType?: string; error?: string },
  ): Promise<void> {
    switch (event.kind) {
      case "transcript-partial":
        this._emitEphemeral(record.sessionId, "transcript-partial", {
          turnId: record.turnId,
          text: (event.text ?? "").slice(0, 8000),
          final: false,
        });
        if (record.turnId) {
          record.retainedPartials.push({
            turnId: record.turnId,
            text: (event.text ?? "").slice(0, 8000),
          });
          if (record.retainedPartials.length > 10) {
            record.retainedPartials.shift();
          }
        }
        break;
      case "transcript-final": {
        const text = (event.text ?? "").slice(0, 8000);
        const turnId = record.turnId ?? createRealtimeTurnId();
        record.turnId = turnId;
        this._emitEphemeral(record.sessionId, "transcript-partial", {
          turnId,
          text,
          final: true,
        });
        record.retainedFinals.push({ turnId, text });
        if (record.retainedFinals.length > 50) {
          record.retainedFinals.shift();
        }
        await this._publishDurable({
          conversationId: (record.conversationId ?? record.sessionId) as string,
          type: "transcript.final",
          sessionId: record.sessionId,
          projectId: record.projectId,
          extra: { turnId, text },
        });
        if (record.conversationId && this._chatHandoff) {
          await this._chatHandoff({
            conversationId: record.conversationId,
            content: text,
            projectId: record.projectId,
          }).catch(() => undefined);
        }
        break;
      }
      case "audio-output":
        if (typeof event.audioBase64 === "string") {
          record.playback.enqueue(event.audioBase64);
          this._emitEphemeral(record.sessionId, "audio-output", {
            audioBase64: event.audioBase64,
            mimeType: event.mimeType,
          });
          if (record.state === "listening" || record.state === "thinking") {
            this._setState(record, "speaking");
          }
        }
        break;
      case "turn-complete":
        if (record.state === "speaking" || record.state === "thinking") {
          this._setState(record, "listening");
        }
        this._emitEphemeral(record.sessionId, "turn", { turnId: record.turnId, completed: true });
        await this._publishDurable({
          conversationId: (record.conversationId ?? record.sessionId) as string,
          type: "turn.completed",
          sessionId: record.sessionId,
          projectId: record.projectId,
        });
        record.turnId = null;
        break;
      case "error":
        await this._publishDurable({
          conversationId: (record.conversationId ?? record.sessionId) as string,
          type: "session.failed",
          sessionId: record.sessionId,
          projectId: record.projectId,
          extra: { error: (event.error ?? "provider error").slice(0, 500) },
        });
        break;
    }
  }

  async ingestAudio(sessionId: string, payloadBase64: string): Promise<void> {
    const record = this._get(sessionId);
    if (TERMINAL_STATES.includes(record.state)) {
      throw new RealtimeSessionStateError("Session is closed");
    }
    // Every audio frame re-verifies capture permission: revocation
    // mid-session stops the flow at the next chunk (fail-closed).
    await this._check(
      "realtime",
      "capture-start",
      `realtime:capture:${record.projectId}`,
      record.projectId,
      createToolCallId(),
    );
    const validated = validateAudioChunk({ payloadBase64, sequence: 0, timestampMs: 0 });
    if (!validated.ok) {
      throw new RealtimeProviderError(`Invalid audio chunk: ${validated.code}`);
    }
    if (record.audioQueue.length >= 256) {
      record.audioQueue.shift();
    }
    record.audioQueue.push({
      payloadBase64,
      sequence: record.audioQueue.length,
      timestampMs: this._clock(),
    });
    this._emitEphemeral(record.sessionId, "audio-input", {
      sequence: record.audioQueue.length,
    });
    if (record.state === "listening" && record.turnId === null) {
      record.turnId = createRealtimeTurnId();
      this._emitEphemeral(record.sessionId, "turn", { turnId: record.turnId, started: true });
    }
    const session = record.providerSession;
    if (session && !record.controller?.signal.aborted) {
      await session.sendAudio({ payloadBase64 }).catch(() => undefined);
    }
  }

  async interrupt(sessionId: string, opts?: { toolCallId?: ToolCallId }): Promise<SessionSnapshot> {
    const record = this._get(sessionId);
    const toolCallId = opts?.toolCallId ?? createToolCallId();
    await this._check(
      "realtime",
      "session-interrupt",
      `realtime:session:${record.projectId}`,
      record.projectId,
      toolCallId,
    );
    // Idempotent: interrupting outside speaking is a safe no-op.
    if (record.state !== "speaking") {
      return this.snapshot(sessionId);
    }
    record.playback.stop();
    await record.providerSession?.interrupt().catch(() => undefined);
    this._setState(record, "interrupted");
    this._setState(record, "listening");
    record.turnId = createRealtimeTurnId();
    this._emitEphemeral(record.sessionId, "turn", { turnId: record.turnId, started: true });
    return this.snapshot(sessionId);
  }

  async stopSession(
    sessionId: string,
    opts?: { toolCallId?: ToolCallId },
  ): Promise<SessionSnapshot> {
    const record = this._get(sessionId);
    const toolCallId = opts?.toolCallId ?? createToolCallId();
    await this._check(
      "realtime",
      "session-stop",
      `realtime:session:${record.projectId}`,
      record.projectId,
      toolCallId,
    ).catch(() => undefined);
    await this._cleanup(record, "stopped");
    return this.snapshot(sessionId);
  }

  async cancelSession(sessionId: string): Promise<SessionSnapshot> {
    const record = this._sessions.get(sessionId);
    if (!record || record.cleanedUp) {
      // Idempotent: unknown or finished sessions report a cancelled snapshot.
      return {
        sessionId,
        projectId: record?.projectId ?? "unknown",
        modelId: record?.modelId ?? "unknown",
        providerId: record?.providerId ?? "unknown",
        state: "cancelled",
        turnId: null,
        startedAt: record?.startedAt ?? this._clock(),
      };
    }
    record.controller?.abort();
    await this._cleanup(record, "cancelled");
    return this.snapshot(sessionId);
  }

  private async _cleanup(
    record: SessionRecord,
    terminal: "stopped" | "failed" | "cancelled",
  ): Promise<void> {
    if (record.cleanedUp) {
      return;
    }
    record.cleanedUp = true;
    record.controller?.abort();
    try {
      await record.capture?.stop();
    } catch {
      // Capture stop failures never block cleanup.
    }
    record.capture?.release();
    record.capture = null;
    record.playback.stop();
    try {
      await record.providerSession?.close();
    } catch {
      // Provider close failures never block cleanup.
    }
    record.providerSession = null;
    record.audioQueue = [];
    if (record.state !== terminal) {
      try {
        this._setState(record, terminal);
      } catch {
        record.state = terminal;
      }
    }
    this._ephemeral.delete(record.sessionId);
    await this._publishDurable({
      conversationId: (record.conversationId ?? record.sessionId) as string,
      type: terminal === "stopped" ? "session.completed" : `session.${terminal}`,
      sessionId: record.sessionId,
      projectId: record.projectId,
    }).catch(() => undefined);
  }

  /**
   * Bounded retained transcripts for UI polling (in-memory only, never
   * persisted; cleared on cleanup). Polling keeps renderer free of
   * push-channel privileges beyond typed invoke.
   */
  getTranscripts(sessionId: string): {
    partial: { turnId: string; text: string } | null;
    finals: Array<{ turnId: string; text: string }>;
  } {
    const record = this._get(sessionId);
    return {
      partial: record.retainedPartials[record.retainedPartials.length - 1] ?? null,
      finals: [...record.retainedFinals],
    };
  }

  /**
   * Tool bridge for provider function calls: canonical tool request through
   * the injected invoker (universal lifecycle + permission enforced by the
   * invoker). Returns text for the provider; never throws to providers.
   */
  async dispatchToolCall(sessionId: string, toolName: string, input: unknown): Promise<string> {
    const record = this._get(sessionId);
    if (!this._toolInvoker) {
      throw new RealtimeProviderError("Tool bridge unavailable");
    }
    try {
      const outcome = await this._toolInvoker(
        toolName,
        input,
        { toolCallId: createToolCallId(), projectId: record.projectId },
        record.controller?.signal,
      );
      return typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
    } catch (err) {
      return `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  getPlayback(sessionId: string): AudioPlayback {
    return this._get(sessionId).playback;
  }
}
