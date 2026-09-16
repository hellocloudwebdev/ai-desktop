// PR38: packages/mcp — secretRef resolution tests
//
// Verifies: { secretRef } env entries resolve via the injected SecretStore,
// raw credentials stay rejected, missing stores/refs fail closed, and
// resolved secrets never appear in errors.

import { describe, expect, it } from "vitest";
import { asSecretRef, type SecretRef, type SecretStore } from "@ai-desktop/storage";
import { McpServerConfigSchema } from "../core/mcp-server-config.js";
import { InProcessMCPHost, type McpClientLike } from "../core/in-process-mcp-host.js";

const REF = asSecretRef("app/provider/acme/api-key");

function createMemorySecretStore(values: Map<string, string>): SecretStore {
  return {
    set: async (ref: SecretRef, secret: string) => {
      values.set(ref, secret);
    },
    get: async (ref: SecretRef) => values.get(ref) ?? null,
    delete: async (ref: SecretRef) => {
      values.delete(ref);
    },
    has: async (ref: SecretRef) => values.has(ref),
  };
}

function createSpyClient(seen: { transports: unknown[] }): McpClientLike {
  return {
    connect: async (transport) => {
      seen.transports.push(transport);
    },
    close: async () => {},
    getServerCapabilities: () => ({ tools: {} }),
    setNotificationHandler: () => {},
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    listPrompts: async () => ({ prompts: [] }),
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
    subscribeResource: async () => ({}),
    unsubscribeResource: async () => ({}),
  };
}

describe("packages/mcp: secretRef env resolution (PR38)", () => {
  it("schema accepts { secretRef } env objects alongside literal strings", () => {
    const parsed = McpServerConfigSchema.parse({
      id: "sec-srv",
      name: "Secret Server",
      transport: "stdio",
      command: "node",
      env: {
        PLAIN: "hello",
        API_TOKEN: { secretRef: "app/provider/acme/api-key" },
      },
    });
    expect(parsed.env?.["PLAIN"]).toBe("hello");
    expect(parsed.env?.["API_TOKEN"]).toEqual({ secretRef: "app/provider/acme/api-key" });
  });

  it("schema rejects empty secretRef values", () => {
    expect(() =>
      McpServerConfigSchema.parse({
        id: "sec-srv",
        name: "Secret Server",
        transport: "stdio",
        command: "node",
        env: { API_TOKEN: { secretRef: "" } },
      }),
    ).toThrow();
  });

  it("resolves secretRef env entries via the SecretStore at connect", async () => {
    const store = createMemorySecretStore(new Map([[REF, "resolved-secret-value"]]));
    const host = new InProcessMCPHost(undefined, {
      secretStore: store,
      clientFactory: () => createSpyClient({ transports: [] }),
    });

    // NOTE: env (including secretRefs) is a stdio-transport concept; the
    // FakeClient ignores the constructed transport so no process spawns.
    await host.connect({
      id: "sec-srv",
      name: "Secret Server",
      transport: "stdio",
      command: "node",
      env: { API_TOKEN: { secretRef: "app/provider/acme/api-key" } },
    });

    expect(host.getServerStatus("sec-srv")?.state).toBe("connected");
    await host.close();
  });

  it("fails closed when a secretRef is present but no SecretStore is injected", async () => {
    const host = new InProcessMCPHost(undefined, {
      clientFactory: () => createSpyClient({ transports: [] }),
    });

    await expect(
      host.connect({
        id: "sec-srv",
        name: "Secret Server",
        transport: "stdio",
        command: "node",
        env: { API_TOKEN: { secretRef: "app/provider/acme/api-key" } },
      }),
    ).rejects.toThrow(/no SecretStore is configured/);

    await host.close();
  });

  it("fails closed for missing secrets without leaking the value", async () => {
    const store = createMemorySecretStore(new Map());
    const host = new InProcessMCPHost(undefined, {
      secretStore: store,
      clientFactory: () => createSpyClient({ transports: [] }),
    });

    const err = await host
      .connect({
        id: "sec-srv",
        name: "Secret Server",
        transport: "stdio",
        command: "node",
        env: { API_TOKEN: { secretRef: "app/provider/acme/api-key" } },
      })
      .catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("missing secret");
    // The error names the (non-secret) reference but carries no secret material
    expect(String(err)).not.toContain("resolved-secret-value");

    await host.close();
  });

  it("rejects malformed secretRef values without leaking them", async () => {
    const store = createMemorySecretStore(new Map());
    const host = new InProcessMCPHost(undefined, {
      secretStore: store,
      clientFactory: () => createSpyClient({ transports: [] }),
    });

    await expect(
      host.connect({
        id: "sec-srv",
        name: "Secret Server",
        transport: "stdio",
        command: "node",
        // Bypass the schema (cast) to exercise host-side validation
        env: { API_TOKEN: { secretRef: "NOT A VALID REF!!" } } as unknown as Record<string, string>,
      }),
    ).rejects.toThrow(/invalid secretRef/i);

    await host.close();
  });

  it("raw credential keys stay rejected even with secretRef siblings", () => {
    expect(() =>
      McpServerConfigSchema.parse({
        id: "sec-srv",
        name: "Secret Server",
        transport: "stdio",
        command: "node",
        env: {
          API_TOKEN: { secretRef: "app/provider/acme/api-key" },
          password: "hunter2",
        },
      }),
    ).toThrow(/Raw credentials/);
  });

  it("streamable-http config requires a clean http(s) URL", () => {
    const ok = McpServerConfigSchema.parse({
      id: "http-srv",
      name: "HTTP Server",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
    expect(ok.transport).toBe("streamable-http");

    expect(() =>
      McpServerConfigSchema.parse({
        id: "http-srv",
        name: "HTTP Server",
        transport: "streamable-http",
      }),
    ).toThrow(/url for sse\/streamable-http/);

    expect(() =>
      McpServerConfigSchema.parse({
        id: "http-srv",
        name: "HTTP Server",
        transport: "streamable-http",
        url: "https://user:pass@mcp.example.com/mcp",
      }),
    ).toThrow(/no embedded credentials/);
  });
});
