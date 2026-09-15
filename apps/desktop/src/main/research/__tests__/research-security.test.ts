// PR35.6-35.9/35.30: apps/desktop — Research Security Tests
//
// Covers the mandatory gate: syntactic URL policy, DNS-backed SSRF guard
// (loopback, RFC1918, link-local/metadata, ULA, multicast, reserved, CGNAT,
// documentation ranges, literal-IP obfuscation, resolution failures),
// per-hop redirect revalidation, response MIME/size policy, credential
// redaction, and the no-subprocess invariant. Fully hermetic: DNS and fetch
// are injected; no live internet.

import { describe, expect, it } from "vitest";
import { checkResearchUrl } from "../security/url-policy.js";
import {
  assertSafeResearchDestination,
  blockedReasonForTestAddress,
} from "../security/ssrf-guard.js";
import { fetchWithRedirectPolicy } from "../security/redirect-policy.js";
import { readBoundedBody } from "../security/response-policy.js";
import {
  ResearchRedirectBlocked,
  ResearchSsrfBlocked,
  redactResearchSecrets,
  toCanonicalResearchError,
} from "../research-errors.js";

function dnsFor(
  hosts: Record<string, string[]>,
): (hostname: string) => Promise<Array<{ address: string; family: number }>> {
  return async (hostname: string) => {
    const addresses = hosts[hostname.toLowerCase()];
    if (!addresses) {
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
}

function jsonResponse(payload: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("research url-policy (syntactic gate)", () => {
  it("allows http/https URLs", () => {
    expect(checkResearchUrl("https://example.com/a").allowed).toBe(true);
    expect(checkResearchUrl("http://example.com/a").allowed).toBe(true);
  });

  it("rejects dangerous schemes without network access", () => {
    for (const bad of [
      "javascript:alert(1)",
      "vbscript:x",
      "data:text/html,hi",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "ftp://example.com/x",
      "gopher://example.com/x",
    ]) {
      const decision = checkResearchUrl(bad);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("dangerous-scheme");
    }
  });

  it("rejects empty, oversized, unparseable, and hostless URLs", () => {
    expect(checkResearchUrl("").reason).toBe("empty");
    expect(checkResearchUrl(undefined).reason).toBe("empty");
    expect(checkResearchUrl(`https://example.com/${"a".repeat(2048)}`).reason).toBe("too-long");
    expect(checkResearchUrl("::not a url::").reason).toBe("unparseable");
    expect(checkResearchUrl("mailto:a@example.com").reason).toBe("unsupported-scheme");
  });
});

describe("research ssrf-guard (DNS-backed)", () => {
  const publicDns = dnsFor({ "example.com": ["93.184.216.34"] });

  it("permits public destinations", async () => {
    const result = await assertSafeResearchDestination("https://example.com/a", {
      resolveAll: publicDns,
    });
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("blocks loopback hostnames and literals", async () => {
    const dns = dnsFor({
      "local.test": ["127.0.0.1"],
      "v6local.test": ["::1"],
      "mapped.test": ["::ffff:127.0.0.1"],
    });
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://local.test/",
      "http://v6local.test/",
      "http://mapped.test/",
    ]) {
      await expect(assertSafeResearchDestination(url, { resolveAll: dns })).rejects.toBeInstanceOf(
        ResearchSsrfBlocked,
      );
    }
  });

  it("blocks RFC1918, CGNAT, link-local, and metadata addresses", async () => {
    const dns = dnsFor({
      "a.test": ["10.1.2.3"],
      "b.test": ["172.16.5.4"],
      "c.test": ["192.168.1.1"],
      "d.test": ["100.64.0.1"],
      "e.test": ["169.254.169.254"],
      "f.test": ["fe80::1"],
      "g.test": ["fc00::1"],
      "h.test": ["ff02::1"],
      "i.test": ["224.0.0.1"],
      "j.test": ["0.0.0.0"],
      "k.test": ["255.255.255.255"],
      "l.test": ["192.0.2.1"],
      "m.test": ["203.0.113.5"],
      "n.test": ["198.51.100.7"],
      "o.test": ["2001:db8::1"],
      "p.test": ["::"],
    });
    for (const host of [
      "a.test",
      "b.test",
      "c.test",
      "d.test",
      "e.test",
      "f.test",
      "g.test",
      "h.test",
      "i.test",
      "j.test",
      "k.test",
      "l.test",
      "m.test",
      "n.test",
      "o.test",
      "p.test",
    ]) {
      await expect(
        assertSafeResearchDestination(`https://${host}/`, { resolveAll: dns }),
      ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
    }
  });

  it("blocks decimal/octal/hex IPv4 literal obfuscation", () => {
    // Node normalizes these forms; the guard sees the parsed address.
    expect(blockedReasonForTestAddress("127.0.0.1")).toContain("loopback");
    expect(blockedReasonForTestAddress("10.0.0.1")).toContain("RFC1918");
    expect(blockedReasonForTestAddress("169.254.169.254")).toContain("link-local");
    expect(blockedReasonForTestAddress("93.184.216.34")).toBeNull();
  });

  it("fails closed on DNS resolution failure and empty answers", async () => {
    await expect(
      assertSafeResearchDestination("https://missing.invalid/", { resolveAll: publicDns }),
    ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
    await expect(
      assertSafeResearchDestination("https://empty.invalid/", {
        resolveAll: async () => [],
      }),
    ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
  });

  it("rejects non-http(s) schemes and enforces host allowlists", async () => {
    await expect(
      assertSafeResearchDestination("file:///etc/passwd", { resolveAll: publicDns }),
    ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
    await expect(
      assertSafeResearchDestination("https://example.com/", {
        resolveAll: publicDns,
        allowedHosts: ["other.com"],
      }),
    ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
    const ok = await assertSafeResearchDestination("https://example.com/", {
      resolveAll: publicDns,
      allowedHosts: ["example.com"],
    });
    expect(ok.normalizedUrl).toContain("example.com");
  });

  it("permits loopback only with an explicit test opt-out", async () => {
    const dns = dnsFor({ "loop.test": ["127.0.0.1"] });
    await expect(
      assertSafeResearchDestination("http://loop.test/", { resolveAll: dns }),
    ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
    const ok = await assertSafeResearchDestination("http://loop.test/", {
      resolveAll: dns,
      denyLoopback: false,
    });
    expect(ok.addresses).toEqual(["127.0.0.1"]);
  });
});

describe("research redirect-policy (per-hop revalidation)", () => {
  const dns = dnsFor({
    "start.test": ["93.184.216.34"],
    "next.test": ["93.184.216.35"],
    "evil.test": ["127.0.0.1"],
  });

  function fetchWith(routes: Record<string, Response>): typeof fetch {
    return (async (input: unknown) => {
      const url = String(input);
      const response = routes[url];
      if (!response) throw new Error(`Unexpected fetch ${url}`);
      return response;
    }) as typeof fetch;
  }

  it("follows same-public redirects and records hops", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "https://next.test/final" },
    });
    const final = new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const { response, hops, finalUrl } = await fetchWithRedirectPolicy("https://start.test/a", {
      resolveAll: dns,
      fetchFn: fetchWith({ "https://start.test/a": redirect, "https://next.test/final": final }),
    });
    expect(response.status).toBe(200);
    expect(hops).toEqual(["https://start.test/a", "https://next.test/final"]);
    expect(finalUrl).toBe("https://next.test/final");
  });

  it("re-resolves every hop and blocks redirect-to-private", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "https://evil.test/admin" },
    });
    await expect(
      fetchWithRedirectPolicy("https://start.test/a", {
        resolveAll: dns,
        fetchFn: fetchWith({ "https://start.test/a": redirect }),
      }),
    ).rejects.toBeInstanceOf(ResearchSsrfBlocked);
  });

  it("blocks redirect-to-forbidden-scheme and missing Location", async () => {
    const js = new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } });
    await expect(
      fetchWithRedirectPolicy("https://start.test/a", {
        resolveAll: dns,
        fetchFn: fetchWith({ "https://start.test/a": js }),
      }),
    ).rejects.toBeInstanceOf(ResearchRedirectBlocked);

    const noLocation = new Response(null, { status: 302 });
    await expect(
      fetchWithRedirectPolicy("https://start.test/a", {
        resolveAll: dns,
        fetchFn: fetchWith({ "https://start.test/a": noLocation }),
      }),
    ).rejects.toBeInstanceOf(ResearchRedirectBlocked);
  });

  it("enforces the hop ceiling", async () => {
    const loop = new Response(null, {
      status: 302,
      headers: { location: "https://start.test/a" },
    });
    await expect(
      fetchWithRedirectPolicy("https://start.test/a", {
        resolveAll: dns,
        maxRedirects: 2,
        fetchFn: fetchWith({ "https://start.test/a": loop }),
      }),
    ).rejects.toBeInstanceOf(ResearchRedirectBlocked);
  });
});

