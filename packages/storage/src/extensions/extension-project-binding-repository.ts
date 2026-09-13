// PR32: packages/storage — ExtensionProjectBindingRepository Interface
//
// Architectural Scope:
//   - Storage abstraction for per-project extension enablement bindings.
//   - Zero Prisma imports outside packages/storage.

export interface StoredExtensionProjectBinding {
  readonly extensionId: string; // ExtensionId
  readonly projectId: string; // ProjectId
  readonly enabled: boolean;
  readonly createdAt: number; // epoch ms
  readonly updatedAt: number; // epoch ms
}

export interface ExtensionProjectBindingRepository {
  setBinding(
    extensionId: string,
    projectId: string,
    enabled: boolean,
  ): Promise<StoredExtensionProjectBinding>;
  getBinding(extensionId: string, projectId: string): Promise<StoredExtensionProjectBinding | null>;
  listBindingsForExtension(extensionId: string): Promise<StoredExtensionProjectBinding[]>;
  listBindingsForProject(projectId: string): Promise<StoredExtensionProjectBinding[]>;
  deleteBindingsForExtension(extensionId: string): Promise<void>;
}
