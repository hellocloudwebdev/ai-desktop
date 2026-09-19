// PR45: renderer — Account & Sync surface
//
// Self-contained Account surface over App-owned account/sync state. Owns no
// domain behavior: identity, credentials, devices, sync transport, and
// persistence stay behind the sibling-owned `window.api.account` /
// `window.api.sync` bridges (probed optionally via `getAccountCommands` /
// `getSyncCommands`, so this surface renders an honest signed-out state
// both before and after the account IPC lands). Every bridge access is
// optional; all failures surface as text; async work here never throws.
//
// State survival: the renderer holds no source of truth. The session,
// device, sync status, and conflicts re-query the bridges on mount and on a
// single bounded poll interval, so remounts and disconnects recover by
// re-fetching. No tokens, secrets, credentials, or URLs are ever rendered:
// only display names, identifiers, device names, statuses, counts, and
// conflict version labels.
//
// Security: display names ≤120; `key=value`-shaped secret material is
// redacted before render; no Node or Electron APIs, no spawned processes,
// no Prisma, no network auth, no raw runtime internals. Nothing executes
// from a partial form: sign-in fires only after `validateSignInForm`
// reports zero errors. Conflicts are never resolved silently: only explicit
// keep-local / keep-remote buttons resolve them. Sign-out preserves local
// projects on this device (delete ≠ wipe).

import React, { useCallback, useEffect, useState } from "react";
import {
  MAX_CONFLICTS_SHOWN,
  conflictCount,
  createLocalAccountSyncStub,
  fetchAccountSession,
  fetchDevice,
  fetchSyncConflicts,
  fetchSyncStatus,
  formatAccountTimestamp,
  formatRelativeTime,
  getAccountCommands,
  getSyncCommands,
  isSignInFormValid,
  pauseSync,
  pendingSyncCount,
  redactSecretAssignments,
  refreshSession,
  resolveConflict,
  sessionStatusLabel,
  signInAccount,
  signOutAccount,
  startSync,
  syncStatusBadgeClass,
  syncStatusIndicator,
  truncateDisplayName,
  truncateText,
  validateSignInForm,
  type AccountCommands,
  type AccountSessionView,
  type DeviceView,
  type SignInFormInput,
  type SyncCommands,
  type SyncConflictView,
  type SyncStatusView,
} from "../../../workspace/account-sync.js";
import type { AccountSurfaceProps } from "./surface-props.js";

const DEFAULT_POLL_MS = 2000;

const EMPTY_SIGN_IN: SignInFormInput = { displayName: "", email: "" };

function SignInForm({
  busy,
  formError,
  onSubmit,
}: {
  busy: boolean;
  formError: string | null;
  onSubmit: (input: SignInFormInput) => void;
}): React.ReactElement {
  const [form, setForm] = useState<SignInFormInput>(EMPTY_SIGN_IN);
  const errors = validateSignInForm(form);
  const valid = Object.keys(errors).length === 0;

  // Nothing executes from a partial form: the submit button stays disabled
  // until `validateSignInForm` reports zero errors, and `onSubmit` fires
  // only from the valid submit path below.
  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isSignInFormValid(form) || busy) return;
    onSubmit(form);
  };

  return (
    <form
      aria-label="Sign in"
      onSubmit={handleSubmit}
      className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs space-y-2"
    >
      <label className="block">
        <span className="text-slate-400 text-[11px]">Display name (≤120)</span>
        <input
          type="text"
          value={form.displayName}
          onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
          aria-label="Display name"
          disabled={busy}
          className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        {errors.displayName && (
          <span className="text-rose-300 text-[11px]">{errors.displayName}</span>
        )}
      </label>
      <label className="block">
        <span className="text-slate-400 text-[11px]">Email (optional)</span>
        <input
          type="email"
          value={form.email ?? ""}
          onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
          aria-label="Email (optional)"
          disabled={busy}
          className="mt-0.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        {errors.email && <span className="text-rose-300 text-[11px]">{errors.email}</span>}
      </label>
      {formError && (
        <p role="alert" className="text-rose-300 text-[11px]">
          {truncateText(formError, 500)}
        </p>
      )}
      {!valid && (
        <p className="text-[11px] text-slate-500">
          Complete the highlighted fields — nothing executes from a partial form.
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !valid}
        title={valid ? "Sign in with this display name" : "Fix validation errors to sign in"}
        className="rounded px-2 py-1 text-[11px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-[10px] text-slate-500">
        Sign-in carries a display name only — credentials stay in the OS keychain and are never
        shown here.
      </p>
    </form>
  );
}

