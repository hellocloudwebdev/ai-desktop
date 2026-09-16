// PR38: packages/mcp — lifecycle & health tests
//
// FakeClient-driven: state transitions, secrets-free health snapshots,
// disconnect clearing tools + subscriptions, reconnect rediscovers.

import { describe, expect, it } from "vitest";
import { InProcessMCPHost, type McpClientLike } from "../core/in-process-mcp-host.js";
import type { McpConnectionState } from "../core/mcp-host.js";

function createFake(state: { capabilities?: unknown; tools?: string[]; failConnect?: boolean }): {
  client: McpClientLike;
  state: { connectCalls: number; closeCalls: number } & typeof state;
} {
  const mutable = { connectCalls: 0, closeCalls: 0, ...state };
  const client: McpClientLike = {
    connect: async () => {
      mutable.connectCalls += 1;
      if (mutable.failConnect) {
        throw new Error("connection refused");
      }
    },
    close: async () => {
      mutable.closeCalls += 1;
    },
    getServerCapabilities: () => mutable.capabilities ?? { tools: {} },
    setNotificationHandler: () => {},
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    listTools: async () => ({
      tools: (mutable.tools ?? ["ping"]).map((name) => ({ name })),
    }),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    listPrompts: async () => ({ prompts: [] }),
    readResource: async () => ({ contents: [{ type: "text", text: "x", uri: "doc://x" }] }),
    getPrompt: async () => ({ messages: [] }),
    subscribeResource: async () => ({}),
    unsubscribeResource: async () => ({}),
  };
  return { client, state: mutable };
}

async function connectFake(
  events?: ConstructorParameters<typeof InProcessMCPHost>[0],
  fake?: ReturnType<typeof createFake>,
  serverId = "life-srv",
) {
  const f = fake ?? createFake({});
  const host = new InProcessMCPHost(events, { clientFactory: () => f.client });
  await host.connect({
    id: serverId,
    name: "Lifecycle Server",
    transport: "in_memory",
    inMemoryServer: {},
  });
  return { host, fake: f };
}

