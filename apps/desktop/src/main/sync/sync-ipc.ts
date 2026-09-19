// PR45: apps/desktop — Sync IPC Handlers (thin typed delegation)
//
// Exactly 5 typed channels (status/start/pause/conflicts/resolve) over the
// main-process SyncService. Zod schemas in @ai-desktop/shared validate in
// main before any handler executes; errors serialize as safe {code,message}
// envelopes via IpcRegistry (service errors already carry a "CODE: message"
// prefix, never stacks or secrets).
//
// There is intentionally NO sync:execute channel — sync flows through the
// main-process SyncService with bounded validation, never arbitrary IPC
// execution. The renderer receives normalized projections only (explicit
// field picks below; record payload secrets can never leak through).
//
// NOTE: apps/desktop/src/main/sync/sync-service.ts has not landed yet. This
// file defines structural ports (SyncServicePort + AccountServicePort) that
// the real DesktopSyncService will satisfy when it arrives; handlers
// normalize unknown results into renderer-safe projections (never pass
// through tokens/secrets: only status/displayName/identifier/deviceName/
// platform/counts/version fields are picked, everything else is dropped).

import {
  IPC_CHANNELS,
  SyncConflictsCommandSchema,
  SyncPauseCommandSchema,
  SyncResolveCommandSchema,
  SyncStartCommandSchema,
  SyncStatusCommandSchema,
} from "@ai-desktop/shared";
import type { IpcRegistry } from "../ipc/index.js";
import type { SyncConflictView, SyncStatusView } from "./sync-service.js";

/**
 * Structural port satisfied by DesktopSyncService. Declared structurally so
 * tests can inject stubs; production wires the real service.
 */
export interface SyncServicePort {
  status(accountId?: string): Promise<SyncStatusView>;
  start(accountId?: string): Promise<SyncStatusView>;
  pause(): Promise<SyncStatusView>;
  conflicts(accountId?: string, limit?: number): Promise<{ conflicts: SyncConflictView[] }>;
  resolve(
    conflictId: string,
    resolution: "keep-local" | "keep-remote",
    projectId?: string,
    accountId?: string,
  ): Promise<{ conflictId: string; appliedEntity: string; appliedVersion: number }>;
}

export interface SyncIpcDependencies {
  readonly syncService: SyncServicePort;
}

const SECRET_KEY_PATTERN = /token|secret|nonce|password|credential|api[_-]?key|ref/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renderer-safe sync status pick: scalars only, never secrets. */
function toStatusProjection(view: SyncStatusView): SyncStatusView {
  const status = (view as SyncStatusView).status ?? "idle";
  const pendingCount =
    typeof (view as SyncStatusView).pendingCount === "number"
      ? (view as SyncStatusView).pendingCount
      : 0;
  const conflictCount =
    typeof (view as SyncStatusView).conflictCount === "number"
      ? (view as SyncStatusView).conflictCount
      : 0;
  const paused = (view as SyncStatusView).paused === true;
  return {
    status,
    ...((view as SyncStatusView).lastSyncAt !== undefined
      ? { lastSyncAt: (view as SyncStatusView).lastSyncAt }
      : {}),
    pendingCount,
    conflictCount,
    ...((view as SyncStatusView).lastError !== undefined
      ? { lastError: (view as SyncStatusView).lastError }
      : {}),
    paused,
  };
}

/** Renderer-safe conflict pick: identifiers + versions + fields only. */
function toConflictProjection(view: SyncConflictView): SyncConflictView {
  const conflictId = String((view as SyncConflictView).conflictId ?? "");
  const entity = String(
    (view as SyncConflictView).entity ??
      (view as unknown as Record<string, unknown>).entityType ??
      "",
  );
  const entityId = String((view as SyncConflictView).entityId ?? "");
  const localVersion =
    typeof (view as SyncConflictView).localVersion === "number"
      ? (view as SyncConflictView).localVersion
      : Number((view as SyncConflictView).localVersion) || 0;
  const remoteVersion =
    typeof (view as SyncConflictView).remoteVersion === "number"
      ? (view as SyncConflictView).remoteVersion
      : Number((view as SyncConflictView).remoteVersion) || 0;
  const changedFields = Array.isArray((view as SyncConflictView).changedFields)
    ? [...((view as SyncConflictView).changedFields as string[])]
    : [];
  return {
    conflictId,
    entity,
    entityId,
    localVersion: localVersion as unknown as number,
    remoteVersion: remoteVersion as unknown as number,
    changedFields,
    ...((view as SyncConflictView).updatedAt !== undefined
      ? { updatedAt: (view as SyncConflictView).updatedAt }
      : {}),
  } as SyncConflictView;
}

function assertNoSecretKeys(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (isPlainRecord(current)) {
      for (const [key, entry] of Object.entries(current)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          throw new Error(`refusing to expose secret-bearing key "${key}" over IPC`);
        }
        stack.push(entry);
      }
    }
  }
}

/**
 * Registers the 5 sync commands on the registry. Fails closed when the
 * service is absent. No Electron WebContents state is consulted.
 */
export function registerSyncHandlers(registry: IpcRegistry, deps: SyncIpcDependencies): void {
  if (!deps.syncService) {
    throw new Error("SyncService is not available");
  }
  const service = deps.syncService;

  registry.registerCommand(IPC_CHANNELS.SYNC_STATUS, SyncStatusCommandSchema, async () => {
    const status = await service.status();
    const projected = toStatusProjection(status);
    assertNoSecretKeys(projected);
    return { sync: projected };
  });

  registry.registerCommand(IPC_CHANNELS.SYNC_START, SyncStartCommandSchema, async () => {
    const status = await service.start();
    const projected = toStatusProjection(status);
    assertNoSecretKeys(projected);
    return { sync: projected };
  });

  registry.registerCommand(IPC_CHANNELS.SYNC_PAUSE, SyncPauseCommandSchema, async () => {
    const status = await service.pause();
    const projected = toStatusProjection(status);
    assertNoSecretKeys(projected);
    return { sync: projected };
  });

  registry.registerCommand(
    IPC_CHANNELS.SYNC_CONFLICTS,
    SyncConflictsCommandSchema,
    async (input) => {
      const outcome = await service.conflicts(undefined, input.limit ?? undefined);
      // Accept both the real { conflicts: [...] } shape and legacy stubs
      // returning a bare array.
      const rawList = Array.isArray(outcome)
        ? (outcome as unknown as SyncConflictView[])
        : Array.isArray((outcome as { conflicts?: unknown }).conflicts)
          ? (outcome as { conflicts: SyncConflictView[] }).conflicts
          : [];
      const projected = rawList.map((entry) => toConflictProjection(entry as SyncConflictView));
      assertNoSecretKeys(projected);
      return { conflicts: projected };
    },
  );

  registry.registerCommand(IPC_CHANNELS.SYNC_RESOLVE, SyncResolveCommandSchema, async (input) => {
    // The Zod schema already validated the resolution enum
    // ("keep-local" | "keep-remote"); forward the validated choice plus the
    // optional project scope (conflicts are globally keyed by conflictId).
    const outcome = await service.resolve(
      input.conflictId,
      input.resolution,
      input.projectId ?? undefined,
    );
    const projected = {
      conflictId: (outcome as { conflictId: string }).conflictId,
      appliedEntity: (outcome as { appliedEntity: string }).appliedEntity,
      appliedVersion: (outcome as { appliedVersion: number }).appliedVersion,
    };
    assertNoSecretKeys(projected);
    return {
      sync: projected,
    };
  });
}
