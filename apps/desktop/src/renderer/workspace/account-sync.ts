// PR45: renderer — Accounts & Cross-Device Sync bridge + pure view helpers
//
// Narrow, renderer-safe access to the account/sync IPC owned by the sibling
// agent (`window.api.account.{get,signIn,signOut,refresh,device}` +
// `window.api.sync.{status,start,pause,conflicts,resolve}`). Method names
// match the real preload bridge exactly; every call threads what the IPC
// requires: empty commands carry `{}` (never undefined — the main-side Zod
// schemas validate an object), `signIn` carries `{ displayName, email? }`,
// `conflicts` carries `{}` (optional `limit`), and `resolve` carries
// `{ conflictId, resolution, projectId? }` (the schema field is
// `resolution`, never `choice`). Each bridge is probed with optional
// chaining: when the sibling IPC has not landed yet (or on non-Electron
// hosts / tests without `window`), every accessor yields an empty result —
// never a crash — and `createLocalAccountSyncStub` provides an in-memory
// stand-in so the Account surface renders and the store/projection tests
// pass.
//
// Invariants:
//   1. Projections only: the renderer never touches runtime internals,
//      Node or Electron APIs, spawned processes, Prisma, network auth, or
//      the DOM bridge beyond `window.api`. Data arrives as
//      `AccountSessionView`/`SyncStatusView`-shaped views and leaves as
//      narrow calls. NO tokens/secrets ever enter renderer state.
//   2. The renderer holds no source of truth: state re-queries the bridges
//      on mount / poll, so remounts and disconnects recover by re-fetching.
//   3. Signing out never wipes local data: sign-out clears the session only;
//      local projects stay on this device (delete ≠ wipe).
//   4. Hygiene at render: display names ≤120; `key=value`-shaped secret
//      material is redacted, never rendered raw.
//   5. Nothing executes from a partial form: sign-in bridge calls fire only
//      after `validateSignInForm` reports zero errors. Conflicts are never
//      resolved silently: only explicit keep-local / keep-remote choices.

// ---------------------------------------------------------------------------
// Vocabulary (canonical: signed_out/authenticating/authenticated/refreshing/
// expired/error sessions; idle/syncing/offline/error/conflict sync)
// ---------------------------------------------------------------------------

