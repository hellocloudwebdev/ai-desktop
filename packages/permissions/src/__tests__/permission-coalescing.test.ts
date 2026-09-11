import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import type { PermissionCheck } from "@ai-desktop/ai-core";
import { DefaultPermissionManager } from "../core/default-permission-manager.js";

describe("packages/permissions: Permission Coalescing & Race Conditions (PR24.12)", () => {
  it("coalesces multiple same-batch requests into a single PermissionRequest with all relatedToolCallIds", async () => {
    const manager = new DefaultPermissionManager();
    const batchId = "batch-xyz";

    const toolCall1 = createToolCallId();
    const toolCall2 = createToolCallId();
    const toolCall3 = createToolCallId();

    const check1: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src/a.ts",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolCall1],
    };

    const check2: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src/a.ts",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolCall2],
    };

    const check3: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src/a.ts",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolCall3],
    };

    const res1 = await manager.check(check1, { batchId });
    const res2 = await manager.check(check2, { batchId });
    const res3 = await manager.check(check3, { batchId });

    expect(res1.kind).toBe("requires_user");
    expect(res2.kind).toBe("requires_user");
    expect(res3.kind).toBe("requires_user");

    if (
      res1.kind === "requires_user" &&
      res2.kind === "requires_user" &&
      res3.kind === "requires_user"
    ) {
      // Must be the EXACT same PermissionRequest ID
      expect(res2.request.id).toBe(res1.request.id);
      expect(res3.request.id).toBe(res1.request.id);

      // Must have coalesced all three tool call IDs
      expect(res3.request.relatedToolCallIds).toContain(toolCall1);
      expect(res3.request.relatedToolCallIds).toContain(toolCall2);
      expect(res3.request.relatedToolCallIds).toContain(toolCall3);
    }
  });

  it("single approval of coalesced request authorizes all related tool calls", async () => {
    const manager = new DefaultPermissionManager();
    const batchId = "batch-123";

    const toolCallA = createToolCallId();
    const toolCallB = createToolCallId();

    const checkA: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "github/get_user",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolCallA],
    };

    const checkB: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "github/get_user",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolCallB],
    };

    const resA = await manager.check(checkA, { batchId });
    const resB = await manager.check(checkB, { batchId });

    expect(resA.kind).toBe("requires_user");
    expect(resB.kind).toBe("requires_user");
    if (resA.kind !== "requires_user") return;

    // User approves the single coalesced request
    await manager.resolve({
      requestId: resA.request.id,
      decision: "granted",
      mode: "allow_once",
    });

    // Both calls are authorized
    expect((await manager.check(checkA)).kind).toBe("allow");
    expect((await manager.check(checkB)).kind).toBe("allow");

    // But an unrelated future call is NOT authorized
    const unrelatedCheck: PermissionCheck = {
      ...checkA,
      relatedToolCallIds: [createToolCallId()],
    };
    expect((await manager.check(unrelatedCheck)).kind).toBe("requires_user");
  });

  it("duplicate resolution calls are safe and idempotent", async () => {
    const manager = new DefaultPermissionManager();

    const check: PermissionCheck = {
      capability: "filesystem",
      action: "write",
      resource: "/workspace/build.log",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    const res = await manager.check(check);
    expect(res.kind).toBe("requires_user");
    if (res.kind !== "requires_user") return;

    // First resolve succeeds
    const firstResolve = await manager.resolve({
      requestId: res.request.id,
      decision: "granted",
      mode: "allow_once",
    });
    expect(firstResolve).toBe(true);

    // Second duplicate resolve is safe and returns false (idempotent)
    const secondResolve = await manager.resolve({
      requestId: res.request.id,
      decision: "granted",
      mode: "allow_once",
    });
    expect(secondResolve).toBe(false);
  });
});
