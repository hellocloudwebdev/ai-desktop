// PR32: packages/storage — ExtensionRepository Interface
//
// Architectural Scope:
//   - Storage abstraction for installed extension metadata and lifecycle/trust state.
//   - Zero Prisma imports outside packages/storage.
//   - Stores metadata and manifest JSON; full packages reside on disk.

export interface StoredExtension {
  readonly id: string; // ExtensionId
  readonly name: string;
  readonly version: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly manifest: string; // JSON-serialized extension manifest
  readonly manifestHash: string;
  readonly lifecycle: string; // e.g. "installed" | "enabled" | "disabled"
  readonly trust: string; // e.g. "untrusted" | "trusted"
  readonly installPath: string | null;
  readonly installedAt: number; // epoch ms
  readonly updatedAt: number; // epoch ms
}

export interface CreateExtensionData {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly manifest: string;
  readonly manifestHash: string;
  readonly lifecycle: string;
  readonly trust: string;
  readonly installPath?: string | null;
  readonly installedAt: number;
  readonly updatedAt: number;
}

export interface ExtensionRepository {
  saveExtension(data: CreateExtensionData): Promise<StoredExtension>;
  getExtension(id: string): Promise<StoredExtension | null>;
  listExtensions(): Promise<StoredExtension[]>;
  setLifecycle(id: string, lifecycle: string): Promise<StoredExtension>;
  setTrust(id: string, trust: string): Promise<StoredExtension>;
  updateHash(id: string, manifestHash: string): Promise<StoredExtension>;
  deleteExtension(id: string): Promise<void>;
}
