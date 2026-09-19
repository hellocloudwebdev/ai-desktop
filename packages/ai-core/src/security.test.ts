import { describe, expect, it } from "vitest";
import {
  AIEventSchema,
  AIEventTypeSchema,
  SecurityEventSchema,
  isCapabilityEvent,
  isCoreEvent,
  isExtensionEvent,
  type SecurityEvent,
} from "./events.js";
import { createConversationId, now } from "@ai-desktop/shared";
import { createEventId } from "./identifiers.js";

const SECURITY_TYPES = [
  "security.ipc.rejected",
  "security.permission.denied",
  "security.secret.redacted",
  "security.path.rejected",
  "security.network.blocked",
  "security.browser.blocked",
  "security.plugin.rejected",
  "security.mcp.rejected",
  "security.document.rejected",
  "security.sync.rejected",
  "security.integrity.failure",
] as const;

function baseFields(sequence = 0) {
  return {
    eventId: createEventId(),
    conversationId: createConversationId(),
    sequence,
    schemaVersion: 1,
    timestamp: now(),
    category: "extension" as const,
  };
}

describe("ai-core security events: bounded audit taxonomy (PR46)", () => {
  it("accepts all 11 security.* types via SecurityEventSchema and AIEventSchema", () => {
    for (const type of SECURITY_TYPES) {
      const evt: SecurityEvent = {
        ...baseFields(),
        type,
        reason: `rejected: ${type}`,
      };
      expect(SecurityEventSchema.safeParse(evt).success).toBe(true);
      expect(AIEventSchema.safeParse(evt).success).toBe(true);
      expect(isExtensionEvent(evt)).toBe(true);
      expect(isCoreEvent(evt)).toBe(false);
      expect(isCapabilityEvent(evt)).toBe(false);
      expect(AIEventTypeSchema.safeParse(type).success).toBe(true);
    }
    expect(SECURITY_TYPES).toHaveLength(11);
  });

  it("accepts optional bounded entity context (entityType/entityId/projectId)", () => {
    const evt: SecurityEvent = {
      ...baseFields(),
      type: "security.path.rejected",
      reason: "Path escapes the workspace",
      entityType: "filesystem.path",
      entityId: "project-a/src/index.ts",
      projectId: "project-a",
    };
    expect(SecurityEventSchema.safeParse(evt).success).toBe(true);
    expect(AIEventSchema.safeParse(evt).success).toBe(true);
    // Bare event without any entity context is also valid.
    const bare: SecurityEvent = {
      ...baseFields(1),
      type: "security.integrity.failure",
      reason: "Checksum mismatch on skill script",
    };
    expect(SecurityEventSchema.safeParse(bare).success).toBe(true);
  });

  it("rejects unknown security types and cross-category confusion", () => {
    const unknownType = { ...baseFields(), type: "security.unknown", reason: "nope" };
    expect(SecurityEventSchema.safeParse(unknownType).success).toBe(false);
    expect(AIEventSchema.safeParse(unknownType).success).toBe(false);
    // A sibling extension type is not a security event.
    const scheduleStyle = { ...baseFields(), type: "schedule.created" };
    expect(SecurityEventSchema.safeParse(scheduleStyle).success).toBe(false);
    const wrongCategory = {
      ...baseFields(),
      type: "security.ipc.rejected",
      category: "core",
      reason: "bad payload",
    };
    expect(SecurityEventSchema.safeParse(wrongCategory).success).toBe(false);
  });

  it("enforces reason bounds (1..500 chars, trimmed)", () => {
    const missing = { ...baseFields(), type: "security.ipc.rejected" };
    expect(SecurityEventSchema.safeParse(missing).success).toBe(false);
    const empty = { ...baseFields(), type: "security.ipc.rejected", reason: "" };
    expect(SecurityEventSchema.safeParse(empty).success).toBe(false);
    const whitespace = { ...baseFields(), type: "security.ipc.rejected", reason: "   " };
    expect(SecurityEventSchema.safeParse(whitespace).success).toBe(false);
    const overlong = {
      ...baseFields(),
      type: "security.network.blocked",
      reason: "r".repeat(501),
    };
    expect(SecurityEventSchema.safeParse(overlong).success).toBe(false);
    const atLimit = {
      ...baseFields(),
      type: "security.network.blocked",
      reason: "r".repeat(500),
    };
    expect(SecurityEventSchema.safeParse(atLimit).success).toBe(true);
  });

  it("enforces entity/project bounds", () => {
    const longEntityType = {
      ...baseFields(),
      type: "security.mcp.rejected",
      reason: "bad tool",
      entityType: "e".repeat(129),
    };
    expect(SecurityEventSchema.safeParse(longEntityType).success).toBe(false);
    const longEntityId = {
      ...baseFields(),
      type: "security.mcp.rejected",
      reason: "bad tool",
      entityId: "e".repeat(257),
    };
    expect(SecurityEventSchema.safeParse(longEntityId).success).toBe(false);
    const longProject = {
      ...baseFields(),
      type: "security.sync.rejected",
      reason: "bad record",
      projectId: "p".repeat(257),
    };
    expect(SecurityEventSchema.safeParse(longProject).success).toBe(false);
  });

  it("carries envelope ids only — never secret-bearing fields", () => {
    const shape = Object.keys(SecurityEventSchema.shape);
    for (const forbidden of ["token", "password", "secret", "payload", "apiKey"]) {
      expect(shape).not.toContain(forbidden);
    }
  });

  it("enforces sequence and schemaVersion on security events", () => {
    const missingSeq = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      schemaVersion: 1,
      timestamp: now(),
      type: "security.ipc.rejected",
      category: "extension",
      reason: "bad payload",
    };
    expect(SecurityEventSchema.safeParse(missingSeq).success).toBe(false);
    expect(AIEventSchema.safeParse(missingSeq).success).toBe(false);
  });
});
