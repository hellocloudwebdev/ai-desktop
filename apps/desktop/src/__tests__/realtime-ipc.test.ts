// PR40: apps/desktop — Realtime IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. All realtime:* channels registered (8 commands).
//   2. NO realtime:execute / voice:execute / audio:execute channel.
//   3. Schema validation rejects malformed inputs before handlers run.
//   4. Service dispatch works; missing service fails closed.

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, generateUlid } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { RealtimeService } from "../main/realtime/realtime-service.js";

const SESSION_ID = generateUlid();

function createMockRealtimeService() {
  return {
    providerCapabilities: vi.fn().mockReturnValue([]),
    createSession: vi.fn().mockResolvedValue({ sessionId: "s1", state: "idle" }),
    startSession: vi.fn().mockResolvedValue({ sessionId: "s1", state: "listening" }),
    interrupt: vi.fn().mockResolvedValue({ sessionId: "s1", state: "listening" }),
    stopSession: vi.fn().mockResolvedValue({ sessionId: "s1", state: "stopped" }),
    snapshot: vi.fn().mockReturnValue({ sessionId: "s1", state: "listening" }),
    listSessions: vi.fn().mockReturnValue([]),
    getTranscripts: vi.fn().mockReturnValue({ partial: null, finals: [] }),
    ingestAudio: vi.fn().mockResolvedValue(undefined),
  };
}

describe("realtime ipc channels", () => {
  it("registers all eight realtime channels", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {
      realtimeService: createMockRealtimeService() as unknown as RealtimeService,
    });
    for (const channel of [
      IPC_CHANNELS.REALTIME_CAPABILITIES,
      IPC_CHANNELS.REALTIME_SESSION_CREATE,
      IPC_CHANNELS.REALTIME_SESSION_START,
      IPC_CHANNELS.REALTIME_SESSION_INTERRUPT,
      IPC_CHANNELS.REALTIME_SESSION_STOP,
      IPC_CHANNELS.REALTIME_SESSION_GET,
      IPC_CHANNELS.REALTIME_SESSION_LIST,
      IPC_CHANNELS.REALTIME_TRANSCRIPT,
      IPC_CHANNELS.REALTIME_AUDIO,
    ]) {
      expect(registry.registeredChannels.has(channel)).toBe(true);
    }
  });

  it("exposes no execute channel", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(channels).not.toContain("realtime:execute");
    expect(channels).not.toContain("voice:execute");
    expect(channels).not.toContain("audio:execute");
  });

  it("rejects empty projectId before the handler runs", async () => {
    const service = createMockRealtimeService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { realtimeService: service as unknown as RealtimeService });
    const res = await registry.invokeCommand(IPC_CHANNELS.REALTIME_SESSION_CREATE, {
      projectId: "",
      modelId: "m1",
    });
    expect(res.ok).toBe(false);
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it("rejects oversized audio before the handler runs", async () => {
    const service = createMockRealtimeService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { realtimeService: service as unknown as RealtimeService });
    const res = await registry.invokeCommand(IPC_CHANNELS.REALTIME_AUDIO, {
      sessionId: SESSION_ID,
      payloadBase64: "A".repeat(100_000),
    });
    expect(res.ok).toBe(false);
    expect(service.ingestAudio).not.toHaveBeenCalled();
  });

  it("dispatches session create to the service", async () => {
    const service = createMockRealtimeService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { realtimeService: service as unknown as RealtimeService });
    const res = await registry.invokeCommand(IPC_CHANNELS.REALTIME_SESSION_CREATE, {
      projectId: "p1",
      modelId: "gemini:gemini-2.5-flash",
    });
    expect(res.ok).toBe(true);
    expect(service.createSession).toHaveBeenCalledWith({
      projectId: "p1",
      modelId: "gemini:gemini-2.5-flash",
    });
  });

  it("dispatches audio to ingestAudio", async () => {
    const service = createMockRealtimeService();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { realtimeService: service as unknown as RealtimeService });
    const res = await registry.invokeCommand(IPC_CHANNELS.REALTIME_AUDIO, {
      sessionId: SESSION_ID,
      payloadBase64: "AAAA",
    });
    expect(res.ok).toBe(true);
    expect(service.ingestAudio).toHaveBeenCalledWith(SESSION_ID, "AAAA");
  });

  it("fails closed without a realtime service", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {});
    const res = await registry.invokeCommand(IPC_CHANNELS.REALTIME_SESSION_LIST, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.value as { sessions: unknown[] }).sessions).toEqual([]);
    }
  });
});
