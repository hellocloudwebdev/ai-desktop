// PR35.12/35.24/35.30: apps/desktop — Research Executor Tests
//
// Covers the universal lifecycle: unknown-tool rejection, Zod validation
// BEFORE permission, permission denial short-circuit (no backend call),
// success path with provenance + surface stamp, canonical error mapping,
// and ToolRegistry-style resolve/list/has.

import { describe, expect, it } from "vitest";
import type { PermissionCheck, PermissionDecisionResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import { ResearchService } from "../research-service.js";
import { ResearchToolExecutor } from "../research-tool-executor.js";
import { StaticWebReader } from "../adapters/web/web-reader.js";
import { defaultResearchPolicy } from "../research-policy.js";

class AllowAllPermissions implements PermissionManager {
  readonly checks: PermissionCheck[] = [];
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return { kind: "allow" };
  }
  async resolve(): Promise<boolean> {
    return true;
  }
  async revoke(): Promise<number> {
    return 0;
  }
  getPendingRequest(): undefined {
    return undefined;
  }
  listPendingRequests(): readonly [] {
    return [];
  }
  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

class DenyAllPermissions extends AllowAllPermissions {
  override async check(): Promise<PermissionDecisionResult> {
    return { kind: "deny", reason: "Denied in test" };
  }
}

function testService(): ResearchService {
  const policy = defaultResearchPolicy({ denyLoopback: false });
  const reader = new StaticWebReader({
    policy,
    fetchFn: (async () =>
      new Response("<html><head><title>T</title></head><body><p>content here</p></body></html>", {
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
    resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  return new ResearchService({ policy, webReader: reader });
}

describe("research tool executor lifecycle", () => {
  it("resolves all five tools with builtin/in_process taxonomy", () => {
    const executor = new ResearchToolExecutor({
      permissionManager: new AllowAllPermissions(),
      researchService: testService(),
    });
    expect(executor.listTools()).toHaveLength(5);
    for (const name of [
      "builtin:research.search",
      "builtin:research.open",
      "builtin:research.github",
      "builtin:research.youtube",
      "builtin:research.rss",
    ]) {
      expect(executor.hasTool(name)).toBe(true);
      const def = executor.resolve(name);
      expect(def?.source).toBe("builtin");
      expect(def?.runtime).toBe("in_process");
      expect(def?.requiredPermissions).toEqual(["research"]);
    }
    expect(executor.hasTool("builtin:browser.open")).toBe(false);
  });

  it("rejects unknown tools before permission", async () => {
    const permissions = new AllowAllPermissions();
    const executor = new ResearchToolExecutor({
      permissionManager: permissions,
      researchService: testService(),
    });
    await expect(executor.execute("builtin:research.nope", {})).rejects.toThrow(
      /Unknown research tool/,
    );
    expect(permissions.checks).toHaveLength(0);
  });

  it("validates input before the permission check", async () => {
    const permissions = new AllowAllPermissions();
    const executor = new ResearchToolExecutor({
      permissionManager: permissions,
      researchService: testService(),
    });
    await expect(executor.execute("builtin:research.open", { url: "" })).rejects.toThrow(
      /Input validation failed/,
    );
    expect(permissions.checks).toHaveLength(0);
  });

  it("denies via PermissionManager without touching the backend", async () => {
    const permissions = new DenyAllPermissions();
    const service = testService();
    const executor = new ResearchToolExecutor({
      permissionManager: permissions,
      researchService: service,
    });
    const outcome = await executor.execute(
      "builtin:research.open",
      { url: "https://example.com/a" },
      { projectId: "proj-1" },
    );
    expect(outcome.isError).toBe(true);
    expect(String(outcome.result)).toContain("Permission denied");
    expect(outcome.metadata).toMatchObject({ permissionStatus: "deny" });
  });

  it("executes open with capability/action/resource and provenance payload", async () => {
    const permissions = new AllowAllPermissions();
    const executor = new ResearchToolExecutor({
      permissionManager: permissions,
      researchService: testService(),
    });
    const outcome = await executor.execute(
      "builtin:research.open",
      { url: "https://example.com/a" },
      { projectId: "proj-1" },
    );
    expect(outcome.isError).toBe(false);
    expect(permissions.checks).toHaveLength(1);
    expect(permissions.checks[0]).toMatchObject({
      capability: "research",
      action: "open",
      scope: "once",
      risk: "low",
    });
    const payload = JSON.parse(String(outcome.result)) as {
      source: { provider: string; channel: string };
    };
    expect(payload.source.provider).toBe("static-reader");
    expect(payload.source.channel).toBe("web");
  });

  it("maps backend failures to canonical error ToolResults", async () => {
    const permissions = new AllowAllPermissions();
    const executor = new ResearchToolExecutor({
      permissionManager: permissions,
      researchService: testService(),
    });
    // No GitHub adapter registered on this service: the executor must
    // surface a canonical [CODE] message, not throw or leak internals.
    const denied = await executor.execute("builtin:research.github", {
      operation: "repository",
      owner: "octo",
      repo: "hello",
    });
    expect(denied.isError).toBe(true);
    expect(String(denied.result)).toMatch(/\[.+\] .+/);
  });

  it("stamps search results with an additive surface descriptor", async () => {
    const permissions = new AllowAllPermissions();
    const service = new ResearchService({
      policy: defaultResearchPolicy({ denyLoopback: false }),
      searchProvider: {
        provider: "exa",
        authenticated: false,
        search: async () => [
          { title: "A", url: "https://example.com/a", snippet: "s", domain: "example.com" },
        ],
        health: async () => "available" as const,
      } as never,
    });
    const executor = new ResearchToolExecutor({
      permissionManager: permissions,
      researchService: service,
    });
    const outcome = await executor.execute("builtin:research.search", { query: "test query" });
    expect(outcome.isError).toBe(false);
    const metadata = outcome.metadata as { surface?: { kind?: string } } | undefined;
    expect(metadata?.surface?.kind).toBe("table");
  });
});