/** Canonical account session states. No tokens/secrets ever accompany them. */
export const SESSION_STATUSES = [
  "signed_out",
  "authenticating",
  "authenticated",
  "refreshing",
  "expired",
  "error",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Canonical cross-device sync states. */
export const SYNC_STATUSES = ["idle", "syncing", "offline", "error", "conflict"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Explicit conflict resolutions. There is no silent/auto choice. */
export const CONFLICT_RESOLUTIONS = ["keep-local", "keep-remote"] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isSyncStatus(value: unknown): value is SyncStatus {
  return typeof value === "string" && (SYNC_STATUSES as readonly string[]).includes(value);
}

export function isConflictResolution(value: unknown): value is ConflictResolution {
  return typeof value === "string" && (CONFLICT_RESOLUTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Caps (renderer mirrors; enforcement lives main-side)
// ---------------------------------------------------------------------------

/** Maximum display-name length (mirror schedules hygiene). */
export const MAX_ACCOUNT_DISPLAY_NAME = 120;
/** Maximum rows rendered per list; the store stays authoritative. */
export const MAX_ACCOUNT_SYNC_ROWS = 50;
/** Maximum conflicts rendered; the store stays authoritative. */
export const MAX_CONFLICTS_SHOWN = 50;

// ---------------------------------------------------------------------------
// Renderer-safe views (projection subsets; secrets never carried)
// ---------------------------------------------------------------------------

export interface AccountSessionView {
  readonly status: SessionStatus;
  readonly displayName?: string;
  readonly identifier?: string;
  readonly updatedAt?: string;
  readonly lastError?: string;
}

export interface DeviceView {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform?: string;
  readonly lastSeenAt?: string;
}

export interface SyncStatusView {
  readonly status: SyncStatus;
  readonly lastSyncAt?: string;
  readonly pendingCount: number;
  readonly conflictCount: number;
  readonly lastError?: string;
  readonly paused: boolean;
}

export interface SyncConflictView {
  readonly conflictId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly localVersion?: string;
  readonly remoteVersion?: string;
  readonly changedFields: string[];
  readonly updatedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Validates one unknown entry into an AccountSessionView, or null when
 * unusable. Accepts sibling spelling variants (displayName/name,
 * identifier/email/userId) so the surface activates with no renderer change
 * once the sibling IPC lands. Token/secret-shaped fields are never picked
 * up: only display names and identifiers enter renderer state.
 */
export function normalizeAccountSession(item: unknown): AccountSessionView | null {
  if (!isRecord(item)) return null;
  if (!isSessionStatus(item.status)) return null;
  return {
    status: item.status,
    displayName: asOptionalString(item.displayName ?? item.name),
    identifier: asOptionalString(item.identifier ?? item.email ?? item.userId),
    updatedAt: asOptionalString(item.updatedAt),
    lastError: asOptionalString(item.lastError ?? item.error),
  };
}

/**
 * Validates one unknown entry into a DeviceView, or null when unusable.
 * Accepts spelling variants (deviceId/id, deviceName/name).
 */
export function normalizeDeviceView(item: unknown): DeviceView | null {
  if (!isRecord(item)) return null;
  const deviceId = asNonEmptyString(item.deviceId ?? item.id);
  if (!deviceId) return null;
  const deviceName = asNonEmptyString(item.deviceName ?? item.name);
  if (!deviceName) return null;
  return {
    deviceId,
    deviceName,
    platform: asOptionalString(item.platform ?? item.os),
    lastSeenAt: asOptionalString(item.lastSeenAt ?? item.lastSeen),
  };
}

/**
 * Validates one unknown entry into a SyncStatusView, or null when unusable.
 * Missing counts default to 0; missing paused defaults to false.
 */
export function normalizeSyncStatus(item: unknown): SyncStatusView | null {
  if (!isRecord(item)) return null;
  if (!isSyncStatus(item.status)) return null;
  return {
    status: item.status,
    lastSyncAt: asOptionalString(item.lastSyncAt ?? item.lastSyncedAt),
    pendingCount: asNonNegativeInt(item.pendingCount ?? item.pending, 0),
    conflictCount: asNonNegativeInt(item.conflictCount ?? item.conflicts, 0),
    lastError: asOptionalString(item.lastError ?? item.error),
    paused: item.paused === true,
  };
}

/**
 * Validates one unknown entry into a SyncConflictView, or null when
 * unusable. Accepts spelling variants (conflictId/id, entity/kind/type).
 */
export function normalizeSyncConflict(item: unknown): SyncConflictView | null {
  if (!isRecord(item)) return null;
  const conflictId = asNonEmptyString(item.conflictId ?? item.id);
  if (!conflictId) return null;
  const entity = asNonEmptyString(item.entity ?? item.kind ?? item.type);
  if (!entity) return null;
  const entityId = asNonEmptyString(item.entityId);
  if (!entityId) return null;
  const changedFields = Array.isArray(item.changedFields)
    ? item.changedFields.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];
  return {
    conflictId,
    entity,
    entityId,
    localVersion: asOptionalString(item.localVersion ?? item.local),
    remoteVersion: asOptionalString(item.remoteVersion ?? item.remote),
    changedFields,
    updatedAt: asOptionalString(item.updatedAt),
  };
}

/** Normalizes a candidate conflict list, dropping entries that fail validation. */
export function normalizeSyncConflicts(items: readonly unknown[]): SyncConflictView[] {
  const views: SyncConflictView[] = [];
  for (const item of items) {
    const view = normalizeSyncConflict(item);
    if (view) views.push(view);
  }
  return views;
}

function unwrapEnvelope(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.ok === true && "value" in raw) return raw.value;
  return raw;
}

/**
 * Accepts the session envelope (`{ ok, value: { session } }` /
 * `{ ok, value: {...} }`) or a raw projection. Anything else yields null.
 */
export function unwrapAccountSession(raw: unknown): unknown {
  const value = unwrapEnvelope(raw);
  if (isRecord(value) && "session" in value) return value.session;
  return value;
}

/** Accepts the device envelope (`{ ok, value: { device } }`) or a raw projection. */
export function unwrapDevice(raw: unknown): unknown {
  const value = unwrapEnvelope(raw);
  if (isRecord(value) && "device" in value) return value.device;
  return value;
}

/** Accepts the status envelope (`{ ok, value: { sync } }`) or a raw projection. */
export function unwrapSyncStatus(raw: unknown): unknown {
  const value = unwrapEnvelope(raw);
  if (isRecord(value) && "sync" in value) return value.sync;
  if (isRecord(value) && "status" in value && typeof value.status === "object") return value.status;
  return value;
}

/**
 * Accepts the conflicts envelope (`{ ok, value: { conflicts } }` /
 * `{ ok, value: [...] }`) or a raw array. Anything else yields [].
 */
export function unwrapSyncConflicts(raw: unknown): unknown[] {
  const value = unwrapEnvelope(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.conflicts)) return value.conflicts;
  return [];
}

// ---------------------------------------------------------------------------
// Labels, indicators, counts
// ---------------------------------------------------------------------------

const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  signed_out: "Signed out",
  authenticating: "Signing in…",
  authenticated: "Signed in",
  refreshing: "Refreshing…",
  expired: "Session expired",
  error: "Sign-in error",
};

export function sessionStatusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABELS[status] ?? status;
}

