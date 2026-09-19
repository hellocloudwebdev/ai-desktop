// PR46: apps/desktop — Main IPC Security Helpers (Electron + Main + IPC layer)
//
// Surgical hardening helpers for the typed IPC registry. This module owns NO
// Electron runtime imports (type-only WebContents reference would be fine, but
// even that is avoided — sender validation is structural so unit tests can use
// stubs and the file stays free of runtime Electron coupling).
//
// Contents:
//   1. Payload-size guards (extend Zod field maxima; do NOT duplicate them).
//      Zod schemas already bound every string/bytes field; the byte guard here
//      caps the *serialized* envelope so a many-keys payload cannot bypass
//      per-field maxima.
//   2. Sender/WebContents validation (destroyed or missing senders fail closed).
//   3. Stale/duplicate-unsafe request handling (opt-in requestId idempotency +
//      timestamp freshness where the caller supplies them; absent fields are
//      ignored — never a break).
//   4. Safe error serialization (no stacks, secrets, or absolute paths).
//   5. Project/entity isolation spot-checks (null-byte/control-char rejection;
//      deeper ownership checks stay in the domain services).
//   6. Forbidden-channel guard (no generic execute/eval/spawn channel may ever
//      be registered) + canonical security.ipc.rejected event factory + emit
//      helper (storage.append THEN bus.publish, mirroring AccountService).

import { createEventId, type AIEvent } from "@ai-desktop/ai-core";
import type { EventBus } from "@ai-desktop/agent-runtime";
import type { EventRepository } from "@ai-desktop/storage";

// ---------------------------------------------------------------------------
// 1. Payload-size guards
// ---------------------------------------------------------------------------

/** Default serialized-payload ceiling for non-binary channels (1 MiB). */
export const IPC_MAX_PAYLOAD_BYTES_DEFAULT = 1_048_576;

/** Serialized-payload ceiling for the base64 document-ingest channel. */
export const IPC_MAX_PAYLOAD_BYTES_DOCUMENTS_INGEST = 15_000_000;

/** Serialized-payload ceiling for the base64 attachment-upload channel. */
export const IPC_MAX_PAYLOAD_BYTES_ATTACHMENTS_UPLOAD = 38_000_000;

/** Request-id dedup window (5 minutes). */
export const IPC_REQUEST_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** Maximum tracked request ids (bounded; oldest evicted first). */
export const IPC_REQUEST_DEDUP_MAX_ENTRIES = 1000;

/** Timestamp freshness window: inputs carrying `timestamp` older than this
 *  are rejected as stale (15 minutes; 5-minute future tolerance). */
export const IPC_REQUEST_STALE_AFTER_MS = 15 * 60 * 1000;
export const IPC_REQUEST_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Sentinel conversation for security audit events that carry no natural
 * conversation id. 26x "0" satisfies the shared ULID pattern and keeps the
 * storage partition stable without inventing a fake conversation.
 */
export const SECURITY_AUDIT_CONVERSATION_ID = "00000000000000000000000000";

/** Canonical reason cap (mirrors SecurityEventSchema reason 1..500). */
export const SECURITY_REASON_MAX_CHARS = 500;

const BINARY_CHANNEL_SUFFIXES: Readonly<Record<string, number>> = {
  "documents:ingest": IPC_MAX_PAYLOAD_BYTES_DOCUMENTS_INGEST,
  "attachments:upload": IPC_MAX_PAYLOAD_BYTES_ATTACHMENTS_UPLOAD,
};

/** Per-channel serialized payload ceiling. Binary channels get higher caps;
 *  everything else shares the 1 MiB default (extends Zod maxima). */
export function maxPayloadBytesForChannel(channel: string): number {
  return BINARY_CHANNEL_SUFFIXES[channel] ?? IPC_MAX_PAYLOAD_BYTES_DEFAULT;
}

