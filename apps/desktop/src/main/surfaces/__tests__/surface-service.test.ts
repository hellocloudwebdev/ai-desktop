// PR33.9: main — Surface Service Tests

import { describe, expect, it } from "vitest";
import { createToolCallId, now } from "@ai-desktop/shared";
import type { PermissionDecisionResult, PermissionManager } from "@ai-desktop/permissions";
import type { PermissionCheck } from "@ai-desktop/ai-core";
import type { ToolResult } from "@ai-desktop/ai-core";
import { buildSurfaceMetadata } from "@ai-desktop/ai-core";
import { SurfaceService } from "../surface-service.js";

class AllowAllPermissions implements PermissionManager {
  readonly checks: string[] = [];
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(`${request.capability}:${request.action}:${request.resource}`);
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

class StubRouter {
  readonly invokes: Array<{ toolName: string; input: unknown }> = [];
  constructor(private readonly _result: unknown = { updated: true }) {}
  async invoke(toolName: string, input: unknown): Promise<ToolResult> {
    this.invokes.push({ toolName, input });
    return {
      toolCallId: createToolCallId(),
      toolName,
      result: this._result,
      isError: false,
      timestamp: now(),
    };
  }
}

const DESCRIPTOR = { id: "sales-table", version: "1.0.0", kind: "table", title: "Sales" } as const;

function createService(
  permissions: PermissionManager = new AllowAllPermissions(),
  router: StubRouter = new StubRouter(),
) {
  return new SurfaceService({
    permissionManager: permissions,
    toolRouter: router as never,
  });
}

function toolResultFor(toolName: string, result: unknown): ToolResult {
  return {
    toolCallId: createToolCallId(),
    toolName,
    result,
    isError: false,
    timestamp: now(),
    metadata: buildSurfaceMetadata(DESCRIPTOR as never),
  };
}

describe("main: SurfaceService (PR33.9)", () => {
  it("creates a surface from a bound tool result with render permission", async () => {
    const permissions = new AllowAllPermissions();
    const service = createService(permissions);
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });

    const instance = await service.createFromToolResult(
      toolResultFor("builtin:reports/sales", [{ quarter: "Q1" }]),
      { projectId: "proj-A" },
    );
    expect(instance).not.toBeNull();
    expect(instance?.status).toBe("active");
    expect(instance?.provenance.projectId).toBe("proj-A");
    expect(permissions.checks.some((c) => c.startsWith("surface:render:sales-table"))).toBe(true);
  });

  it("returns null without a registered binding (no forged surfaces)", async () => {
    const service = createService();
    const instance = await service.createFromToolResult(
      toolResultFor("builtin:reports/other", []),
      {},
    );
    expect(instance).toBeNull();
  });

  it("rejects oversized data and over-wide tables at the host boundary", async () => {
    const service = createService();
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    const wide = toolResultFor("builtin:reports/sales", {
      columns: Array.from({ length: 51 }, (_, i) => `c${i}`),
      rows: [],
    });
    expect(await service.createFromToolResult(wide, {})).toBeNull();

    const tall = toolResultFor("builtin:reports/sales", {
      columns: ["a"],
      rows: Array.from({ length: 501 }, () => ["x"]),
    });
    expect(await service.createFromToolResult(tall, {})).toBeNull();

    const fitting = toolResultFor("builtin:reports/sales", {
      columns: ["a"],
      rows: [["x"]],
    });
    expect(await service.createFromToolResult(fitting, {})).not.toBeNull();
  });

  it("rejects forged descriptors that hash-mismatch the binding", async () => {
    const service = createService();
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    const forged: ToolResult = {
      ...toolResultFor("builtin:reports/sales", []),
      metadata: buildSurfaceMetadata({
        ...DESCRIPTOR,
        version: "9.9.9",
      } as never),
    };
    const instance = await service.createFromToolResult(forged, {});
    expect(instance).toBeNull();
  });

  it("returns null on render denial without creating anything", async () => {
    const service = createService(new DenyAllPermissions());
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    const instance = await service.createFromToolResult(
      toolResultFor("builtin:reports/sales", []),
      {},
    );
    expect(instance).toBeNull();
    expect(service.listByProject("proj-A")).toHaveLength(0);
  });

