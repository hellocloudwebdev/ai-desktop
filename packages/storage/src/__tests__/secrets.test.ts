// PR9: packages/storage — SecretStore Contract Tests
//
// Tests the SecretStore CONTRACT (Step 32.31), not a specific platform
// implementation, using an in-memory test double. Test secrets are obviously
// fake values; no real provider keys are ever used (Step 32.23). Test
// references use the reserved `ai-desktop/test/` namespace (Step 32.33).

import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-desktop/shared";
import { generateUlid } from "@ai-desktop/shared";
import { asSecretRef, parseSecretRef, type SecretRef } from "../secrets/secret-ref.js";
import {
  SecretBackendError,
  validateSecretInputs,
  type SecretStore,
} from "../secrets/secret-store.js";
import { OSKeychainSecretStore } from "../secrets/os-secret-store.js";

function testRef(label: string): SecretRef {
  return asSecretRef(`ai-desktop/test/${generateUlid().toLowerCase()}-${label}`);
}

/**
 * In-memory SecretStore test double implementing the exact contract semantics:
 * replace-on-set, null-on-missing get, idempotent delete.
 */
class InMemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, string>();

  async set(ref: SecretRef, secret: string): Promise<void> {
    validateSecretInputs(ref, secret, true);
    this.entries.set(ref, secret);
  }

  async get(ref: SecretRef): Promise<string | null> {
    validateSecretInputs(ref);
    return this.entries.get(ref) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    validateSecretInputs(ref);
    this.entries.delete(ref);
  }

  async has(ref: SecretRef): Promise<boolean> {
    validateSecretInputs(ref);
    return this.entries.has(ref);
  }
}

/**
 * Double whose backend always fails, proving backend failures are surfaced
 * distinctly from missing credentials.
 */
class FailingSecretStore implements SecretStore {
  async set(ref: SecretRef, secret: string): Promise<void> {
    void ref;
    void secret;
    throw new SecretBackendError("Credential backend unavailable");
  }
  async get(ref: SecretRef): Promise<string | null> {
    void ref;
    throw new SecretBackendError("Credential backend unavailable");
  }
  async delete(ref: SecretRef): Promise<void> {
    void ref;
    throw new SecretBackendError("Credential backend unavailable");
  }
  async has(ref: SecretRef): Promise<boolean> {
    void ref;
    throw new SecretBackendError("Credential backend unavailable");
  }
}

async function runContractSuite(name: string, makeStore: () => SecretStore): Promise<void> {
  describe(name, () => {
    it("stores and retrieves a secret with exact round-trip fidelity", async () => {
      const store = makeStore();
      const ref = testRef("roundtrip");
      const secret = "test-secret-value-do-not-use-in-production";

      await store.set(ref, secret);
      await expect(store.get(ref)).resolves.toBe(secret);
    });

    it("round-trips realistic credential shapes exactly (JWT-like, unicode)", async () => {
      const store = makeStore();
      const ref = testRef("shapes");
      const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.test-signature-not-a-real-token";
      const unicode = "test-sécret-vàlüé-🔐";

      await store.set(ref, jwtLike);
      await expect(store.get(ref)).resolves.toBe(jwtLike);

      await store.set(ref, unicode);
      await expect(store.get(ref)).resolves.toBe(unicode);
    });

    it("has() reports existence without exposing the value", async () => {
      const store = makeStore();
      const ref = testRef("has");

      await expect(store.has(ref)).resolves.toBe(false);
      await store.set(ref, "test-secret-value");
      await expect(store.has(ref)).resolves.toBe(true);
    });

    it("returns null for a missing credential (get) and false (has)", async () => {
      const store = makeStore();
      const missing = testRef("missing");

      await expect(store.get(missing)).resolves.toBeNull();
      await expect(store.has(missing)).resolves.toBe(false);
    });

    it("replaces an existing value for the same reference without duplication", async () => {
      const store = makeStore();
      const ref = testRef("replace");

      await store.set(ref, "first-test-value");
      await store.set(ref, "second-test-value");

      await expect(store.get(ref)).resolves.toBe("second-test-value");
    });

    it("deletes a credential and subsequent get() returns null", async () => {
      const store = makeStore();
      const ref = testRef("delete");

      await store.set(ref, "test-secret-value");
      await store.delete(ref);

      await expect(store.has(ref)).resolves.toBe(false);
      await expect(store.get(ref)).resolves.toBeNull();
    });

    it("delete is idempotent: deleting a missing reference is a safe no-op", async () => {
      const store = makeStore();
      const ref = testRef("idempotent-delete");

      await store.set(ref, "test-secret-value");
      await store.delete(ref);
      await expect(store.delete(ref)).resolves.toBeUndefined();
      await expect(store.has(ref)).resolves.toBe(false);
    });

    it("rejects malformed references with ValidationError at the boundary", async () => {
      const store = makeStore();

      const malformed = [
        "", // empty
        "onlyonesegment", // fewer than 2 segments
        "/leading/slash", // leading slash
        "trailing/slash/", // trailing slash
        "double//slash", // empty segment
        "has uppercase/segment", // whitespace + uppercase
        "app/provider/anthropic/api-key=sk-fake", // '=' smuggles secret material
        "app/provider/anthropic/api key", // whitespace in segment
        `${"a".repeat(65)}/segment`, // segment too long
      ];

      for (const raw of malformed) {
        expect(() => parseSecretRef(raw)).toThrow(ValidationError);
      }

      // Even a branded-but-malformed ref must be rejected at the store boundary
      const smuggled = asSecretRef("bad ref=with-secret");
      await expect(store.set(smuggled, "test-secret-value")).rejects.toThrow(ValidationError);
      await expect(store.get(smuggled)).rejects.toThrow(ValidationError);
      await expect(store.has(smuggled)).rejects.toThrow(ValidationError);
      await expect(store.delete(smuggled)).rejects.toThrow(ValidationError);
    });

    it("rejects empty and non-string secret values", async () => {
      const store = makeStore();
      const ref = testRef("empty-secret");

      await expect(store.set(ref, "")).rejects.toThrow();
      await expect(store.set(ref, undefined as unknown as string)).rejects.toThrow();
      await expect(store.has(ref)).resolves.toBe(false);
    });
  });
}

