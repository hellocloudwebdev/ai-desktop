// PR46: packages/mcp — Network Guards in Owned Code (adversarial)
//
// Owned-code only: McpServerConfig URL allowlist + credential/secret refusal.
// SSRF redirect/DNS guards live in apps/desktop (sibling-owned, OFF-LIMITS).

import { describe, expect, it } from "vitest";
import { McpServerConfigSchema } from "../core/mcp-server-config.js";

describe("mcp network-guards: scheme allowlist (javascript:/data:/file: denied)", () => {
  it("rejects dangerous schemes for remote transports", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,hello",
      "file:///etc/passwd",
      "ftp://example.com/tool",
      "gopher://example.com/",
    ]) {
      const result = McpServerConfigSchema.safeParse({
        id: "srv",
        name: "srv",
        transport: "streamable-http",
        url,
      });
      expect(result.success, url).toBe(false);
    }
  });

  it("accepts http(s) remote URLs", () => {
    for (const url of ["http://example.com/mcp", "https://example.com:8443/mcp"]) {
      const result = McpServerConfigSchema.safeParse({
        id: "srv",
        name: "srv",
        transport: "streamable-http",
        url,
      });
      expect(result.success, url).toBe(true);
    }
  });

  it("rejects embedded credentials in remote URLs (fail-closed)", () => {
    const result = McpServerConfigSchema.safeParse({
      id: "srv",
      name: "srv",
      transport: "sse",
      url: "https://user:pass@example.com/mcp",
    });
    expect(result.success).toBe(false);
  });
});

describe("mcp network-guards: secret quarantine in config", () => {
  it("rejects raw secret keys in env and headers", () => {
    const envBad = McpServerConfigSchema.safeParse({
      id: "srv",
      name: "srv",
      transport: "stdio",
      command: "node",
      env: { apiKey: "sk-live-12345678" },
    });
    expect(envBad.success).toBe(false);
    const headersBad = McpServerConfigSchema.safeParse({
      id: "srv",
      name: "srv",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" },
    });
    expect(headersBad.success).toBe(false);
  });

  it("accepts structured { secretRef } env values (never the string-prefix form)", () => {
    const ok = McpServerConfigSchema.safeParse({
      id: "srv",
      name: "srv",
      transport: "stdio",
      command: "node",
      env: { TOKEN: { secretRef: "app/provider/srv/api-key" } },
    });
    expect(ok.success).toBe(true);
    // A literal "secretRef:..." string is just a string, not a reference.
    const literal = McpServerConfigSchema.safeParse({
      id: "srv",
      name: "srv",
      transport: "stdio",
      command: "node",
      env: { TOKEN: "secretRef:app/provider/srv/api-key" },
    });
    expect(literal.success).toBe(true);
    if (literal.success) {
      expect(literal.data.env?.["TOKEN"]).toBe("secretRef:app/provider/srv/api-key");
    }
  });

  it("requires transport-matching config (stdio needs command, http needs url)", () => {
    expect(
      McpServerConfigSchema.safeParse({ id: "s", name: "s", transport: "stdio" }).success,
    ).toBe(false);
    expect(
      McpServerConfigSchema.safeParse({ id: "s", name: "s", transport: "streamable-http" }).success,
    ).toBe(false);
  });
});