  it("blocks plugin surfaces when the extension gate fails", async () => {
    const service = new SurfaceService({
      permissionManager: new AllowAllPermissions(),
      toolRouter: new StubRouter() as never,
      extensionGate: { isActive: () => false, isEnabledForProject: () => true },
    });
    service.registerToolSurface("plugin:weather/widget", DESCRIPTOR, {
      source: "plugin",
      originId: "weather",
    });
    const instance = await service.createFromToolResult(
      toolResultFor("plugin:weather/widget", []),
      { projectId: "proj-A" },
    );
    expect(instance).toBeNull();
  });

  it("routes actions through validation, permission, and the router", async () => {
    const permissions = new AllowAllPermissions();
    const router = new StubRouter();
    const service = createService(permissions, router);
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    service.registerToolAction("builtin:reports/sales", {
      actionId: "refresh",
      type: "refresh",
      inputSchema: { type: "object", required: [], properties: {} },
      toolName: "builtin:reports/refresh",
    });

    const instance = await service.createFromToolResult(
      toolResultFor("builtin:reports/sales", []),
      { projectId: "proj-A" },
    );
    expect(instance).not.toBeNull();
    if (!instance) return;

    const result = await service.invokeAction(
      instance.instanceId,
      "refresh",
      {},
      { projectId: "proj-A" },
    );
    expect(result.isError).toBe(false);
    expect(router.invokes).toHaveLength(1);
    expect(router.invokes[0].toolName).toBe("builtin:reports/refresh");
    expect(
      permissions.checks.some((c) => c.startsWith("surface:interact:sales-table:refresh")),
    ).toBe(true);
  });

  it("validates action input before permission or router", async () => {
    const permissions = new AllowAllPermissions();
    const router = new StubRouter();
    const service = createService(permissions, router);
    service.registerToolSurface(
      "builtin:forms/submit",
      { id: "form-1", version: "1.0.0", kind: "form" },
      {
        source: "builtin",
        originId: "builtin:forms/submit",
      },
    );
    service.registerToolAction("builtin:forms/submit", {
      actionId: "submit",
      type: "submit",
      inputSchema: { type: "object", required: ["name"], properties: {} },
      toolName: "builtin:forms/save",
    });
    const created = await service.createFromToolResult(
      {
        toolCallId: createToolCallId(),
        toolName: "builtin:forms/submit",
        result: {},
        isError: false,
        timestamp: now(),
        metadata: buildSurfaceMetadata({ id: "form-1", version: "1.0.0", kind: "form" } as never),
      },
      {},
    );
    expect(created).not.toBeNull();
    if (!created) return;
    const before = permissions.checks.length;
    await expect(service.invokeAction(created.instanceId, "submit", {}, {})).rejects.toThrow(
      /Missing required action parameter/,
    );
    expect(permissions.checks.length).toBe(before);
    expect(router.invokes).toHaveLength(0);
  });

  it("denied actions return isError without router invocation", async () => {
    const router = new StubRouter();
    const service = createService(new DenyAllPermissions(), router);
    // Bypass creation gate by registering + creating under allow, then deny:
    // simpler — register binding, create with a permissive twin is overkill;
    // instead assert unknown-action path throws and deny path via direct setup.
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    // Creation itself is denied (render), so craft the instance via registry:
    const registered = service.registry.register(DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
      toolCallId: createToolCallId(),
    });
    service.registry.setStatus(registered.instanceId, "mounted");
    service.registry.setStatus(registered.instanceId, "active");
    service.registerToolAction("builtin:reports/sales", {
      actionId: "refresh",
      type: "refresh",
      inputSchema: { type: "object", required: [], properties: {} },
      toolName: "builtin:reports/refresh",
    });
    const result = await service.invokeAction(registered.instanceId, "refresh", {}, {});
    expect(result.isError).toBe(true);
    expect(router.invokes).toHaveLength(0);
  });

  it("dispose is idempotent and unknown instances throw", async () => {
    const service = createService();
    service.registerToolSurface("builtin:reports/sales", DESCRIPTOR, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    const instance = await service.createFromToolResult(
      toolResultFor("builtin:reports/sales", []),
      {},
    );
    expect(instance).not.toBeNull();
    if (!instance) return;
    expect(service.dispose(instance.instanceId)).toBe(true);
    expect(service.dispose(instance.instanceId)).toBe(true);
    expect(service.dispose("01JZZZZZZZZZZZZZZZZZZZZZZ" as never)).toBe(false);
    await expect(service.invokeAction(instance.instanceId, "refresh", {}, {})).rejects.toThrow(
      /Unknown or disposed surface/,
    );
  });
});
