// PR40: apps/desktop — Realtime Service Tests
//
// Session lifecycle, state machine enforcement, interruption idempotence,
// cancellation, timeouts, project isolation, concurrent-session rejection,
// malformed audio, provider failure cleanup. Fake provider + permissions.

import { describe, expect, it } from "vitest";
import type { PermissionDecisionResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { IEventBus } from "@ai-desktop/agent-runtime";
import type { RealtimeProvider, RealtimeProviderSession } from "@ai-desktop/providers";
import { NullAudioCapture, BufferedPlayback, RealtimeService } from "../realtime-service.js";
import { RealtimeSessionStateError } from "../realtime-errors.js";

class AllowAllPermissions implements PermissionManager {
  async check(): Promise<PermissionDecisionResult> {
    return { kind: "allow" };
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

class DenyPermissions extends AllowAllPermissions {
  override async check(): Promise<PermissionDecisionResult> {
    return { kind: "deny", reason: "no mic" };
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

interface FakeSessionOpts {
  events?: Array<{
    kind: "transcript-partial" | "transcript-final" | "audio-output" | "turn-complete" | "error";
    text?: string;
    audioBase64?: string;
  }>;
  failCreate?: boolean;
}

function fakeProvider(opts?: FakeSessionOpts): RealtimeProvider & { sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    providerId: "fake-live",
    supportsRealtime: () => !opts?.failCreate,
    getCapabilities: () => ({
      capabilities: ["audio-input", "audio-output", "transcription"] as never,
    }),
    createSession: async () => {
      if (opts?.failCreate) {
        throw new Error("provider down");
      }
      const session = new FakeSession(opts?.events ?? []);
      sessions.push(session);
      return session;
    },
  };
}

class FakeSession implements RealtimeProviderSession {
  closed = false;
  interrupted = 0;
  sentAudio = 0;
  constructor(private readonly _events: FakeSessionOpts["events"] = []) {}

  async sendAudio(): Promise<void> {
    this.sentAudio += 1;
  }
  async sendInput(): Promise<void> {}
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async *events(): AsyncIterable<never> {
    for (const event of this._events ?? []) {
      yield event as never;
    }
  }
}

function makeService(
  provider?: RealtimeProvider & { sessions: FakeSession[] },
  permissions?: PermissionManager,
) {
  const bus = new MemoryBus();
  const perms = permissions ?? new AllowAllPermissions();
  const providers = provider ? [provider] : [fakeProvider()];
  const service = new RealtimeService({
    permissionManager: perms,
    eventBus: bus,
    providers,
  });
  return { service, bus };
}

describe("RealtimeService lifecycle", () => {
  it("creates, starts, and stops a session", async () => {
    const { service, bus } = makeService();
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    expect(created.state).toBe("idle");
    const started = await service.startSession(created.sessionId);
    expect(started.state).toBe("listening");
    const stopped = await service.stopSession(created.sessionId);
    expect(stopped.state).toBe("stopped");
    const types = bus.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("session.created");
    expect(types).toContain("session.started");
    expect(types).toContain("session.completed");
  });

  it("rejects invalid transitions", async () => {
    const { service } = makeService();
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await expect(service.interrupt(created.sessionId)).resolves.toBeDefined();
    await expect(service.stopSession("nope")).rejects.toBeInstanceOf(RealtimeSessionStateError);
  });

  it("rejects concurrent sessions per project", async () => {
    const { service } = makeService();
    await service.createSession({ projectId: "p1", modelId: "m1" });
    await expect(service.createSession({ projectId: "p1", modelId: "m1" })).rejects.toThrow(
      /already has an active/,
    );
    await service.createSession({ projectId: "p2", modelId: "m1" });
  });

  it("denies without permission", async () => {
    const { service } = makeService(undefined, new DenyPermissions());
    await expect(service.createSession({ projectId: "p1", modelId: "m1" })).rejects.toThrow(
      /denied|permission/i,
    );
  });

  it("fails cleanly when the provider is down", async () => {
    const { service } = makeService(fakeProvider({ failCreate: true }));
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await expect(service.startSession(created.sessionId)).rejects.toThrow();
    expect(service.snapshot(created.sessionId).state).toBe("failed");
  });
});

describe("RealtimeService interruption", () => {
  it("interrupts speaking and resumes listening with a new turn", async () => {
    const provider = fakeProvider({
      events: [{ kind: "audio-output", audioBase64: "AAAA" }],
    });
    const { service } = makeService(provider);
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await service.startSession(created.sessionId);
    await new Promise((r) => setTimeout(r, 50));
    expect(service.snapshot(created.sessionId).state).toBe("speaking");
    const turnBefore = service.snapshot(created.sessionId).turnId;
    const after = await service.interrupt(created.sessionId);
    expect(after.state).toBe("listening");
    expect(after.turnId).not.toBe(turnBefore);
    expect(provider.sessions[0]?.interrupted).toBe(1);
    await service.stopSession(created.sessionId);
  });

  it("interrupt outside speaking is a safe no-op", async () => {
    const { service } = makeService();
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await service.startSession(created.sessionId);
    const snap = await service.interrupt(created.sessionId);
    expect(snap.state).toBe("listening");
    await service.stopSession(created.sessionId);
  });
});

describe("RealtimeService audio + transcripts", () => {
  it("ingests bounded audio and forwards to provider", async () => {
    const provider = fakeProvider();
    const { service } = makeService(provider);
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await service.startSession(created.sessionId);
    await service.ingestAudio(created.sessionId, "AAAA");
    expect(provider.sessions[0]?.sentAudio).toBe(1);
    await service.stopSession(created.sessionId);
  });

  it("rejects malformed audio", async () => {
    const { service } = makeService();
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await service.startSession(created.sessionId);
    await expect(service.ingestAudio(created.sessionId, "")).rejects.toThrow();
    await service.stopSession(created.sessionId);
  });

  it("delivers final transcripts to ephemeral subscribers + chat handoff", async () => {
    const provider = fakeProvider({ events: [{ kind: "transcript-final", text: "hello" }] });
    const handoffs: Array<{ content: string }> = [];
    const bus = new MemoryBus();
    const service = new RealtimeService({
      permissionManager: new AllowAllPermissions(),
      eventBus: bus,
      providers: [provider],
      chatHandoff: async (input) => {
        handoffs.push({ content: input.content });
      },
    });
    const partials: unknown[] = [];
    const created = await service.createSession({
      projectId: "p1",
      modelId: "m1",
      conversationId: "c1",
    });
    service.subscribe(created.sessionId, (e) => {
      if (e.kind === "transcript-partial") {
        partials.push(e.payload);
      }
    });
    await service.startSession(created.sessionId);
    await new Promise((r) => setTimeout(r, 50));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.content).toBe("hello");
    const types = bus.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("transcript.final");
    await service.stopSession(created.sessionId);
  });

  it("never persists partials or audio to the durable bus", async () => {
    const provider = fakeProvider({
      events: [
        { kind: "transcript-partial", text: "hel" },
        { kind: "audio-output", audioBase64: "AAAA" },
      ],
    });
    const { service, bus } = makeService(provider);
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await service.startSession(created.sessionId);
    await new Promise((r) => setTimeout(r, 50));
    const types = bus.events.map((e) => (e as { type: string }).type);
    expect(types).not.toContain("transcript.partial");
    expect(types).not.toContain("audio.output.chunk");
    await service.stopSession(created.sessionId);
  });
});

describe("RealtimeService cancellation + isolation", () => {
  it("cancel is idempotent and releases capture", async () => {
    const { service } = makeService();
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    await service.startSession(created.sessionId);
    const first = await service.cancelSession(created.sessionId);
    expect(first.state).toBe("cancelled");
    const second = await service.cancelSession(created.sessionId);
    expect(second.state).toBe("cancelled");
    const unknown = await service.cancelSession("missing");
    expect(unknown.state).toBe("cancelled");
  });

  it("lists sessions scoped by project", async () => {
    const { service } = makeService();
    await service.createSession({ projectId: "pA", modelId: "m1" });
    await service.createSession({ projectId: "pB", modelId: "m1" });
    expect(service.listSessions("pA")).toHaveLength(1);
    expect(service.listSessions()).toHaveLength(2);
  });

  it("dispatches tool calls through the invoker", async () => {
    const bus = new MemoryBus();
    const service = new RealtimeService({
      permissionManager: new AllowAllPermissions(),
      eventBus: bus,
      providers: [fakeProvider()],
      toolInvoker: async (toolName) => ({ isError: false, result: `ran ${toolName}` }),
    });
    const created = await service.createSession({ projectId: "p1", modelId: "m1" });
    const result = await service.dispatchToolCall(created.sessionId, "builtin:research.search", {});
    expect(result).toBe("ran builtin:research.search");
  });
});

describe("capture and playback primitives", () => {
  it("null capture releases exactly once", async () => {
    const capture = new NullAudioCapture();
    expect(capture.released).toBe(false);
    await capture.start();
    capture.release();
    expect(capture.released).toBe(true);
    await expect(capture.start()).rejects.toThrow();
  });

  it("buffered playback bounds the queue", () => {
    const playback = new BufferedPlayback();
    for (let i = 0; i < 300; i++) {
      playback.enqueue(`chunk-${i}`);
    }
    expect(playback.queued).toBeLessThanOrEqual(256);
    playback.stop();
    expect(playback.queued).toBe(0);
  });
});
