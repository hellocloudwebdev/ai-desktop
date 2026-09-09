// PR22.5: packages/storage — ProviderProfileRepository Interface
//
// Architectural invariants:
//   - Full CRUD for provider profiles (unlike append-only EventRepository).
//   - Raw credentials are never persisted; only credentialRef is stored.
//   - Canonical IDs (ProviderId, ModelId) are stored as-is, never translated to native vendor IDs.

import type { ProviderId } from "@ai-desktop/ai-core";

export interface StoredProviderProfile {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly credentialRef: string | null;
  readonly endpointUrl: string | null;
  readonly organizationId: string | null;
  readonly defaultModelId: string | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateProfileData {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly credentialRef?: string | null;
  readonly endpointUrl?: string | null;
  readonly organizationId?: string | null;
  readonly defaultModelId?: string | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdateProfileData {
  readonly name?: string;
  readonly credentialRef?: string | null;
  readonly endpointUrl?: string | null;
  readonly organizationId?: string | null;
  readonly defaultModelId?: string | null;
  readonly enabled?: boolean;
  readonly updatedAt: number;
}

export interface ProviderProfileRepository {
  create(data: CreateProfileData): Promise<StoredProviderProfile>;
  getById(id: string): Promise<StoredProviderProfile | null>;
  getByProviderId(providerId: ProviderId): Promise<StoredProviderProfile[]>;
  listAll(): Promise<StoredProviderProfile[]>;
  listEnabled(): Promise<StoredProviderProfile[]>;
  update(id: string, data: UpdateProfileData): Promise<StoredProviderProfile>;
  delete(id: string): Promise<void>;
}
