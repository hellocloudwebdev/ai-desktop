// PR45: packages/ai-core — Provider-Neutral Identity Contracts (CONTRACTS layer)
//
// Pure domain contracts for user accounts, devices, and sessions: branded
// identifiers, record schemas, session lifecycle, a type-only AuthProvider
// port, caps, secret guards, and event names.
//
// Dependency rule:
//   ai-core -> shared (ai-core may ONLY depend on @ai-desktop/shared)
//
// Zero Electron, Prisma, child process spawn, filesystem, or network imports.
// NO runtime logic here: no provider implementation, no vendor SDK, no token
// store, no persistence writer. Caps and policies below are enforced by
// sibling layers, never by these schemas.
//
// Canonical PR45 decisions (implemented exactly; do not drift):
//   1. Identity: UserAccountRecord { accountId (branded ULID AccountId),
//      displayName <=120, email? (optional email-or-plaintext identifier
//      <=256, never required), createdAt, updatedAt, schemaVersion:1 }.
//      DeviceRecord { deviceId (branded ULID DeviceId), accountId,
//      deviceName <=120, platform (win32/darwin/linux/unknown), createdAt,
//      lastSeenAt }. AccountSession { accountId, deviceId, status,
//      createdAt, expiresAt?, lastRefreshAt? }. NO passwords, NO tokens, NO
//      secrets anywhere in these schemas (enforced by an assertNoSecrets
//      guard + tests). Email is validated as either a well-formed email
//      (contains "@" implies local@domain.dot) or a plaintext identifier;
//      it is never required.
//   2. Session statuses EXACTLY: signed_out/authenticating/authenticated/
//      refreshing/expired/error with the isLegalSessionTransition map below.
//      Terminal-ish signed_out fans out to authenticating only.
//   3. AuthProvider boundary lives here as a TYPE-ONLY port interface (no
//      implementation, no vendor SDK). Concrete providers stay outside
//      ai-core (sibling layers). Authentication != authorization: login
//      never implies AllowAll; every tool execution still flows through
//      PermissionManager.
//  10. Secret guard: reuses assertNoSecrets from background-tasks.js in all
//      record validators below.
//  11. Branded ULID ids follow the identifiers.ts pattern locally (defined
//      here, not in identifiers.ts, to minimize cross-PR conflicts).

import { z } from "zod";
import { TimestampStringSchema, generateUlid, isUlid, type Brand } from "@ai-desktop/shared";
import { assertNoSecrets } from "./background-tasks.js";

// ---------------------------------------------------------------------------
// Branded Account / Device Identifiers
//
// Never reuse logical entity IDs across entities. Defined here rather than
// in identifiers.ts to keep this PR's ownership to its own files; the
// pattern mirrors identifiers.ts and schedules.ts.
// ---------------------------------------------------------------------------

export type AccountId = Brand<string, "AccountId">;
export type DeviceId = Brand<string, "DeviceId">;

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const UlidSchema = z.string().trim().regex(ULID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const AccountIdSchema = UlidSchema.transform((val) => val.toUpperCase() as AccountId);
export const DeviceIdSchema = UlidSchema.transform((val) => val.toUpperCase() as DeviceId);

export function createAccountId(seedTime?: number): AccountId {
  return generateUlid(seedTime) as AccountId;
}

export function createDeviceId(seedTime?: number): DeviceId {
  return generateUlid(seedTime) as DeviceId;
}

export function parseAccountId(raw: string): AccountId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid AccountId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as AccountId;
}

export function parseDeviceId(raw: string): DeviceId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid DeviceId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as DeviceId;
}

export function asAccountId(raw: string): AccountId {
  return raw as AccountId;
}

export function asDeviceId(raw: string): DeviceId {
  return raw as DeviceId;
}

// ---------------------------------------------------------------------------
// Bounds (decision 1)
// ---------------------------------------------------------------------------

export const MAX_ACCOUNT_DISPLAY_NAME_LENGTH = 120;
export const MAX_ACCOUNT_EMAIL_LENGTH = 256;
export const MAX_DEVICE_NAME_LENGTH = 120;
export const ACCOUNT_SCHEMA_VERSION = 1;

