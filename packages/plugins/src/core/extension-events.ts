// PR32: packages/plugins — Extension Custom Events
//
// Invariants:
//   1. This factory can ONLY construct "extension.custom" events
//      (type "extension.custom", category "extension"). It NEVER constructs
//      core or capability event types (task.*, conversation.*, message.*,
//      tool.*, permission.*, execution.*) — forging those through this
//      factory is impossible because type/category are hardcoded.
//   2. Event shape matches ai-core ExtensionCustomEventSchema; ai-core is NOT
//      modified — validation reuses ExtensionCustomEventSchema directly.
//   3. Payload JSON is capped at 64KB.

import { z } from "zod";
import {
  createEventId,
  CURRENT_SCHEMA_VERSION,
  ExtensionCustomEventSchema,
  type ExtensionCustomEvent,
} from "@ai-desktop/ai-core";
import {
  createConversationId,
  now,
  ValidationError,
  type Result,
  ok,
  err,
} from "@ai-desktop/shared";

export const EXTENSION_EVENT_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export const MAX_EXTENSION_EVENT_PAYLOAD_BYTES = 64 * 1024; // 64KB

export interface BuildExtensionCustomEventParams {
  readonly extensionId: string;
  readonly extensionName: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly conversationId?: string;
  readonly eventId?: string;
  readonly timestamp?: string;
}

const BuildParamsSchema = z.object({
  extensionId: z.string().trim().min(1).max(64),
  extensionName: z.string().trim().min(1).max(100),
  eventName: z.string().trim().min(1).max(64).regex(EXTENSION_EVENT_NAME_PATTERN, {
    message: "eventName must match ^[a-z][a-z0-9._-]{0,63}$",
  }),
  payload: z.unknown(),
  conversationId: z.string().trim().min(1).optional(),
  eventId: z.string().trim().min(1).optional(),
  timestamp: z.string().trim().min(1).optional(),
});

/**
 * Builds an ExtensionCustomEvent-shaped object. Type/category are hardcoded
 * to "extension.custom"/"extension" so callers cannot forge other event types.
 */
export function buildExtensionCustomEvent(
  params: BuildExtensionCustomEventParams,
): Result<ExtensionCustomEvent, ValidationError> {
  const parsed = BuildParamsSchema.safeParse(params);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return err(new ValidationError(`Invalid extension event params: ${issues}`));
  }

  const { extensionName, eventName, payload } = parsed.data;

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    return err(new ValidationError("Extension event payload is not JSON-serializable"));
  }
  if (
    payloadJson !== undefined &&
    Buffer.byteLength(payloadJson, "utf8") > MAX_EXTENSION_EVENT_PAYLOAD_BYTES
  ) {
    return err(
      new ValidationError(
        `Extension event payload exceeds ${MAX_EXTENSION_EVENT_PAYLOAD_BYTES} bytes`,
      ),
    );
  }

  let conversationId: string;
  try {
    conversationId = parsed.data.conversationId ?? createConversationId();
  } catch {
    return err(new ValidationError("Invalid conversationId for extension event"));
  }

  const candidate = {
    eventId: parsed.data.eventId ?? createEventId(),
    conversationId,
    sequence: 0,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    timestamp: (parsed.data.timestamp ?? now()) as string,
    // Hardcoded: this factory can ONLY emit extension.custom events.
    type: "extension.custom",
    category: "extension",
    extensionName,
    payload: { extensionId: parsed.data.extensionId, eventName, data: payload },
  };

  const validated = ExtensionCustomEventSchema.safeParse(candidate);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return err(new ValidationError(`Extension event failed ai-core validation: ${issues}`));
  }
  return ok(validated.data);
}

/**
 * Validates an unknown value against ai-core ExtensionCustomEventSchema.
 */
export function validateExtensionEvent(
  value: unknown,
): Result<ExtensionCustomEvent, ValidationError> {
  const parsed = ExtensionCustomEventSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return err(new ValidationError(`Invalid extension event: ${issues}`));
  }
  return ok(parsed.data);
}
