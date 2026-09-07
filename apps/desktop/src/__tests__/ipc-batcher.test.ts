// PR15: apps/desktop — IPC Batcher tests (Step 38.35–38.47)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversationId,
  createMessageId,
  createTaskId,
  now,
  type ConversationId,
} from "@ai-desktop/shared";
import { createEventId, type AIEvent } from "@ai-desktop/ai-core";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import {
  DEFAULT_BATCH_INTERVAL_MS,
  IpcBatcher,
  TERMINAL_EVENT_TYPES,
  isTerminalEvent,
} from "../main/ipc/batcher.js";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";

// ---------------------------------------------------------------------------
// Canonical event fixtures (transport fidelity checks rely on these passing
// through the batcher byte-for-byte)
// ---------------------------------------------------------------------------

let fixtureSequence = 0;

function makeDeltaEvent(conversationId: ConversationId, deltaText: string): AIEvent {
  fixtureSequence += 1;
  return {
    eventId: createEventId(),
    conversationId,
    sequence: fixtureSequence,
    schemaVersion: 1,
    timestamp: now(),
    type: "message.delta",
    category: "core",
    messageId: createMessageId(),
    deltaText,
  } as AIEvent;
}

function makeCompletedEvent(conversationId: ConversationId): AIEvent {
  fixtureSequence += 1;
  return {
    eventId: createEventId(),
    conversationId,
    sequence: fixtureSequence,
    schemaVersion: 1,
    timestamp: now(),
    type: "message.completed",
    category: "core",
    messageId: createMessageId(),
    finishReason: "end_turn",
  } as AIEvent;
}

function makeTaskCompletedEvent(conversationId: ConversationId): AIEvent {
  fixtureSequence += 1;
  return {
    eventId: createEventId(),
    conversationId,
    sequence: fixtureSequence,
    schemaVersion: 1,
    timestamp: now(),
    type: "task.completed",
    category: "extension",
    taskId: createTaskId(),
  } as AIEvent;
}

interface MockWebContents extends Electron.WebContents {
  sent: Array<{ channel: string; data: unknown }>;
  destroyedListeners: Array<() => void>;
  sendImpl: (channel: string, data: unknown) => void;
}

function makeMockWebContents(): MockWebContents {
  const sent: Array<{ channel: string; data: unknown }> = [];
  const destroyedListeners: Array<() => void> = [];
  const wc = {
    sent,
    destroyedListeners,
    sendImpl: (channel: string, data: unknown) => {
      sent.push({ channel, data });
    },
    isDestroyed: vi.fn().mockReturnValue(false),
    send: vi.fn(),
    once: vi.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === "destroyed") {
        destroyedListeners.push(cb);
      }
    }),
  } as unknown as MockWebContents;
  wc.send = vi
    .fn()
    .mockImplementation((channel: string, data: unknown) => wc.sendImpl(channel, data));
  return wc;
}