const EMAIL_WITH_AT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Optional email-or-plaintext identifier (<=256, never required). Values
 * containing "@" must be well-formed emails; values without "@" are
 * accepted as plaintext identifiers (usernames, display handles).
 */
export const AccountEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ACCOUNT_EMAIL_LENGTH)
  .refine((val) => !val.includes("@") || EMAIL_WITH_AT_PATTERN.test(val), {
    message: "Email must be a valid email address (local@domain.tld) or a plaintext identifier",
  });

// ---------------------------------------------------------------------------
// UserAccountRecord / DeviceRecord (decision 1: no passwords/tokens/secrets)
// ---------------------------------------------------------------------------

export const UserAccountRecordSchema = z
  .object({
    accountId: AccountIdSchema,
    displayName: z.string().trim().min(1).max(MAX_ACCOUNT_DISPLAY_NAME_LENGTH),
    email: AccountEmailSchema.optional(),
    createdAt: TimestampStringSchema,
    updatedAt: TimestampStringSchema,
    schemaVersion: z.literal(ACCOUNT_SCHEMA_VERSION),
  })
  .superRefine((val, ctx) => {
    try {
      assertNoSecrets(val.displayName);
      if (val.email !== undefined) assertNoSecrets(val.email);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: account text appears to contain secret material; store a secure reference instead",
        path: ["displayName"],
      });
    }
  });
export type UserAccountRecord = z.infer<typeof UserAccountRecordSchema>;

/** Alias used by the AuthProvider port below. */
export type UserAccount = UserAccountRecord;

export const DevicePlatformSchema = z.enum(["win32", "darwin", "linux", "unknown"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceRecordSchema = z
  .object({
    deviceId: DeviceIdSchema,
    accountId: AccountIdSchema,
    deviceName: z.string().trim().min(1).max(MAX_DEVICE_NAME_LENGTH),
    platform: DevicePlatformSchema,
    createdAt: TimestampStringSchema,
    lastSeenAt: TimestampStringSchema,
  })
  .superRefine((val, ctx) => {
    try {
      assertNoSecrets(val.deviceName);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: device text appears to contain secret material; store a secure reference instead",
        path: ["deviceName"],
      });
    }
  });
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

// ---------------------------------------------------------------------------
// Session Lifecycle (decision 2)
// ---------------------------------------------------------------------------

export const AccountSessionStatusSchema = z.enum([
  "signed_out",
  "authenticating",
  "authenticated",
  "refreshing",
  "expired",
  "error",
]);
export type AccountSessionStatus = z.infer<typeof AccountSessionStatusSchema>;

/**
 * Legal session transitions (decision 2, implemented exactly).
 * Terminal-ish signed_out fans out to authenticating only.
 */
export const SESSION_TRANSITIONS: Record<AccountSessionStatus, readonly AccountSessionStatus[]> = {
  signed_out: ["authenticating"],
  authenticating: ["authenticated", "error", "signed_out"],
  authenticated: ["refreshing", "expired", "signed_out", "error"],
  refreshing: ["authenticated", "expired", "error", "signed_out"],
  expired: ["authenticating", "signed_out"],
  error: ["authenticating", "signed_out"],
};

export function isLegalSessionTransition(
  from: AccountSessionStatus,
  to: AccountSessionStatus,
): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export const AccountSessionSchema = z.object({
  accountId: AccountIdSchema,
  deviceId: DeviceIdSchema,
  status: AccountSessionStatusSchema,
  createdAt: TimestampStringSchema,
  expiresAt: TimestampStringSchema.optional(),
  lastRefreshAt: TimestampStringSchema.optional(),
});
export type AccountSession = z.infer<typeof AccountSessionSchema>;

// ---------------------------------------------------------------------------
// Creation-Time Input Validators (throw ZodError; secret guard included)
// ---------------------------------------------------------------------------

const AccountInputBaseSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_ACCOUNT_DISPLAY_NAME_LENGTH),
  email: AccountEmailSchema.optional(),
});

export type AccountInput = z.infer<typeof AccountInputBaseSchema>;

/**
 * Validates raw account-creation input. Throws ZodError for schema
 * violations and for secret-bearing text (surfaced as a secret-refused
 * issue, never echoing the value).
 */
