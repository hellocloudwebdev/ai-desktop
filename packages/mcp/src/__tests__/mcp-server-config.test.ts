import { describe, expect, it } from "vitest";
import { McpServerConfigSchema, type McpServerConfig } from "../core/mcp-server-config.js";

describe("packages/mcp: McpServerConfig & Security Rules (PR25.3)", () => {
  it("accepts valid stdio transport configuration", () => {
    const config: McpServerConfig = {
      id: "local-tools",
      name: "Local Tools Server",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      env: { NODE_ENV: "production", WORKSPACE: "/workspace" },
      disabled: false,
    };

    const parsed = McpServerConfigSchema.parse(config);
    expect(parsed.id).toBe("local-tools");
    expect(parsed.transport).toBe("stdio");
    expect(parsed.command).toBe("node");
  });

  it("accepts valid sse transport configuration", () => {
    const config: McpServerConfig = {
      id: "remote-tools",
      name: "Remote SSE Server",
      transport: "sse",
      url: "https://mcp.example.com/sse",
      headers: { "X-Custom-Header": "custom-value" },
      disabled: false,
    };

    const parsed = McpServerConfigSchema.parse(config);
    expect(parsed.id).toBe("remote-tools");
    expect(parsed.transport).toBe("sse");
    expect(parsed.url).toBe("https://mcp.example.com/sse");
  });

  it("accepts valid in_memory transport configuration", () => {
    const config: McpServerConfig = {
      id: "in-mem",
      name: "In-Memory Test Server",
      transport: "in_memory",
      inMemoryServer: {},
      disabled: false,
    };

    const parsed = McpServerConfigSchema.parse(config);
    expect(parsed.transport).toBe("in_memory");
  });

  it("rejects stdio transport without a command", () => {
    const invalidConfig = {
      id: "no-cmd",
      name: "No Command",
      transport: "stdio",
    };

    expect(() => McpServerConfigSchema.parse(invalidConfig)).toThrow(/command for stdio/);
  });

  it("rejects sse transport without a url", () => {
    const invalidConfig = {
      id: "no-url",
      name: "No URL",
      transport: "sse",
    };

    expect(() => McpServerConfigSchema.parse(invalidConfig)).toThrow(/url for sse/);
  });

  it("SECURITY: rejects raw credentials in env (apiKey, accessToken, secret, password)", () => {
    const configWithApiKey = {
      id: "leaked-key",
      name: "Leaked Key",
      transport: "stdio",
      command: "npx",
      env: {
        API_KEY: "sk-ant-secret12345",
      },
    };

    expect(() => McpServerConfigSchema.parse(configWithApiKey)).toThrow(/Raw credentials/);

    const configWithPassword = {
      id: "leaked-pw",
      name: "Leaked Password",
      transport: "stdio",
      command: "node",
      env: {
        PASSWORD: "super-secret-password",
      },
    };

    expect(() => McpServerConfigSchema.parse(configWithPassword)).toThrow(/Raw credentials/);
  });

  it("SECURITY: rejects raw credentials in headers (Authorization)", () => {
    const configWithAuth = {
      id: "leaked-header",
      name: "Leaked Header",
      transport: "sse",
      url: "https://example.com/sse",
      headers: {
        Authorization: "Bearer secret-token-123",
      },
    };

    expect(() => McpServerConfigSchema.parse(configWithAuth)).toThrow(/Raw credentials/);
  });
});