const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  idle: "Idle",
  syncing: "Syncing",
  offline: "Offline",
  error: "Sync error",
  conflict: "Conflict",
};

export function syncStatusLabel(status: SyncStatus): string {
  return SYNC_STATUS_LABELS[status] ?? status;
}

/**
 * Sidebar/surface sync indicator. Canonical display strings: Synced /
 * Syncing… / Offline / Needs attention / Conflict.
 */
export function syncStatusIndicator(status: SyncStatus): string {
  if (status === "idle") return "Synced";
  if (status === "syncing") return "Syncing…";
  if (status === "offline") return "Offline";
  if (status === "conflict") return "Conflict";
  return "Needs attention";
}

const SYNC_STATUS_BADGE_CLASSES: Record<SyncStatus, string> = {
  idle: "bg-emerald-800 text-emerald-100",
  syncing: "bg-indigo-800 text-indigo-100",
  offline: "bg-slate-700 text-slate-400",
  error: "bg-rose-800 text-rose-100",
  conflict: "bg-amber-800 text-amber-100",
};

export function syncStatusBadgeClass(status: SyncStatus): string {
  return SYNC_STATUS_BADGE_CLASSES[status] ?? "bg-slate-700 text-slate-200";
}

/** True when the sync state needs operator attention (sidebar dot input). */
export function syncNeedsAttention(status: SyncStatus): boolean {
  return status === "error" || status === "conflict" || status === "offline";
}

/** Pending upload count carried by a sync projection (never negative). */
export function pendingSyncCount(status: SyncStatusView | null): number {
  return status ? status.pendingCount : 0;
}

/** Unresolved conflict count carried by a sync projection (never negative). */
export function conflictCount(status: SyncStatusView | null): number {
  return status ? status.conflictCount : 0;
}

// ---------------------------------------------------------------------------
// Render hygiene: truncation + secret redaction + formatting
// ---------------------------------------------------------------------------

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function truncateDisplayName(value: string): string {
  return truncateText(value, MAX_ACCOUNT_DISPLAY_NAME);
}

/**
 * Redacts `key=value`-shaped secret material before render (API keys,
 * tokens, passwords, bearer credentials). Plain prose that merely mentions
 * these words (e.g. "token limit exceeded") passes through untouched —
 * only assignment-shaped fragments are withheld. Mirrors
 * background-tasks.ts / schedules.ts.
 */
export function redactSecretAssignments(value: string): string {
  return value
    .replace(/\b[Bb]earer\s+\S+/g, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|oauth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|authorization)\s*[:=]\s*("[^"]*"|'[^']*'|(?!Bearer\b)\S+)/gi,
      "$1: [redacted]",
    );
}

/** Safe timestamp for display; malformed input renders as "—", never throws. */
export function formatAccountTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * Relative time ("just now", "5m ago", "3h ago", "2d ago") for last-seen /
 * last-sync display. Missing/malformed renders "—". Pure (clock
 * injectable). Future timestamps render "just now".
 */
export function formatRelativeTime(value: string | undefined, nowMs?: number): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "—";
  const now = nowMs ?? Date.now();
  const diffSeconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSeconds < 60) return "just now";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86_400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  const days = Math.floor(diffSeconds / 86_400);
  if (days < 30) return `${days}d ago`;
  return formatAccountTimestamp(value);
}