/** Best-effort serialized size estimate (JSON length; 0 for unserializable). */
export function estimatePayloadBytes(rawInput: unknown): number {
  try {
    const serialized = JSON.stringify(rawInput);
    if (typeof serialized !== "string") {
      return 0;
    }
    return serialized.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 2. Forbidden-channel guard (no generic execute/eval/spawn channel)
// ---------------------------------------------------------------------------

const FORBIDDEN_CHANNEL_SEGMENTS = new Set(["execute", "eval", "spawn"]);

/**
 * True when any `:`/`/`/`-`/`_` separated segment of the channel equals
 * execute/eval/spawn (case-insensitive). Segment-exact matching avoids false
 * positives on words like "retrieval" or "interval".
 */
export function isForbiddenIpcChannel(channel: string): boolean {
  const segments = channel.toLowerCase().split(/[:/_-]+/);
  return segments.some((segment) => FORBIDDEN_CHANNEL_SEGMENTS.has(segment));
}

// ---------------------------------------------------------------------------
// 3. Sender validation (structural — no Electron runtime import)
// ---------------------------------------------------------------------------

export interface IpcSenderLike {
  readonly sender?: {
    isDestroyed?: () => boolean;
  } | null;
}

export function validateIpcSender(event: unknown): { ok: true } | { ok: false; reason: string } {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "missing sender envelope" };
  }
  const sender = (event as IpcSenderLike).sender;
  if (!sender) {
    return { ok: false, reason: "missing sender" };
  }
  try {
    if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) {
      return { ok: false, reason: "sender destroyed" };
    }
  } catch {
    return { ok: false, reason: "sender check failed" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. Safe error serialization (no stacks / secrets / absolute paths)
// ---------------------------------------------------------------------------

const SECRET_VALUE_PATTERN =
  /(api[_-]?key|secret|bearer\s+[A-Za-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]+|sk-(live|test)-[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|password\s*[:=]\s*\S+|passwd\s*[:=]\s*\S+|client[_-]?secret\s*[:=]\s*\S+|access[_-]?token\s*[:=]\s*\S+|refresh[_-]?token\s*[:=]\s*\S+)/gi;

const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s"'`;,)]*/g;
const UNIX_PATH_PATTERN =
  /\/(?:home|users|root|etc|var|tmp|opt|srv|mnt|dev|proc|sys|private|data|app|workspace|workspaces|projects?|repos?|git|code|src|desktop|documents|downloads)[^\s"'`;,)]*/gi;

/** First-line only, secrets redacted, absolute paths collapsed, capped. */
export function sanitizeErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message || err.name || "handler failed";
  } else if (typeof err === "string") {
    raw = err;
  } else {
    try {
      raw = JSON.stringify(err) ?? "handler failed";
    } catch {
      raw = "handler failed";
    }
  }
  const firstLine = raw.split("\n")[0] ?? "";
  const redacted = firstLine
    .replace(SECRET_VALUE_PATTERN, "[redacted]")
    .replace(WINDOWS_PATH_PATTERN, "<path>")
    .replace(UNIX_PATH_PATTERN, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  const safe = redacted || "handler failed";
  return safe.length > SECURITY_REASON_MAX_CHARS ? safe.slice(0, SECURITY_REASON_MAX_CHARS) : safe;
}

/** Scrub a security-event reason: trimmed, single-line, secret-free, 1..500. */
export function scrubSecurityReason(reason: string): string {
  const singleLine = reason.replace(/\s+/g, " ").trim();
  const redacted = singleLine
    .replace(SECRET_VALUE_PATTERN, "[redacted]")
    .replace(WINDOWS_PATH_PATTERN, "<path>")
    .replace(UNIX_PATH_PATTERN, "<path>");
  const capped =
    redacted.length > SECURITY_REASON_MAX_CHARS
      ? redacted.slice(0, SECURITY_REASON_MAX_CHARS)
      : redacted;
  return capped || "ipc rejected";
}

// ---------------------------------------------------------------------------
// 5. Project / entity isolation spot-checks
// ---------------------------------------------------------------------------

/**
 * Shallow isolation spot-check on parsed input. Zod owns shape/bounds; this
 * layer rejects only unambiguous smuggling markers (null bytes, control
 * characters in projectId) that no legitimate caller ever sends. Deeper
 * ownership (wrong-project / wrong-entity) stays in the domain services,
 * which fail closed on unknown ids.
 */
export function checkProjectIsolation(
  input: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!input || typeof input !== "object") {
    return { ok: true };
  }
  const record = input as Record<string, unknown>;
  const projectId = record["projectId"];
  if (projectId === undefined) {
    return { ok: true };
  }
  if (typeof projectId !== "string") {
    return { ok: false, reason: "project isolation: projectId must be a string" };
  }
  // biome-ignore lint: explicit control-character check is the point.
  if (projectId.includes("\0") || /[\u0000-\u001f\u007f]/.test(projectId)) {
    return { ok: false, reason: "project isolation: projectId carries control characters" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 6. Stale / duplicate request tracking (opt-in via requestId / timestamp)
// ---------------------------------------------------------------------------

export function extractRequestId(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") {
    return undefined;
  }
  const value = (rawInput as Record<string, unknown>)["requestId"];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "unknown") {
    return undefined;
  }
  return trimmed.slice(0, 128);
}

export function extractTimestampMs(rawInput: unknown): number | undefined {
  if (!rawInput || typeof rawInput !== "object") {
    return undefined;
  }
  const value = (rawInput as Record<string, unknown>)["timestamp"];
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Bounded duplicate/stale tracker. Duplicate suppression keys on
 * channel+requestId (only when the caller supplies a requestId); staleness
 * applies only when the caller supplies a timestamp. Inputs without either
 * field pass through untouched — never a behavior break.
 */
export class IpcRequestTracker {
  private readonly _seen = new Map<string, number>();
  private readonly _windowMs: number;
  private readonly _maxEntries: number;

  constructor(options: { windowMs?: number; maxEntries?: number } = {}) {
    this._windowMs = options.windowMs ?? IPC_REQUEST_DEDUP_WINDOW_MS;
    this._maxEntries = options.maxEntries ?? IPC_REQUEST_DEDUP_MAX_ENTRIES;
  }

  check(
    channel: string,
    rawInput: unknown,
    nowMs: number = Date.now(),
  ): { ok: true } | { ok: false; code: "DUPLICATE_REQUEST" | "STALE_REQUEST"; reason: string } {
    const timestampMs = extractTimestampMs(rawInput);
    if (timestampMs !== undefined) {
      const age = nowMs - timestampMs;
      if (age > IPC_REQUEST_STALE_AFTER_MS) {
        return {
          ok: false,
          code: "STALE_REQUEST",
          reason: `stale request: ${Math.round(age / 1000)}s old`,
        };
      }
      if (timestampMs - nowMs > IPC_REQUEST_FUTURE_TOLERANCE_MS) {
        return {
          ok: false,
          code: "STALE_REQUEST",
          reason: "stale request: timestamp in the future",
        };
      }
    }

    const requestId = extractRequestId(rawInput);
    if (requestId === undefined) {
      return { ok: true };
    }
    const key = `${channel}::${requestId}`;
    this._evictExpired(nowMs);
    const firstSeen = this._seen.get(key);
    if (firstSeen !== undefined && nowMs - firstSeen < this._windowMs) {
      return { ok: false, code: "DUPLICATE_REQUEST", reason: `duplicate requestId "${requestId}"` };
    }
    this._seen.set(key, nowMs);
    if (this._seen.size > this._maxEntries) {
      const oldest = this._seen.keys().next();
      if (!oldest.done) {
        this._seen.delete(oldest.value);
      }
    }
    return { ok: true };
  }

  private _evictExpired(nowMs: number): void {
    if (this._seen.size === 0) {
      return;
    }
    for (const [key, seenAt] of this._seen) {
      if (nowMs - seenAt >= this._windowMs) {
        this._seen.delete(key);
      }
    }
  }

  get size(): number {
    return this._seen.size;
  }
}

// ---------------------------------------------------------------------------
// 7. Canonical security.ipc.rejected event factory + emit helper
// ---------------------------------------------------------------------------

export interface SecurityIpcRejectedInfo {
  readonly channel: string;
  readonly reason: string;
  readonly conversationId?: string;
  readonly projectId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
}

function pickBoundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Pull bounded entity context out of raw/parsed input for the audit event. */
export function extractSecurityContext(rawInput: unknown): {
  conversationId?: string;
  projectId?: string;
  entityType?: string;
  entityId?: string;
} {
  if (!rawInput || typeof rawInput !== "object") {
    return {};
  }
  const record = rawInput as Record<string, unknown>;
  const out: {
    conversationId?: string;
    projectId?: string;
    entityType?: string;
    entityId?: string;
  } = {};
  const conversationId = pickBoundedText(record["conversationId"], 256);
  if (conversationId) {
    out.conversationId = conversationId;
  }
  const projectId = pickBoundedText(record["projectId"], 256);
  if (projectId) {
    out.projectId = projectId;
  }
  for (const [key, entityType] of [
    ["messageId", "message"],
    ["taskId", "task"],
    ["sessionId", "session"],
    ["documentId", "document"],
    ["scheduleId", "schedule"],
  ] as const) {
    const entityId = pickBoundedText(record[key], 256);
    if (entityId) {
      out.entityType = entityType;
      out.entityId = entityId;
      break;
    }
  }
  return out;
}

/**
 * Build a canonical security.ipc.rejected AIEvent (category "extension",
 * following the ScheduleEventSchema pattern). The reason is scrubbed;
 * entity context is bounded; secrets never survive this factory.
 */
export function createSecurityIpcRejectedEvent(
  info: SecurityIpcRejectedInfo,
  options: { eventId?: string; timestamp?: string; sequence?: number } = {},
): AIEvent {
  return createSecurityEvent("security.ipc.rejected", info, options);
}

/** All 11 canonical security audit types (ai-core SecurityEventSchema). */
export type SecurityAuditType =
  | "security.ipc.rejected"
  | "security.permission.denied"
  | "security.secret.redacted"
  | "security.path.rejected"
  | "security.network.blocked"
  | "security.browser.blocked"
  | "security.plugin.rejected"
  | "security.mcp.rejected"
  | "security.document.rejected"
  | "security.sync.rejected"
  | "security.integrity.failure";

/**
 * Build any canonical security.* AIEvent (category "extension"). The IPC
 * wrapper above stays the primary path; window/navigation rejections use
 * security.browser.blocked through this factory with the same scrubbing and
 * bounds.
 */
export function createSecurityEvent(
  securityType: SecurityAuditType,
  info: SecurityIpcRejectedInfo,
  options: { eventId?: string; timestamp?: string; sequence?: number } = {},
): AIEvent {
  const context = extractSecurityContext({
    conversationId: info.conversationId,
    projectId: info.projectId,
  });
  const conversationId =
    typeof info.conversationId === "string" && info.conversationId.trim().length > 0
      ? info.conversationId.trim().slice(0, 256)
      : (context.conversationId ?? SECURITY_AUDIT_CONVERSATION_ID);
  const event = {
    eventId: options.eventId ?? createEventId(),
    conversationId,
    sequence: options.sequence ?? 0,
    schemaVersion: 1,
    timestamp: options.timestamp ?? new Date().toISOString(),
    type: securityType,
    category: "extension",
    reason: scrubSecurityReason(`${info.channel}: ${info.reason}`),
    ...(info.entityType || context.entityType
      ? { entityType: (info.entityType ?? context.entityType) as string }
      : {}),
    ...(info.entityId || context.entityId
      ? { entityId: (info.entityId ?? context.entityId) as string }
      : {}),
    ...(info.projectId || context.projectId
      ? { projectId: (info.projectId ?? context.projectId) as string }
      : {}),
  } as unknown as AIEvent;
  return event;
}

export interface SecurityEmitPorts {
  readonly storage: Pick<EventRepository, "append" | "getByConversation">;
  readonly bus: Pick<EventBus, "publish">;
}

/**
 * Emit any canonical security.* audit event via storage.append THEN
 * bus.publish (the AccountService/SchedulerService ordering: persistence
 * before delivery). Best-effort — audit emission never throws into the IPC
 * dispatch path. Sequence is allocated from the conversation length with a
 * bounded retry on duplicate-sequence races.
 */
export async function emitSecurityEvent(
  ports: SecurityEmitPorts,
  securityType: SecurityAuditType,
  info: SecurityIpcRejectedInfo,
): Promise<void> {
  const conversationId = (
    typeof info.conversationId === "string" && info.conversationId.trim().length > 0
      ? info.conversationId.trim().slice(0, 256)
      : SECURITY_AUDIT_CONVERSATION_ID
  ) as AIEvent["conversationId"];
  try {
    let base = 0;
    try {
      const existing = await ports.storage.getByConversation(conversationId);
      base = existing.length;
    } catch {
      base = 0;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const event = createSecurityEvent(securityType, info, {
        conversationId,
        sequence: base + attempt,
      } as unknown as { sequence: number });
      try {
        await ports.storage.append(event);
        try {
          await ports.bus.publish(event);
        } catch {
          // Delivery failure must not fail the rejection path.
        }
        return;
      } catch {
        continue;
      }
    }
  } catch {
    // Audit emission is best-effort by design.
  }
}

/**
 * Emit a security.ipc.rejected audit event (primary IPC path).
 * Thin wrapper over emitSecurityEvent; kept so call sites read plainly.
 */
export async function emitSecurityIpcRejected(
  ports: SecurityEmitPorts,
  info: SecurityIpcRejectedInfo,
): Promise<void> {
  return emitSecurityEvent(ports, "security.ipc.rejected", info);
}
