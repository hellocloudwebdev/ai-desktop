// apps/desktop — Production release smoke checks.
//
// Runs a fixed sequence of health probes (launch, storage, permissions,
// persistence) at startup. Never throws: every probe failure — including
// unexpected exceptions — is captured as { ok: false, detail }. Details are
// passed through the shared secret scrubber before they are returned.

import { redactSecrets } from "@ai-desktop/shared";

export interface SmokeStorageProbe {
  ping(): Promise<boolean>;
}

export interface SmokePermissionProbe {
  check(...args: readonly unknown[]): Promise<unknown>;
}

export interface SmokeCheckDependencies {
  readonly storage?: SmokeStorageProbe;
  readonly permissionManager?: SmokePermissionProbe;
}

export interface SmokeCheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export type SmokeCheckName = "launch" | "storage" | "permissions" | "persistence";

function scrub(detail: string): string {
  return redactSecrets(detail).slice(0, 500);
}

function toDetailText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value.length > 0 ? value : fallback;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  try {
    const text = JSON.stringify(value) ?? fallback;
    return text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}

async function runProbe(
  name: SmokeCheckName,
  probe: () => Promise<string | undefined>,
): Promise<SmokeCheckResult> {
  try {
    const detail = await probe();
    if (detail === undefined) {
      return { name, ok: true };
    }
    return { name, ok: true, detail: scrub(detail) };
  } catch (error) {
    const message = error instanceof Error ? error.message : toDetailText(error, "probe failed");
    return { name, ok: false, detail: scrub(message.length > 0 ? message : "probe failed") };
  }
}

/**
 * Runs the four release smoke checks sequentially and returns one result
 * per check. Resolves in all cases; rejects never.
 */
export async function runProductionSmokeChecks(
  deps: SmokeCheckDependencies = {},
): Promise<SmokeCheckResult[]> {
  const results: SmokeCheckResult[] = [];
  results.push(await runProbe("launch", () => Promise.resolve(undefined)));
  results.push(
    await runProbe("storage", async () => {
      if (!deps.storage) {
        throw new Error("Storage probe unavailable.");
      }
      const alive = await deps.storage.ping();
      if (!alive) {
        throw new Error("Storage ping returned false.");
      }
      return undefined;
    }),
  );
  results.push(
    await runProbe("permissions", async () => {
      if (!deps.permissionManager) {
        throw new Error("Permission manager probe unavailable.");
      }
      await deps.permissionManager.check({});
      return undefined;
    }),
  );
  results.push(
    await runProbe("persistence", async () => {
      if (!deps.storage) {
        throw new Error("Persistence probe unavailable without storage.");
      }
      const alive = await deps.storage.ping();
      if (!alive) {
        throw new Error("Persistence ping returned false.");
      }
      return undefined;
    }),
  );
  return results;
}