describe("apps/desktop: IpcBatcher — transport batching (~32 ms window)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches multiple events published within the window into ONE delivery (§38.35)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    const a = makeDeltaEvent(convId, "A");
    const b = makeDeltaEvent(convId, "B");
    const c = makeDeltaEvent(convId, "C");
    batcher.enqueue(a);
    batcher.enqueue(b);
    batcher.enqueue(c);

    // Nothing delivered before the window elapses
    expect(webContents.sent).toHaveLength(0);

    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);

    // Exactly one IPC delivery containing [A, B, C]
    expect(webContents.sent).toHaveLength(1);
    const batch = webContents.sent[0];
    expect(batch.channel).toBe(IPC_CHANNELS.CHAT_STREAM_BATCH);
    expect((batch.data as { events: AIEvent[] }).events).toEqual([a, b, c]);

    // Timer no longer scheduled after flush
    expect(batcher.isTimerScheduled(convId)).toBe(false);
    batcher.destroy();
  });

  it("assigns events arriving just before vs after the flush to the correct batches (§38.36)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    const first = makeDeltaEvent(convId, "before");
    batcher.enqueue(first);
    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS - 1);
    const second = makeDeltaEvent(convId, "just-before");
    batcher.enqueue(second); // joins the still-pending batch

    vi.advanceTimersByTime(1); // timer fires
    expect(webContents.sent).toHaveLength(1);
    expect((webContents.sent[0].data as { events: AIEvent[] }).events).toEqual([first, second]);

    // After the flush a new event starts a NEW batch
    const third = makeDeltaEvent(convId, "after");
    batcher.enqueue(third);
    expect(webContents.sent).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);

    expect(webContents.sent).toHaveLength(2);
    expect((webContents.sent[1].data as { events: AIEvent[] }).events).toEqual([third]);

    // No duplication or loss across both batches
    const allDelivered = [
      ...(webContents.sent[0].data as { events: AIEvent[] }).events,
      ...(webContents.sent[1].data as { events: AIEvent[] }).events,
    ];
    expect(allDelivered).toEqual([first, second, third]);
    batcher.destroy();
  });

  it("uses one timer per pending batch context, not one per event (§38.17)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    for (let i = 0; i < 20; i++) {
      batcher.enqueue(makeDeltaEvent(convId, `delta-${i}`));
    }

    // A single pending batch context with one timer and all 20 events queued
    expect(batcher.isTimerScheduled(convId)).toBe(true);
    expect(batcher.pendingCount(convId)).toBe(20);
    expect(batcher.contextCount).toBe(1);

    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);
    expect(webContents.sent).toHaveLength(1);
    expect((webContents.sent[0].data as { events: AIEvent[] }).events).toHaveLength(20);
    batcher.destroy();
  });

  it("preserves incoming event order exactly, never sorting (§38.39, §38.10)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    const events = ["1", "2", "3", "4", "5"].map((t) => makeDeltaEvent(convId, t));
    // Deliberately shuffled enqueue order of decreasing sequences
    for (const e of [events[2], events[0], events[4], events[1], events[3]]) {
      batcher.enqueue(e);
    }

    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);

    const delivered = (webContents.sent[0].data as { events: AIEvent[] }).events;
    expect(delivered).toEqual([events[2], events[0], events[4], events[1], events[3]]);
    batcher.destroy();
  });

  it("transports canonical events untouched: eventId, sequence, schemaVersion, payload (§38.12, §38.34, §38.52)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    const original = makeDeltaEvent(convId, "faithful");
    const snapshot = structuredClone(original);
    batcher.enqueue(original);

    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);

    const delivered = (webContents.sent[0].data as { events: AIEvent[] }).events[0];
    expect(delivered).toEqual(snapshot);
    expect(delivered.eventId).toBe(original.eventId);
    expect(delivered.sequence).toBe(original.sequence);
    expect(delivered.schemaVersion).toBe(original.schemaVersion);
    expect(delivered).toBe(original); // same reference — no cloning/rewriting
    batcher.destroy();
  });

  it("delivers many rapid deltas as one bounded batch, not one IPC transfer per delta (§38.38)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    const inputCount = 100;
    for (let i = 0; i < inputCount; i++) {
      batcher.enqueue(makeDeltaEvent(convId, `chunk-${i}`));
    }

    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);

    expect(webContents.sent.length).toBe(1);
    expect(webContents.sent.length).toBeLessThan(inputCount);
    batcher.destroy();
  });

  it("terminates cleanly via destroy(): no stale timers, contexts cleared", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);
    batcher.enqueue(makeDeltaEvent(convId, "pending"));

    batcher.destroy();
    expect(batcher.contextCount).toBe(0);
    expect(batcher.isTimerScheduled(convId)).toBe(false);

    // Pending event never delivered after destroy
    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS * 10);
    expect(webContents.sent).toHaveLength(0);
  });
});

