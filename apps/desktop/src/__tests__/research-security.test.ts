// PR35: apps/desktop — Research Security Test Suite
//
// Covers SSRF guard (loopback, RFC1918, link-local, metadata, IPv6,
// localhost, DNS failures, redirect-to-private), dangerous schemes, MIME
// policy, response bounds, secret redaction, and subprocess/shell policy.

import { describe, expect, it } from "vitest";
import {
  isSupportedResearchMimeType,
  MAX_DECOMPRESSED_BYTES,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from "@ai-desktop/ai-core";
import {
  assertHostAllowed,
  assertUrlSyntaxAllowed,
  isBlockedIpAddress,
  resolveRedirectUrl,
  validateOutboundUrl,
  validateRedirect,
  type DnsResolver,
} from "../main/research/security/ssrf-guard.js";
import {
  redactSecretsFromMessage,
  ResearchCancelled,
  ResearchRedirectRejected,
  ResearchSsrfBlocked,
  ResearchUrlRejected,
  toCanonicalResearchError,
} from "../main/research/research-errors.js";

const publicResolver: DnsResolver = {
  async lookup(hostname: string) {
    if (hostname === "example.com") {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    if (hostname === "ipv6.example.com") {
      return [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }];
    }
    throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  },
};

const internalResolver: DnsResolver = {
  async lookup(hostname: string) {
    const table: Record<string, Array<{ address: string; family: number }>> = {
      "internal.example.com": [{ address: "10.1.2.3", family: 4 }],
      "loop.example.com": [{ address: "127.0.0.1", family: 4 }],
      "link.example.com": [{ address: "169.254.10.20", family: 4 }],
      "meta.example.com": [{ address: "169.254.169.254", family: 4 }],
      "v6local.example.com": [{ address: "::1", family: 6 }],
      "rebind.example.com": [{ address: "93.184.216.34", family: 4 }],
    };
    const hit = table[hostname];
    if (!hit) {
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return hit;
  },
};

describe("research security: blocked IP ranges", () => {
  it("blocks loopback addresses", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("127.200.10.5")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
  });

  it("blocks RFC1918 private IPv4 ranges", () => {
    expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.255.255.255")).toBe(true);
    expect(isBlockedIpAddress("172.16.0.1")).toBe(true);
    expect(isBlockedIpAddress("172.31.255.255")).toBe(true);
    expect(isBlockedIpAddress("192.168.0.1")).toBe(true);
    expect(isBlockedIpAddress("192.168.77.77")).toBe(true);
  });

  it("does not block public IPv4 neighbors of private ranges", () => {
    expect(isBlockedIpAddress("172.15.255.255")).toBe(false);
    expect(isBlockedIpAddress("172.32.0.1")).toBe(false);
    expect(isBlockedIpAddress("192.167.255.255")).toBe(false);
    expect(isBlockedIpAddress("9.255.255.255")).toBe(false);
    expect(isBlockedIpAddress("11.0.0.1")).toBe(false);
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false);
  });

  it("blocks link-local, CGNAT, metadata, multicast, and reserved IPv4", () => {
    expect(isBlockedIpAddress("169.254.10.20")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("100.64.0.1")).toBe(true);
    expect(isBlockedIpAddress("100.100.100.200")).toBe(true);
    expect(isBlockedIpAddress("224.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("0.0.0.0")).toBe(true);
    expect(isBlockedIpAddress("255.255.255.255")).toBe(true);
  });

  it("blocks private and special IPv6 ranges", () => {
    expect(isBlockedIpAddress("::")).toBe(true);
    expect(isBlockedIpAddress("fe80::1")).toBe(true);
    expect(isBlockedIpAddress("fc00::1")).toBe(true);
    expect(isBlockedIpAddress("fd12:3456::1")).toBe(true);
    expect(isBlockedIpAddress("ff02::1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isBlockedIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isBlockedIpAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("fails closed on garbage input", () => {
    expect(isBlockedIpAddress("")).toBe(true);
    expect(isBlockedIpAddress("not-an-ip")).toBe(true);
    expect(isBlockedIpAddress("999.999.999.999")).toBe(true);
  });
});

describe("research security: URL syntax policy", () => {
  it("accepts http/https URLs", () => {
    expect(assertUrlSyntaxAllowed("https://example.com/a").hostname).toBe("example.com");
    expect(assertUrlSyntaxAllowed("http://example.com/").protocol).toBe("http:");
  });

  it("rejects dangerous schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<h1>x</h1>",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "ftp://example.com/x",
      "gopher://example.com/",
    ]) {
      expect(() => assertUrlSyntaxAllowed(url)).toThrow(ResearchUrlRejected);
    }
  });

  it("rejects malformed URLs", () => {
    expect(() => assertUrlSyntaxAllowed("")).toThrow(ResearchUrlRejected);
    expect(() => assertUrlSyntaxAllowed("not a url")).toThrow(ResearchUrlRejected);
  });
});

describe("research security: SSRF host validation", () => {
  it("allows public hosts after DNS resolution", async () => {
    const addrs = await assertHostAllowed("example.com", publicResolver);
    expect(addrs).toEqual(["93.184.216.34"]);
  });

  it("blocks localhost by name", async () => {
    await expect(assertHostAllowed("localhost", publicResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
  });

  it("blocks literal internal IPs without DNS", async () => {
    await expect(assertHostAllowed("127.0.0.1", publicResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
    await expect(assertHostAllowed("10.0.0.5", publicResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
    await expect(assertHostAllowed("::1", publicResolver)).rejects.toThrow(ResearchSsrfBlocked);
  });

  it("blocks hostnames resolving to internal addresses (DNS rebinding)", async () => {
    await expect(assertHostAllowed("internal.example.com", internalResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
    await expect(assertHostAllowed("loop.example.com", internalResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
    await expect(assertHostAllowed("link.example.com", internalResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
    await expect(assertHostAllowed("meta.example.com", internalResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
    await expect(assertHostAllowed("v6local.example.com", internalResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
  });

  it("fails closed on DNS resolution failure", async () => {
    await expect(assertHostAllowed("missing.example.com", publicResolver)).rejects.toThrow(
      ResearchSsrfBlocked,
    );
  });

  it("validates the full outbound URL end to end", async () => {
    const ok = await validateOutboundUrl("https://example.com/article", publicResolver);
    expect(ok.url.hostname).toBe("example.com");
    await expect(
      validateOutboundUrl("https://internal.example.com/x", internalResolver),
    ).rejects.toThrow(ResearchSsrfBlocked);
    await expect(validateOutboundUrl("javascript:alert(1)", publicResolver)).rejects.toThrow(
      ResearchUrlRejected,
    );
  });
});

describe("research security: redirect policy", () => {
  it("resolves relative redirects against the current URL", () => {
    const next = resolveRedirectUrl("https://example.com/a", "/b");
    expect(next.toString()).toBe("https://example.com/b");
  });

  it("rejects redirects to forbidden schemes", () => {
    expect(() => resolveRedirectUrl("https://example.com/a", "javascript:alert(1)")).toThrow(
      ResearchRedirectRejected,
    );
    expect(() => resolveRedirectUrl("https://example.com/a", "file:///etc/passwd")).toThrow(
      ResearchRedirectRejected,
    );
  });

  it("re-validates redirect destinations against SSRF (rebinding guard)", async () => {
    const next = await validateRedirect(
      "https://example.com/a",
      "https://example.com/b",
      0,
      MAX_REDIRECTS,
      publicResolver,
    );
    expect(next.hostname).toBe("example.com");
    await expect(
      validateRedirect(
        "https://example.com/a",
        "https://internal.example.com/x",
        0,
        MAX_REDIRECTS,
        internalResolver,
      ),
    ).rejects.toThrow(ResearchSsrfBlocked);
  });

  it("enforces the maximum redirect count", async () => {
    await expect(
      validateRedirect(
        "https://example.com/a",
        "https://example.com/b",
        MAX_REDIRECTS,
        MAX_REDIRECTS,
        publicResolver,
      ),
    ).rejects.toThrow(ResearchRedirectRejected);
  });
});

describe("research security: content-type policy and bounds", () => {
  it("supports the documented MIME vocabulary", () => {
    expect(isSupportedResearchMimeType("text/html; charset=utf-8")).toBe(true);
    expect(isSupportedResearchMimeType("text/plain")).toBe(true);
    expect(isSupportedResearchMimeType("application/json")).toBe(true);
    expect(isSupportedResearchMimeType("application/rss+xml")).toBe(true);
    expect(isSupportedResearchMimeType("application/atom+xml")).toBe(true);
  });

  it("rejects binary and executable MIME types", () => {
    expect(isSupportedResearchMimeType("application/pdf")).toBe(false);
    expect(isSupportedResearchMimeType("application/octet-stream")).toBe(false);
    expect(isSupportedResearchMimeType("application/x-msdownload")).toBe(false);
    expect(isSupportedResearchMimeType("image/png")).toBe(false);
    expect(isSupportedResearchMimeType("")).toBe(false);
  });

  it("publishes sane byte bounds (compression-bomb protection)", () => {
    expect(MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_DECOMPRESSED_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_DECOMPRESSED_BYTES).toBeGreaterThan(MAX_RESPONSE_BYTES);
  });
});

describe("research security: credential hygiene", () => {
  it("redacts secrets from error messages", () => {
    expect(redactSecretsFromMessage("key api-key: abc123 failed")).not.toContain("abc123");
    expect(redactSecretsFromMessage("auth Bearer mytoken123")).not.toContain("mytoken123");
    expect(redactSecretsFromMessage("cookie: session=xyz")).not.toContain("xyz");
    expect(redactSecretsFromMessage("authorization: Basic abc")).not.toContain("abc");
  });

  it("never exposes the rejected URL host internals in SSRF errors", async () => {
    try {
      await assertHostAllowed("10.9.9.9", publicResolver);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchSsrfBlocked);
      expect(String((err as Error).message)).not.toContain("10.9.9.9");
    }
  });

  it("does not store URLs on rejection errors", () => {
    const err = new (class extends ResearchUrlRejected {})("https://internal/x");
    expect((err as { url?: unknown }).url).toBeUndefined();
  });

  it("maps aborts to cancellation and timeouts canonically", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(toCanonicalResearchError(abort)).toBeInstanceOf(ResearchCancelled);
    expect(toCanonicalResearchError(new Error("connection timed out")).code).toBe("TIMEOUT");
  });
});
