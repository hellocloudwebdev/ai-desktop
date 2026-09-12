// PR3: packages/shared — Logical Entity IDs
//
// The architecture requires branded ULIDs for logical entity IDs so they
// do not collapse into interchangeable strings at compile time.
//
// Specification:
//   - Canonical 26-character Crockford Base32 representation
//   - 48-bit timestamp (ms since epoch) + 80-bit cryptographic randomness
//   - Usable across Node.js, Electron (main + renderer), and browser contexts
//   - Zero external runtime dependencies (relies on standard globalThis.crypto)

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_REGEX = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_LEN = 26;

export type Brand<T, B extends string> = T & {
  readonly __brand: B;
};

export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type TaskId = Brand<string, "TaskId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type PermissionRequestId = Brand<string, "PermissionRequestId">;
export type SessionId = Brand<string, "SessionId">;

function getCrypto(): Crypto {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    return globalThis.crypto;
  }
  throw new Error(
    "A secure cryptographic random source (crypto.getRandomValues) is required to generate ULIDs.",
  );
}

function encodeTime(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 0xffffffffffff) {
    throw new RangeError(
      `ULID timestamp must be a non-negative integer <= 281474976710655 (got ${timeMs})`,
    );
  }
  let str = "";
  let remainder = Math.floor(timeMs);
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = remainder % 32;
    str = CROCKFORD_BASE32[mod] + str;
    remainder = Math.floor((remainder - mod) / 32);
  }
  return str;
}

function encodeRandom(): string {
  const crypto = getCrypto();
  const buffer = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(buffer);
  let str = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    str += CROCKFORD_BASE32[buffer[i] % 32];
  }
  return str;
}

/**
 * Generates a standard 26-character Crockford Base32 ULID.
 * @param seedTime Optional timestamp in ms since Unix epoch (defaults to Date.now()).
 */
export function generateUlid(seedTime: number = Date.now()): string {
  return encodeTime(seedTime) + encodeRandom();
}

/**
 * Validates whether a given value is a syntactically valid 26-character ULID string.
 */
export function isUlid(value: unknown): value is string {
  return typeof value === "string" && value.length === ULID_LEN && ULID_REGEX.test(value);
}

/**
 * Extracts the 48-bit timestamp (ms since epoch) from a valid ULID.
 */
export function getUlidTimestamp(ulid: string): number {
  if (!isUlid(ulid)) {
    throw new TypeError(`Cannot extract timestamp from invalid ULID: "${ulid}"`);
  }
  const upper = ulid.toUpperCase();
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const char = upper[i];
    const index = CROCKFORD_BASE32.indexOf(char);
    if (index === -1) {
      throw new TypeError(`Invalid Crockford character '${char}' in ULID timestamp portion`);
    }
    time = time * 32 + index;
  }
  return time;
}

// ---------------------------------------------------------------------------
// Branded ID Constructors (generate fresh branded ULIDs)
// ---------------------------------------------------------------------------

export function createConversationId(seedTime?: number): ConversationId {
  return generateUlid(seedTime) as ConversationId;
}

export function createMessageId(seedTime?: number): MessageId {
  return generateUlid(seedTime) as MessageId;
}

export function createTaskId(seedTime?: number): TaskId {
  return generateUlid(seedTime) as TaskId;
}

export function createToolCallId(seedTime?: number): ToolCallId {
  return generateUlid(seedTime) as ToolCallId;
}

export function createPermissionRequestId(seedTime?: number): PermissionRequestId {
  return generateUlid(seedTime) as PermissionRequestId;
}

export function createSessionId(seedTime?: number): SessionId {
  return generateUlid(seedTime) as SessionId;
}

// ---------------------------------------------------------------------------
// Branded ID Parsers (validate syntax and return branded types)
// ---------------------------------------------------------------------------

export function parseConversationId(raw: string): ConversationId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid ConversationId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as ConversationId;
}

export function parseMessageId(raw: string): MessageId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid MessageId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as MessageId;
}

export function parseTaskId(raw: string): TaskId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid TaskId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as TaskId;
}

export function parseToolCallId(raw: string): ToolCallId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid ToolCallId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as ToolCallId;
}

export function parsePermissionRequestId(raw: string): PermissionRequestId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid PermissionRequestId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as PermissionRequestId;
}

export function parseSessionId(raw: string): SessionId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid SessionId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as SessionId;
}

// ---------------------------------------------------------------------------
// Trusted Type Casting Helpers (for trusted persistence / test layers)
// ---------------------------------------------------------------------------

export function asConversationId(raw: string): ConversationId {
  return raw as ConversationId;
}

export function asMessageId(raw: string): MessageId {
  return raw as MessageId;
}

export function asTaskId(raw: string): TaskId {
  return raw as TaskId;
}

export function asToolCallId(raw: string): ToolCallId {
  return raw as ToolCallId;
}

export function asPermissionRequestId(raw: string): PermissionRequestId {
  return raw as PermissionRequestId;
}

export function asSessionId(raw: string): SessionId {
  return raw as SessionId;
}
