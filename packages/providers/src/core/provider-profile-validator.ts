// PR22.4: packages/providers — ProviderProfile Validation
//
// Invariants (Step 42 / PR22.4):
//   1. Validates profile identity, name, provider existence, credential safety,
//      and default model ownership against the ProviderRegistry.
//   2. Delegates provider-specific credential/config checks to the registered
//      adapter via ProviderConfigValidator (PR20) — no duplicated validation.
//   3. Pure offline validation: zero network calls.

import { err, ok, type Result } from "@ai-desktop/shared";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import { validateProviderConfig } from "./provider-config-validator.js";
import type { ProviderProfile } from "./provider-profile.js";
import { ProviderConfigError } from "./provider-errors.js";

/**
 * Validates a ProviderProfile against the registry and its registered adapter.
 * Returns Result.ok with the validated profile, or Result.err with a canonical
 * ProviderConfigError describing the failure.
 */
export function validateProviderProfile(
  profile: ProviderProfile,
  registry: ProviderRegistry,
): Result<ProviderProfile, ProviderConfigError> {
  // 1. Display name must be non-empty
  if (!profile.name || profile.name.trim().length === 0) {
    return err(
      new ProviderConfigError("Profile display name cannot be empty", {
        providerId: profile.providerId,
      }),
    );
  }

  // 2. Provider must exist in the registry
  const registration = registry.getProvider(profile.providerId);
  if (!registration) {
    return err(
      new ProviderConfigError(
        `Provider "${profile.providerId}" is not registered; cannot create profile`,
        { providerId: profile.providerId },
      ),
    );
  }

  // 3. Disabled profiles are structurally valid but must not resolve for execution
  //    (execution-time check is the resolver's responsibility).

  // 4. credentialRef safety: never a raw key (§PR22.5 credential separation)
  if (profile.credentialRef !== undefined) {
    const trimmed = profile.credentialRef.trim();
    if (!trimmed) {
      return err(
        new ProviderConfigError("credentialRef cannot be empty", {
          providerId: profile.providerId,
        }),
      );
    }
    if (
      trimmed.startsWith("sk-") ||
      trimmed.startsWith("AIzaSy") ||
      trimmed.startsWith("Bearer ")
    ) {
      return err(
        new ProviderConfigError(
          "credentialRef appears to contain a raw credential instead of a secret reference",
          { providerId: profile.providerId },
        ),
      );
    }
  }

  // 5. defaultModelId must belong to the profile's provider and support baseline chat
  if (profile.defaultModelId !== undefined) {
    const model = registry.getModel(profile.defaultModelId);
    if (!model) {
      return err(
        new ProviderConfigError(`Default model "${profile.defaultModelId}" is not registered`, {
          providerId: profile.providerId,
        }),
      );
    }
    if (model.providerId !== profile.providerId) {
      return err(
        new ProviderConfigError(
          `Default model "${profile.defaultModelId}" belongs to provider "${model.providerId}" but profile targets provider "${profile.providerId}"`,
          { providerId: profile.providerId },
        ),
      );
    }
    if (
      !model.capabilities.includes("text_generation") ||
      !model.capabilities.includes("streaming")
    ) {
      return err(
        new ProviderConfigError(
          `Default model "${profile.defaultModelId}" does not support baseline chat capabilities (text_generation + streaming)`,
          { providerId: profile.providerId },
        ),
      );
    }
  }

  // 6. Delegate provider-specific config validation to the adapter via PR20 validator
  const configResult = validateProviderConfig(
    {
      providerId: profile.providerId,
      credentialRef: profile.credentialRef,
      endpointUrl: profile.endpointUrl,
      organizationId: profile.organizationId,
      defaultModelId: profile.defaultModelId,
    },
    registration.adapter,
  );
  if (!configResult.ok) {
    return err(configResult.error);
  }

  return ok(profile);
}
