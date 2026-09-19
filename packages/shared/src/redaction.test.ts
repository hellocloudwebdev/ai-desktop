// PR46: packages/shared — Centralized Secret Redaction (adversarial)
//
// Every test FAILS without the mitigation (raw secret would survive).
// Prose-passthrough guards lock that bare words are not over-redacted.

import { describe, expect, it } from "vitest";
import { containsSecretMaterial, redactSecrets, REDACTED } from "./redaction.js";

describe("redaction: api keys and bearer", () => {
  it("redacts apiKey assignments with : and =", () => {
    expect(redactSecrets("call failed: apiKey: abc123SECRETxyz")).not.toContain("abc123SECRETxyz");
    expect(redactSecrets("call failed: apiKey: abc123SECRETxyz")).toContain(REDACTED);
    expect(redactSecrets("api_key=sk-test-12345678")).not.toContain("sk-test-12345678");
  });

  it("redacts bearer tokens but keeps short prose untouched", () => {
    const out = redactSecrets("auth failed: Bearer mytoken1234567890");
    expect(out).not.toContain("mytoken1234567890");
    expect(out).toContain(REDACTED);
    expect(redactSecrets("the bearer of bad news arrived")).toBe("the bearer of bad news arrived");
  });

  it("redacts standalone provider token shapes", () => {
    expect(redactSecrets("key sk-live-abcdefgh12345678 leaked")).not.toContain(
      "sk-live-abcdefgh12345678",
    );
    expect(redactSecrets("token ghp_abcdefgh1234567890 in log")).not.toContain(
      "ghp_abcdefgh1234567890",
    );
    expect(redactSecrets("id AKIAIOSFODNN7EXAMPLE here")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("redaction: oauth, passwords, cookies, auth headers", () => {
  it("redacts oauth and token assignments", () => {
    expect(redactSecrets("oauth token=secrettoken123456")).not.toContain("secrettoken123456");
    expect(redactSecrets("access_token: abcdef1234567890")).not.toContain("abcdef1234567890");
    expect(redactSecrets("refresh_token=refresh1234567890")).not.toContain("refresh1234567890");
    expect(redactSecrets("client_secret: topsecret123456")).not.toContain("topsecret123456");
  });

  it("redacts password assignments", () => {
    expect(redactSecrets("db password=hunter2-secret99")).not.toContain("hunter2-secret99");
    expect(redactSecrets("login failed: password: CorrectHorse99")).not.toContain("CorrectHorse99");
  });

  it("redacts cookie and authorization headers", () => {
    expect(redactSecrets("cookie: session=xyz-secret-123")).not.toContain("xyz-secret-123");
    expect(redactSecrets("authorization: Basic abcDEF123456")).not.toContain("abcDEF123456");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi.jkl12345")).not.toContain(
      "abc.def.ghi",
    );
  });

  it("redacts private-key blocks wholesale", () => {
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7b test key material\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`failed to load ${key} from disk`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA7b");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).toContain(REDACTED);
  });
});

describe("redaction: prose passthrough (no over-redaction)", () => {
  it("leaves bare prose untouched", () => {
    expect(redactSecrets("token limit reached for this model")).toBe(
      "token limit reached for this model",
    );
    expect(redactSecrets("password policy requires 12 chars")).toBe(
      "password policy requires 12 chars",
    );
    expect(redactSecrets("api key rotation guide")).toBe("api key rotation guide");
    expect(redactSecrets("oauth refresh flow explained")).toBe("oauth refresh flow explained");
    expect(redactSecrets("cookie recipe with chocolate chips")).toBe(
      "cookie recipe with chocolate chips",
    );
  });

  it("is idempotent and handles empty input", () => {
    const once = redactSecrets("apiKey: abc123SECRETxyz and password=hunter2-secret99");
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets("")).toBe("");
  });

  it("containsSecretMaterial mirrors redaction detection", () => {
    expect(containsSecretMaterial("apiKey: abc123")).toBe(true);
    expect(containsSecretMaterial("Bearer mytoken1234567890")).toBe(true);
    expect(containsSecretMaterial("token limit reached")).toBe(false);
    expect(containsSecretMaterial("hello world")).toBe(false);
    expect(containsSecretMaterial("")).toBe(false);
  });
});
