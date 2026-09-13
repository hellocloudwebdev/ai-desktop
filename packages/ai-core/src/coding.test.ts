// PR30.2: packages/ai-core — Coding Contract Tests

import { describe, expect, it } from "vitest";
import {
  CODING_TOOL_IDS,
  codingCapabilityFor,
  codingRiskFor,
  isCodingToolId,
  validateCodingTaskRequest,
} from "./coding.js";

describe("packages/ai-core: Coding contracts (PR30.2)", () => {
  it("accepts a valid project-scoped coding request with explicit workspace", () => {
    const ctx = validateCodingTaskRequest({
      projectId: "proj-A",
      workspaceRoot: "D:/work/sample-project",
      prompt: "Fix the failing test",
    });
    expect(ctx.projectId).toBe("proj-A");
    expect(ctx.workspaceRoot).toBe("D:/work/sample-project");
    expect(ctx.cwd).toBe("D:/work/sample-project");
    expect(ctx.taskId).toBeUndefined();
  });

  it("rejects requests without projectId or workspaceRoot", () => {
    expect(() => validateCodingTaskRequest({ workspaceRoot: "D:/work/x", prompt: "Hi" })).toThrow();
    expect(() => validateCodingTaskRequest({ projectId: "p", prompt: "Hi" })).toThrow();
    expect(() =>
      validateCodingTaskRequest({ projectId: "p", workspaceRoot: "D:/work/x", prompt: "" }),
    ).toThrow();
  });

  it("rejects prompts containing raw credentials", () => {
    expect(() =>
      validateCodingTaskRequest({
        projectId: "p",
        workspaceRoot: "D:/work/x",
        prompt: "Use key sk-ant-abcdefghijklmnopqrstuvwx to deploy",
      }),
    ).toThrow(/credentials/);
  });

  it("maps every coding tool to a capability with the specified risk", () => {
    expect(CODING_TOOL_IDS).toHaveLength(5);
    for (const id of CODING_TOOL_IDS) {
      expect(isCodingToolId(id)).toBe(true);
      const capability = codingCapabilityFor(id);
      expect([
        "filesystem.read",
        "filesystem.list",
        "filesystem.search",
        "filesystem.write",
        "execution.run",
      ]).toContain(capability);
    }
    expect(isCodingToolId("builtin:filesystem.destroy")).toBe(false);
    expect(codingRiskFor("filesystem.read")).toBe("low");
    expect(codingRiskFor("filesystem.list")).toBe("low");
    expect(codingRiskFor("filesystem.search")).toBe("low");
    expect(codingRiskFor("filesystem.write")).toBe("medium");
    expect(codingRiskFor("execution.run")).toBe("high");
  });

  it("keeps ToolSource/ToolRuntime axes separate for coding tools", () => {
    // Filesystem tools: source builtin, runtime in_process (execution is NOT a source).
    // Command execution delegates to ExecutionManager with runtime execution.
    expect(codingCapabilityFor("builtin:filesystem.read")).toBe("filesystem.read");
    expect(codingCapabilityFor("builtin:execution.run")).toBe("execution.run");
  });
});
