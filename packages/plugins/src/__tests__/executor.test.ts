import { describe, expect, it, vi } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import type { PermissionManager } from "@ai-desktop/ai-core";
import {
  PluginToolRegistry,
  buildPluginToolDefinition,
} from "../tools/extension-tool-contribution.js";
import { PluginToolExecutor, type PluginToolHandler } from "../core/extension-tool-executor.js";

function allowManager(): PermissionManager & { check: ReturnType<typeof vi.fn> } {
  return { check: vi.fn(async () => ({ kind: "allow" as const })) };
}

function denyManager(): PermissionManager & { check: ReturnType<typeof vi.fn> } {
  return { check: vi.fn(async () => ({ kind: "deny" as const, reason: "nope" })) };
}

function setup(options?: {
  active?: boolean;
  enabledForProject?: boolean;
  handler?: PluginToolHandler;
  permissionManager?: PermissionManager & { check: ReturnType<typeof vi.fn> };
}) {
  const registry = new PluginToolRegistry();
  const def = buildPluginToolDefinition(
    {
      extensionId: "ext-a",
      tool: {
        name: "echo",
        description: "Echoes input",
        parameters: { type: "object", properties: {}, required: ["text"] },
      },
    },
    "hash-1",
  );
  registry.registerTool(def);
  const pm = options?.permissionManager ?? allowManager();
  const handler = options?.handler ?? (async (input: unknown) => ({ echoed: input }));
  const handlers = new Map<string, PluginToolHandler>([[def.name, handler]]);
  const executor = new PluginToolExecutor({
    toolRegistry: registry,
    permissionManager: pm,
    handlers,
    isEnabledForProject: () => options?.enabledForProject ?? true,
    isExtensionActive: () => options?.active ?? true,
  });
  return { registry, pm, executor, toolName: def.name, handlers };
}

describe("packages/plugins: PluginToolExecutor (PR32)", () => {
  it("allow -> executes handler and returns completed ToolResult", async () => {
    const { executor, toolName, pm } = setup();
    const res = await executor.execute(
      toolName,
      { text: "hi" },
      { toolCallId: createToolCallId() },
    );
    expect(res.isError).toBe(false);
    expect(res.result).toEqual({ echoed: { text: "hi" } });
    expect(pm.check).toHaveBeenCalledTimes(1);
    const checkArg = (pm.check as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(checkArg["capability"]).toBe("plugin");
    expect(checkArg["action"]).toBe("call");
  });

  it("deny -> isError ToolResult and handler NOT invoked", async () => {
    const handler = vi.fn(async () => "backend");
    const { executor, toolName, pm } = setup({
      permissionManager: denyManager(),
      handler,
    });
    const res = await executor.execute(toolName, { text: "hi" });
    expect(res.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(pm.check).toHaveBeenCalledTimes(1);
  });

  it("disabled extension -> pluginStatus disabled, NO permission call, NO backend", async () => {
    const handler = vi.fn(async () => "backend");
    const { executor, toolName, pm } = setup({ active: false, handler });
    const res = await executor.execute(toolName, { text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.metadata?.["pluginStatus"]).toBe("disabled");
    expect(pm.check).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("project-disabled -> pluginStatus project-disabled, NO permission call, NO backend", async () => {
    const handler = vi.fn(async () => "backend");
    const { executor, toolName, pm } = setup({ enabledForProject: false, handler });
    const res = await executor.execute(toolName, { text: "hi" }, { projectId: "proj-x" });
    expect(res.isError).toBe(true);
    expect(res.metadata?.["pluginStatus"]).toBe("project-disabled");
    expect(pm.check).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("validation failure -> throws before permission call", async () => {
    const handler = vi.fn(async () => "backend");
    const { executor, toolName, pm } = setup({ handler });
    await expect(executor.execute(toolName, {})).rejects.toThrow(/Missing required parameter/);
    expect(pm.check).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("unknown tool -> isError ToolResult without permission call", async () => {
    const { executor, pm } = setup();
    const res = await executor.execute("plugin:ext-a/ghost", {});
    expect(res.isError).toBe(true);
    expect(pm.check).not.toHaveBeenCalled();
  });

  it("handler timeout -> isError ToolResult", async () => {
    const { executor, toolName } = setup({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "late";
      },
    });
    const res = await executor.execute(toolName, { text: "hi" }, { timeoutMs: 20 });
    expect(res.isError).toBe(true);
    expect(String(res.result)).toMatch(/timed out/);
  });

  it("missing handler -> isError ToolResult after allow", async () => {
    const { executor, toolName, handlers } = setup();
    handlers.delete(toolName);
    const res = await executor.execute(toolName, { text: "hi" });
    expect(res.isError).toBe(true);
    expect(String(res.result)).toMatch(/No handler/);
  });
});