function ConflictRow({
  conflict,
  busy,
  onResolve,
}: {
  conflict: SyncConflictView;
  busy: boolean;
  onResolve: (conflictId: string, choice: "keep-local" | "keep-remote") => void;
}): React.ReactElement {
  return (
    <li className="rounded bg-slate-800/60 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-slate-300">{conflict.entity}</span>
        <span className="font-mono text-slate-500">{conflict.entityId.slice(0, 12)}…</span>
        <span className="text-slate-400">
          local {truncateText(redactSecretAssignments(conflict.localVersion ?? "—"), 80)}
        </span>
        <span className="text-slate-500">vs</span>
        <span className="text-slate-400">
          remote {truncateText(redactSecretAssignments(conflict.remoteVersion ?? "—"), 80)}
        </span>
      </div>
      {conflict.changedFields.length > 0 && (
        <p className="text-slate-500 mt-0.5">
          Changed: {conflict.changedFields.slice(0, 8).join(", ")}
        </p>
      )}
      {/* Explicit choices only: conflicts are never resolved automatically. */}
      <div className="flex gap-2 mt-1.5">
        <button
          type="button"
          onClick={() => onResolve(conflict.conflictId, "keep-local")}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
        >
          Keep local
        </button>
        <button
          type="button"
          onClick={() => onResolve(conflict.conflictId, "keep-remote")}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
        >
          Keep remote
        </button>
      </div>
    </li>
  );
}

