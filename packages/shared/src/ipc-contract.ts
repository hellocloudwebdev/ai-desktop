// PR3: packages/shared — IPC Contract Specification
//
// Establishes the typed contract between renderer, preload, and main processes.
//
// Constitutional Rule:
//   - shared ↑ desktop / preload / renderer
//   - shared NEVER imports Electron or DOM APIs.
//   - The actual handlers, invokers, and streaming listeners reside in apps/desktop.
//   - Zod schemas provide runtime validation at process boundaries.

import { z } from "zod";
import type { ConversationId, MessageId, PermissionRequestId, TaskId, ToolCallId } from "./ids.js";
import type { Timestamp } from "./time.js";
import { type Result, ok, err } from "./result.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Canonical Channel Names
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = {
  // Chat & streaming operations
  CHAT_SEND: "chat:send",
  CHAT_CANCEL: "chat:cancel",
  CHAT_SUBSCRIBE: "chat:subscribe",
  CHAT_UNSUBSCRIBE: "chat:unsubscribe",
  CHAT_STREAM_EVENT: "chat:stream-event",
  CHAT_STREAM_BATCH: "chat:stream-batch",

  // Application lifecycle & health
  APP_HEALTH_CHECK: "app:health-check",
  APP_GET_VERSION: "app:get-version",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ---------------------------------------------------------------------------
// Base Field Schemas
// ---------------------------------------------------------------------------

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const UlidStringSchema = z
  .string()
  .trim()
  .regex(ULID_PATTERN, { message: "Value must be a valid 26-character Crockford Base32 ULID" });

export const TimestampStringSchema = z.string().trim().regex(ISO_UTC_PATTERN, {
  message: "Timestamp must be an ISO-8601 UTC string (YYYY-MM-DDTHH:mm:ss.sssZ)",
});

export const ConversationIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ConversationId,
);
export const MessageIdSchema = UlidStringSchema.transform((val) => val.toUpperCase() as MessageId);
export const TaskIdSchema = UlidStringSchema.transform((val) => val.toUpperCase() as TaskId);
export const PermissionRequestIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as PermissionRequestId,
);
export const ToolCallIdSchema = UlidStringSchema.transform(
  (val) => val.toUpperCase() as ToolCallId,
);

// ---------------------------------------------------------------------------
// Command Contracts (Renderer -> Main Process)
// ---------------------------------------------------------------------------

/**
 * Command to send a user message and initiate/continue a conversation stream.
 */
export const ChatSendCommandSchema = z.object({
  conversationId: ConversationIdSchema,
  content: z.string().min(1, "Message content cannot be empty"),
  clientMessageId: MessageIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: TimestampStringSchema.optional(),
});

export type ChatSendCommand = z.infer<typeof ChatSendCommandSchema>;

/**
 * Command to cancel an active streaming operation or task.
 */
export const ChatCancelCommandSchema = z.object({
  conversationId: ConversationIdSchema,
  messageId: MessageIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  reason: z.string().max(500).optional(),
});

export type ChatCancelCommand = z.infer<typeof ChatCancelCommandSchema>;

/**
 * Command to subscribe to streaming events for a specific conversation.
 */
export const ChatSubscribeCommandSchema = z.object({
  conversationId: ConversationIdSchema,
});

export type ChatSubscribeCommand = z.infer<typeof ChatSubscribeCommandSchema>;

/**
 * Command to unsubscribe from streaming events for a specific conversation.
 */
export const ChatUnsubscribeCommandSchema = z.object({
  conversationId: ConversationIdSchema,
});

export type ChatUnsubscribeCommand = z.infer<typeof ChatUnsubscribeCommandSchema>;

// ---------------------------------------------------------------------------
// Event Contracts (Main Process -> Renderer)
// ---------------------------------------------------------------------------

export const ChatStreamEventKindSchema = z.enum([
  "delta",
  "status",
  "tool_call",
  "tool_result",
  "error",
  "done",
]);

export type ChatStreamEventKind = z.infer<typeof ChatStreamEventKindSchema>;

export const ChatStreamDeltaPayloadSchema = z.object({
  text: z.string(),
  messageId: MessageIdSchema.optional(),
});

export const ChatStreamStatusPayloadSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
});

export const ChatStreamToolCallPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolName: z.string(),
  arguments: z.unknown(),
});

export const ChatStreamToolResultPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export const ChatStreamErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const ChatStreamDonePayloadSchema = z.object({
  messageId: MessageIdSchema.optional(),
  finishReason: z.string().optional(),
});

export const ChatStreamEventSchema = z.object({
  conversationId: ConversationIdSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: TimestampStringSchema,
  kind: ChatStreamEventKindSchema,
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("delta"), delta: ChatStreamDeltaPayloadSchema }),
    z.object({ kind: z.literal("status"), status: ChatStreamStatusPayloadSchema }),
    z.object({ kind: z.literal("tool_call"), toolCall: ChatStreamToolCallPayloadSchema }),
    z.object({ kind: z.literal("tool_result"), toolResult: ChatStreamToolResultPayloadSchema }),
    z.object({ kind: z.literal("error"), error: ChatStreamErrorPayloadSchema }),
    z.object({ kind: z.literal("done"), done: ChatStreamDonePayloadSchema }),
  ]),
});

export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

// ---------------------------------------------------------------------------
// Generic Envelope Wrappers (for typed IPC calls)
// ---------------------------------------------------------------------------

export interface IpcRequestEnvelope<T> {
  readonly id: string;
  readonly channel: string;
  readonly payload: T;
  readonly timestamp: Timestamp;
}

export type IpcResponseEnvelope<T> =
  | {
      readonly requestId: string;
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

// ---------------------------------------------------------------------------
// Runtime Validation Helpers (returning Result<T, ValidationError>)
// ---------------------------------------------------------------------------

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
}

export function validateChatSendCommand(input: unknown): Result<ChatSendCommand, ValidationError> {
  const parsed = ChatSendCommandSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(
    new ValidationError(`Invalid ChatSendCommand: ${formatZodIssues(parsed.error.issues)}`, {
      details: parsed.error.issues,
    }),
  );
}

export function validateChatCancelCommand(
  input: unknown,
): Result<ChatCancelCommand, ValidationError> {
  const parsed = ChatCancelCommandSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(
    new ValidationError(`Invalid ChatCancelCommand: ${formatZodIssues(parsed.error.issues)}`, {
      details: parsed.error.issues,
    }),
  );
}

export function validateChatStreamEvent(input: unknown): Result<ChatStreamEvent, ValidationError> {
  const parsed = ChatStreamEventSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(
    new ValidationError(`Invalid ChatStreamEvent: ${formatZodIssues(parsed.error.issues)}`, {
      details: parsed.error.issues,
    }),
  );
}