// ---------------------------------------------------------------------------
// Sign-in form validation (client-side; nothing executes until valid)
// ---------------------------------------------------------------------------

export interface SignInFormInput {
  readonly displayName: string;
  readonly email?: string;
}

export type SignInFormErrors = Record<string, string>;

/**
 * True when a value looks like pasted secret material (`key=value`
 * assignment shapes or bearer credentials). Such values are rejected from
 * the sign-in form: display names and identifiers must never carry secrets.
 */
export function looksSecretShaped(value: string): boolean {
  return redactSecretAssignments(value) !== value;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates the sign-in form. Returns a field→message map; empty means
 * valid. Covers displayName (1–120, no secret-shaped values) and the
 * optional email (valid shape, ≤256 to match the `AccountSignInCommand`
 * schema bound, no secret-shaped values). Callers must not touch the bridge
 * until the map is empty — nothing executes from a partial form.
 */
export function validateSignInForm(input: SignInFormInput): SignInFormErrors {
  const errors: SignInFormErrors = {};
  const displayName = input.displayName.trim();
  if (displayName.length === 0) errors.displayName = "Display name is required.";
  else if (displayName.length > MAX_ACCOUNT_DISPLAY_NAME)
    errors.displayName = `Display name must be ≤${MAX_ACCOUNT_DISPLAY_NAME} characters.`;
  else if (looksSecretShaped(displayName))
    errors.displayName = "Display name must not contain secrets or credentials.";
  const email = (input.email ?? "").trim();
  if (email.length > 0) {
    if (email.length > 256) errors.email = "Email must be ≤256 characters.";
    else if (!EMAIL_PATTERN.test(email)) errors.email = "Email must be a valid address.";
    else if (looksSecretShaped(email)) errors.email = "Email must not contain secrets.";
  }
  return errors;
}

export function isSignInFormValid(input: SignInFormInput): boolean {
  return Object.keys(validateSignInForm(input)).length === 0;
}

// ---------------------------------------------------------------------------
// Narrow bridge clients (`window.api.account.*` + `window.api.sync.*`)
// ---------------------------------------------------------------------------

/**
 * Empty IPC command payload. Threaded as `{}` on every empty command —
 * never undefined — because the main-side Zod schemas
 * (`AccountGetCommandSchema`, `AccountSignOutCommandSchema`,
 * `AccountRefreshCommandSchema`, `AccountDeviceCommandSchema`,
 * `SyncStatusCommandSchema`, `SyncStartCommandSchema`,
 * `SyncPauseCommandSchema`) validate an object.
 */
export type EmptyCommandArgs = Record<string, never>;

/**
 * Expected narrow client for the account IPC (`window.api.account.*`,
 * canonical `account:*` channels). Method names and payload shapes mirror
 * the real preload bridge (`get({})`, `signIn({ displayName, email? })`,
 * `signOut({})`, `refresh({})`, `device({})`). Carries display projections
 * only — never tokens, secrets, or credentials.
 */
export interface AccountCommands {
  get(args: EmptyCommandArgs): Promise<unknown>;
  signIn(args: { displayName: string; email?: string }): Promise<unknown>;
  signOut(args: EmptyCommandArgs): Promise<unknown>;
  refresh(args: EmptyCommandArgs): Promise<unknown>;
  device(args: EmptyCommandArgs): Promise<unknown>;
}

/**
 * Expected narrow client for the sync IPC (`window.api.sync.*`, canonical
 * `sync:*` channels). Method names and payload shapes mirror the real
 * preload bridge (`status({})`, `start({})`, `pause({})`,
 * `conflicts({ limit? })`, `resolve({ conflictId, resolution,
 * projectId? })`). Conflict resolution is always explicit (keep-local /
 * keep-remote); there is no silent/auto choice.
 */
export interface SyncCommands {
  status(args: EmptyCommandArgs): Promise<unknown>;
  start(args: EmptyCommandArgs): Promise<unknown>;
  pause(args: EmptyCommandArgs): Promise<unknown>;
  conflicts(args: { limit?: number }): Promise<unknown>;
  resolve(args: { conflictId: string; resolution: string; projectId?: string }): Promise<unknown>;
}

const ACCOUNT_COMMAND_NAMES = ["get", "signIn", "signOut", "refresh", "device"] as const;
const SYNC_COMMAND_NAMES = ["status", "start", "pause", "conflicts", "resolve"] as const;

function probeBridge<T>(bridgeName: "account" | "sync", names: readonly string[]): T | null {
  try {
    if (typeof window === "undefined") return null;
    const api = window as unknown as { api?: Record<string, Record<string, unknown> | undefined> };
    const bridge = api.api?.[bridgeName];
    if (!bridge) return null;
    for (const name of names) {
      if (typeof bridge[name] !== "function") return null;
    }
    return bridge as unknown as T;
  } catch {
    return null;
  }
}

/**
 * Returns the sibling-owned account bridge when every expected method is
 * present, otherwise null. Never throws: a missing bridge is an expected
 * pre-landing state, not an error.
 */
export function getAccountCommands(): AccountCommands | null {
  return probeBridge<AccountCommands>("account", ACCOUNT_COMMAND_NAMES);
}

/**
 * Returns the sibling-owned sync bridge when every expected method is
 * present, otherwise null. Never throws: a missing bridge is an expected
 * pre-landing state, not an error.
 */
export function getSyncCommands(): SyncCommands | null {
  return probeBridge<SyncCommands>("sync", SYNC_COMMAND_NAMES);
}

/** Fetches the session projection. Absent bridge → signed-out empty state. */
export async function fetchAccountSession(
  commands: AccountCommands | null,
): Promise<AccountSessionView> {
  if (!commands) return { status: "signed_out" };
  const raw = await commands.get({});
  return normalizeAccountSession(unwrapAccountSession(raw)) ?? { status: "signed_out" };
}

/** Fetches the device projection. Absent bridge or no device → null. */
export async function fetchDevice(commands: AccountCommands | null): Promise<DeviceView | null> {
  if (!commands) return null;
  const raw = await commands.device({});
  return normalizeDeviceView(unwrapDevice(raw));
}

/** Fetches the sync projection. Absent bridge → idle empty state. */
export async function fetchSyncStatus(commands: SyncCommands | null): Promise<SyncStatusView> {
  if (!commands) return { status: "idle", pendingCount: 0, conflictCount: 0, paused: false };
  const raw = await commands.status({});
  return (
    normalizeSyncStatus(unwrapSyncStatus(raw)) ?? {
      status: "idle",
      pendingCount: 0,
      conflictCount: 0,
      paused: false,
    }
  );
}

/** Fetches the conflict list. Absent bridge → []. */
export async function fetchSyncConflicts(
  commands: SyncCommands | null,
): Promise<SyncConflictView[]> {
  if (!commands) return [];
  const raw = await commands.conflicts({});
  return normalizeSyncConflicts(unwrapSyncConflicts(raw));
}

export interface AccountSyncCommandResult {
  readonly ok: boolean;
  readonly error: string | null;
}

function toCommandResult(raw: unknown, action: string): AccountSyncCommandResult {
  if (isRecord(raw) && raw.ok === false) {
    const error = isRecord(raw.error)
      ? asOptionalString(raw.error.message)
      : asOptionalString(raw.error);
    return { ok: false, error: error ?? `${action} failed` };
  }
  return { ok: true, error: null };
}

async function runBridgeCommand(
  available: boolean,
  action: string,
  invoke: () => Promise<unknown>,
): Promise<AccountSyncCommandResult> {
  if (!available) return { ok: false, error: "Account IPC is not available yet." };
  try {
    return toCommandResult(await invoke(), action);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `${action} failed` };
  }
}

