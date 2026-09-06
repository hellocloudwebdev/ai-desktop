// PR5: packages/ai-core — Projection Helpers
//
// Shared deterministic utilities for event replay, sequence ordering,
// and event schema version validation.
//
// Invariants:
//   - Pure functions with no external I/O or side effects.
//   - Input event arrays and individual events are never mutated.
//   - Unsupported or future schema versions fail deterministically.

import type { AIEvent } from "../events.js";
import { CURRENT_SCHEMA_VERSION } from "../events.js";
import { EventStreamError } from "../errors.js";

/**
 * Set of supported schemaVersion values for AI events.
 * Currently supported: 1.
 */
export const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([CURRENT_SCHEMA_VERSION]);

/**
 * Validates that an event's schemaVersion is supported by the projection layer.
 * Throws EventStreamError if the version is unrecognised or unsupported.
 */
export function validateEventSchemaVersion(event: AIEvent): void {
  if (!event || typeof event !== "object") {
    throw new EventStreamError("Encountered null or non-object event in projection stream");
  }

  if (
    typeof event.schemaVersion !== "number" ||
    !SUPPORTED_SCHEMA_VERSIONS.has(event.schemaVersion)
  ) {
    throw new EventStreamError(
      `Unsupported event schemaVersion "${String(event.schemaVersion)}" for event "${String(event.eventId)}" (type: "${String(event.type)}"). Supported versions: ${Array.from(SUPPORTED_SCHEMA_VERSIONS).join(", ")}`,
    );
  }
}

/**
 * Validates and deterministically sorts an immutable event stream.
 *
 * Sorting order is strictly authoritative:
 *   1. conversationId
 *   2. sequence (ascending)
 *   3. eventId (tie-breaker for absolute determinism)
 *
 * Invariant: Never mutates the input array.
 */
export function prepareEventStream(events: readonly AIEvent[]): AIEvent[] {
  if (!Array.isArray(events)) {
    throw new EventStreamError("Event stream must be an array");
  }

  for (const event of events) {
    validateEventSchemaVersion(event);
  }

  return [...events].sort((a, b) => {
    if (a.conversationId !== b.conversationId) {
      return a.conversationId.localeCompare(b.conversationId);
    }
    if (a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return a.eventId.localeCompare(b.eventId);
  });
}