export function AccountSurface({
  account: injectedAccount,
  sync: injectedSync,
  pollIntervalMs = DEFAULT_POLL_MS,
}: AccountSurfaceProps): React.ReactElement {
  // Bridge probes with local-stub fallback: the stub keeps the surface
  // operable (honest signed-out state) before the sibling IPC lands, and
  // tests pass without Electron. Real state always re-queries on mount.
  const [stub] = useState(() => createLocalAccountSyncStub());
  const account: AccountCommands = injectedAccount ?? getAccountCommands() ?? stub.account;
  const sync: SyncCommands = injectedSync ?? getSyncCommands() ?? stub.sync;
  const bridgeAbsent =
    (injectedAccount == null && getAccountCommands() === null) ||
    (injectedSync == null && getSyncCommands() === null);

  const [session, setSession] = useState<AccountSessionView>({ status: "signed_out" });
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusView>({
    status: "idle",
    pendingCount: 0,
    conflictCount: 0,
    paused: false,
  });
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState<boolean>(false);

  const signedIn = session.status === "authenticated" || session.status === "refreshing";

  const refreshAll = useCallback(async () => {
    try {
      // No renderer-local truth: every refresh re-queries the bridges, so
      // remounts and disconnects recover by re-fetching.
      const nextSession = await fetchAccountSession(account);
      setSession(nextSession);
      const isSignedIn =
        nextSession.status === "authenticated" || nextSession.status === "refreshing";
      setDevice(isSignedIn ? await fetchDevice(account) : null);
      setSyncStatus(await fetchSyncStatus(sync));
      setConflicts(isSignedIn ? await fetchSyncConflicts(sync) : []);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [account, sync]);

  // Re-query on mount + a single bounded poll. No renderer-local source of
  // truth: remounts and disconnects recover by re-fetching.
  useEffect(() => {
    setLoading(true);
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void refreshAll();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [refreshAll, pollIntervalMs]);

  const handleSignIn = useCallback(
    async (input: SignInFormInput) => {
      // Nothing executes from a partial form: reject invalid input before
      // any bridge call.
      if (!isSignInFormValid(input)) {
        setFormError("Fix validation errors before signing in.");
        return;
      }
      setFormBusy(true);
      setFormError(null);
      const result = await signInAccount(account, input);
      if (!result.ok) setFormError(result.error);
      await refreshAll();
      setFormBusy(false);
    },
    [account, refreshAll],
  );

  const handleSignOut = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    const result = await signOutAccount(account);
    if (!result.ok) setActionError(result.error);
    await refreshAll();
    setActionBusy(false);
  }, [account, refreshAll]);

  const handleRefresh = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    const result = await refreshSession(account);
    if (!result.ok) setActionError(result.error);
    await refreshAll();
    setActionBusy(false);
  }, [account, refreshAll]);

  const handleStartSync = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    const result = await startSync(sync);
    if (!result.ok) setActionError(result.error);
    await refreshAll();
    setActionBusy(false);
  }, [sync, refreshAll]);

  const handlePauseSync = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    const result = await pauseSync(sync);
    if (!result.ok) setActionError(result.error);
    await refreshAll();
    setActionBusy(false);
  }, [sync, refreshAll]);

  const handleResolve = useCallback(
    async (conflictId: string, choice: "keep-local" | "keep-remote") => {
      setActionBusy(true);
      setActionError(null);
      const result = await resolveConflict(sync, conflictId, choice);
      if (!result.ok) setActionError(result.error);
      await refreshAll();
      setActionBusy(false);
    },
    [sync, refreshAll],
  );

  const visibleConflicts = conflicts.slice(0, MAX_CONFLICTS_SHOWN);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 pt-4">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Account</p>
        <button
          type="button"
          onClick={() => void refreshAll()}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
        >
          Refresh
        </button>
      </div>
      {bridgeAbsent && (
        <p className="text-[11px] text-slate-500 px-6 pt-2">
          Account IPC is not available yet — showing local state. The surface re-queries
          automatically once the account bridge lands.
        </p>
      )}
      {loading ? (
        <p className="text-xs text-slate-500 px-6 py-4">Loading account…</p>
      ) : (
        <div className="px-6 pb-2">
          {refreshError && (
            <p role="alert" className="text-rose-300 text-xs mt-2">
              {truncateText(refreshError, 500)}
            </p>
          )}
          <section aria-label="Session status" className="mt-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                signedIn ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-400"
              }`}
            >
              {sessionStatusLabel(session.status)}
            </span>
          </section>

          {!signedIn ? (
            <section aria-label="Signed out" className="mt-2">
              <p className="text-xs text-slate-400">
                You are signed out. Sign in to sync across devices.
              </p>
              <SignInForm
                busy={formBusy}
                formError={formError}
                onSubmit={(input) => void handleSignIn(input)}
              />
              {session.status === "expired" && (
                <p className="text-[11px] text-amber-300 mt-2">
                  Your session expired — sign in again. Local projects were preserved.
                </p>
              )}
              {session.status === "error" && session.lastError && (
                <p role="alert" className="text-rose-300 text-[11px] mt-2">
                  {truncateText(redactSecretAssignments(session.lastError), 500)}
                </p>
              )}
            </section>
          ) : (
            <>
              <section
                aria-label="Signed-in account"
                className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs"
              >
                <p className="font-medium text-slate-100">
                  {truncateDisplayName(redactSecretAssignments(session.displayName ?? "Account"))}
                </p>
                {session.identifier && (
                  <p className="font-mono text-slate-400 text-[11px] mt-0.5">
                    {truncateText(redactSecretAssignments(session.identifier), 320)}
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mt-2">
                  <dt className="text-slate-500">Device</dt>
                  <dd className="text-slate-300">
                    {device
                      ? `${truncateText(redactSecretAssignments(device.deviceName), 120)}${device.platform ? ` · ${device.platform}` : ""}`
                      : "—"}
                  </dd>
                  <dt className="text-slate-500">Device last seen</dt>
                  <dd className="text-slate-300">{formatRelativeTime(device?.lastSeenAt)}</dd>
                  <dt className="text-slate-500">Sync status</dt>
                  <dd>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${syncStatusBadgeClass(syncStatus.status)}`}
                    >
                      {syncStatusIndicator(syncStatus.status)}
                    </span>
                  </dd>
                  <dt className="text-slate-500">Last sync</dt>
                  <dd className="text-slate-300">
                    {formatAccountTimestamp(syncStatus.lastSyncAt)} (
                    {formatRelativeTime(syncStatus.lastSyncAt)})
                  </dd>
                  <dt className="text-slate-500">Pending</dt>
                  <dd className="text-slate-300">{pendingSyncCount(syncStatus)} pending</dd>
                  <dt className="text-slate-500">Conflicts</dt>
                  <dd className="text-slate-300">{conflictCount(syncStatus)} conflicts</dd>
                </dl>
                {syncStatus.lastError && (
                  <p role="alert" className="text-rose-300 text-[11px] mt-2">
                    {truncateText(redactSecretAssignments(syncStatus.lastError), 500)}
                  </p>
                )}
                {actionError && (
                  <p role="alert" className="text-rose-300 text-[11px] mt-2">
                    {truncateText(actionError, 500)}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    disabled={actionBusy}
                    className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
                  >
                    {actionBusy ? "Working…" : "Refresh session"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSignOut()}
                    disabled={actionBusy}
                    title="Sign-out keeps local projects on this device"
                    className="rounded px-2 py-1 text-[11px] font-medium bg-rose-900/60 hover:bg-rose-800 text-rose-200 disabled:opacity-50"
                  >
                    {actionBusy ? "Working…" : "Sign out"}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 mt-2">
                  Signing out preserves local projects on this device (delete ≠ wipe) — only the
                  session is cleared.
                </p>
                <p className="text-[10px] text-slate-500 mt-1">
                  Sync settings live in Settings — this surface only starts, pauses, and resolves
                  conflicts explicitly.
                </p>
              </section>

              <section
                aria-label="Sync detail"
                className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-slate-100">Sync</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleStartSync()}
                      disabled={actionBusy}
                      className="rounded px-2 py-1 text-[11px] font-medium bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
                    >
                      {actionBusy ? "Working…" : "Start sync"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePauseSync()}
                      disabled={actionBusy}
                      className="rounded px-2 py-1 text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50"
                    >
                      {actionBusy ? "Working…" : "Pause"}
                    </button>
                  </div>
                </div>
                {syncStatus.paused && (
                  <p className="text-[11px] text-slate-400 mb-2">Sync is paused on this device.</p>
                )}
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                  Conflicts ({conflicts.length})
                </p>
                {conflicts.length === 0 ? (
                  <p className="text-slate-500 text-[11px]">No conflicts to resolve.</p>
                ) : (
                  <>
                    <ul aria-label="Sync conflicts" className="space-y-1">
                      {visibleConflicts.map((conflict) => (
                        <ConflictRow
                          key={conflict.conflictId}
                          conflict={conflict}
                          busy={actionBusy}
                          onResolve={(id, choice) => void handleResolve(id, choice)}
                        />
                      ))}
                    </ul>
                    {conflicts.length > visibleConflicts.length && (
                      <p className="text-[10px] text-slate-500 mt-1">
                        Showing {visibleConflicts.length} of {conflicts.length} — list bounded at
                        render.
                      </p>
                    )}
                  </>
                )}
                <p className="text-[10px] text-slate-500 mt-2">
                  Conflicts are never resolved automatically — choose Keep local or Keep remote for
                  each one.
                </p>
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
