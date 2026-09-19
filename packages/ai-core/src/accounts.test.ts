// PR45: packages/ai-core — Account contract unit tests (CONTRACTS layer)

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  ACCOUNT_EVENT_NAMES,
  ACCOUNT_EVENT_TYPES,
  ACCOUNT_SCHEMA_VERSION,
  AccountEmailSchema,
  AccountErrorCodeSchema,
  AccountEventNameSchema,
  AccountEventTypeSchema,
  AccountIdSchema,
  AccountSessionSchema,
  AccountSessionStatusSchema,
  DeviceIdSchema,
  DevicePlatformSchema,
  DeviceRecordSchema,
  MAX_ACCOUNT_DISPLAY_NAME_LENGTH,
  MAX_ACCOUNT_EMAIL_LENGTH,
  MAX_DEVICE_NAME_LENGTH,
  SESSION_TRANSITIONS,
  UserAccountRecordSchema,
  accountEventType,
  asAccountId,
  asDeviceId,
  createAccountId,
  createDeviceId,
  isLegalSessionTransition,
  parseAccountId,
  parseDeviceId,
  toAccountError,
  validateAccountInput,
  validateDeviceInput,
  type AccountSession,
  type AccountSessionStatus,
  type AuthProvider,
} from "./accounts.js";
import { isUlid } from "@ai-desktop/shared";

const TS = "2026-09-18T00:00:00.000Z";
const TS2 = "2026-09-18T01:00:00.000Z";

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: createAccountId(),
    displayName: "Ada Lovelace",
    createdAt: TS,
    updatedAt: TS,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: createDeviceId(),
    accountId: createAccountId(),
    deviceName: "Ada's Laptop",
    platform: "win32",
    createdAt: TS,
    lastSeenAt: TS,
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    accountId: createAccountId(),
    deviceId: createDeviceId(),
    status: "authenticated",
    createdAt: TS,
    ...overrides,
  };
}

describe("accounts: branded ids", () => {
  it("generates valid ULIDs distinct across account/device namespaces", () => {
    const aid = createAccountId();
    const did = createDeviceId();
    expect(isUlid(aid)).toBe(true);
    expect(isUlid(did)).toBe(true);
    expect(aid).not.toBe(did);
    expect(AccountIdSchema.safeParse(aid).success).toBe(true);
    expect(DeviceIdSchema.safeParse(did).success).toBe(true);
    expect(AccountIdSchema.safeParse("too-short").success).toBe(false);
    expect(DeviceIdSchema.safeParse("!!!").success).toBe(false);
  });

  it("parses valid ULIDs case-insensitively and throws TypeError on malformed input", () => {
    const raw = createAccountId().toLowerCase();
    expect(parseAccountId(raw)).toBe(raw.toUpperCase());
    expect(parseDeviceId(raw)).toBe(raw.toUpperCase());
    expect(() => parseAccountId("bad-id")).toThrow(TypeError);
    expect(() => parseDeviceId("bad-id")).toThrow(TypeError);
    expect(asAccountId("x")).toBe("x");
    expect(asDeviceId("y")).toBe("y");
  });

  it("normalizes lowercase ULIDs to uppercase via schema transform", () => {
    const lower = createDeviceId().toLowerCase();
    expect(DeviceIdSchema.parse(lower)).toBe(lower.toUpperCase());
    expect(AccountIdSchema.parse(lower)).toBe(lower.toUpperCase());
  });
});