describe("apps/desktop: IpcBatcher — terminal event immediate flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies terminal events per the canonical taxonomy (§38.8)", () => {
    const convId = createConversationId();
    const terminal = makeCompletedEvent(convId);
    expect(isTerminalEvent(terminal)).toBe(true);

    expect(TERMINAL_EVENT_TYPES.has("message.completed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("message.cancelled")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("message.failed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("tool.call.completed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("tool.call.failed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("execution.completed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("execution.failed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("task.completed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("task.failed")).toBe(true);
    expect(TERMINAL_EVENT_TYPES.has("task.cancelled")).toBe(true);

    // Non-terminal event types must not be classified as terminal
    expect(TERMINAL_EVENT_TYPES.has("message.delta")).toBe(false);
    expect(TERMINAL_EVENT_TYPES.has("message.started")).toBe(false);
    expect(TERMINAL_EVENT_TYPES.has("tool.call.started")).toBe(false);
    expect(isTerminalEvent(makeDeltaEvent(convId, "x"))).toBe(false);
    expect(isTerminalEvent(makeTaskCompletedEvent(convId))).toBe(true);
  });

  it("flushes terminal event immediately, carrying all pending events in order (§38.37, §38.40)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    const delta1 = makeDeltaEvent(convId, "delta1");
    const delta2 = makeDeltaEvent(convId, "delta2");
    const completed = makeCompletedEvent(convId);

    batcher.enqueue(delta1);
    batcher.enqueue(delta2);
    expect(batcher.isTimerScheduled(convId)).toBe(true);

    // Terminal event arrives while the timer is pending
    batcher.enqueue(completed);

    // Delivered IMMEDIATELY, no timer wait
    expect(webContents.sent).toHaveLength(1);
    expect((webContents.sent[0].data as { events: AIEvent[] }).events).toEqual([
      delta1,
      delta2,
      completed,
    ]);
    expect(batcher.pendingCount(convId)).toBe(0);

    // Pending timer was cancelled — advancing time must not re-deliver
    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS * 5);
    expect(webContents.sent).toHaveLength(1);
    batcher.destroy();
  });

  it("double flush (terminal + scheduled timer fire) produces exactly one delivery (§38.21)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    batcher.enqueue(makeDeltaEvent(convId, "only"));
    batcher.enqueue(makeCompletedEvent(convId)); // terminal → immediate flush

    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS * 5);

    // Only one IPC delivery; no duplicate send from the raced timer
    expect(webContents.sent).toHaveLength(1);
    batcher.destroy();
  });

  it("empty flush is a no-op: no empty batch is ever sent (§38.20, §38.42)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const webContents = makeMockWebContents();

    batcher.subscribe(convId, webContents);

    expect(() => batcher.flush(convId)).not.toThrow();
    expect(() => batcher.flushAll()).not.toThrow();
    expect(webContents.sent).toHaveLength(0);

    // Also safe after the batch was already flushed and queue is empty again
    batcher.enqueue(makeDeltaEvent(convId, "x"));
    batcher.flush(convId);
    expect(webContents.sent).toHaveLength(1);
    expect(() => batcher.flush(convId)).not.toThrow();
    expect(webContents.sent).toHaveLength(1);
    batcher.destroy();
  });

  it("events arriving during send start the NEXT batch, not appended to the in-flight one (§38.22, §38.24, §38.46)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const mock = makeMockWebContents();

    const lateEvent = makeDeltaEvent(convId, "during-send");
    // Simulate a re-entrant listener: sending batch A enqueues event B
    mock.sendImpl = (channel, data) => {
      mock.sent.push({ channel, data });
      batcher.enqueue(lateEvent);
    };

    batcher.subscribe(convId, mock);

    const a = makeDeltaEvent(convId, "A");
    batcher.enqueue(a);
    batcher.flush(convId);

    // Batch A delivered; B NOT appended to it
    expect((mock.sent[0].data as { events: AIEvent[] }).events).toEqual([a]);

    // B is preserved for the next batch
    expect(batcher.pendingCount(convId)).toBe(1);
    expect(batcher.hasPending(convId)).toBe(true);
    batcher.flush(convId);
    expect((mock.sent[1].data as { events: AIEvent[] }).events).toEqual([lateEvent]);
    batcher.destroy();
  });
});