export function signInAccount(
  commands: AccountCommands | null,
  input: SignInFormInput,
): Promise<AccountSyncCommandResult> {
  return runBridgeCommand(commands !== null, "sign in", () => {
    if (!commands) throw new Error("Account IPC is not available yet.");
    return commands.signIn({
      displayName: input.displayName.trim(),
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    });
  });
}

/**
 * Signs out the session. Sign-out clears the session only — local projects
 * stay on this device (delete ≠ wipe). The UI states this explicitly.
 */
export function signOutAccount(
  commands: AccountCommands | null,
): Promise<AccountSyncCommandResult> {
  return runBridgeCommand(commands !== null, "sign out", () => {
    if (!commands) throw new Error("Account IPC is not available yet.");
    return commands.signOut({});
  });
}

export function refreshSession(
  commands: AccountCommands | null,
): Promise<AccountSyncCommandResult> {
  return runBridgeCommand(commands !== null, "refresh", () => {
    if (!commands) throw new Error("Account IPC is not available yet.");
    return commands.refresh({});
  });
}

export function startSync(commands: SyncCommands | null): Promise<AccountSyncCommandResult> {
  return runBridgeCommand(commands !== null, "start sync", () => {
    if (!commands) throw new Error("Account IPC is not available yet.");
    return commands.start({});
  });
}

