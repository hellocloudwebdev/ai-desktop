// PR20: packages/providers — Provider Configuration Validator
//
// Invariants (Step 3, 4, 5):
//   1. Validates structural schema via ProviderConfigSchema.
//   2. Converts raw Zod validation issues into canonical ProviderConfigError (no Zod errors leak).
//   3. Enforces provider ID consistency: config.providerId === adapter.providerId.
//   4. Delegates provider-owned semantic checks to adapter.validateConfig(config).
//   5. Strictly synchronous/offline — zero network calls.

import { err, ok, type Result } from "@ai-desktop/shared";
import type { ProviderAdapter } from "./provider-adapter.js";
import { ProviderConfigSchema, type ProviderConfig } from "./provider-config.js";
import { ProviderConfigError } from "./provider-errors.js";

export interface ProviderConfigValidator {
  validate(config: unknown, adapter: ProviderAdapter): Result<ProviderConfig, ProviderConfigError>;
}

export class DefaultProviderConfigValidator implements ProviderConfigValidator {
  validate(config: unknown, adapter: ProviderAdapter): Result<ProviderConfig, ProviderConfigError> {
    if (!config || typeof config !== "object") {
      return err(
        new ProviderConfigError("Configuration must be a non-null object", {
          providerId: adapter?.providerId,
        }),
      );
    }

    if (!adapter || typeof adapter !== "object" || !adapter.providerId) {
      return err(
        new ProviderConfigError("A valid ProviderAdapter instance is required for validation"),
      );
    }

    // Explicit check for raw secret keys before schema parse (§Step 8)
    const rawKeys = Object.keys(config);
    const forbiddenKeys = ["apiKey", "accessToken", "refreshToken", "password", "secret"];
    const foundForbidden = forbiddenKeys.filter((k) => rawKeys.includes(k));
    if (foundForbidden.length > 0) {
      return err(
        new ProviderConfigError(
          `Raw credentials (${foundForbidden.join(", ")}) are forbidden in ProviderConfig; use credentialRef instead`,
          {
            providerId: (config as { providerId?: string })?.providerId ?? adapter.providerId,
          },
        ),
      );
    }

    // 1. Structural schema validation via Zod
    const parseResult = ProviderConfigSchema.safeParse(config);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      return err(
        new ProviderConfigError(`Invalid provider configuration: ${issues}`, {
          providerId: (config as { providerId?: string })?.providerId ?? adapter.providerId,
        }),
      );
    }

    const validatedConfig = parseResult.data as ProviderConfig;

    // 2. Provider ID consistency (§Step 5)
    if (validatedConfig.providerId !== adapter.providerId) {
      return err(
        new ProviderConfigError(
          `Provider ID mismatch: configuration specifies "${validatedConfig.providerId}" but adapter is for "${adapter.providerId}"`,
          { providerId: adapter.providerId },
        ),
      );
    }

    // 3. Provider-owned semantic validation (§Step 2, Step 6, Step 9)
    const semanticResult = adapter.validateConfig(validatedConfig);
    if (!semanticResult.ok) {
      return err(semanticResult.error);
    }

    return ok(validatedConfig);
  }
}

export const providerConfigValidator: ProviderConfigValidator =
  new DefaultProviderConfigValidator();

export function validateProviderConfig(
  config: unknown,
  adapter: ProviderAdapter,
): Result<ProviderConfig, ProviderConfigError> {
  return providerConfigValidator.validate(config, adapter);
}
