import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import type { PermissionCheck } from "@ai-desktop/ai-core";
import {
  matchesExecutionCommand,
  matchesFilesystemPath,
  matchesPolicy,
  normalizePath,
  type PermissionPolicy,
} from "../core/permission-policy.js";

describe("packages/permissions: PermissionCore Matching & Security Dimensions", () => {
  it("normalizes paths correctly across Windows and POSIX separators", () => {
    expect(normalizePath("C:\\Users\\Hp\\project\\")).toBe("C:/Users/Hp/project");
    expect(normalizePath("/home/user/repo/")).toBe("/home/user/repo");
    expect(normalizePath("/")).toBe("/");
  });

  it("enforces path-aware filesystem matching without boundary escapes", () => {
    // 1. Enclosed files match
    expect(matchesFilesystemPath("/workspace/src", "/workspace/src/index.ts")).toBe(true);
    expect(matchesFilesystemPath("/workspace/src", "/workspace/src/sub/deep/file.ts")).toBe(true);
    expect(matchesFilesystemPath("/workspace/src", "/workspace/src")).toBe(true);

    // 2. Trailing escape attempts without directory slash do NOT match
    // E.g., /workspace/src-malicious must not match /workspace/src
    expect(matchesFilesystemPath("/workspace/src", "/workspace/src-malicious/file.ts")).toBe(false);

    // 3. Unrelated directories do NOT match
    expect(matchesFilesystemPath("/workspace/src", "/workspace/package.json")).toBe(false);
    expect(matchesFilesystemPath("/workspace/src", "/etc/passwd")).toBe(false);
  });

  it("enforces command-aware execution matching with word boundaries", () => {
    // 1. Command with args matches
    expect(matchesExecutionCommand("npm test", "npm test")).toBe(true);
    expect(matchesExecutionCommand("npm test", "npm test -- --runInBand")).toBe(true);

    // 2. Command prefix collision does NOT match
    // E.g. "npm test-malicious" must not match "npm test"
    expect(matchesExecutionCommand("npm test", "npm test-malicious")).toBe(false);

    // 3. Different command does NOT match
    expect(matchesExecutionCommand("npm test", "rm -rf /")).toBe(false);
    expect(matchesExecutionCommand("git status", "git commit")).toBe(false);
  });

  it("CRITICAL: strictly separates secrets.use from secrets.read", () => {
    const usePolicy: PermissionPolicy = {
      id: "pol-use",
      capability: "secrets.use",
      resourcePattern: "app/provider/anthropic/api-key",
      decision: "allow",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const useCheck: PermissionCheck = {
      capability: "secrets.use",
      action: "use",
      resource: "app/provider/anthropic/api-key",
      scope: "project",
      risk: "high",
      relatedToolCallIds: [createToolCallId()],
    };

    const readCheck: PermissionCheck = {
      capability: "secrets.read", // Asking to read/display the key!
      action: "read",
      resource: "app/provider/anthropic/api-key",
      scope: "project",
      risk: "critical",
      relatedToolCallIds: [createToolCallId()],
    };

    // secrets.use matches use check
    expect(matchesPolicy(usePolicy, useCheck)).toBe(true);

    // secrets.use NEVER grants secrets.read implicitly!
    expect(matchesPolicy(usePolicy, readCheck)).toBe(false);
  });

  it("enforces per-tool isolation for MCP tools", () => {
    const mcpPolicy: PermissionPolicy = {
      id: "pol-mcp",
      capability: "mcp",
      action: "call",
      resourcePattern: "github/get_issue",
      decision: "allow",
      scope: "session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const allowedCheck: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "github/get_issue",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    const unauthorizedCheck: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "github/delete_repo", // Different tool on same server!
      scope: "session",
      risk: "critical",
      relatedToolCallIds: [createToolCallId()],
    };

    expect(matchesPolicy(mcpPolicy, allowedCheck)).toBe(true);
    expect(matchesPolicy(mcpPolicy, unauthorizedCheck)).toBe(false);
  });

  it("rejects expired policies", () => {
    const expiredPolicy: PermissionPolicy = {
      id: "pol-expired",
      capability: "filesystem",
      resourcePattern: "/workspace",
      decision: "allow",
      scope: "session",
      createdAt: Date.now() - 2000,
      updatedAt: Date.now() - 2000,
      expiresAt: Date.now() - 1000, // Expired 1 second ago
    };

    const check: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/file.ts",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    expect(matchesPolicy(expiredPolicy, check)).toBe(false);
  });
});
