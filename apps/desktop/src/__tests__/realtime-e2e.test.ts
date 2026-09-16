// PR40: apps/desktop — Realtime End-to-End Tests
//
// Full RealtimeService + scripted fake live provider: session lifecycle with
// chat handoff, interrupt/resume, project isolation, mid-session provider
// failure, cancellation idempotence, and permission-denied start. No new
// dependencies.
//
// DISCREPANCY vs the brief: E2E6 asserts zero captures were ever created
// (start throws at the capture-start permission gate before the capture
// factory runs), rather than released === true on a non-existent capture.

import { describe, expect, it } from "vitest";
import type { PermissionDecisionResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { IEventBus } from "@ai-desktop/agent-runtime";
import type {
  RealtimeProvider,
  RealtimeProviderEvent,
  RealtimeProviderSession,
} from "@ai-desktop/providers";
import { RealtimeService } from "../main/realtime/realtime-service.js";
import type { AudioCapture } from "../main/realtime/realtime-service.js";

class GatePermissions implements PermissionManager {
  constructor(public mode: "allow" | "deny" = "allow") {}

  async check(): Promise<PermissionDecisionResult> {
    return this.mode === "allow" ? { kind: "allow" } : { kind: "deny", reason: "denied for test" };
  }

  async resolve(): Promise<boolean> {
    return true;
  }

  async revoke(): Promise<number> {
    return 0;
  }

  getPendingRequest(): undefined {
    return undefined;
  }

  listPendingRequests(): readonly [] {
    return [];
  }

  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

class MemoryBus implements IEventBus {
  readonly events: unknown[] = [];

  async publish(event: unknown): Promise<void> {
    this.events.push(event);
  }

  subscribe(): () => void {
    return () => undefined;
  }

  once(): () => void {
    return () => undefined;
  }

  get subscriberCount(): number {
    return 0;
  }

  clear(): void {}
}

class LiveSession implements RealtimeProviderSession {
  closeCalls = 0;
  closed = false;
  interrupted = 0;
  sentAudio = 0;

  constructor(private readonly _script: readonly RealtimeProviderEvent[] = []) {}

  async sendAudio(): Promise<void> {
    this.sentAudio += 1;
  }

  async sendInput(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
  }

  async *events(): AsyncGenerator<RealtimeProviderEvent> {
    for (const event of this._script) {
      yield event;
    }
  }
}

/** Provider event stream dies mid-session: yields once, then throws. */
class DyingSession extends LiveSession {
  override async *events(): AsyncGenerator<RealtimeProviderEvent> {
    yield { kind: "audio-output", audioBase64: "AAAA" };
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error("socket died mid-session");
  }
}

class LiveProvider implements RealtimeProvider {
  readonly providerId = "fake-live";
  createCalls = 0;
  readonly sessions: LiveSession[] = [];
  constructor(
    private readonly _scripts: RealtimeProviderEvent[][] = [],
    private readonly _dieAtIndex = -1,
  ) {}

  supportsRealtime(): boolean {
    return true;
  }

  getCapabilities() {
    return { capabilities: ["audio-input", "audio-output", "transcription"] as never };
  }

  async createSession(): Promise<RealtimeProviderSession> {
    const index = this.createCalls;
    this.createCalls += 1;
    const session =
      index === this._dieAtIndex ? new DyingSession() : new LiveSession(this._scripts[index] ?? []);
    this.sessions.push(session);
    return session;
  }
}

class TrackingCapture implements AudioCapture {
  onChunk: ((chunk: { payloadBase64: string }) => void) | null = null;
  private _released = false;

  get released(): boolean {
    return this._released;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  release(): void {
    this._released = true;
    this.onChunk = null;
  }
}

function makeService(scripts: RealtimeProviderEvent[][] = [], dieAtIndex = -1) {
  const bus = new MemoryBus();
  const perms = new GatePermissions();
  const provider = new LiveProvider(scripts, dieAtIndex);
  const captures: TrackingCapture[] = [];
  const handoffs: Array<{ content: string; projectId: string; conversationId: string }> = [];
  const service = new RealtimeService({
    permissionManager: perms,
    eventBus: bus,
    providers: [provider],
    captureFactory: () => {
      const capture = new TrackingCapture();
      captures.push(capture);
      return capture;
    },
    chatHandoff: async (input) => {
      handoffs.push({
        content: input.content,
        projectId: input.projectId,
        conversationId: input.conversationId,
      });
    },
    toolInvoker: async () => ({ isError: false, result: "ok" }),
  });
  return { service, bus, perms, provider, captures, handoffs };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function durableTypes(bus: MemoryBus): string[] {
  return bus.events.map((e) => (e as { type: string }).type);
}

describe("realtime e2e", () => {
  it("E2E1 create -> start -> audio -> transcript-final -> chat handoff -> stop", async () => {
    const h = makeService([[{ kind: "transcript-final", text: "hello from live session" }]]);
    const created = await h.service.createSession({
      projectId: "p1",
      modelId: "live",
      conversationId: "conv-e2e-1",
    });
    const partials: Array<{ text: string; final: boolean }> = [];
    h.service.subscribe(created.sessionId, (event) => {
      if (event.kind === "transcript-partial") {
        partials.push(event.payload as { text: string; final: boolean });
      }
    });
    await h.service.startSession(created.sessionId);
    await h.service.ingestAudio(created.sessionId, "AAAA");
    expect(h.provider.sessions[0]?.sentAudio).toBeGreaterThanOrEqual(1);

    await waitFor(() => h.handoffs.length === 1);
    expect(h.handoffs[0]).toMatchObject({
      content: "hello from live session",
      projectId: "p1",
      conversationId: "conv-e2e-1",
    });
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({ text: "hello from live session", final: true });

    const stopped = await h.service.stopSession(created.sessionId);
    expect(stopped.state).toBe("stopped");
    expect(durableTypes(h.bus)).toEqual(
      expect.arrayContaining([
        "session.created",
        "session.started",
        "transcript.final",
        "session.completed",
      ]),
    );
    expect(h.captures[0]?.released).toBe(true);
  });

  it("E2E2 speaking -> interrupt -> listening with a new turn", async () => {
    const h = makeService([[{ kind: "audio-output", audioBase64: "AAAA" }]]);
    const created = await h.service.createSession({ projectId: "p1", modelId: "live" });
    await h.service.startSession(created.sessionId);
    await waitFor(() => h.service.snapshot(created.sessionId).state === "speaking");
    expect(h.service.getPlayback(created.sessionId).queued).toBeGreaterThanOrEqual(1);

    const turnBefore = h.service.snapshot(created.sessionId).turnId;
    const after = await h.service.interrupt(created.sessionId);
    expect(after.state).toBe("listening");
    expect(after.turnId).not.toBe(turnBefore);
    expect(h.service.getPlayback(created.sessionId).queued).toBe(0);
    expect(h.provider.sessions[0]?.interrupted).toBe(1);
    await h.service.stopSession(created.sessionId);
  });

  it("E2E3 project isolation: audio and transcripts never cross projects", async () => {
    const h = makeService([
      [{ kind: "transcript-final", text: "hello project A" }],
      [{ kind: "transcript-final", text: "hello project B" }],
    ]);
    const a = await h.service.createSession({
      projectId: "pA",
      modelId: "live",
      conversationId: "conv-A",
    });
    const b = await h.service.createSession({
      projectId: "pB",
      modelId: "live",
      conversationId: "conv-B",
    });
    const aSeen: Array<{ sessionId: string; payload: unknown }> = [];
    const bSeen: Array<{ sessionId: string; payload: unknown }> = [];
    h.service.subscribe(a.sessionId, (event) => {
      aSeen.push({ sessionId: event.sessionId, payload: event.payload });
    });
    h.service.subscribe(b.sessionId, (event) => {
      bSeen.push({ sessionId: event.sessionId, payload: event.payload });
    });
    // Start order binds script[0] -> A and script[1] -> B.
    await h.service.startSession(a.sessionId);
    await h.service.startSession(b.sessionId);
    await h.service.ingestAudio(a.sessionId, "AAAA");

    await waitFor(() => h.handoffs.length === 2);
    for (const entry of aSeen) {
      expect(entry.sessionId).toBe(a.sessionId);
    }
    for (const entry of bSeen) {
      expect(entry.sessionId).toBe(b.sessionId);
    }
    expect(JSON.stringify(aSeen)).toContain("hello project A");
    expect(JSON.stringify(aSeen)).not.toContain("hello project B");
    expect(JSON.stringify(bSeen)).toContain("hello project B");
    expect(JSON.stringify(bSeen)).not.toContain("hello project A");
    const handoffA = h.handoffs.find((x) => x.conversationId === "conv-A");
    const handoffB = h.handoffs.find((x) => x.conversationId === "conv-B");
    expect(handoffA).toMatchObject({ content: "hello project A", projectId: "pA" });
    expect(handoffB).toMatchObject({ content: "hello project B", projectId: "pB" });
    expect(h.provider.sessions[0]?.sentAudio).toBe(1);
    expect(h.provider.sessions[1]?.sentAudio).toBe(0);
    await h.service.stopSession(a.sessionId);
    await h.service.stopSession(b.sessionId);
  });

  it("E2E4 provider failure mid-session -> failed state, capture released, failed event", async () => {
    const h = makeService([], 0);
    const created = await h.service.createSession({ projectId: "p1", modelId: "live" });
    await h.service.startSession(created.sessionId);
    await waitFor(() => h.service.snapshot(created.sessionId).state === "failed");
    expect(h.captures[0]?.released).toBe(true);
    expect(h.provider.sessions[0]?.closed).toBe(true);
    expect(durableTypes(h.bus)).toContain("session.failed");
  });

  it("E2E5 cancellation is idempotent: three cancels -> single provider close", async () => {
    const h = makeService();
    const created = await h.service.createSession({ projectId: "p1", modelId: "live" });
    await h.service.startSession(created.sessionId);
    const first = await h.service.cancelSession(created.sessionId);
    expect(first.state).toBe("cancelled");
    const second = await h.service.cancelSession(created.sessionId);
    expect(second.state).toBe("cancelled");
    const third = await h.service.cancelSession(created.sessionId);
    expect(third.state).toBe("cancelled");
    expect(h.provider.sessions[0]?.closeCalls).toBe(1);
    expect(durableTypes(h.bus).filter((t) => t === "session.cancelled")).toHaveLength(1);
  });

  it("E2E6 permission-denied start throws and never opens the microphone", async () => {
    const h = makeService();
    const created = await h.service.createSession({ projectId: "p1", modelId: "live" });
    h.perms.mode = "deny";
    await expect(h.service.startSession(created.sessionId)).rejects.toThrow(/denied|permission/i);
    expect(h.captures).toHaveLength(0);
    expect(h.provider.createCalls).toBe(0);
    expect(h.service.snapshot(created.sessionId).state).toBe("idle");
  });
});