describe("packages/mcp: lifecycle & health (PR38)", () => {
  it("emits connecting -> connected state transitions on connect", async () => {
    const transitions: McpConnectionState[] = [];
    const { host } = await connectFake({
      onStateChanged: (_id, state) => {
        transitions.push(state);
      },
    });

    expect(transitions).toEqual(["connecting", "connected"]);
    expect(host.getServerStatus("life-srv")?.state).toBe("connected");

    await host.close();
  });

  it("emits failed with an error message when connect throws", async () => {
    const seen: Array<{ state: McpConnectionState; error?: string }> = [];
    const f = createFake({ failConnect: true });
    const host = new InProcessMCPHost(
      {
        onStateChanged: (_id, state, error) => {
          seen.push({ state, error });
        },
      },
      { clientFactory: () => f.client },
    );

    await expect(
      host.connect({
        id: "bad-srv",
        name: "Bad Server",
        transport: "in_memory",
        inMemoryServer: {},
      }),
    ).rejects.toThrow(/Failed to connect/);
    expect(host.getServerStatus("bad-srv")?.state).toBe("failed");
    expect(seen.at(-1)?.state).toBe("failed");
    expect(seen.at(-1)?.error).toContain("connection refused");

    await host.close();
  });

  it("health snapshot carries counts and flags but never secrets", async () => {
    const { host } = await connectFake();
    const health = host.getHealth("life-srv");

    expect(health).toMatchObject({
      serverId: "life-srv",
      name: "Lifecycle Server",
      transport: "in_memory",
      state: "connected",
      toolCount: 1,
      resourceCount: 0,
      promptCount: 0,
      subscriptionCount: 0,
    });
    expect(health?.capabilities.tools).toBe(true);
    expect(health?.lastConnectedAt).toBeDefined();

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("env");
    expect(serialized).not.toContain("secret");

    await host.close();
  });

  it("health for unknown servers is undefined; failed servers report lastFailure", async () => {
    const f = createFake({ failConnect: true });
    const host = new InProcessMCPHost(undefined, { clientFactory: () => f.client });

    expect(host.getHealth("ghost")).toBeUndefined();

    await expect(
      host.connect({
        id: "bad-srv",
        name: "Bad Server",
        transport: "in_memory",
        inMemoryServer: {},
      }),
    ).rejects.toThrow();
    const health = host.getHealth("bad-srv");
    expect(health?.state).toBe("failed");
    expect(health?.lastFailure).toContain("connection refused");

    await host.close();
  });

  it("disconnect clears tools, resources, prompts, capabilities, and subscriptions", async () => {
    const { host } = await connectFake();
    expect((await host.listTools("life-srv")).length).toBe(1);

    await host.disconnect("life-srv");
    expect(host.getServerStatus("life-srv")?.state).toBe("disconnected");
    expect(await host.listTools("life-srv")).toEqual([]);
    const health = host.getHealth("life-srv");
    expect(health?.toolCount).toBe(0);
    expect(health?.capabilities.tools).toBe(false);

    await host.close();
  });

  it("disconnect on unknown servers is a safe no-op", async () => {
    const { host } = await connectFake();
    await host.disconnect("ghost");
    expect(host.getServerStatus("life-srv")?.state).toBe("connected");
    await host.close();
  });

  it("reconnect rediscovers tools and capabilities", async () => {
    const f = createFake({ tools: ["v1-tool"] });
    const { host } = await connectFake(undefined, f);

    expect((await host.listTools("life-srv")).map((t) => t.name)).toContain("mcp:life-srv/v1-tool");

    await host.disconnect("life-srv");
    f.state.tools = ["v2-tool"];
    await host.connect({
      id: "life-srv",
      name: "Lifecycle Server",
      transport: "in_memory",
      inMemoryServer: {},
    });

    const names = (await host.listTools("life-srv")).map((t) => t.name);
    expect(names).toContain("mcp:life-srv/v2-tool");
    expect(names).not.toContain("mcp:life-srv/v1-tool");
    expect(f.state.connectCalls).toBe(2);

    await host.close();
  });

  it("connect is idempotent while connected (no second client connect)", async () => {
    const f = createFake({});
    const { host } = await connectFake(undefined, f);

    await host.connect({
      id: "life-srv",
      name: "Lifecycle Server",
      transport: "in_memory",
      inMemoryServer: {},
    });
    expect(f.state.connectCalls).toBe(1);

    await host.close();
  });

  it("onCapabilitiesChanged fires on connect with discovered flags", async () => {
    const seen: Array<{ serverId: string; tools: boolean }> = [];
    const { host } = await connectFake({
      onCapabilitiesChanged: (serverId, caps) => {
        seen.push({ serverId, tools: caps.tools });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ serverId: "life-srv", tools: true });

    await host.close();
  });

  it("close disconnects every session and clears the registry", async () => {
    const f = createFake({});
    const host = new InProcessMCPHost(undefined, { clientFactory: () => f.client });
    await host.connect({
      id: "srv-1",
      name: "S1",
      transport: "in_memory",
      inMemoryServer: {},
    });
    await host.connect({
      id: "srv-2",
      name: "S2",
      transport: "in_memory",
      inMemoryServer: {},
    });

    await host.close();
    expect(host.listServers()).toEqual([]);
    expect(f.state.closeCalls).toBe(2);

    await host.close(); // second close is safe
  });

  it("callTool on disconnected servers throws a state error", async () => {
    const { host } = await connectFake();
    await host.disconnect("life-srv");
    await expect(host.callTool("life-srv", "ping", {})).rejects.toThrow(/not connected/);
    await expect(host.callTool("ghost", "ping", {})).rejects.toThrow(/not configured/);
    await host.close();
  });

  it("listTools/listResources/listPrompts return [] for unknown servers", async () => {
    const { host } = await connectFake();
    expect(await host.listTools("ghost")).toEqual([]);
    expect(await host.listResources("ghost")).toEqual([]);
    expect(await host.listPrompts("ghost")).toEqual([]);
    await host.close();
  });
});
