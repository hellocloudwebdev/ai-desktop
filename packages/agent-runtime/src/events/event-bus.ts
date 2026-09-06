// PR6: packages/agent-runtime — In-Process EventBus
//
// Architectural Role:
//   Thin, in-process event transport distributing canonical AIEvent objects
//   to subscribers within the local application process.
//
// Invariants:
//   - Events are authoritative.
//   - In-process distribution only (no Redis, no worker queue, no WebSockets, no HTTP).
//   - Preserves publication delivery order strictly (A -> B -> C).
//   - Subscriber isolation: exceptions in one subscriber do not disrupt delivery to others.
//   - Idempotent unsubscription: calling unsubscribe multiple times is safe and a no-op.
//   - Zero persistence: EventBus does not write to SQLite, Prisma, or storage.
//   - Zero IPC: EventBus does not interface with Electron IPC or webContents.
//   - Zero Agent Loop: no planning, ReAct loop, or autonomous scheduling inside EventBus.
//   - Zero Event Mutation: published event objects are frozen or treated as immutable.

import type { AIEvent, AIEventType } from "@ai-desktop/ai-core";

/**
 * Functional callback receiving a published AIEvent.
 * Can be synchronous or asynchronous.
 */
export type EventListener<T extends AIEvent = AIEvent> = (
  event: Readonly<T>,
) => void | Promise<void>;

/**
 * Idempotent cleanup function returned by subscribe.
 * Safe to call multiple times without error.
 */
export type Unsubscribe = () => void;

/**
 * Custom error handler invoked when a subscriber throws or rejects.
 */
export type EventBusErrorHandler = (error: unknown, event: Readonly<AIEvent>) => void;

export interface EventBusOptions {
  /**
   * Optional custom handler for errors thrown by listeners.
   * If not provided, errors are logged via console.error without interrupting other listeners.
   */
  readonly onError?: EventBusErrorHandler;
}

export interface SubscriptionOptions {
  /**
   * Optional event type filter. If provided, the listener only receives events matching this type.
   */
  readonly type?: AIEventType;
}

/**
 * Minimal public contract for the internal in-process EventBus.
 */
export interface IEventBus {
  /**
   * Publishes a canonical AIEvent to all active subscribers.
   * Delivery preserves publication order and executes synchronously across listeners.
   */
  publish(event: Readonly<AIEvent>): Promise<void>;

  /**
   * Subscribes a listener to canonical events.
   * Returns an idempotent unsubscribe function.
   */
  subscribe<T extends AIEvent = AIEvent>(
    listener: EventListener<T>,
    options?: SubscriptionOptions,
  ): Unsubscribe;

  /**
   * Subscribes a listener for exactly one event matching criteria, then automatically unsubscribes.
   */
  once<T extends AIEvent = AIEvent>(
    listener: EventListener<T>,
    options?: SubscriptionOptions,
  ): Unsubscribe;

  /**
   * Number of active subscribers currently registered.
   */
  readonly subscriberCount: number;

  /**
   * Clears all active subscribers and resets the bus.
   */
  clear(): void;
}

interface SubscriptionRecord {
  readonly id: number;
  readonly listener: EventListener<AIEvent>;
  readonly filterType?: AIEventType;
  readonly once?: boolean;
}

/**
 * In-process implementation of the Phase-0 EventBus.
 */
export class EventBus implements IEventBus {
  private _nextSubscriptionId = 1;
  private readonly _subscriptions = new Map<number, SubscriptionRecord>();
  private readonly _onError: EventBusErrorHandler;
  private _isPublishing = false;
  private readonly _queue: Readonly<AIEvent>[] = [];

  constructor(options?: EventBusOptions) {
    this._onError =
      options?.onError ??
      ((err, event) => {
        console.error(
          `[EventBus] Uncaught error in subscriber for event "${String(event.type)}" (${String(event.eventId)}):`,
          err,
        );
      });
  }

  get subscriberCount(): number {
    return this._subscriptions.size;
  }

  subscribe<T extends AIEvent = AIEvent>(
    listener: EventListener<T>,
    options?: SubscriptionOptions,
  ): Unsubscribe {
    if (typeof listener !== "function") {
      throw new TypeError("EventBus.subscribe requires a valid listener function");
    }

    const id = this._nextSubscriptionId++;
    const record: SubscriptionRecord = {
      id,
      listener: listener as unknown as EventListener<AIEvent>,
      filterType: options?.type,
      once: false,
    };

    this._subscriptions.set(id, record);

    let unsubscribed = false;
    return () => {
      if (!unsubscribed) {
        unsubscribed = true;
        this._subscriptions.delete(id);
      }
    };
  }

  once<T extends AIEvent = AIEvent>(
    listener: EventListener<T>,
    options?: SubscriptionOptions,
  ): Unsubscribe {
    if (typeof listener !== "function") {
      throw new TypeError("EventBus.once requires a valid listener function");
    }

    const id = this._nextSubscriptionId++;
    const record: SubscriptionRecord = {
      id,
      listener: listener as unknown as EventListener<AIEvent>,
      filterType: options?.type,
      once: true,
    };

    this._subscriptions.set(id, record);

    let unsubscribed = false;
    return () => {
      if (!unsubscribed) {
        unsubscribed = true;
        this._subscriptions.delete(id);
      }
    };
  }

  /**
   * Publishes a canonical AIEvent to active subscribers.
   *
   * Queue-backed re-entrancy protection ensures that if a listener publishes
   * an event while another is in flight, events are processed strictly in FIFO order.
   */
  async publish(event: Readonly<AIEvent>): Promise<void> {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new TypeError("EventBus.publish requires a valid canonical AIEvent object");
    }

    // Freeze event shallowly if not already frozen to prevent listener mutations
    if (!Object.isFrozen(event)) {
      Object.freeze(event);
    }

    this._queue.push(event);

    if (this._isPublishing) {
      // Re-entrant publish call: queued for FIFO execution in the active loop
      return;
    }

    this._isPublishing = true;
    try {
      while (this._queue.length > 0) {
        const currentEvent = this._queue.shift()!;
        await this._dispatch(currentEvent);
      }
    } finally {
      this._isPublishing = false;
    }
  }

  clear(): void {
    this._subscriptions.clear();
    this._queue.length = 0;
  }

  private async _dispatch(event: Readonly<AIEvent>): Promise<void> {
    // Snapshot active subscribers to isolate modifications during delivery
    const snapshot = Array.from(this._subscriptions.values());

    for (const record of snapshot) {
      // Check if subscriber was removed during this dispatch cycle
      if (!this._subscriptions.has(record.id)) {
        continue;
      }

      // Check type filter
      if (record.filterType && record.filterType !== event.type) {
        continue;
      }

      // Auto-remove once subscribers before invocation
      if (record.once) {
        this._subscriptions.delete(record.id);
      }

      // Deliver event with subscriber isolation
      try {
        const result = record.listener(event);
        if (result && typeof (result as Promise<void>).then === "function") {
          await (result as Promise<void>).catch((err) => {
            this._onError(err, event);
          });
        }
      } catch (err) {
        this._onError(err, event);
      }
    }
  }
}
