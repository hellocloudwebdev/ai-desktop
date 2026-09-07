// PR9: packages/storage — SecretRef Contract
//
// A SecretRef is a non-secret, stable, namespaced identifier for a credential
// stored in the OS credential store. It is safe to persist (e.g. as a SQLite
// credential reference), log under normal policy, and serialize.
//
// Hard boundary (Step 32.7/32.8):
//   SecretRef  -> identifies a credential; never contains secret material
//   SecretValue -> the credential itself; only ever handled inside
//                  secret-handling code and the OS keychain
//
// Canonical namespace shapes:
//   app/provider/<provider-id>/api-key     (production credentials)
//   ai-desktop/test/<unique-test-id>       (test credentials only)

import { z } from "zod";
import type { Brand } from "@ai-desktop/shared";
import { ValidationError } from "@ai-desktop/shared";

export type SecretRef = Brand<string, "SecretRef">;

// Segment rules: lowercase alphanumeric start, then lowercase alphanumeric
// plus dot/underscore/dash. Rejects whitespace, "=", uppercase, and empty
// segments so a secret value can never hide inside a reference.
const SECRET_REF_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const MAX_REF_LENGTH = 256;
const MAX_SEGMENT_LENGTH = 64;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 8;

function isWellFormedSecretRef(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REF_LENGTH) {
    return false;
  }
  if (raw.startsWith("/") || raw.endsWith("/") || raw.includes("//")) {
    return false;
  }
  const segments = raw.split("/");
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) {
    return false;
  }
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment.length <= MAX_SEGMENT_LENGTH &&
      SECRET_REF_SEGMENT_PATTERN.test(segment),
  );
}

export const SecretRefSchema = z
  .string()
  .refine(isWellFormedSecretRef, {
    message:
      "SecretRef must be 2-8 lowercase '/'-separated segments (e.g. 'app/provider/anthropic/api-key'); " +
      "it must not contain whitespace, '=', uppercase letters, or secret material",
  })
  .transform((value: string) => value as SecretRef);

/**
 * Parses and validates a raw string into a SecretRef.
 * Throws ValidationError for malformed references so that arbitrary
 * user-supplied strings never become unconstrained OS credential identifiers.
 */
export function parseSecretRef(raw: string): SecretRef {
  const result = SecretRefSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue: z.ZodIssue) => issue.message).join("; ");
    throw new ValidationError(`Invalid SecretRef "${String(raw)}": ${detail}`);
  }
  return result.data;
}

/**
 * Type guard for values already known to be SecretRefs.
 */
export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "string" && isWellFormedSecretRef(value);
}

/**
 * Trusted cast for references originating from verified persistence layers.
 * Does not re-validate; use parseSecretRef at untrusted boundaries.
 */
export function asSecretRef(raw: string): SecretRef {
  return raw as SecretRef;
}