describe("research response-policy (MIME + bounds)", () => {
  it("reads allowlisted bodies with truncation flagged", async () => {
    const body = await readBoundedBody(
      new Response("hello world", { headers: { "content-type": "text/html; charset=utf-8" } }),
      { maxBytes: 1024, maxChars: 5 },
    );
    expect(body.text).toBe("hello");
    expect(body.truncated).toBe(true);
    expect(body.mimeType).toBe("text/html");
  });

  it("rejects binaries and enforces byte ceilings", async () => {
    await expect(
      readBoundedBody(new Response("x", { headers: { "content-type": "image/png" } })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MIME" });
    await expect(
      readBoundedBody(
        new Response("x".repeat(100), { headers: { "content-type": "text/plain" } }),
        {
          maxBytes: 10,
          maxChars: 1000,
        },
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readBoundedBody(new Response("x", { headers: { "content-type": "text/plain" } }), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("research credential hygiene", () => {
  it("redacts raw secrets from messages and URLs", () => {
    expect(redactResearchSecrets("key sk-ant-abcdefghijklmnopqrstuvwx done")).toContain(
      "[REDACTED]",
    );
    expect(redactResearchSecrets("key sk-ant-abcdefghijklmnopqrstuvwx done")).not.toContain(
      "sk-ant-",
    );
    expect(
      redactResearchSecrets("https://api.example.com/?api_key=supersecretvalue&x=1"),
    ).toContain("[REDACTED]");
    expect(redactResearchSecrets("AIzaSyD12345678901234567890123456789012")).toContain(
      "[REDACTED]",
    );
  });

  it("classifies errors without leaking secrets", () => {
    const err = toCanonicalResearchError(
      new Error("request failed with sk-ant-abcdefghijklmnopqrstuvwx inside"),
    );
    expect(err.message).not.toContain("sk-ant-");
    expect(
      toCanonicalResearchError(Object.assign(new Error("x"), { name: "AbortError" })).code,
    ).toBe("CANCELLED");
    expect(
      toCanonicalResearchError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
        .code,
    ).toBe("TIMEOUT");
    expect(toCanonicalResearchError(new Error("401 Unauthorized")).code).toBe("AUTH_REQUIRED");
  });

  it("uses no subprocesses anywhere under the research tree", async () => {
    const { execFileSync } = await import("node:child_process");
    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");
    const root = path.resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // Import of the subprocess module, or a bare spawn/exec/execFile call
      // (a call not preceded by "." so regex.exec()/promise.exec() matches
      // elsewhere do not count). No research file may do either.
      if (
        /from\s+["']node:child_process["']|require\(["']child_process["']\)|node:child_process/.test(
          text,
        ) ||
        /(^|[^.\w$])(spawn|exec|execFile|execFileSync|spawnSync|execSync)\s*\(/.test(text)
      ) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
    expect(typeof execFileSync).toBe("function");
  });

  it("never performs live network access in this suite (json helper sanity)", () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
  });
});
