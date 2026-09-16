// PR38: packages/mcp — CapabilityDiscovery unit tests
//
// Uses FakeClient objects (structural, no SDK import) covering: all-false
// fallback, tools-only servers, full servers, and mapping correctness.

import { describe, expect, it } from "vitest";
import {
  CapabilityDiscovery,
  EMPTY_CAPABILITIES,
  type CapabilityDiscoveryClient,
} from "../core/mcp-capability-discovery.js";

function fakeClient(partial: CapabilityDiscoveryClient): CapabilityDiscoveryClient {
  return partial;
}

describe("packages/mcp: CapabilityDiscovery (PR38)", () => {
  it("returns all-false when the client exposes nothing", async () => {
    const caps = await CapabilityDiscovery.discover(fakeClient({}));
    expect(caps).toEqual(EMPTY_CAPABILITIES);
  });

  it("returns all-false when getServerCapabilities throws and probes are absent", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        getServerCapabilities: () => {
          throw new Error("not initialized");
        },
      }),
    );
    expect(caps).toEqual(EMPTY_CAPABILITIES);
  });

  it("returns all-false when every probe rejects", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        listTools: async () => {
          throw new Error("unsupported");
        },
        listResources: async () => {
          throw new Error("unsupported");
        },
        listPrompts: async () => {
          throw new Error("unsupported");
        },
      }),
    );
    expect(caps).toEqual({ ...EMPTY_CAPABILITIES });
  });

  it("maps a tools-only server correctly", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        getServerCapabilities: () => ({ tools: { listChanged: true } }),
      }),
    );
    expect(caps).toEqual({
      tools: true,
      resources: false,
      prompts: false,
      logging: false,
      subscriptions: false,
      toolsListChanged: true,
      resourcesListChanged: false,
      promptsListChanged: false,
    });
  });

  it("maps a full server with subscriptions and listChanged flags", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        getServerCapabilities: () => ({
          tools: { listChanged: false },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
          logging: {},
        }),
      }),
    );
    expect(caps.tools).toBe(true);
    expect(caps.resources).toBe(true);
    expect(caps.prompts).toBe(true);
    expect(caps.logging).toBe(true);
    expect(caps.subscriptions).toBe(true);
    expect(caps.toolsListChanged).toBe(false);
    expect(caps.resourcesListChanged).toBe(true);
    expect(caps.promptsListChanged).toBe(true);
  });

  it("treats resources without subscribe as non-subscribable", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        getServerCapabilities: () => ({ resources: { listChanged: true } }),
      }),
    );
    expect(caps.resources).toBe(true);
    expect(caps.subscriptions).toBe(false);
    expect(caps.resourcesListChanged).toBe(true);
  });

  it("ignores a null capabilities snapshot and falls back to probing", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        getServerCapabilities: () => undefined,
        listTools: async () => ({ tools: [] }),
        listResources: async () => {
          throw new Error("no resources");
        },
        listPrompts: async () => ({ prompts: [] }),
      }),
    );
    expect(caps.tools).toBe(true);
    expect(caps.resources).toBe(false);
    expect(caps.prompts).toBe(true);
    // Probe path cannot observe listChanged/logging/subscriptions
    expect(caps.toolsListChanged).toBe(false);
    expect(caps.subscriptions).toBe(false);
  });

  it("probe fallback reports tools:false when listTools rejects", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        listTools: async () => {
          throw new Error("method not found");
        },
      }),
    );
    expect(caps.tools).toBe(false);
  });

  it("never throws when the client object itself misbehaves", async () => {
    const exploding = new Proxy(fakeClient({}), {
      get: () => {
        throw new Error("proxy boom");
      },
    });
    await expect(CapabilityDiscovery.discover(exploding)).resolves.toEqual(EMPTY_CAPABILITIES);
  });

  it("treats malformed capability blocks as absent, not as errors", async () => {
    const caps = await CapabilityDiscovery.discover(
      fakeClient({
        getServerCapabilities: () => ({
          tools: "yes",
          resources: 42,
          prompts: null,
          logging: false,
        }),
      }),
    );
    // "yes"/42 are present; explicit null/false count as absent.
    expect(caps.tools).toBe(true);
    expect(caps.resources).toBe(true);
    expect(caps.prompts).toBe(false);
    expect(caps.logging).toBe(false);
    expect(caps.subscriptions).toBe(false);
  });

  it("EMPTY_CAPABILITIES is all-false with the full flag set", () => {
    expect(Object.keys(EMPTY_CAPABILITIES).sort()).toEqual(
      [
        "logging",
        "prompts",
        "promptsListChanged",
        "resources",
        "resourcesListChanged",
        "subscriptions",
        "tools",
        "toolsListChanged",
      ].sort(),
    );
    expect(Object.values(EMPTY_CAPABILITIES).every((v) => v === false)).toBe(true);
  });

  it("discovery is pure: repeated calls return equal but independent records", async () => {
    const client = fakeClient({
      getServerCapabilities: () => ({ tools: {} }),
    });
    const first = await CapabilityDiscovery.discover(client);
    const second = await CapabilityDiscovery.discover(client);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
