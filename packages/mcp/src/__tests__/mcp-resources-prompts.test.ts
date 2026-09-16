// PR38: packages/mcp — resources/prompts/subscriptions host tests
//
// FakeClient (structural, no SDK import, no processes) driving
// InProcessMCPHost through discovery caps, URI validation, template match,
// read truncation, prompt framing, and subscription cap/TTL/cleanup.

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MCP_MAX_PROMPTS_PER_SERVER,
  MCP_MAX_RESOURCES_PER_SERVER,
  MCP_MAX_SUBSCRIPTIONS_PER_PROJECT,
} from "@ai-desktop/ai-core";
import { InProcessMCPHost, type McpClientLike } from "../core/in-process-mcp-host.js";

interface FakeState {
  capabilities: unknown;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  resourceTemplates: Array<{ uriTemplate: string; name: string }>;
  prompts: Array<{
    name: string;
    description?: string;
    arguments?: Array<{ name: string; required?: boolean }>;
  }>;
  resourcePayloads: Map<string, { mimeType?: string; text?: string; blob?: string }>;
  promptPayloads: Map<string, { messages: Array<{ role: string; content: unknown }> }>;
  failSubscribe: boolean;
  handlers: Array<(notification: unknown) => void | Promise<void>>;
}

function createFakeClient(state: FakeState): McpClientLike {
  return {
    connect: async () => {},
    close: async () => {},
    getServerCapabilities: () => state.capabilities,
    setNotificationHandler: (_schema, handler) => {
      state.handlers.push(handler);
    },
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    listTools: async () => ({ tools: state.tools }),
    listResources: async () => ({ resources: state.resources }),
    listResourceTemplates: async () => ({ resourceTemplates: state.resourceTemplates }),
    listPrompts: async () => ({ prompts: state.prompts }),
    readResource: async (params) => {
      const uri = (params as { uri: string }).uri;
      const payload = state.resourcePayloads.get(uri);
      if (!payload) {
        throw new Error(`unknown resource ${uri}`);
      }
      const content: Record<string, unknown> = { type: "resource", uri };
      if (payload.mimeType) content.mimeType = payload.mimeType;
      if (payload.text !== undefined) content.text = payload.text;
      if (payload.blob !== undefined) content.blob = payload.blob;
      return { contents: [content] };
    },
    getPrompt: async (params) => {
      const name = (params as { name: string }).name;
      const payload = state.promptPayloads.get(name);
      if (!payload) {
        throw new Error(`unknown prompt ${name}`);
      }
      return payload;
    },
    subscribeResource: async () => {
      if (state.failSubscribe) {
        throw new Error("subscribe not supported");
      }
      return {};
    },
    unsubscribeResource: async () => ({}),
  };
}

function fullState(): FakeState {
  return {
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
    },
    tools: [{ name: "ping" }],
    resources: [
      { uri: "doc://guide", name: "Guide", description: "User guide", mimeType: "text/plain" },
    ],
    resourceTemplates: [{ uriTemplate: "doc://{page}", name: "Doc page" }],
    prompts: [{ name: "summarize", description: "Summarize text" }],
    resourcePayloads: new Map([
      ["doc://guide", { mimeType: "text/plain", text: "Guide contents" }],
      ["doc://intro", { mimeType: "text/plain", text: "Intro contents" }],
    ]),
    promptPayloads: new Map([
      [
        "summarize",
        {
          messages: [{ role: "user", content: { type: "text", text: "Summarize this" } }],
        },
      ],
    ]),
    failSubscribe: false,
    handlers: [],
  };
}

