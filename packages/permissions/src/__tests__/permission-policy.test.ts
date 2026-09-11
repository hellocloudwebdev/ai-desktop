import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import type { PermissionCheck } from "@ai-desktop/ai-core";
import { PermissionPolicyEvaluator } from "../core/policy-evaluator.js";
import type { PermissionPolicy } from "../core/permission-policy.js";

describe("packages/permissions: PermissionPolicyEvaluator (PR24.3)", () => {
  const evaluator = new PermissionPolicyEvaluator();

  it("returns allow when matching allow policy exists", () => {
    const policy: PermissionPolicy = {
      id: "pol-1",
      capability: "filesystem",
      action: "read",
      resourcePattern: "/workspace",
      decision: "allow",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const check: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src/app.ts",
      scope: "project",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    const outcome = evaluator.evaluate(check, [policy]);
    expect(outcome.kind).toBe("allow");
  });

  it("returns deny when matching deny policy exists", () => {
    const policy: PermissionPolicy = {
      id: "pol-deny",
      capability: "execution",
      action: "execute",
      resourcePattern: "rm -rf",
      decision: "deny",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const check: PermissionCheck = {
      capability: "execution",
      action: "execute",
      resource: "rm -rf /",
      scope: "project",
      risk: "critical",
      relatedToolCallIds: [createToolCallId()],
    };

    const outcome = evaluator.evaluate(check, [policy]);
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.reason).toContain("Operation denied by policy rule");
    }
  });

  it("explicit deny takes absolute precedence over allow policy", () => {
    const allowAllFilesystem: PermissionPolicy = {
      id: "pol-allow-fs",
      capability: "filesystem",
      resourcePattern: "/workspace",
      decision: "allow",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const denyEnvFiles: PermissionPolicy = {
      id: "pol-deny-env",
      capability: "filesystem",
      resourcePattern: "/workspace/.env",
      decision: "deny",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const safeCheck: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src/index.ts",
      scope: "project",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    const sensitiveCheck: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/.env",
      scope: "project",
      risk: "high",
      relatedToolCallIds: [createToolCallId()],
    };

    // Safe file: allowed
    expect(evaluator.evaluate(safeCheck, [allowAllFilesystem, denyEnvFiles]).kind).toBe("allow");

    // Sensitive file: denied due to deny precedence
    expect(evaluator.evaluate(sensitiveCheck, [allowAllFilesystem, denyEnvFiles]).kind).toBe(
      "deny",
    );
  });

  it("returns requires_user when no matching rule exists", () => {
    const check: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "github/create_issue",
      scope: "once",
      risk: "medium",
      relatedToolCallIds: [createToolCallId()],
    };

    const outcome = evaluator.evaluate(check, []);
    expect(outcome.kind).toBe("requires_user");
  });
});
