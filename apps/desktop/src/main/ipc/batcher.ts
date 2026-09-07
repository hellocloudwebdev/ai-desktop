// PR15: apps/desktop — IPC Event Batcher
//
// Transport optimization between the internal fine-grained event stream and the
// renderer: many events cross the Electron IPC boundary as one transfer inside
// a ~32 ms window, while terminal events flush immediately.
//
// Invariants (Step 38):
//   1. Lives strictly inside apps/desktop (Electron boundary).
//   2. Transports canonical AIEvents without changing their meaning: eventId,
//      sequence, schemaVersion, and payloads pass through untouched.
//   3. Preserves incoming event order exactly; never sorts, merges, or coalesces.
//   4. One timer per pending conversation batch context; a timer exists only
//      while events are pending (no timer-per-event, no global interval).
//   5. Terminal events flush immediately, carrying all pending events with them.
//   6. Empty flush is a no-op — never sends an empty batch.
//   7. Snapshot-then-clear before send: events arriving during delivery start
//      the next batch and are never appended to an in-flight one.
//   8. WebContents destruction cleans up its subscriptions, pending batches,
//      and timers.
//   9. Failed sends never crash the main process; the affected subscription is
//      cleaned up without retry loops or dead-letter queues.
//  10. Bounded state: events for conversations without subscribers are dropped
//      at enqueue time; the last unsubscribe drops that conversation's pending
//      batch and clears its timer.
//  11. Zero persistence, zero provider logic, zero secrets — transport only.
//  12. No domain batch event types are introduced; the batch envelope is a
//      plain transport wrapper, not part of the canonical event taxonomy.

import type { WebContents } from "electron";
import { IPC_CHANNELS, type ConversationId } from "@ai-desktop/shared";
import type { AIEvent } from "@ai-desktop/ai-core";

/**
 * Target batching interval. An implementation target, not a domain-semantic
 * constant — stays local to the Electron IPC layer (§38.6).
 */
export const DEFAULT_BATCH_INTERVAL_MS = 32;

/**
 * Terminal event classification following the canonical ai-core taxonomy (§38.8).
 *
 * The handoff lists `tool.call.cancelled` and `execution.cancelled`, which do
 * not exist in the canonical event union; their terminal failure counterparts
 * (`tool.call.failed`, `execution.failed`) are the classified terminal states.
 */
export const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Core: message lifecycle end states
  "message.completed",
  "message.failed",
  "message.cancelled",
  // Capability: tool call end states
  "tool.call.completed",
  "tool.call.failed",
  // Capability: execution end states
  "execution.completed",
  "execution.failed",
  // Extension: task end states
  "task.completed",
  "task.failed",
  "task.cancelled",
]);

export function isTerminalEvent(event: Readonly<AIEvent>): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/**
 * Transport envelope for one batched delivery. Not a domain event type —
 * a plain wrapper around untouched canonical events (§38.32, §38.33).
 */
export interface ChatStreamBatch {
  readonly conversationId: ConversationId;
  readonly events: readonly AIEvent[];
}

interface BatchContext {
  pending: AIEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<WebContents>;
}

export interface IpcBatcherOptions {
  /** Batching window in milliseconds. Defaults to 32. */
  intervalMs?: number;
  /** IPC channel used for batch delivery. Defaults to CHAT_STREAM_BATCH. */
  channel?: string;
}

export class IpcBatcher {
  private readonly _contexts = new Map<ConversationId, BatchContext>();
  private readonly _conversationsByWebContents = new Map<WebContents, Set<ConversationId>>();
  private readonly _intervalMs: number;
  private readonly _channel: string;

  constructor(options: IpcBatcherOptions = {}) {
    this._intervalMs = options.intervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    this._channel = options.channel ?? IPC_CHANNELS.CHAT_STREAM_BATCH;
  }

  /**
   * Registers a WebContents as a subscriber for a conversation's batched events.
   * The WebContents' destruction automatically cleans up every subscription it
   * holds, its pending batches, and their timers (§38.15).
   */
  subscribe(conversationId: ConversationId, webContents: WebContents): void {
    let context = this._contexts.get(conversationId);
    if (!context) {
      context = { pending: [], timer: null, subscribers: new Set() };
      this._contexts.set(conversationId, context);
    }
    context.subscribers.add(webContents);

    let conversations = this._conversationsByWebContents.get(webContents);
    if (!conversations) {
      conversations = new Set();
      this._conversationsByWebContents.set(webContents, conversations);
      // One destroyed-listener per WebContents, not per subscription.
      webContents.once("destroyed", () => this._onWebContentsDestroyed(webContents));
    }
    conversations.add(conversationId);
  }