export function pauseSync(commands: SyncCommands | null): Promise<AccountSyncCommandResult> {
  return runBridgeCommand(commands !== null, "pause sync", () => {
    if (!commands) throw new Error("Account IPC is not available yet.");
    return commands.pause({});
  });
}

/**
 * Resolves one conflict with an explicit choice. Only `keep-local` /
 * `keep-remote` are accepted — conflicts are never resolved silently. The
 * operator's choice threads onto the wire as `resolution` to match the
 * `SyncResolveCommand` schema (`{ conflictId, resolution, projectId? }`).
 */
export function resolveConflict(
  commands: SyncCommands | null,
  conflictId: string,
  choice: string,
): Promise<AccountSyncCommandResult> {
  return runBridgeCommand(commands !== null, "resolve conflict", () => {
    if (!commands) throw new Error("Account IPC is not available yet.");
    if (!isConflictResolution(choice)) throw new Error("Choose keep-local or keep-remote.");
    return commands.resolve({ conflictId, resolution: choice });
  });
}

// ---------------------------------------------------------------------------
// Local stub (pre-IPC stand-in; renderer-local only, never a source of truth)
// ---------------------------------------------------------------------------

export interface LocalConflictSeed {
  readonly conflictId: string;
  readonly entity?: string;
  readonly entityId?: string;
  readonly localVersion?: string;
  readonly remoteVersion?: string;
  readonly changedFields?: string[];
}

export interface LocalAccountSyncStub {
  readonly account: AccountCommands;
  readonly sync: SyncCommands;
  /** Pins the sync status (offline/conflict simulation for tests/previews). */
  setSyncMode(status: SyncStatus): void;
  seedConflict(conflict: LocalConflictSeed): void;
  /**
   * Renderer-local projects. Sign-out never touches this list: local data
   * is preserved across sessions (delete ≠ wipe).
   */
  readonly localProjects: string[];
}

/**
 * In-memory stand-in implementing `AccountCommands` + `SyncCommands` with
 * IPC-shaped envelopes. Used when the sibling bridges are absent so the
 * Account surface renders an honest signed-out state and tests exercise the
 * full normalize → label → display pipeline. Production state always
 * re-queries the real bridges on mount, so stub contents never leak across
 * a real landing. Sign-in/out follows the canonical state machine
 * (signed_out → authenticating → authenticated; sign-out → signed_out with
 * local projects preserved). No tokens or secrets are ever stored.
 */
