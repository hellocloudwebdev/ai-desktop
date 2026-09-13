// PR32: packages/plugins — Extension Trust Model
//
// Trust != permission:
//   Trust records whether the host operator has approved a specific extension
//   definition (identified by manifest hash). Trust NEVER grants runtime
//   permissions by itself: every tool call still passes through
//   PermissionManager.check() at execution time. A definition change
//   (hash mismatch) invalidates prior trust and requires re-approval.

import { createHash } from "node:crypto";

export type TrustState = "untrusted" | "trusted" | "blocked";

interface TrustHashInput {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly capabilities?: unknown;
  readonly contributes?: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * SHA-256 hex of the canonical JSON of {id, version, capabilities sorted, contributes}.
 */
export function computeExtensionDefinitionHash(manifest: unknown): string {
  const m = (manifest ?? {}) as TrustHashInput;
  const caps = Array.isArray(m.capabilities) ? [...(m.capabilities as unknown[])].sort() : [];
  const canonical = canonicalize({
    id: m.id,
    version: m.version,
    capabilities: caps,
    contributes: m.contributes ?? {},
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * True when the definition hash changed and the host must re-approve.
 */
export function trustRequiresReapproval(oldHash: string, newHash: string): boolean {
  return oldHash !== newHash;
}

/**
 * Downgrades a trusted record to untrusted after a definition change.
 * Blocked stays blocked; untrusted stays untrusted.
 */
export function markTrustInvalidated(current: TrustState): TrustState {
  if (current === "trusted") {
    return "untrusted";
  }
  return current;
}