describe("apps/desktop: IpcBatcher — subscription lifecycle & isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops events for conversations with no subscribers; state stays bounded (§38.26, §38.47)", () => {
    const batcher = new IpcBatcher();
    const orphanConvId = createConversationId();

    // No subscription exists for this conversation
    for (let i = 0; i < 500; i++) {
      batcher.enqueue(makeDeltaEvent(orphanConvId, `orphan-${i}`));
    }

    expect(batcher.contextCount).toBe(0);
    expect(batcher.hasPending(orphanConvId)).toBe(false);

    // A burst of events while the destination is unavailable leaves no
    // renderer-specific pending state behind
    const convId = createConversationId();
    const webContents = makeMockWebContents();
    batcher.subscribe(convId, webContents);
    batcher.unsubscribe(convId, webContents);
    for (let i = 0; i < 500; i++) {
      batcher.enqueue(makeDeltaEvent(convId, `dropped-${i}`));
    }
    expect(batcher.contextCount).toBe(0);
    expect(webContents.sent).toHaveLength(0);
    batcher.destroy();
  });

  it("delivers scoped events to multiple renderers; A's failure never affects B (§38.14, §38.43)", () => {
    const batcher = new IpcBatcher();
    const convA = createConversationId();
    const convB = createConversationId();
    const rendererA = makeMockWebContents();
    const rendererB = makeMockWebContents();

    batcher.subscribe(convA, rendererA);
    batcher.subscribe(convB, rendererB);

    const eventA = makeDeltaEvent(convA, "for-A");
    const eventB = makeDeltaEvent(convB, "for-B");
    batcher.enqueue(eventA);
    batcher.enqueue(eventB);

    batcher.flushAll();

    // Each renderer receives only its own conversation's events
    expect(rendererA.sent).toHaveLength(1);
    expect((rendererA.sent[0].data as { conversationId: string }).conversationId).toBe(convA);
    expect((rendererA.sent[0].data as { events: AIEvent[] }).events).toEqual([eventA]);

    expect(rendererB.sent).toHaveLength(1);
    expect((rendererB.sent[0].data as { conversationId: string }).conversationId).toBe(convB);
    expect((rendererB.sent[0].data as { events: AIEvent[] }).events).toEqual([eventB]);

    // Renderer A dies: B continues functioning independently
    const eventB2 = makeDeltaEvent(convB, "for-B-2");
    rendererA.sendImpl = () => {
      throw new Error("WebContents gone");
    };
    batcher.enqueue(makeDeltaEvent(convA, "will-fail"));
    // The send failure surfaces at flush time; the affected subscription is cleaned up
    expect(() => batcher.flush(convA)).not.toThrow();
    expect(batcher.subscriberCount(convA)).toBe(0);

    batcher.enqueue(eventB2);
    batcher.flush(convB);
    expect(rendererB.sent).toHaveLength(2);
    expect((rendererB.sent[1].data as { events: AIEvent[] }).events).toEqual([eventB2]);
    batcher.destroy();
  });

  it("WebContents destruction cleans subscriptions, pending batches, and timers (§38.15, §38.44)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const mock = makeMockWebContents();

    batcher.subscribe(convId, mock);
    expect(batcher.subscriberCount(convId)).toBe(1);

    batcher.enqueue(makeDeltaEvent(convId, "pending-1"));
    expect(batcher.hasPending(convId)).toBe(true);
    expect(batcher.isTimerScheduled(convId)).toBe(true);

    // Simulate WebContents destruction
    expect(mock.destroyedListeners).toHaveLength(1);
    mock.destroyedListeners[0]();

    // Subscription, pending batch, and timer all cleaned up
    expect(batcher.subscriberCount(convId)).toBe(0);
    expect(batcher.contextCount).toBe(0);
    expect(batcher.hasPending(convId)).toBe(false);
    expect(batcher.isTimerScheduled(convId)).toBe(false);

    // No later send occurs
    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS * 10);
    expect(mock.sent).toHaveLength(0);

    // Events after destruction are dropped, not buffered
    batcher.enqueue(makeDeltaEvent(convId, "post-destroy"));
    expect(batcher.hasPending(convId)).toBe(false);
    batcher.destroy();
  });

  it("failed sends do not crash the main process and clean up the affected subscription (§38.25, §38.45)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const mock = makeMockWebContents();
    mock.sendImpl = () => {
      throw new Error("Object has been destroyed");
    };

    batcher.subscribe(convId, mock);
    batcher.enqueue(makeDeltaEvent(convId, "boom"));

    // Flush swallows the send failure; main process remains stable
    expect(() => batcher.flush(convId)).not.toThrow();
    expect(batcher.subscriberCount(convId)).toBe(0);

    // No retry loop: subsequent events for the dead renderer are simply dropped
    batcher.enqueue(makeDeltaEvent(convId, "after-failure"));
    expect(batcher.hasPending(convId)).toBe(false);
    batcher.destroy();
  });

  it("last unsubscribe drops the conversation's pending batch and clears its timer (§38.26)", () => {
    const batcher = new IpcBatcher();
    const convId = createConversationId();
    const mock = makeMockWebContents();

    batcher.subscribe(convId, mock);
    batcher.enqueue(makeDeltaEvent(convId, "never-delivered"));

    batcher.unsubscribe(convId, mock);

    expect(batcher.contextCount).toBe(0);
    expect(batcher.isTimerScheduled(convId)).toBe(false);
    vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS * 10);
    expect(mock.sent).toHaveLength(0);
    batcher.destroy();
  });

  it("unsubscribe is idempotent and a destroyed WebContents with multiple conversations is fully detached", () => {
    const batcher = new IpcBatcher();
    const convA = createConversationId();
    const convB = createConversationId();
    const mock = makeMockWebContents();

    batcher.subscribe(convA, mock);
    batcher.subscribe(convB, mock);
    expect(mock.destroyedListeners).toHaveLength(1); // one listener per WebContents

    batcher.unsubscribe(convA, mock);
    expect(() => batcher.unsubscribe(convA, mock)).not.toThrow();

    mock.destroyedListeners[0]();
    expect(batcher.subscriberCount(convA)).toBe(0);
    expect(batcher.subscriberCount(convB)).toBe(0);
    batcher.destroy();
  });
});