export function createLocalAccountSyncStub(
  initial: { displayName?: string; identifier?: string; localProjects?: string[] } = {},
): LocalAccountSyncStub {
  const envelope = (value: unknown): unknown => ({ ok: true, value });
  const failure = (message: string): unknown => ({ ok: false, error: { message } });
  const nowIso = (): string => new Date().toISOString();

  let session: AccountSessionView = { status: "signed_out" };
  let device: DeviceView | null = null;
  let sync: SyncStatusView = { status: "idle", pendingCount: 0, conflictCount: 0, paused: false };
  let pinned: SyncStatus | null = null;
  const conflicts = new Map<string, SyncConflictView>();
  const localProjects: string[] = [...(initial.localProjects ?? ["sample-project"])];

  const applySync = (next: SyncStatusView): SyncStatusView => {
    sync = pinned ? { ...next, status: pinned } : next;
    return sync;
  };

  const refreshConflictCount = (): void => {
    applySync({ ...sync, conflictCount: conflicts.size });
  };

  if (initial.displayName) {
    session = {
      status: "authenticated",
      displayName: initial.displayName,
      identifier: initial.identifier,
      updatedAt: nowIso(),
    };
    device = {
      deviceId: "stub-device-01",
      deviceName: "This device",
      platform: "local",
      lastSeenAt: nowIso(),
    };
  }

  const account: AccountCommands = {
    async get(): Promise<unknown> {
      return envelope({ session });
    },
    async signIn(args: { displayName: string; email?: string }): Promise<unknown> {
      const errors = validateSignInForm({ displayName: args.displayName, email: args.email });
      const first = Object.values(errors)[0];
      if (first) return failure(`validation-error: ${first}`);
      // Canonical sign-in state machine: signed_out → authenticating →
      // authenticated. No credentials cross the bridge: only a display name
      // and an optional identifier.
      session = { status: "authenticating" };
      const displayName = args.displayName.trim();
      session = {
        status: "authenticated",
        displayName: displayName.slice(0, MAX_ACCOUNT_DISPLAY_NAME),
        ...(args.email?.trim() ? { identifier: args.email.trim() } : {}),
        updatedAt: nowIso(),
      };
      device = {
        deviceId: "stub-device-01",
        deviceName: "This device",
        platform: "local",
        lastSeenAt: nowIso(),
      };
      return envelope({ session });
    },
    async signOut(): Promise<unknown> {
      // Sign-out clears the session only. Local projects are preserved:
      // the stub never deletes from `localProjects` here (delete ≠ wipe).
      session = { status: "signed_out", updatedAt: nowIso() };
      device = null;
      return envelope({ session });
    },
    async refresh(): Promise<unknown> {
      if (session.status === "signed_out") return failure("not-signed-in: no session to refresh");
      if (session.status === "expired") return failure("session-expired: sign in again");
      session = { ...session, status: "refreshing" };
      session = { ...session, status: "authenticated", updatedAt: nowIso() };
      return envelope({ session });
    },
    async device(): Promise<unknown> {
      if (!device) return failure("not-signed-in: no device");
      return envelope({ device: { ...device, lastSeenAt: nowIso() } });
    },
  };

  const syncBridge: SyncCommands = {
    async status(): Promise<unknown> {
      refreshConflictCount();
      return envelope({ sync });
    },
    async start(): Promise<unknown> {
      if (pinned === "offline") return failure("offline: connect before syncing");
      applySync({
        ...sync,
        status: conflicts.size > 0 ? "conflict" : "syncing",
        paused: false,
        lastSyncAt: nowIso(),
        pendingCount: 0,
      });
      return envelope({ sync });
    },
    async pause(): Promise<unknown> {
      applySync({ ...sync, status: "idle", paused: true });
      return envelope({ sync });
    },
    async conflicts(): Promise<unknown> {
      return envelope({ conflicts: [...conflicts.values()] });
    },
    async resolve(args: {
      conflictId: string;
      resolution: string;
      projectId?: string;
    }): Promise<unknown> {
      if (!isConflictResolution(args.resolution)) {
        return failure("validation-error: Choose keep-local or keep-remote.");
      }
      if (!conflicts.has(args.conflictId)) {
        return failure(`not-found: ${args.conflictId}`);
      }
      // Explicit choice only: keep-local keeps the local version,
      // keep-remote takes the remote version. Nothing silent.
      conflicts.delete(args.conflictId);
      refreshConflictCount();
      if (conflicts.size === 0 && sync.status === "conflict") {
        applySync({ ...sync, status: "idle" });
      }
      return envelope({ resolved: true, conflictId: args.conflictId, resolution: args.resolution });
    },
  };

  return {
    account,
    sync: syncBridge,
    setSyncMode(status: SyncStatus): void {
      pinned = status;
      applySync({ ...sync, status });
    },
    seedConflict(conflict: LocalConflictSeed): void {
      const view = normalizeSyncConflict({
        conflictId: conflict.conflictId,
        entity: conflict.entity ?? "memory",
        entityId: conflict.entityId ?? "fact-01",
        ...(conflict.localVersion ? { localVersion: conflict.localVersion } : {}),
        ...(conflict.remoteVersion ? { remoteVersion: conflict.remoteVersion } : {}),
        changedFields: conflict.changedFields ?? ["content"],
        updatedAt: nowIso(),
      });
      if (!view) return;
      conflicts.set(view.conflictId, view);
      refreshConflictCount();
      if (pinned === null) applySync({ ...sync, status: "conflict" });
    },
    localProjects,
  };
}