async function connectHost(state: FakeState, serverId = "fake-srv") {
  const host = new InProcessMCPHost(undefined, {
    clientFactory: () => createFakeClient(state),
  });
  await host.connect({
    id: serverId,
    name: "Fake Server",
    transport: "in_memory",
    inMemoryServer: {},
  });
  return host;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("packages/mcp: resources, prompts, subscriptions (PR38)", () => {
  it("discovers resources and prompts after connect", async () => {
    const state = fullState();
    const host = await connectHost(state);

    const resources = await host.listResources("fake-srv");
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ uri: "doc://guide", name: "Guide" });

    const prompts = await host.listPrompts("fake-srv");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.name).toBe("summarize");

    await host.close();
  });

  it("caps synced resources and prompts at the ai-core bounds", async () => {
    const state = fullState();
    state.resources = Array.from({ length: MCP_MAX_RESOURCES_PER_SERVER + 10 }, (_, i) => ({
      uri: `doc://r${i}`,
      name: `R${i}`,
    }));
    state.prompts = Array.from({ length: MCP_MAX_PROMPTS_PER_SERVER + 10 }, (_, i) => ({
      name: `p${i}`,
    }));
    state.promptPayloads = new Map();
    const host = await connectHost(state);

    expect((await host.listResources("fake-srv")).length).toBe(MCP_MAX_RESOURCES_PER_SERVER);
    expect((await host.listPrompts("fake-srv")).length).toBe(MCP_MAX_PROMPTS_PER_SERVER);

    await host.close();
  });

  it("readResource rejects dangerous schemes", async () => {
    const state = fullState();
    const host = await connectHost(state);

    for (const uri of ["javascript:alert(1)", "data:text/plain,hi", "file:///etc/passwd"]) {
      await expect(host.readResource("fake-srv", uri)).rejects.toThrow(/not allowed|not provided/);
    }

    await host.close();
  });

  it("readResource rejects over-long URIs and unknown URIs", async () => {
    const state = fullState();
    const host = await connectHost(state);

    await expect(host.readResource("fake-srv", `doc://${"a".repeat(2000)}`)).rejects.toThrow(
      /Invalid resource URI|not provided/,
    );
    await expect(host.readResource("fake-srv", "other://missing")).rejects.toThrow(/not provided/);

    await host.close();
  });

  it("readResource allows template-matched URIs and reads text", async () => {
    const state = fullState();
    const host = await connectHost(state);

    // doc://intro is not a listed resource but matches doc://{page}
    const content = await host.readResource("fake-srv", "doc://intro");
    expect(content.text).toBe("Intro contents");
    expect(content.mimeType).toBe("text/plain");
    expect(content.truncated).toBeUndefined();

    await host.close();
  });

  it("readResource truncates text beyond the 256 KB ceiling", async () => {
    const state = fullState();
    state.resourcePayloads.set("doc://guide", {
      mimeType: "text/plain",
      text: "B".repeat(300 * 1024),
    });
    const host = await connectHost(state);

    const content = await host.readResource("fake-srv", "doc://guide");
    expect(content.truncated).toBe(true);
    expect(Buffer.byteLength(content.text ?? "", "utf8")).toBeLessThanOrEqual(256 * 1024);

    await host.close();
  });

  it("getPrompt returns normalized messages with the framed:true marker (no ai-core framing)", async () => {
    const state = fullState();
    const host = await connectHost(state);

    const result = await host.getPrompt("fake-srv", "summarize", { text: "hello" });
    expect(result.framed).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Summarize this" });
    // Raw content: the host does not apply frameMcpContent itself
    expect(result.messages[0]?.content).not.toContain("Untrusted MCP content");

    await host.close();
  });

  it("getPrompt rejects unknown prompt names", async () => {
    const state = fullState();
    const host = await connectHost(state);

    await expect(host.getPrompt("fake-srv", "nope")).rejects.toThrow(/not available/);

    await host.close();
  });

  it("subscribe requires the subscriptions capability", async () => {
    const state = fullState();
    state.capabilities = { tools: {}, resources: {}, prompts: {} }; // no subscribe flag
    const host = await connectHost(state);

    await expect(host.subscribe("fake-srv", "doc://guide", "proj-a")).rejects.toThrow(
      /does not advertise the subscriptions capability/,
    );

    await host.close();
  });

  it("subscribe enforces the per-project cap", async () => {
    const state = fullState();
    const host = await connectHost(state);

    for (let i = 0; i < MCP_MAX_SUBSCRIPTIONS_PER_PROJECT; i++) {
      await host.subscribe("fake-srv", "doc://guide", "proj-cap");
    }
    await expect(host.subscribe("fake-srv", "doc://guide", "proj-cap")).rejects.toThrow(
      /Subscription limit reached/,
    );
    // A different project still has quota
    const other = await host.subscribe("fake-srv", "doc://guide", "proj-other");
    expect(other.projectId).toBe("proj-other");

    await host.close();
  });

  it("subscriptions expire after the TTL (lazy prune)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const state = fullState();
    const host = await connectHost(state);

    const sub = await host.subscribe("fake-srv", "doc://guide", "proj-ttl");
    expect(host.getHealth("fake-srv")?.subscriptionCount).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:05:01Z")); // TTL (300s) + 1s
    // Lazy prune surfaces via health and frees quota
    expect(host.getHealth("fake-srv")?.subscriptionCount).toBe(0);
    await host.unsubscribe(sub.subscriptionId); // idempotent no-op after expiry

    await host.close();
  });

  it("disconnect clears subscriptions; unsubscribe is idempotent", async () => {
    const state = fullState();
    const host = await connectHost(state);

    const sub = await host.subscribe("fake-srv", "doc://guide", "proj-x");
    await host.unsubscribe(sub.subscriptionId);
    expect(host.getHealth("fake-srv")?.subscriptionCount).toBe(0);
    await host.unsubscribe(sub.subscriptionId); // safe no-op
    await host.unsubscribe("missing-id"); // safe no-op

    await host.subscribe("fake-srv", "doc://guide", "proj-x");
    await host.disconnect("fake-srv");
    expect(host.getHealth("fake-srv")?.subscriptionCount).toBe(0);
    expect(await host.listResources("fake-srv")).toEqual([]);

    await host.close();
  });

  it("server subscribe failures surface without recording a subscription", async () => {
    const state = fullState();
    state.failSubscribe = true;
    const host = await connectHost(state);

    await expect(host.subscribe("fake-srv", "doc://guide", "proj-f")).rejects.toThrow(
      /Failed to subscribe/,
    );
    expect(host.getHealth("fake-srv")?.subscriptionCount).toBe(0);

    await host.close();
  });

  it("list_changed handlers resync the matching category and emit capabilities events", async () => {
    const state = fullState();
    const seen: Array<{ serverId: string; resourceCount: number }> = [];
    const host = new InProcessMCPHost(
      {
        onCapabilitiesChanged: (serverId) => {
          seen.push({ serverId, resourceCount: -1 });
        },
      },
      { clientFactory: () => createFakeClient(state) },
    );
    await host.connect({
      id: "fake-srv",
      name: "Fake Server",
      transport: "in_memory",
      inMemoryServer: {},
    });
    const eventsAfterConnect = seen.length;
    expect(eventsAfterConnect).toBeGreaterThan(0);

    // Server adds a resource, then fires every captured notification handler
    state.resources = [...state.resources, { uri: "doc://new", name: "New" }];
    for (const handler of [...state.handlers]) {
      await handler({ method: "notifications/resources/list_changed" });
    }

    const resources = await host.listResources("fake-srv");
    expect(resources.map((r) => r.uri)).toContain("doc://new");
    expect(seen.length).toBeGreaterThan(eventsAfterConnect);

    await host.close();
  });

  it("tools-only servers skip resource/prompt sync and stay healthy", async () => {
    const state = fullState();
    state.capabilities = { tools: { listChanged: true } };
    state.resources = [];
    state.prompts = [];
    const host = await connectHost(state);

    expect(await host.listResources("fake-srv")).toEqual([]);
    expect(await host.listPrompts("fake-srv")).toEqual([]);
    const health = host.getHealth("fake-srv");
    expect(health?.capabilities.tools).toBe(true);
    expect(health?.capabilities.resources).toBe(false);

    await host.close();
  });

  it("close clears all servers and their subscriptions", async () => {
    const state = fullState();
    const host = await connectHost(state, "srv-a");
    await host.subscribe("srv-a", "doc://guide", "proj-a");
    await host.close();
    expect(host.listServers()).toEqual([]);
    expect(host.getHealth("srv-a")).toBeUndefined();
  });
});
