import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";
import {
  createConversationId,
  createMessageId,
  createTaskId,
  createToolCallId,
  now,
} from "@ai-desktop/shared";
import {
  createEventId,
  textPart,
  type AIEvent,
  type MessageCompletedEvent,
  type MessageCreatedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type TaskCreatedEvent,
  type ToolCallRequestedEvent,
} from "@ai-desktop/ai-core";

describe("EventBus: Core Publication & Subscription Lifecycle", () => {
  it("delivers published canonical events to a registered subscriber", async () => {
    const bus = new EventBus();
    const received: AIEvent[] = [];

    bus.subscribe((event) => {
      received.push(event);
    });

    const event: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Hello")],
    };

    await bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("delivers the same event to multiple subscribers", async () => {
    const bus = new EventBus();
    const sub1Events: AIEvent[] = [];
    const sub2Events: AIEvent[] = [];

    bus.subscribe((e) => {
      sub1Events.push(e);
    });
    bus.subscribe((e) => {
      sub2Events.push(e);
    });

    expect(bus.subscriberCount).toBe(2);

    const event: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: createMessageId(),
      role: "assistant",
      content: [],
    };

    await bus.publish(event);

    expect(sub1Events).toHaveLength(1);
    expect(sub2Events).toHaveLength(1);
    expect(sub1Events[0]).toBe(sub2Events[0]);
  });

  it("filters events by specific type when filterType option is provided", async () => {
    const bus = new EventBus();
    const deltaEvents: MessageDeltaEvent[] = [];

    bus.subscribe<MessageDeltaEvent>(
      (e) => {
        deltaEvents.push(e);
      },
      {
        type: "message.delta",
      },
    );

    const convId = createConversationId();
    const msgId = createMessageId();

    const started: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: msgId,
      role: "assistant",
      content: [],
    };

    const delta: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: msgId,
      deltaText: "chunk",
    };

    await bus.publish(started);
    await bus.publish(delta);

    expect(deltaEvents).toHaveLength(1);
    expect(deltaEvents[0].type).toBe("message.delta");
    expect(deltaEvents[0].deltaText).toBe("chunk");
  });

  it("once() automatically unsubscribes after receiving exactly one event", async () => {
    const bus = new EventBus();
    const received: AIEvent[] = [];

    bus.once((e) => {
      received.push(e);
    });

    const convId = createConversationId();
    const event1: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "1",
    };

    const event2: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "2",
    };

    await bus.publish(event1);
    await bus.publish(event2);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event1);
    expect(bus.subscriberCount).toBe(0);
  });
});

describe("EventBus: Ordering & Re-entrancy Invariants", () => {
  it("preserves strictly sequential publication order (A -> B -> C)", async () => {
    const bus = new EventBus();
    const observedTypes: string[] = [];

    bus.subscribe((e) => {
      observedTypes.push(e.type);
    });

    const convId = createConversationId();
    const msgId = createMessageId();

    const eA: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: msgId,
      role: "assistant",
      content: [],
    };

    const eB: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: msgId,
      deltaText: "text",
    };

    const eC: MessageCompletedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 2,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: msgId,
    };

    await bus.publish(eA);
    await bus.publish(eB);
    await bus.publish(eC);

    expect(observedTypes).toEqual(["message.started", "message.delta", "message.completed"]);
  });

  it("maintains FIFO ordering under re-entrant publish calls from within a subscriber", async () => {
    const bus = new EventBus();
    const dispatchLog: string[] = [];

    const convId = createConversationId();
    const event2: MessageCompletedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: createMessageId(),
    };

    bus.subscribe((e) => {
      dispatchLog.push(`sub1:${e.type}`);
      if (e.type === "message.started") {
        // Re-entrant publish call while dispatching event 1
        void bus.publish(event2);
      }
    });

    bus.subscribe((e) => {
      dispatchLog.push(`sub2:${e.type}`);
    });

    const event1: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: createMessageId(),
      role: "assistant",
      content: [],
    };

    await bus.publish(event1);

    // Event 1 must complete dispatching to ALL subscribers before Event 2 begins dispatching
    expect(dispatchLog).toEqual([
      "sub1:message.started",
      "sub2:message.started",
      "sub1:message.completed",
      "sub2:message.completed",
    ]);
  });
});