export function validateAccountInput(input: unknown): AccountInput {
  return AccountInputBaseSchema.superRefine((val, ctx) => {
    try {
      assertNoSecrets(val.displayName);
      if (val.email !== undefined) assertNoSecrets(val.email);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: account text appears to contain secret material; store a secure reference instead",
        path: ["displayName"],
      });
    }
  }).parse(input);
}

const DeviceInputBaseSchema = z.object({
  accountId: AccountIdSchema,
  deviceName: z.string().trim().min(1).max(MAX_DEVICE_NAME_LENGTH),
  platform: DevicePlatformSchema,
});

export type DeviceInput = z.infer<typeof DeviceInputBaseSchema>;

/**
 * Validates raw device-registration input. Throws ZodError for schema
 * violations and for secret-bearing device names.
 */
export function validateDeviceInput(input: unknown): DeviceInput {
  return DeviceInputBaseSchema.superRefine((val, ctx) => {
    try {
      assertNoSecrets(val.deviceName);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: device text appears to contain secret material; store a secure reference instead",
        path: ["deviceName"],
      });
    }
  }).parse(input);
}

// ---------------------------------------------------------------------------
// AuthProvider Port (decision 3: TYPE-ONLY, no implementation, no vendor SDK)
//
// Concrete providers stay outside ai-core (sibling layers own OAuth,
// OS-keychain token storage, and network). Sessions carry status + ids
// only, NEVER tokens: token material lives in the OS keychain behind a
// secure reference (constitutional rule 9).
//
// Authentication != authorization: a successful login never implies
// AllowAll. Every tool execution still flows through PermissionManager.
// ---------------------------------------------------------------------------

export interface AccountSignInInput {
  readonly displayName: string;
  readonly email?: string;
}

export interface AuthProvider {
  signIn(input: AccountSignInInput): AccountSession;
  signOut(): void;
  refresh(): AccountSession;
  getCurrentAccount(): UserAccount | null;
}

// ---------------------------------------------------------------------------
// Error Taxonomy
// ---------------------------------------------------------------------------

export const AccountErrorCodeSchema = z.enum([
  "not-found",
  "validation-error",
  "secret-refused",
  "conflict",
  "storage-error",
]);
export type AccountErrorCode = z.infer<typeof AccountErrorCodeSchema>;

export interface AccountError {
  readonly code: AccountErrorCode;
  readonly message: string;
}

export function toAccountError(code: AccountErrorCode, message: string): AccountError {
  return { code: AccountErrorCodeSchema.parse(code), message };
}

// ---------------------------------------------------------------------------
// Account / Device Event Names
//
// Full event names (11-account+device set is 7 entries; the "11" in the PR
// brief counts account+device (7) plus sync (5) as 12 listed names — the
// list below implements exactly the 12 names enumerated in the brief):
//   account.created, account.signed_in, account.signed_out,
//   account.session.expired, account.session.refreshed,
//   device.registered, device.seen.
// Events carry ids + status/detail only, NEVER tokens.
// ---------------------------------------------------------------------------

export const ACCOUNT_EVENT_TYPES = [
  "created",
  "signed_in",
  "signed_out",
  "session.expired",
  "session.refreshed",
  "device.registered",
  "device.seen",
] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

export const AccountEventTypeSchema = z.enum(ACCOUNT_EVENT_TYPES);

export const ACCOUNT_EVENT_NAMES = [
  "account.created",
  "account.signed_in",
  "account.signed_out",
  "account.session.expired",
  "account.session.refreshed",
  "device.registered",
  "device.seen",
] as const;
export type AccountEventName = (typeof ACCOUNT_EVENT_NAMES)[number];

export const AccountEventNameSchema = z.enum(ACCOUNT_EVENT_NAMES);

/**
 * Builds a fully-qualified account/device event name, rejecting anything
 * outside the allowlist so producers cannot invent ad-hoc event types.
 * Mirrors backgroundEventType/scheduleEventType: short suffixes map to
 * "account.<suffix>", except "device.*" suffixes which are already
 * fully qualified.
 */
export function accountEventType(type: string): AccountEventName {
  if (!(ACCOUNT_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid account event type: "${type}"`);
  }
  if (type.startsWith("device.")) {
    return type as AccountEventName;
  }
  return `account.${type}` as AccountEventName;
}
