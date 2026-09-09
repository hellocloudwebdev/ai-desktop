// PR10: packages/providers — Provider Configuration Contract
//
// Hard boundary (Step 33.21/33.22):
//   Provider configuration stores only a non-secret credential reference (SecretRef).
//   Raw API keys, access tokens, or refresh tokens must NEVER reside here.

import { z } from "zod";
import type { ProviderId } from "@ai-desktop/ai-core";
import { ProviderIdSchema } from "@ai-desktop/ai-core";

export const ProviderConfigSchema = z
  .object({
    providerId: ProviderIdSchema,
    credentialRef: z.string().trim().min(1, "credentialRef cannot be empty").optional(),
    endpointUrl: z.string().url("endpointUrl must be a valid URL").optional(),
    organizationId: z.string().trim().min(1).optional(),
    defaultModelId: z.string().trim().min(1).optional(),
    timeoutMs: z
      .number()
      .int("timeoutMs must be an integer")
      .positive("timeoutMs must be a positive integer")
      .finite("timeoutMs must be a finite number")
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ProviderConfig = {
  readonly providerId: ProviderId;
  readonly credentialRef?: string;
  readonly endpointUrl?: string;
  readonly organizationId?: string;
  readonly defaultModelId?: string;
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
};
