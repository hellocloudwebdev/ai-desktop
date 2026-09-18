import { describe, expect, it } from "vitest";
import {
  AIEventSchema,
  isCapabilityEvent,
  isCoreEvent,
  isExtensionEvent,
  type AIEvent,
  type ConversationCreatedEvent,
  type MessageCreatedEvent,
  type MessageDeltaEvent,
  type PermissionRequestedEvent,
  type ScheduleEvent,
  type TaskBackgroundEvent,
  type TaskCreatedEvent,
  type ToolCallRequestedEvent,
} from "./events.js";
import {
  createConversationId,
  createMessageId,
  createPermissionRequestId,
  createTaskId,
  createToolCallId,
  now,
} from "@ai-desktop/shared";
import { createEventId, createTaskNodeId } from "./identifiers.js";
import { createScheduleId, createScheduledRunId } from "./schedules.js";
import { textPart } from "./content.js";

describe("ai-core events: AIEvent Discriminated Union and Validation", () => {
  it("validates core events (conversation.created, message.created, message.delta)", () => {
    const convId = createConversationId();

    const convCreated: ConversationCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
      title: "First Conversation",
    };
    expect(AIEventSchema.safeParse(convCreated).success).toBe(true);
    expect(isCoreEvent(convCreated)).toBe(true);
    expect(isCapabilityEvent(convCreated)).toBe(false);

    const msgCreated: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Hello assistant")],
    };
    expect(AIEventSchema.safeParse(msgCreated).success).toBe(true);

    const delta: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 2,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "chunk",
    };
    expect(AIEventSchema.safeParse(delta).success).toBe(true);
  });

  it("validates capability events (tool.call.requested, permission.requested)", () => {
    const convId = createConversationId();
    const toolCallId = createToolCallId();

    const toolRequested: ToolCallRequestedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 3,
      schemaVersion: 1,
      timestamp: now(),
      type: "tool.call.requested",
      category: "capability",
      toolCallId,
      toolName: "bash",
      toolSource: "builtin",
      toolRuntime: "execution",
      input: { command: "ls" },
    };
    expect(AIEventSchema.safeParse(toolRequested).success).toBe(true);
    expect(isCapabilityEvent(toolRequested)).toBe(true);
    expect(isCoreEvent(toolRequested)).toBe(false);

    const permRequested: PermissionRequestedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 4,
      schemaVersion: 1,
      timestamp: now(),
      type: "permission.requested",
      category: "capability",
      permissionRequestId: createPermissionRequestId(),
      relatedToolCallIds: [toolCallId],
      capability: "shell:exec",
      action: "execute",
      resource: "/bin/bash",
      risk: "high",
      scope: "session",
    };
    expect(AIEventSchema.safeParse(permRequested).success).toBe(true);
  });

  it("validates extension events (task.created)", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const rootNodeId = createTaskNodeId();

    const taskCreated: TaskCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 5,
      schemaVersion: 1,
      timestamp: now(),
      type: "task.created",
      category: "extension",
      taskId,
      title: "Analyze codebase",
      rootNodeIds: [rootNodeId],
    };
    expect(AIEventSchema.safeParse(taskCreated).success).toBe(true);
    expect(isExtensionEvent(taskCreated)).toBe(true);
  });

  it("validates task.background.* lifecycle events (PR43)", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const base = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 6,
      schemaVersion: 1,
      timestamp: now(),
      category: "extension" as const,
      taskId,
      projectId: "proj-1",
    };
    const started: TaskBackgroundEvent = {
      ...base,
      type: "task.background.started",
      status: "running",
    };
    expect(AIEventSchema.safeParse(started).success).toBe(true);
    expect(isExtensionEvent(started)).toBe(true);
    const recovered: TaskBackgroundEvent = {
      ...base,
      type: "task.background.recovered",
      status: "running",
      detail: "resumable after restart",
    };
    expect(AIEventSchema.safeParse(recovered).success).toBe(true);
    const badType = { ...base, type: "task.background.launch", status: "running" };
    expect(AIEventSchema.safeParse(badType).success).toBe(false);
    const missingProject = { ...base, type: "task.background.started", status: "running" };
    delete (missingProject as Record<string, unknown>).projectId;
    expect(AIEventSchema.safeParse(missingProject).success).toBe(false);
  });

  it("validates schedule.* lifecycle events (PR44)", () => {
    const convId = createConversationId();
    const base = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 7,
      schemaVersion: 1,
      timestamp: now(),
      category: "extension" as const,
      scheduleId: createScheduleId(),
      projectId: "proj-1",
    };
    const created: ScheduleEvent = {
      ...base,
      type: "schedule.created",
    };
    expect(AIEventSchema.safeParse(created).success).toBe(true);
    expect(isExtensionEvent(created)).toBe(true);
    const runStarted: ScheduleEvent = {
      ...base,
      type: "schedule.run.started",
      runId: createScheduledRunId(),
      status: "running",
      detail: "launched via tick",
    };
    expect(AIEventSchema.safeParse(runStarted).success).toBe(true);
    const runSkipped: ScheduleEvent = {
      ...base,
      type: "schedule.run.skipped",
      runId: createScheduledRunId(),
      status: "skipped",
    };
    expect(AIEventSchema.safeParse(runSkipped).success).toBe(true);
    const badType = { ...base, type: "schedule.launch", status: "running" };
    expect(AIEventSchema.safeParse(badType).success).toBe(false);
    const backgroundStyle = { ...base, type: "task.background.started", status: "running" };
    expect(AIEventSchema.safeParse(backgroundStyle).success).toBe(false);
    const missingProject = { ...base, type: "schedule.created" };
    delete (missingProject as Record<string, unknown>).projectId;
    expect(AIEventSchema.safeParse(missingProject).success).toBe(false);
    const missingSchedule = { ...base, type: "schedule.created" };
    delete (missingSchedule as Record<string, unknown>).scheduleId;
    expect(AIEventSchema.safeParse(missingSchedule).success).toBe(false);
    const overlongDetail = {
      ...base,
      type: "schedule.run.failed",
      detail: "d".repeat(2001),
    };
    expect(AIEventSchema.safeParse(overlongDetail).success).toBe(false);
  });

  it("enforces sequence and schemaVersion on all events", () => {
    const missingSeq = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      // missing sequence
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
    };
    expect(AIEventSchema.safeParse(missingSeq).success).toBe(false);

    const negativeSeq = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: -1,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
    };
    expect(AIEventSchema.safeParse(negativeSeq).success).toBe(false);
  });

  it("allows exhaustive narrowing by type discriminator in TypeScript", () => {
    const event: AIEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "sample delta",
    };

    let handled = false;
    switch (event.type) {
      case "message.delta":
        expect(event.deltaText).toBe("sample delta");
        handled = true;
        break;
      default:
        break;
    }
    expect(handled).toBe(true);
  });
});
