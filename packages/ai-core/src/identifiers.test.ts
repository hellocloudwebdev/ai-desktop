import { describe, expect, it } from "vitest";
import {
  createEventId,
  createExecutionId,
  createTaskNodeId,
  parseEventId,
  parseExecutionId,
  parseTaskNodeId,
  EventIdSchema,
  ExecutionIdSchema,
  TaskNodeIdSchema,
  ModelIdSchema,
  ProviderIdSchema,
  type EventId,
  type ExecutionId,
  type TaskNodeId,
} from "./identifiers.js";
import { isUlid } from "@ai-desktop/shared";

describe("ai-core identifiers: Branded ID Generation and Validation", () => {
  it("generates valid ULIDs for EventId, ExecutionId, and TaskNodeId", () => {
    const eventId = createEventId();
    const execId = createExecutionId();
    const nodeId = createTaskNodeId();

    expect(isUlid(eventId)).toBe(true);
    expect(isUlid(execId)).toBe(true);
    expect(isUlid(nodeId)).toBe(true);
  });

  it("parses valid ULID strings into uppercase branded types", () => {
    const raw = createEventId().toLowerCase();
    expect(parseEventId(raw)).toBe(raw.toUpperCase());
    expect(parseExecutionId(raw)).toBe(raw.toUpperCase());
    expect(parseTaskNodeId(raw)).toBe(raw.toUpperCase());
  });

  it("throws TypeError on malformed IDs during parsing", () => {
    expect(() => parseEventId("bad-id")).toThrow(TypeError);
    expect(() => parseExecutionId("bad-id")).toThrow(TypeError);
    expect(() => parseTaskNodeId("bad-id")).toThrow(TypeError);
  });

  it("validates IDs via Zod schemas", () => {
    const raw = createEventId();
    expect(EventIdSchema.safeParse(raw).success).toBe(true);
    expect(ExecutionIdSchema.safeParse(raw).success).toBe(true);
    expect(TaskNodeIdSchema.safeParse(raw).success).toBe(true);

    expect(EventIdSchema.safeParse("too-short").success).toBe(false);

    expect(ModelIdSchema.safeParse("gemini:gemini-2.5-flash").success).toBe(true);
    expect(ProviderIdSchema.safeParse("gemini").success).toBe(true);
  });

  it("maintains compile-time type safety across branded identifiers", () => {
    const eventId = createEventId();
    const execId = createExecutionId();
    const nodeId = createTaskNodeId();

    function acceptEventId(id: EventId) {
      return Boolean(id);
    }
    function acceptExecutionId(id: ExecutionId) {
      return Boolean(id);
    }
    function acceptTaskNodeId(id: TaskNodeId) {
      return Boolean(id);
    }

    expect(acceptEventId(eventId)).toBe(true);
    expect(acceptExecutionId(execId)).toBe(true);
    expect(acceptTaskNodeId(nodeId)).toBe(true);
  });
});
