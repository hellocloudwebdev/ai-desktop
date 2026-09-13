// PR32: packages/plugins — Extension Registry (metadata only)
//
// Invariants:
//   1. Metadata only: this registry owns install/lifecycle/trust records.
//      It contains NO tool logic (tool registration lives in PluginToolRegistry).
//   2. Duplicate registration is rejected.
//   3. Disabled or unregistered extensions contribute nothing (enforced by
//      ExtensionManager; this registry never exposes tools).

import { ValidationError } from "@ai-desktop/shared";
import { assertTransition, type ExtensionLifecycle } from "./lifecycle.js";
import type { TrustState } from "./extension-trust.js";

export interface ExtensionRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly manifestHash: string;
  readonly lifecycle: ExtensionLifecycle;
  readonly trust: TrustState;
  readonly installPath?: string;
  readonly installedAt: number;
  readonly updatedAt: number;
}

export class ExtensionRegistry {
  private readonly _records = new Map<string, ExtensionRecord>();

  register(record: ExtensionRecord): void {
    if (this._records.has(record.id)) {
      throw new ValidationError(`Extension "${record.id}" is already registered`);
    }
    this._records.set(record.id, record);
  }

  unregister(id: string): boolean {
    return this._records.delete(id);
  }

  get(id: string): ExtensionRecord | undefined {
    return this._records.get(id);
  }

  list(): readonly ExtensionRecord[] {
    return [...this._records.values()];
  }

  has(id: string): boolean {
    return this._records.has(id);
  }

  setLifecycle(id: string, state: ExtensionLifecycle): ExtensionRecord {
    const existing = this._records.get(id);
    if (!existing) {
      throw new ValidationError(`Cannot set lifecycle: extension "${id}" is not registered`);
    }
    assertTransition(existing.lifecycle, state);
    const updated: ExtensionRecord = {
      ...existing,
      lifecycle: state,
      updatedAt: Date.now(),
    };
    this._records.set(id, updated);
    return updated;
  }

  setTrust(id: string, trust: TrustState): ExtensionRecord {
    const existing = this._records.get(id);
    if (!existing) {
      throw new ValidationError(`Cannot set trust: extension "${id}" is not registered`);
    }
    const updated: ExtensionRecord = { ...existing, trust, updatedAt: Date.now() };
    this._records.set(id, updated);
    return updated;
  }

  updateHash(id: string, manifestHash: string): ExtensionRecord {
    const existing = this._records.get(id);
    if (!existing) {
      throw new ValidationError(`Cannot update hash: extension "${id}" is not registered`);
    }
    const updated: ExtensionRecord = { ...existing, manifestHash, updatedAt: Date.now() };
    this._records.set(id, updated);
    return updated;
  }

  clear(): void {
    this._records.clear();
  }
}