describe("accounts: email-or-plaintext identifier", () => {
  it("accepts valid emails", () => {
    for (const email of ["ada@example.com", "a.b+tag@sub.domain.io", "user@domain.co"]) {
      expect(AccountEmailSchema.safeParse(email).success).toBe(true);
    }
  });

  it("accepts plaintext identifiers without @", () => {
    for (const id of ["adalovelace", "Ada Lovelace", "user_123", " local handle "]) {
      expect(AccountEmailSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects malformed emails containing @ and empty/overlong values", () => {
    expect(AccountEmailSchema.safeParse("not-an-email@").success).toBe(false);
    expect(AccountEmailSchema.safeParse("@no-local.com").success).toBe(false);
    expect(AccountEmailSchema.safeParse("a@b").success).toBe(false);
    expect(AccountEmailSchema.safeParse("a @ b.com").success).toBe(false);
    expect(AccountEmailSchema.safeParse("").success).toBe(false);
    expect(AccountEmailSchema.safeParse("   ").success).toBe(false);
    expect(AccountEmailSchema.safeParse("e".repeat(257)).success).toBe(false);
    expect(MAX_ACCOUNT_EMAIL_LENGTH).toBe(256);
  });
});

describe("accounts: UserAccountRecord", () => {
  it("accepts a minimal record without email (email never required)", () => {
    const parsed = UserAccountRecordSchema.parse(makeAccount());
    expect(parsed.email).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);
    expect(ACCOUNT_SCHEMA_VERSION).toBe(1);
  });

  it("accepts records with email and plaintext identifiers", () => {
    expect(UserAccountRecordSchema.parse(makeAccount({ email: "ada@example.com" })).email).toBe(
      "ada@example.com",
    );
    expect(UserAccountRecordSchema.parse(makeAccount({ email: "adalovelace" })).email).toBe(
      "adalovelace",
    );
  });

  it("rejects missing/empty/overlong display names and bad ids", () => {
    expect(() => UserAccountRecordSchema.parse(makeAccount({ displayName: "" }))).toThrow();
    expect(() =>
      UserAccountRecordSchema.parse(makeAccount({ displayName: "n".repeat(121) })),
    ).toThrow();
    expect(MAX_ACCOUNT_DISPLAY_NAME_LENGTH).toBe(120);
    expect(() => UserAccountRecordSchema.parse(makeAccount({ accountId: "nope" }))).toThrow();
    expect(() => UserAccountRecordSchema.parse(makeAccount({ schemaVersion: 2 }))).toThrow();
    expect(() => UserAccountRecordSchema.parse(makeAccount({ createdAt: "tomorrow" }))).toThrow();
    expect(() => UserAccountRecordSchema.parse(makeAccount({ email: "bad@" }))).toThrow();
  });

  it("refuses secret-bearing displayName/email with secret-refused (never echoing)", () => {
    const sensitive = "api_key=SUPER-SENSITIVE-ACCOUNT-VALUE";
    const res = UserAccountRecordSchema.safeParse(
      makeAccount({ displayName: `hello ${sensitive}` }),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toContain("secret-refused");
      expect(JSON.stringify(res.error)).not.toContain("SUPER-SENSITIVE-ACCOUNT-VALUE");
    }
    const res2 = UserAccountRecordSchema.safeParse(
      makeAccount({ displayName: "ok", email: "x token=hunter2-secret" }),
    );
    // email with spaces fails email shape OR secret guard; either way rejected
    expect(res2.success).toBe(false);
    expect(() =>
      UserAccountRecordSchema.parse(makeAccount({ displayName: "db password=hunter2-secret" })),
    ).toThrow(/secret-refused/);
  });

  it("contains NO password/token/secret fields by construction", () => {
    const shape = Object.keys(UserAccountRecordSchema.shape);
    for (const forbidden of ["password", "token", "secret", "credential", "apiKey", "api_key"]) {
      expect(shape).not.toContain(forbidden);
    }
    expect(shape).toEqual(
      expect.arrayContaining(["accountId", "displayName", "createdAt", "updatedAt"]),
    );
  });
});

describe("accounts: DeviceRecord", () => {
  it("accepts every documented platform", () => {
    for (const platform of ["win32", "darwin", "linux", "unknown"]) {
      expect(DeviceRecordSchema.parse(makeDevice({ platform })).platform).toBe(platform);
      expect(DevicePlatformSchema.safeParse(platform).success).toBe(true);
    }
    expect(DevicePlatformSchema.safeParse("win64").success).toBe(false);
    expect(DevicePlatformSchema.safeParse("").success).toBe(false);
  });

  it("rejects missing ids, empty/overlong names, and bad timestamps", () => {
    expect(() => DeviceRecordSchema.parse(makeDevice({ deviceId: "bad" }))).toThrow();
    expect(() => DeviceRecordSchema.parse(makeDevice({ accountId: "bad" }))).toThrow();
    expect(() => DeviceRecordSchema.parse(makeDevice({ deviceName: "" }))).toThrow();
    expect(() => DeviceRecordSchema.parse(makeDevice({ deviceName: "d".repeat(121) }))).toThrow();
    expect(MAX_DEVICE_NAME_LENGTH).toBe(120);
    expect(() => DeviceRecordSchema.parse(makeDevice({ lastSeenAt: "never" }))).toThrow();
  });

  it("refuses secret-bearing device names", () => {
    expect(() => DeviceRecordSchema.parse(makeDevice({ deviceName: "laptop oauth=zzz" }))).toThrow(
      /secret-refused/,
    );
    expect(() => DeviceRecordSchema.parse(makeDevice({ deviceName: "api_key=abc123" }))).toThrow(
      /secret-refused/,
    );
  });

  it("contains NO password/token/secret fields by construction", () => {
    const shape = Object.keys(DeviceRecordSchema.shape);
    for (const forbidden of ["password", "token", "secret", "credential", "refreshToken"]) {
      expect(shape).not.toContain(forbidden);
    }
  });
});

describe("accounts: session lifecycle", () => {
  it("accepts exactly the six documented statuses", () => {
    for (const s of [
      "signed_out",
      "authenticating",
      "authenticated",
      "refreshing",
      "expired",
      "error",
    ]) {
      expect(AccountSessionStatusSchema.safeParse(s).success).toBe(true);
    }
    for (const bad of ["signed_in", "logged_in", "active", "pending", ""]) {
      expect(AccountSessionStatusSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("fans signed_out to authenticating only", () => {
    expect(isLegalSessionTransition("signed_out", "authenticating")).toBe(true);
    expect(isLegalSessionTransition("signed_out", "signed_out")).toBe(false);
    expect(isLegalSessionTransition("signed_out", "authenticated")).toBe(false);
    expect(isLegalSessionTransition("signed_out", "expired")).toBe(false);
    expect(isLegalSessionTransition("signed_out", "error")).toBe(false);
    expect(SESSION_TRANSITIONS["signed_out"]).toEqual(["authenticating"]);
  });

  it("implements the exact authenticating fan-out", () => {
    expect(isLegalSessionTransition("authenticating", "authenticated")).toBe(true);
    expect(isLegalSessionTransition("authenticating", "error")).toBe(true);
    expect(isLegalSessionTransition("authenticating", "signed_out")).toBe(true);
    expect(isLegalSessionTransition("authenticating", "refreshing")).toBe(false);
    expect(isLegalSessionTransition("authenticating", "expired")).toBe(false);
    expect(isLegalSessionTransition("authenticating", "authenticating")).toBe(false);
  });

  it("implements the exact authenticated fan-out", () => {
    for (const to of ["refreshing", "expired", "signed_out", "error"] as const) {
      expect(isLegalSessionTransition("authenticated", to)).toBe(true);
    }
    expect(isLegalSessionTransition("authenticated", "authenticated")).toBe(false);
    expect(isLegalSessionTransition("authenticated", "authenticating")).toBe(false);
  });

  it("implements the exact refreshing fan-out", () => {
    for (const to of ["authenticated", "expired", "error", "signed_out"] as const) {
      expect(isLegalSessionTransition("refreshing", to)).toBe(true);
    }
    expect(isLegalSessionTransition("refreshing", "refreshing")).toBe(false);
    expect(isLegalSessionTransition("refreshing", "authenticating")).toBe(false);
  });

  it("implements expired/error recovery fan-out", () => {
    for (const from of ["expired", "error"] as const) {
      expect(isLegalSessionTransition(from, "authenticating")).toBe(true);
      expect(isLegalSessionTransition(from, "signed_out")).toBe(true);
      expect(isLegalSessionTransition(from, "authenticated")).toBe(false);
      expect(isLegalSessionTransition(from, "refreshing")).toBe(false);
      expect(isLegalSessionTransition(from, from)).toBe(false);
    }
  });

  it("covers all six statuses in the transition map", () => {
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual(
      ["authenticated", "authenticating", "error", "expired", "refreshing", "signed_out"].sort(),
    );
    const all: AccountSessionStatus[] = [
      "signed_out",
      "authenticating",
      "authenticated",
      "refreshing",
      "expired",
      "error",
    ];
    for (const s of all) {
      expect(Array.isArray(SESSION_TRANSITIONS[s])).toBe(true);
    }
  });
});

describe("accounts: AccountSession record", () => {
  it("accepts a minimal session and optional expiry/refresh fields", () => {
    const parsed = AccountSessionSchema.parse(makeSession());
    expect(parsed.status).toBe("authenticated");
    expect(parsed.expiresAt).toBeUndefined();
    const full = AccountSessionSchema.parse(
      makeSession({ status: "refreshing", expiresAt: TS2, lastRefreshAt: TS2 }),
    );
    expect(full.expiresAt).toBe(TS2);
  });

  it("rejects bad statuses, bad ids, and bad timestamps", () => {
    expect(() => AccountSessionSchema.parse(makeSession({ status: "signed_in" }))).toThrow();
    expect(() => AccountSessionSchema.parse(makeSession({ accountId: "bad" }))).toThrow();
    expect(() => AccountSessionSchema.parse(makeSession({ createdAt: "now" }))).toThrow();
  });

  it("carries ids + status only — NEVER tokens", () => {
    const shape = Object.keys(AccountSessionSchema.shape);
    expect(shape).toEqual(expect.arrayContaining(["accountId", "deviceId", "status", "createdAt"]));
    for (const forbidden of ["token", "refreshToken", "accessToken", "password", "secret"]) {
      expect(shape).not.toContain(forbidden);
    }
    const session: AccountSession = makeSession() as AccountSession;
    expect(JSON.stringify(session)).not.toMatch(/token|password/i);
  });
});

describe("accounts: validateAccountInput / validateDeviceInput", () => {
  it("accepts minimal inputs", () => {
    expect(validateAccountInput({ displayName: "Ada" })).toEqual({ displayName: "Ada" });
    expect(validateAccountInput({ displayName: "Ada", email: "ada@example.com" }).email).toBe(
      "ada@example.com",
    );
    const device = validateDeviceInput({
      accountId: createAccountId(),
      deviceName: "laptop",
      platform: "linux",
    });
    expect(device.platform).toBe("linux");
  });

  it("throws ZodError for schema violations and secrets without echoing", () => {
    for (const bad of [
      {},
      { displayName: "" },
      { displayName: "n".repeat(121) },
      { displayName: "ok", email: "bad@" },
    ]) {
      try {
        validateAccountInput(bad);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
      }
    }
    const sensitive = "password=SUPER-SENSITIVE-INPUT";
    try {
      validateAccountInput({ displayName: `hi ${sensitive}` });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      expect(String(err)).toContain("secret-refused");
      expect(String(err)).not.toContain("SUPER-SENSITIVE-INPUT");
    }
    try {
      validateDeviceInput({
        accountId: createAccountId(),
        deviceName: "x",
        platform: "win64",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });
});

describe("accounts: AuthProvider port is type-only (no vendor SDK)", () => {
  it("a mock provider satisfies the port shape without tokens", () => {
    const accountId = createAccountId();
    const deviceId = createDeviceId();
    let current: { accountId: typeof accountId; displayName: string } | null = null;
    const provider: AuthProvider = {
      signIn: (input) => {
        current = { accountId, displayName: input.displayName };
        return { accountId, deviceId, status: "authenticated", createdAt: TS };
      },
      signOut: () => {
        current = null;
      },
      refresh: () => ({ accountId, deviceId, status: "authenticated", createdAt: TS }),
      getCurrentAccount: () =>
        current === null
          ? null
          : {
              accountId: current.accountId,
              displayName: current.displayName,
              createdAt: TS,
              updatedAt: TS,
              schemaVersion: 1 as const,
            },
    };
    expect(provider.getCurrentAccount()).toBeNull();
    const session = provider.signIn({ displayName: "Ada" });
    expect(session.status).toBe("authenticated");
    expect(provider.getCurrentAccount()?.displayName).toBe("Ada");
    provider.signOut();
    expect(provider.getCurrentAccount()).toBeNull();
    // Authentication never implies authorization: session carries no grant.
    expect(Object.keys(session)).not.toContain("permissions");
    expect(Object.keys(session)).not.toContain("token");
  });
});

describe("accounts: error helper", () => {
  it("returns the {code, message} shape and rejects unknown codes", () => {
    expect(toAccountError("not-found", "missing")).toEqual({
      code: "not-found",
      message: "missing",
    });
    expect(() => toAccountError("nope" as never, "bad")).toThrow();
    for (const code of ["not-found", "validation-error", "secret-refused", "conflict"]) {
      expect(AccountErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

describe("accounts: event allowlist", () => {
  it("builds fully-qualified names for all 7 allowlisted types", () => {
    expect(accountEventType("created")).toBe("account.created");
    expect(accountEventType("signed_in")).toBe("account.signed_in");
    expect(accountEventType("signed_out")).toBe("account.signed_out");
    expect(accountEventType("session.expired")).toBe("account.session.expired");
    expect(accountEventType("session.refreshed")).toBe("account.session.refreshed");
    expect(accountEventType("device.registered")).toBe("device.registered");
    expect(accountEventType("device.seen")).toBe("device.seen");
    expect(ACCOUNT_EVENT_TYPES).toHaveLength(7);
    expect(ACCOUNT_EVENT_NAMES).toHaveLength(7);
    for (const t of ACCOUNT_EVENT_TYPES) {
      expect(AccountEventTypeSchema.safeParse(t).success).toBe(true);
    }
    for (const n of ACCOUNT_EVENT_NAMES) {
      expect(AccountEventNameSchema.safeParse(n).success).toBe(true);
    }
  });

  it("rejects sync-style, background-style, and ad-hoc types", () => {
    expect(() => accountEventType("started")).toThrow();
    expect(() => accountEventType("task.background.started")).toThrow();
    expect(() => accountEventType("sync.started")).toThrow();
    expect(() => accountEventType("")).toThrow();
    expect(() => accountEventType("account.created")).toThrow();
    expect(() => accountEventType("session.created")).toThrow();
  });
});
