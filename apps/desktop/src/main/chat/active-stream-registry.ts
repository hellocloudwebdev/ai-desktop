// PR14: apps/desktop — ActiveStreamRegistry
//
// Invariants (Step 37):
//   1. Registry owns the relationship MessageId -> AbortController.
//   2. In-memory runtime state strictly in the Electron main chat-service layer.
//   3. Controllers are NEVER persisted to SQLite, event payloads, or disk.
//   4. Standard AbortController / AbortSignal primitive for cooperative cancellation.
//   5. Duplicate registration for the same MessageId is rejected with ConflictError.
//   6. Aborting or removing an unknown or already-aborted stream is safe and idempotent.
//   7. Stream isolation: cancelling one stream does not impact any other active stream.

import { ConflictError, type MessageId } from "@ai-desktop/shared";

export class ActiveStreamRegistry {
  private readonly _streams = new Map<MessageId, AbortController>();

  /**
   * Registers a new stream for the given message ID.
   * Allocates an AbortController and returns its AbortSignal for downstream consumption.
   *
   * @param messageId - Canonical MessageId identifying the streaming message.
   * @returns AbortSignal associated with the registered stream.
   * @throws {ConflictError} if a stream for the specified messageId is already registered.
   */
  register(messageId: MessageId): AbortSignal {
    if (this._streams.has(messageId)) {
      throw new ConflictError(`Stream for message "${messageId}" is already active in registry`);
    }

    const controller = new AbortController();
    this._streams.set(messageId, controller);
    return controller.signal;
  }

  /**
   * Aborts the active stream for the given message ID.
   * Idempotent: safe to call multiple times for the same messageId, or on unknown streams.
   *
   * @param messageId - Canonical MessageId identifying the stream to abort.
   * @param reason - Optional cancellation reason forwarded to AbortController.abort().
   * @returns true if an active stream was found and aborted; false if no stream was registered.
   */
  abort(messageId: MessageId, reason?: unknown): boolean {
    const controller = this._streams.get(messageId);
    if (!controller) {
      return false;
    }

    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
    return true;
  }

  /**
   * Removes a stream from the registry upon completion, cancellation, or error.
   * Should be invoked in a `finally` block of the streaming handler.
   * Idempotent: safe to call multiple times or on unknown streams.
   *
   * @param messageId - Canonical MessageId identifying the stream to deregister.
   * @returns true if the stream was present and removed; false otherwise.
   */
  remove(messageId: MessageId): boolean {
    return this._streams.delete(messageId);
  }

  /**
   * Checks whether a stream is currently registered for the given message ID.
   */
  has(messageId: MessageId): boolean {
    return this._streams.has(messageId);
  }

  /**
   * Retrieves the AbortController for the given message ID, if registered.
   */
  get(messageId: MessageId): AbortController | undefined {
    return this._streams.get(messageId);
  }

  /**
   * Aborts all active streams and clears the registry.
   * Useful for application shutdown, window closing, or test cleanup.
   */
  clear(reason?: unknown): void {
    for (const controller of this._streams.values()) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
    this._streams.clear();
  }

  /**
   * The number of currently registered active streams.
   */
  get size(): number {
    return this._streams.size;
  }
}
