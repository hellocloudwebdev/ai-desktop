import { describe, expect, it } from "vitest";
import {
  AccountEventSchema,
  AIEventSchema,
  SyncEventSchema,
  isCapabilityEvent,
  isCoreEvent,
  isExtensionEvent,
  type AccountEvent,
  type AIEvent,
  type ConversationCreatedEvent,
  type MessageCreatedEvent,
  type MessageDeltaEvent,
  type PermissionRequestedEvent,
  type ScheduleEvent,
  type SyncEvent,
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
import { createAccountId, createDeviceId } from "./accounts.js";
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

  it("validates account.* / device.* lifecycle events (PR45)", () => {
    const convId = createConversationId();
    const base = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 8,
      schemaVersion: 1,
      timestamp: now(),
      category: "extension" as const,
      accountId: createAccountId(),
    };
    const created: AccountEvent = {
      ...base,
      type: "account.created",
    };
    expect(AccountEventSchema.safeParse(created).success).toBe(true);
    expect(AIEventSchema.safeParse(created).success).toBe(true);
    expect(isExtensionEvent(created)).toBe(true);
    for (const type of [
      "account.created",
      "account.signed_in",
      "account.signed_out",
      "account.session.expired",
      "account.session.refreshed",
      "device.registered",
      "device.seen",
    ] as const) {
      const evt = {
        ...base,
        eventId: createEventId(),
        type,
        deviceId: createDeviceId(),
        status: "authenticated",
        detail: "ok",
      };
      expect(AccountEventSchema.safeParse(evt).success).toBe(true);
      expect(AIEventSchema.safeParse(evt).success).toBe(true);
    }
    const seenWithoutDevice: AccountEvent = {
      ...base,
      eventId: createEventId(),
      type: "device.seen",
    };
    expect(AccountEventSchema.safeParse(seenWithoutDevice).success).toBe(true);
    // Events carry ids + status/detail only, NEVER tokens.
    const shape = Object.keys(AccountEventSchema.shape);
    for (const forbidden of ["token", "password", "secret", "refreshToken", "accessToken"]) {
      expect(shape).not.toContain(forbidden);
    }
    expect(shape).toEqual(expect.arrayContaining(["accountId", "type", "category"]));
    const badType = { ...base, eventId: createEventId(), type: "account.launch" };
    expect(AccountEventSchema.safeParse(badType).success).toBe(false);
    expect(AIEventSchema.safeParse(badType).success).toBe(false);
    const syncStyle = { ...base, eventId: createEventId(), type: "sync.started" };
    expect(AccountEventSchema.safeParse(syncStyle).success).toBe(false);
    const missingAccount = { ...base, eventId: createEventId(), type: "account.created" };
    delete (missingAccount as Record<string, unknown>).accountId;
    expect(AccountEventSchema.safeParse(missingAccount).success).toBe(false);
    const badAccountId = {
      ...base,
      eventId: createEventId(),
      type: "account.created",
      accountId: "bad",
    };
    expect(AccountEventSchema.safeParse(badAccountId).success).toBe(false);
    const overlongDetail = {
      ...base,
      eventId: createEventId(),
      type: "account.signed_in",
      detail: "d".repeat(2001),
    };
    expect(AccountEventSchema.safeParse(overlongDetail).success).toBe(false);
    const wrongCategory = {
      ...base,
      eventId: createEventId(),
      type: "account.created",
      category: "core",
    };
    expect(AccountEventSchema.safeParse(wrongCategory).success).toBe(false);
  });

  it("validates sync.* lifecycle events (PR45)", () => {
    const convId = createConversationId();
    const base = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 9,
      schemaVersion: 1,
      timestamp: now(),
      category: "extension" as const,
    };
    const started: SyncEvent = {
      ...base,
      type: "sync.started",
      accountId: createAccountId(),
      deviceId: createDeviceId(),
    };
    expect(SyncEventSchema.safeParse(started).success).toBe(true);
    expect(AIEventSchema.safeParse(started).success).toBe(true);
    expect(isExtensionEvent(started)).toBe(true);
    for (const type of [
      "sync.started",
      "sync.completed",
      "sync.failed",
      "sync.conflict",
      "sync.queued",
    ] as const) {
      const evt = {
        ...base,
        eventId: createEventId(),
        type,
        accountId: createAccountId(),
        deviceId: createDeviceId(),
        status: "syncing",
        detail: "ok",
        entityType: "account.preferences",
        entityId: "theme",
      };
      expect(SyncEventSchema.safeParse(evt).success).toBe(true);
      expect(AIEventSchema.safeParse(evt).success).toBe(true);
    }
    // accountId/deviceId/entity context are all optional (offline/queued before login).
    const bare: SyncEvent = { ...base, eventId: createEventId(), type: "sync.queued" };
    expect(SyncEventSchema.safeParse(bare).success).toBe(true);
    // Events carry ids + status/detail only, NEVER tokens or payload bytes.
    const shape = Object.keys(SyncEventSchema.shape);
    for (const forbidden of ["token", "password", "secret", "payload"]) {
      expect(shape).not.toContain(forbidden);
    }
    const badType = { ...base, eventId: createEventId(), type: "sync.launch" };
    expect(SyncEventSchema.safeParse(badType).success).toBe(false);
    expect(AIEventSchema.safeParse(badType).success).toBe(false);
    const accountStyle = { ...base, eventId: createEventId(), type: "account.created" };
    expect(SyncEventSchema.safeParse(accountStyle).success).toBe(false);
    const badEntity = {
      ...base,
      eventId: createEventId(),
      type: "sync.conflict",
      entityType: "user.token",
      entityId: "theme",
    };
    expect(SyncEventSchema.safeParse(badEntity).success).toBe(false);
    const overlongDetail = {
      ...base,
      eventId: createEventId(),
      type: "sync.failed",
      detail: "d".repeat(2001),
    };
    expect(SyncEventSchema.safeParse(overlongDetail).success).toBe(false);
    const wrongCategory = {
      ...base,
      eventId: createEventId(),
      type: "sync.started",
      category: "core",
    };
    expect(SyncEventSchema.safeParse(wrongCategory).success).toBe(false);
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
