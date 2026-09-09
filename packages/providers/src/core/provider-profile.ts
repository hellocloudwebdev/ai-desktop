// PR22.2: packages/providers — ProviderProfile Canonical Contract
//
// Architectural invariants (Step 42 / PR22):
//   1. Provider, Model, and Profile are strictly separate concepts:
//        Provider = service/backend identity (ProviderId)
//        Model    = specific model + capabilities (ModelDefinition)
//        Profile  = user's configured provider instance + selected defaults
//   2. Profile stores only a non-secret credentialRef, never raw credentials.
//   3. Profile identity uses plain ULID strings (generateUlid) — no new branded ID type
//      is invented, consistent with the repository's existing ID strategy.
//   4. Profiles are validated against the ProviderRegistry, never trusted blindly.

import { z } from "zod";
import type { ModelId, ProviderId } from "@ai-desktop/ai-core";
import { ModelIdSchema, ProviderIdSchema } from "@ai-desktop/ai-core";
import { isUlid } from "@ai-desktop/shared";

export interface ProviderProfile {
  /** Plain ULID string identity (generated via shared generateUlid). */
  readonly id: string;
  /** Owning provider identity (e.g. "anthropic", "gemini"). */
  readonly providerId: ProviderId;
  /** User-facing display name (e.g. "Personal Anthropic"). */
  readonly name: string;
  /** Non-secret credential reference resolved through the OS SecretStore. */
  readonly credentialRef?: string;
  /** Optional custom endpoint URL. */
  readonly endpointUrl?: string;
  /** Optional organization/workspace identifier. */
  readonly organizationId?: string;
  /** Canonical ModelId used as this profile's default model. */
  readonly defaultModelId?: ModelId;
  /** Whether this profile is enabled for execution. */
  readonly enabled: boolean;
  /** Epoch milliseconds of creation. */
  readonly createdAt: number;
  /** Epoch milliseconds of last update. */
  readonly updatedAt: number;
}

export const ProviderProfileSchema = z.object({
  id: z.string().refine((v) => isUlid(v), "Profile id must be a valid ULID"),
  providerId: ProviderIdSchema,
  name: z.string().trim().min(1, "Profile name cannot be empty").max(200),
  credentialRef: z.string().trim().min(1).optional(),
  endpointUrl: z.string().url().optional(),
  organizationId: z.string().trim().min(1).optional(),
  defaultModelId: ModelIdSchema.optional(),
  enabled: z.boolean(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

export const CreateProfileInputSchema = ProviderProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CreateProfileInput = z.infer<typeof CreateProfileInputSchema>;
