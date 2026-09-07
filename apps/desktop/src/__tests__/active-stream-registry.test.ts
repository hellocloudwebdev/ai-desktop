import { describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  ConflictError,
  createConversationId,
  createMessageId,
  type MessageId,
} from "@ai-desktop/shared";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";

describe("apps/desktop: ActiveStreamRegistry (Main Chat Cancellation Registry)", () => {
  it("registers an active stream and provides an AbortSignal", () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();

    expect(registry.has(messageId)).toBe(false);
    expect(registry.size).toBe(0);

    const signal = registry.register(messageId);

    expect(registry.has(messageId)).toBe(true);
    expect(registry.size).toBe(1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(registry.get(messageId)).toBeDefined();
  });

  it("rejects duplicate registration for the same message ID with ConflictError", () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();

    const signal = registry.register(messageId);

    expect(() => registry.register(messageId)).toThrow(ConflictError);
    expect(() => registry.register(messageId)).toThrow(
      `Stream for message "${messageId}" is already active in registry`,
    );

    // Existing signal remains intact and not aborted
    expect(registry.size).toBe(1);
    expect(signal.aborted).toBe(false);
  });

  it("aborts an active stream and forwards optional reason", () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();
    const signal = registry.register(messageId);

    const abortListener = vi.fn();
    signal.addEventListener("abort", abortListener);

    const aborted = registry.abort(messageId, "User requested stop");

    expect(aborted).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("User requested stop");
    expect(abortListener).toHaveBeenCalledTimes(1);
  });

  it("abort is idempotent on already-aborted streams", () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();
    const signal = registry.register(messageId);

    const abortListener = vi.fn();
    signal.addEventListener("abort", abortListener);

    expect(registry.abort(messageId)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(abortListener).toHaveBeenCalledTimes(1);

    // Calling abort a second time must not re-fire event or throw
    expect(registry.abort(messageId)).toBe(true);
    expect(abortListener).toHaveBeenCalledTimes(1);
  });

  it("abort returns false for unregistered / unknown message IDs without throwing", () => {
    const registry = new ActiveStreamRegistry();
    const unknownId = createMessageId();

    expect(registry.abort(unknownId)).toBe(false);
    expect(registry.has(unknownId)).toBe(false);
  });

  it("removes streams idempotently", () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();
    registry.register(messageId);

    expect(registry.size).toBe(1);
    expect(registry.remove(messageId)).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.has(messageId)).toBe(false);

    // Second removal returns false
    expect(registry.remove(messageId)).toBe(false);
  });

  it("guarantees independent stream isolation across multiple concurrent streams", () => {
    const registry = new ActiveStreamRegistry();
    const id1 = createMessageId();
    const id2 = createMessageId();
    const id3 = createMessageId();

    const signal1 = registry.register(id1);
    const signal2 = registry.register(id2);
    const signal3 = registry.register(id3);

    expect(registry.size).toBe(3);

    // Aborting stream 2 must NOT affect stream 1 or 3
    registry.abort(id2);

    expect(signal1.aborted).toBe(false);
    expect(signal2.aborted).toBe(true);
    expect(signal3.aborted).toBe(false);

    // Clean up one stream
    registry.remove(id2);
    expect(registry.size).toBe(2);
    expect(registry.has(id1)).toBe(true);
    expect(registry.has(id2)).toBe(false);
    expect(registry.has(id3)).toBe(true);
  });

  it("properly cleans up registry entries in a try...finally lifecycle", async () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();

    async function simulateStream(id: MessageId, shouldFail = false) {
      const signal = registry.register(id);
      try {
        if (signal.aborted) {
          return "aborted";
        }
        if (shouldFail) {
          throw new Error("Stream failure");
        }
        return "completed";
      } finally {
        registry.remove(id);
      }
    }

    // Success path cleans up
    const res1 = await simulateStream(messageId);
    expect(res1).toBe("completed");
    expect(registry.has(messageId)).toBe(false);
    expect(registry.size).toBe(0);

    // Error path cleans up
    const errorId = createMessageId();
    await expect(simulateStream(errorId, true)).rejects.toThrow("Stream failure");
    expect(registry.has(errorId)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("integrates cancellation with downstream cooperative async generator", async () => {
    const registry = new ActiveStreamRegistry();
    const messageId = createMessageId();
    const signal = registry.register(messageId);

    // Mock an async generator stream that checks signal.aborted
    async function* mockChunkStream(sig: AbortSignal) {
      for (let i = 0; i < 10; i++) {
        if (sig.aborted) {
          return;
        }
        yield `chunk-${i}`;
        // Small delay
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const emitted: string[] = [];
    const streamPromise = (async () => {
      try {
        for await (const chunk of mockChunkStream(signal)) {
          emitted.push(chunk);
          if (chunk === "chunk-1") {
            registry.abort(messageId, "Cancel after chunk 1");
          }
        }
      } finally {
        registry.remove(messageId);
      }
    })();

    await streamPromise;

    expect(emitted).toEqual(["chunk-0", "chunk-1"]);
    expect(signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("aborts all active signals and clears registry on clear()", () => {
    const registry = new ActiveStreamRegistry();
    const id1 = createMessageId();
    const id2 = createMessageId();

    const sig1 = registry.register(id1);
    const sig2 = registry.register(id2);

    expect(registry.size).toBe(2);

    registry.clear("Window closed");

    expect(registry.size).toBe(0);
    expect(sig1.aborted).toBe(true);
    expect(sig1.reason).toBe("Window closed");
    expect(sig2.aborted).toBe(true);
    expect(sig2.reason).toBe("Window closed");
  });

  it("wires correctly with IPC CHAT_CANCEL command handler", async () => {
    const ipcRegistry = new IpcRegistry();
    const streamRegistry = new ActiveStreamRegistry();

    registerIpcHandlers(ipcRegistry, { streamRegistry });

    const activeId = createMessageId();
    const convId = createConversationId();
    const signal = streamRegistry.register(activeId);

    expect(ipcRegistry.registeredChannels.has(IPC_CHANNELS.CHAT_CANCEL)).toBe(true);

    // 1. Invoke CHAT_CANCEL via IPC for active stream
    const cancelActiveRes = await ipcRegistry.invokeCommand<{ cancelled: boolean }>(
      IPC_CHANNELS.CHAT_CANCEL,
      {
        requestId: "req-1",
        conversationId: convId,
        messageId: activeId,
      },
    );

    expect(cancelActiveRes.ok).toBe(true);
    if (cancelActiveRes.ok) {
      expect(cancelActiveRes.value.cancelled).toBe(true);
    }
    expect(signal.aborted).toBe(true);

    // 2. Invoke CHAT_CANCEL via IPC for unknown message ID
    const unknownId = createMessageId();
    const cancelUnknownRes = await ipcRegistry.invokeCommand<{ cancelled: boolean }>(
      IPC_CHANNELS.CHAT_CANCEL,
      {
        requestId: "req-2",
        conversationId: convId,
        messageId: unknownId,
      },
    );

    expect(cancelUnknownRes.ok).toBe(true);
    if (cancelUnknownRes.ok) {
      expect(cancelUnknownRes.value.cancelled).toBe(false);
    }

    ipcRegistry.destroy();
    streamRegistry.clear();
  });
});