describe("apps/desktop: IpcBatcher — typed IPC integration", () => {
  it("routes canonical events from IpcRegistry.publishEvent through the attached batcher", async () => {
    vi.useFakeTimers();
    try {
      const ipcRegistry = new IpcRegistry();
      const batcher = new IpcBatcher();
      const convId = createConversationId();
      const mock = makeMockWebContents();

      registerIpcHandlers(ipcRegistry, { batcher });
      expect(ipcRegistry.batcher).toBe(batcher);

      // CHAT_SUBSCRIBE wires the sender into the batcher
      await ipcRegistry.invokeCommand(IPC_CHANNELS.CHAT_SUBSCRIBE, { conversationId: convId }, {
        sender: mock,
      } as never);
      expect(batcher.subscriberCount(convId)).toBe(1);

      // publishEvent is the canonical publication path
      const delta = makeDeltaEvent(convId, "via-registry");
      ipcRegistry.publishEvent(delta);
      expect(batcher.pendingCount(convId)).toBe(1);

      vi.advanceTimersByTime(DEFAULT_BATCH_INTERVAL_MS);
      expect(mock.sent).toHaveLength(1);
      expect(mock.sent[0].channel).toBe(IPC_CHANNELS.CHAT_STREAM_BATCH);
      expect((mock.sent[0].data as { events: AIEvent[] }).events).toEqual([delta]);

      // CHAT_UNSUBSCRIBE detaches the batcher subscription too
      await ipcRegistry.invokeCommand(IPC_CHANNELS.CHAT_UNSUBSCRIBE, { conversationId: convId }, {
        sender: mock,
      } as never);
      expect(batcher.subscriberCount(convId)).toBe(0);
      expect(batcher.contextCount).toBe(0);

      ipcRegistry.destroy();
      expect(ipcRegistry.batcher).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("default batch interval is ~32 ms and is configurable locally (§38.6)", () => {
    expect(DEFAULT_BATCH_INTERVAL_MS).toBe(32);

    vi.useFakeTimers();
    try {
      const batcher = new IpcBatcher({ intervalMs: 10 });
      const convId = createConversationId();
      const mock = makeMockWebContents();

      batcher.subscribe(convId, mock);
      batcher.enqueue(makeDeltaEvent(convId, "fast"));

      vi.advanceTimersByTime(9);
      expect(mock.sent).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(mock.sent).toHaveLength(1);
      batcher.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
