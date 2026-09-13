// PR33.36: desktop — Rich Surface Defining E2E
//
// Tool → stamped result → SurfaceService → instance → structured action →
// permission → ToolExecutor path → updated view → dispose → cleanup.
// Then the plugin-backed variant. No raw HTML/script anywhere.

import { describe, expect, it } from "vitest";
import { createToolCallId, now } from "@ai-desktop/shared";
import type { PermissionDecisionResult, PermissionManager } from "@ai-desktop/permissions";
import type { PermissionCheck, ToolResult } from "@ai-desktop/ai-core";
import { buildSurfaceMetadata } from "@ai-desktop/ai-core";
import { SurfaceService } from "../main/surfaces/surface-service.js";

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

class StubRouter {
  readonly invokes: Array<{ toolName: string; input: unknown }> = [];
  constructor(private readonly _handler: (toolName: string, input: unknown) => unknown) {}
  async invoke(toolName: string, input: unknown): Promise<ToolResult> {
    this.invokes.push({ toolName, input });
    return {
      toolCallId: createToolCallId(),
      toolName,
      result: this._handler(toolName, input),
      isError: false,
      timestamp: now(),
    };
  }
}

const TABLE = { id: "report-table", version: "1.0.0", kind: "table", title: "Report" } as const;

function resultFor(toolName: string, result: unknown): ToolResult {
  return {
    toolCallId: createToolCallId(),
    toolName,
    result,
    isError: false,
    timestamp: now(),
    metadata: buildSurfaceMetadata(TABLE as never),
  };
}

describe("desktop: rich surface defining E2E (PR33.36)", () => {
  it("tool → table surface → row select → executor → update → dispose", async () => {
    const permissions = new AllowAllPermissions();
    const router = new StubRouter((toolName, input) =>
      toolName === "builtin:reports/refresh"
        ? { refreshed: true, filter: (input as { status?: string }).status ?? "all" }
        : { ok: true },
    );
    const service = new SurfaceService({
      permissionManager: permissions,
      toolRouter: router as never,
    });
    service.registerToolSurface("builtin:reports/sales", TABLE, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    service.registerToolAction("builtin:reports/sales", {
      actionId: "refresh",
      type: "refresh",
      inputSchema: { type: "object", required: [], properties: { status: { type: "string" } } },
      toolName: "builtin:reports/refresh",
      title: "Refresh",
    });

    // 1-2. Tool returns structured table data; surface appears.
    const instance = await service.createFromToolResult(
      resultFor("builtin:reports/sales", [{ quarter: "Q1", total: 100 }]),
      { projectId: "proj-A" },
    );
    expect(instance).not.toBeNull();
    if (!instance) return;
    expect(instance.status).toBe("active");

    // 3-5. Structured row-select action → permission → existing executor path.
    const updated = await service.invokeAction(
      instance.instanceId,
      "refresh",
      { status: "open" },
      { projectId: "proj-A" },
    );
    expect(updated.isError).toBe(false);
    expect(updated.result).toEqual({ refreshed: true, filter: "open" });
    expect(router.invokes).toHaveLength(1);
    expect(permissions.checks.some((c) => c === "surface:interact:report-table:refresh")).toBe(
      true,
    );

    // 6-7. Dispose cleans up idempotently; further actions fail closed.
    expect(service.dispose(instance.instanceId)).toBe(true);
    expect(service.dispose(instance.instanceId)).toBe(true);
    await expect(service.invokeAction(instance.instanceId, "refresh", {}, {})).rejects.toThrow(
      /disposed/,
    );
  });

  it("plugin-backed surface honors the extension gate and project scope", async () => {
    let active = true;
    const service = new SurfaceService({
      permissionManager: new AllowAllPermissions(),
      toolRouter: new StubRouter(() => ({ pong: true })) as never,
      extensionGate: {
        isActive: () => active,
        isEnabledForProject: (_id: string, project: string) => project === "proj-A",
      },
    });
    service.registerToolSurface("plugin:weather/widget", TABLE, {
      source: "plugin",
      originId: "weather",
    });

    const forA = await service.createFromToolResult(resultFor("plugin:weather/widget", []), {
      projectId: "proj-A",
    });
    expect(forA).not.toBeNull();

    const forB = await service.createFromToolResult(resultFor("plugin:weather/widget", []), {
      projectId: "proj-B",
    });
    expect(forB).toBeNull();

    active = false;
    const afterDisable = await service.createFromToolResult(
      resultFor("plugin:weather/widget", []),
      { projectId: "proj-A" },
    );
    expect(afterDisable).toBeNull();
  });

  it("no raw HTML or script survives the descriptor boundary", async () => {
    const service = new SurfaceService({
      permissionManager: new AllowAllPermissions(),
      toolRouter: new StubRouter(() => ({})) as never,
    });
    // A tool-stamped descriptor with an application kind is policy-rejected.
    service.registerToolSurface("builtin:reports/sales", TABLE, {
      source: "builtin",
      originId: "builtin:reports/sales",
    });
    const base = resultFor("builtin:reports/sales", "<script>alert(1)</script>");
    const evil: typeof base = {
      ...base,
      metadata: buildSurfaceMetadata({
        id: "evil-app",
        version: "1.0.0",
        kind: "application",
      } as never),
    };
    // Hash-mismatch (unregistered id) → null before any rendering decision.
    expect(await service.createFromToolResult(evil, {})).toBeNull();
  });
});
