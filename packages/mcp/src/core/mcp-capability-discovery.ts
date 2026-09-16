// PR38: packages/mcp — MCP Capability Discovery
//
// Maps an SDK Client's negotiated server capabilities to a flat boolean
// capability record used by InProcessMCPHost to decide which categories
// (tools / resources / prompts / subscriptions) to sync.
//
// Invariants:
//   1. SDK types stay inside packages/mcp: only `import type { Client }`
//      (same path the host uses) plus a structural probe interface, so tests
//      can pass FakeClient objects without importing the real SDK.
//   2. discover() NEVER throws: any failure yields all-false capabilities
//      and the caller (host) decides what to sync.
//   3. Pure mapping, no state: CapabilityDiscovery holds no sessions.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface DiscoveredCapabilities {
  readonly tools: boolean;
  readonly resources: boolean;
  readonly prompts: boolean;
  readonly logging: boolean;
  readonly subscriptions: boolean;
  readonly toolsListChanged: boolean;
  readonly resourcesListChanged: boolean;
  readonly promptsListChanged: boolean;
}

export const EMPTY_CAPABILITIES: DiscoveredCapabilities = {
  tools: false,
  resources: false,
  prompts: false,
  logging: false,
  subscriptions: false,
  toolsListChanged: false,
  resourcesListChanged: false,
  promptsListChanged: false,
};

/**
 * Minimal structural surface CapabilityDiscovery needs. Members use method
 * shorthand so parameter checking stays bivariant and the real SDK Client
 * (verified @modelcontextprotocol/sdk 1.30.0) satisfies this contract; see
 * the compile-time assertion below. All probe methods are optional so
 * partial fakes (e.g. tools-only servers) are expressible.
 */
export interface CapabilityDiscoveryClient {
  getServerCapabilities?(): unknown;
  // `...args: never[]`: implementors may declare any (or no) parameters —
  // never is assignable to every parameter type, so the real SDK Client,
  // bound methods, and zero-arg fakes all satisfy this contract while the
  // host itself always calls these probes with zero arguments.
  listTools?(...args: never[]): Promise<unknown>;
  listResources?(...args: never[]): Promise<unknown>;
  listPrompts?(...args: never[]): Promise<unknown>;
}

// Compile-time assertion: the real SDK Client satisfies the probe contract.
// If the SDK surface changes, this assignment fails and discovery must be
// revisited — SDK types still never escape this package at runtime.
type _AssertClientSatisfiesProbeContract = Client extends CapabilityDiscoveryClient ? true : false;
const _assertClientSatisfiesProbeContract: _AssertClientSatisfiesProbeContract = true;
void _assertClientSatisfiesProbeContract;

interface ServerCapabilityBlock {
  readonly listChanged?: unknown;
  readonly subscribe?: unknown;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function isTrue(value: unknown): boolean {
  return value === true;
}

function mapServerCapabilities(raw: unknown): DiscoveredCapabilities | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const caps = raw as {
    readonly tools?: ServerCapabilityBlock;
    readonly resources?: ServerCapabilityBlock;
    readonly prompts?: ServerCapabilityBlock;
    readonly logging?: unknown;
  };
  const resources = caps.resources;
  const tools = caps.tools;
  const prompts = caps.prompts;
  return {
    tools: isPresent(tools),
    resources: isPresent(resources),
    prompts: isPresent(prompts),
    logging: isPresent(caps.logging),
    subscriptions: isTrue(resources?.subscribe),
    toolsListChanged: isTrue(tools?.listChanged),
    resourcesListChanged: isTrue(resources?.listChanged),
    promptsListChanged: isTrue(prompts?.listChanged),
  };
}

async function probe(fn: (() => Promise<unknown>) | undefined): Promise<boolean> {
  if (typeof fn !== "function") {
    return false;
  }
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

export class CapabilityDiscovery {
  /**
   * Discovers server capabilities. Prefers the negotiated
   * getServerCapabilities() snapshot; falls back to probing
   * listTools/listResources/listPrompts (unsupported endpoints throw and
   * map to false). listChanged flags, logging, and subscriptions cannot be
   * probed without side effects, so the probe path reports them as false.
   * Never throws: total failure yields EMPTY_CAPABILITIES.
   */
  static async discover(client: CapabilityDiscoveryClient): Promise<DiscoveredCapabilities> {
    try {
      if (typeof client.getServerCapabilities === "function") {
        const mapped = mapServerCapabilities(client.getServerCapabilities());
        if (mapped) {
          return mapped;
        }
      }

      const [tools, resources, prompts] = await Promise.all([
        probe(client.listTools?.bind(client)),
        probe(client.listResources?.bind(client)),
        probe(client.listPrompts?.bind(client)),
      ]);

      return {
        ...EMPTY_CAPABILITIES,
        tools,
        resources,
        prompts,
      };
    } catch {
      return { ...EMPTY_CAPABILITIES };
    }
  }
}
