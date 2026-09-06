import { describe, expect, it } from "vitest";
import { AllowAllPermissionManager } from "../allow-all/allow-all-permission-manager.js";
import type { PermissionManager } from "../core/permission-manager.js";
import { createToolCallId, ValidationError } from "@ai-desktop/shared";
import type { PermissionCheck } from "@ai-desktop/ai-core";

describe("AllowAllPermissionManager: Permission Checkpoint Tests", () => {
  const validRequest: PermissionCheck = {
    capability: "file_system:read",
    action: "read",
    resource: "package.json",
    scope: "session",
    risk: "low",
    relatedToolCallIds: [createToolCallId()],
    reason: "Verifying package configuration",
  };

  it("implements the PermissionManager interface and allows a valid request", async () => {
    const manager: PermissionManager = new AllowAllPermissionManager();

    const decision = await manager.check(validRequest);

    expect(decision).toEqual({ kind: "allow" });
  });

  it("handles multiple sequential requests without internal state leakage", async () => {
    const manager = new AllowAllPermissionManager();

    const requestA: PermissionCheck = {
      capability: "shell:exec",
      action: "exec",
      resource: "/bin/ls",
      scope: "once",
      risk: "high",
      relatedToolCallIds: [createToolCallId()],
    };

    const requestB: PermissionCheck = {
      capability: "network:http",
      action: "fetch",
      resource: "https://api.github.com",
      scope: "project",
      risk: "medium",
      relatedToolCallIds: [createToolCallId()],
    };

    const decisionA = await manager.check(requestA);
    const decisionB = await manager.check(requestB);

    expect(decisionA).toEqual({ kind: "allow" });
    expect(decisionB).toEqual({ kind: "allow" });
  });

  it("is purely deterministic across repeated concurrent invocations", async () => {
    const manager = new AllowAllPermissionManager();

    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => manager.check(validRequest)),
    );

    expect(decisions.every((d) => d.kind === "allow")).toBe(true);
    expect(decisions).toHaveLength(25);
  });

  it("preserves full request shape across all 5 evaluation dimensions", async () => {
    const manager = new AllowAllPermissionManager();

    const fullRequest: PermissionCheck = {
      capability: "database:query",
      action: "select",
      resource: "users",
      scope: "always",
      risk: "critical",
      relatedToolCallIds: [createToolCallId(), createToolCallId()],
      reason: "Running database audit query",
      metadata: { auditLog: true },
    };

    const decision = await manager.check(fullRequest);
    expect(decision).toEqual({ kind: "allow" });
  });

  it("rejects invalid requests with ValidationError at the input boundary", async () => {
    const manager = new AllowAllPermissionManager();

    const emptyCapability = {
      capability: "",
      action: "read",
      resource: "file.txt",
      relatedToolCallIds: [createToolCallId()],
    } as unknown as PermissionCheck;

    await expect(manager.check(emptyCapability)).rejects.toThrow(ValidationError);

    const emptyToolCallIds = {
      capability: "file_system:read",
      action: "read",
      resource: "file.txt",
      relatedToolCallIds: [], // must relate to at least one tool call
    } as unknown as PermissionCheck;

    await expect(manager.check(emptyToolCallIds)).rejects.toThrow(ValidationError);

    const invalidRisk = {
      capability: "file_system:read",
      action: "read",
      resource: "file.txt",
      risk: "super_extreme", // invalid risk level
      relatedToolCallIds: [createToolCallId()],
    } as unknown as PermissionCheck;

    await expect(manager.check(invalidRisk)).rejects.toThrow(ValidationError);
  });
});