describe("SecretStore contract", () => {
  runContractSuite("InMemorySecretStore (contract double)", () => new InMemorySecretStore());

  it("surfaces backend failures distinctly from missing credentials", async () => {
    const store = new FailingSecretStore();
    const ref = testRef("backend-failure");

    await expect(store.get(ref)).rejects.toThrow(SecretBackendError);
    await expect(store.get(ref)).rejects.not.toBeNull();
    await expect(store.has(ref)).rejects.toThrow(SecretBackendError);
    await expect(store.set(ref, "test-secret-value")).rejects.toThrow(SecretBackendError);
  });

  it("never embeds secret values in backend error messages", async () => {
    const secret = "super-secret-test-value-never-log-me";
    const failing = Object.assign(new FailingSecretStore(), {
      async get(): Promise<string | null> {
        throw new SecretBackendError("Keychain locked", {
          cause: new Error("backend detail without secret"),
        });
      },
    });

    let captured: unknown;
    try {
      await failing.get(asSecretRef("ai-desktop/test/error-message"));
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(SecretBackendError);
    expect(String(captured)).not.toContain(secret);
  });

  it("parseSecretRef accepts canonical production namespace shapes", () => {
    expect(parseSecretRef("app/provider/anthropic/api-key")).toBe("app/provider/anthropic/api-key");
    expect(parseSecretRef("app/oauth/anthropic/refresh-token")).toBe(
      "app/oauth/anthropic/refresh-token",
    );
    expect(parseSecretRef("ai-desktop/test/local-only")).toBe("ai-desktop/test/local-only");
  });

  describe("OSKeychainSecretStore (live platform integration)", () => {
    // Unique test-service namespace prevents collision with any real user credentials
    const testServiceName = `ai-desktop-test-${generateUlid().toLowerCase()}`;
    const store = new OSKeychainSecretStore({ serviceName: testServiceName });
    const createdRefs: SecretRef[] = [];

    function makeLiveRef(label: string): SecretRef {
      const ref = asSecretRef(`ai-desktop/test/${generateUlid().toLowerCase()}-${label}`);
      createdRefs.push(ref);
      return ref;
    }

    // Best-effort cleanup of any credentials written to the OS keychain during tests
    async function cleanup(): Promise<void> {
      for (const ref of createdRefs) {
        try {
          await store.delete(ref);
        } catch {
          // ignore cleanup errors
        }
      }
    }

    it("stores, checks, retrieves, and idempotently deletes in OS keychain", async () => {
      const ref = makeLiveRef("live-crud");
      const secret = "test-live-os-secret-value-do-not-use";

      try {
        expect(await store.has(ref)).toBe(false);
        expect(await store.get(ref)).toBeNull();

        await store.set(ref, secret);
        expect(await store.has(ref)).toBe(true);
        expect(await store.get(ref)).toBe(secret);

        // Replace
        await store.set(ref, "replacement-secret-value");
        expect(await store.get(ref)).toBe("replacement-secret-value");

        // Delete
        await store.delete(ref);
        expect(await store.has(ref)).toBe(false);
        expect(await store.get(ref)).toBeNull();

        // Idempotent second delete
        await expect(store.delete(ref)).resolves.toBeUndefined();
      } finally {
        await cleanup();
      }
    });

    it("round-trips realistic multi-byte and token strings in OS keychain", async () => {
      const ref = makeLiveRef("unicode");
      const complex = "sk-ant-api03-sample-token-with-unicode-🔐-éàü";

      try {
        await store.set(ref, complex);
        expect(await store.get(ref)).toBe(complex);
      } finally {
        await cleanup();
      }
    });
  });
});