describe("EventBus: Idempotent Unsubscribe & Cleanup", () => {
  it("stops delivering events after unsubscribe is called", async () => {
    const bus = new EventBus();
    const received: AIEvent[] = [];

    const unsubscribe = bus.subscribe((e) => {
      received.push(e);
    });
    expect(bus.subscriberCount).toBe(1);

    const event1: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("1")],
    };

    await bus.publish(event1);
    expect(received).toHaveLength(1);

    // Unsubscribe
    unsubscribe();
    expect(bus.subscriberCount).toBe(0);

    const event2: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("2")],
    };

    await bus.publish(event2);
    expect(received).toHaveLength(1); // No new events delivered
  });

  it("unsubscription is completely idempotent (multiple calls are safe no-ops)", () => {
    const bus = new EventBus();
    const unsubscribe = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);

    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();

    expect(bus.subscriberCount).toBe(0);
  });

  it("clear() removes all active subscriptions and pending queue", () => {
    const bus = new EventBus();
    bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);

    bus.clear();
    expect(bus.subscriberCount).toBe(0);
  });
});

describe("EventBus: Subscriber Isolation & Immutability", () => {
  it("isolates subscriber errors without interrupting other subscribers", async () => {
    const errorHandler = vi.fn();
    const bus = new EventBus({ onError: errorHandler });
    const sub2Received: AIEvent[] = [];

    bus.subscribe(() => {
      throw new Error("Faulty subscriber exploded");
    });

    bus.subscribe((e) => {
      sub2Received.push(e);
    });

    const event: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: createMessageId(),
      role: "assistant",
      content: [],
    };

    await bus.publish(event);

    // Sub 2 must receive event despite sub 1 crashing
    expect(sub2Received).toHaveLength(1);
    expect(sub2Received[0]).toBe(event);

    // Custom error handler received the failure
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect((errorHandler.mock.calls[0][0] as Error).message).toBe("Faulty subscriber exploded");
  });

  it("isolates asynchronous rejections in subscribers", async () => {
    const errorHandler = vi.fn();
    const bus = new EventBus({ onError: errorHandler });
    const sub2Received: AIEvent[] = [];

    bus.subscribe(async () => {
      return Promise.reject(new Error("Async rejection"));
    });

    bus.subscribe((e) => {
      sub2Received.push(e);
    });

    const event: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: createMessageId(),
      role: "assistant",
      content: [],
    };

    await bus.publish(event);

    expect(sub2Received).toHaveLength(1);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect((errorHandler.mock.calls[0][0] as Error).message).toBe("Async rejection");
  });

  it("freezes published events to prevent listener mutation", async () => {
    const bus = new EventBus();
    const event: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: createMessageId(),
      role: "assistant",
      content: [],
    };

    expect(Object.isFrozen(event)).toBe(false);

    await bus.publish(event);

    expect(Object.isFrozen(event)).toBe(true);
  });

  it("transports Capability and Extension events cleanly without special pathways", async () => {
    const bus = new EventBus();
    const capabilityEvents: AIEvent[] = [];
    const extensionEvents: AIEvent[] = [];

    bus.subscribe((e) => {
      if (e.category === "capability") capabilityEvents.push(e);
      if (e.category === "extension") extensionEvents.push(e);
    });

    const toolEvent: ToolCallRequestedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "tool.call.requested",
      category: "capability",
      toolCallId: createToolCallId(),
      toolName: "read_file",
      toolSource: "builtin",
      toolRuntime: "in_process",
      input: {},
    };

    const taskEvent: TaskCreatedEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "task.created",
      category: "extension",
      taskId: createTaskId(),
      title: "Run tests",
      rootNodeIds: [],
    };

    await bus.publish(toolEvent);
    await bus.publish(taskEvent);

    expect(capabilityEvents).toHaveLength(1);
    expect(extensionEvents).toHaveLength(1);
  });

  it("throws TypeError on invalid event or listener inputs", async () => {
    const bus = new EventBus();

    expect(() => bus.subscribe(null as unknown as () => void)).toThrow(TypeError);
    expect(() => bus.once(undefined as unknown as () => void)).toThrow(TypeError);

    await expect(bus.publish(null as unknown as AIEvent)).rejects.toThrow(TypeError);
    await expect(bus.publish({} as unknown as AIEvent)).rejects.toThrow(TypeError);
  });
});