  /**
   * Removes a WebContents from a conversation's subscribers. Idempotent.
   * When the last subscriber leaves, the conversation's pending batch is
   * dropped and its timer cleared — renderer-specific state stays bounded (§38.26).
   */
  unsubscribe(conversationId: ConversationId, webContents: WebContents): void {
    const context = this._contexts.get(conversationId);
    if (context) {
      context.subscribers.delete(webContents);
      if (context.subscribers.size === 0) {
        if (context.timer !== null) {
          clearTimeout(context.timer);
        }
        this._contexts.delete(conversationId);
      }
    }

    const conversations = this._conversationsByWebContents.get(webContents);
    if (conversations) {
      conversations.delete(conversationId);
      if (conversations.size === 0) {
        this._conversationsByWebContents.delete(webContents);
      }
    }
  }

  /**
   * Queues a canonical event for batched delivery. Terminal events flush
   * immediately, carrying all pending events of the conversation with them.
   * Events for conversations without subscribers are dropped at enqueue time.
   */
  enqueue(event: Readonly<AIEvent>): void {
    const context = this._contexts.get(event.conversationId);
    if (!context || context.subscribers.size === 0) {
      // No delivery target: drop rather than buffer unboundedly. Events stay
      // authoritative in the event storage layer (§38.26).
      return;
    }

    context.pending.push(event);

    if (isTerminalEvent(event)) {
      this.flush(event.conversationId);
      return;
    }

    if (context.timer === null) {
      context.timer = setTimeout(() => this._onFlushTimer(event.conversationId), this._intervalMs);
    }
  }

  /**
   * Immediately delivers a conversation's pending events. Safe to call at any
   * time: an empty pending queue is a no-op and never sends an empty batch,
   * and a racing scheduled flush cannot duplicate delivery (§38.20, §38.21).
   */
  flush(conversationId: ConversationId): void {
    const context = this._contexts.get(conversationId);
    if (!context) {
      return;
    }

    if (context.timer !== null) {
      clearTimeout(context.timer);
      context.timer = null;
    }

    if (context.pending.length === 0) {
      return;
    }

    this._deliver(conversationId, context);
  }

  /** Flushes every conversation that currently has pending events. */
  flushAll(): void {
    for (const conversationId of [...this._contexts.keys()]) {
      this.flush(conversationId);
    }
  }

  /**
   * Clears all subscriptions, pending batches, and timers. Used on application
   * teardown; never flushes pending batches on the way out.
   */
  destroy(): void {
    for (const context of this._contexts.values()) {
      if (context.timer !== null) {
        clearTimeout(context.timer);
      }
    }
    this._contexts.clear();
    this._conversationsByWebContents.clear();
  }

  hasPending(conversationId: ConversationId): boolean {
    return (this._contexts.get(conversationId)?.pending.length ?? 0) > 0;
  }

  pendingCount(conversationId: ConversationId): number {
    return this._contexts.get(conversationId)?.pending.length ?? 0;
  }

  isTimerScheduled(conversationId: ConversationId): boolean {
    return (this._contexts.get(conversationId)?.timer ?? null) !== null;
  }

  subscriberCount(conversationId: ConversationId): number {
    return this._contexts.get(conversationId)?.subscribers.size ?? 0;
  }

  get contextCount(): number {
    return this._contexts.size;
  }

  private _onFlushTimer(conversationId: ConversationId): void {
    const context = this._contexts.get(conversationId);
    if (!context) {
      return;
    }
    context.timer = null;
    if (context.pending.length === 0) {
      return;
    }
    this._deliver(conversationId, context);
  }

  /**
   * Snapshot-then-clear before sending: events enqueued during delivery
   * (re-entrant listeners, send callbacks) land in a fresh pending array and
   * are never appended to the in-flight batch (§38.22, §38.24).
   */
  private _deliver(conversationId: ConversationId, context: BatchContext): void {
    const events = context.pending;
    context.pending = [];

    const batch: ChatStreamBatch = { conversationId, events };

    for (const webContents of [...context.subscribers]) {
      if (webContents.isDestroyed()) {
        this.unsubscribe(conversationId, webContents);
        continue;
      }
      try {
        webContents.send(this._channel, batch);
      } catch {
        // Renderer is gone: clean up its subscription. No retry, no crash (§38.25).
        this.unsubscribe(conversationId, webContents);
      }
    }
  }

  private _onWebContentsDestroyed(webContents: WebContents): void {
    const conversations = this._conversationsByWebContents.get(webContents);
    if (!conversations) {
      return;
    }
    for (const conversationId of [...conversations]) {
      this.unsubscribe(conversationId, webContents);
    }
  }
}
