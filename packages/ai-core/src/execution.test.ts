import { describe, expect, it } from "vitest";
import {
  ExecutionRequestSchema,
  ExecutionResultSchema,
  type ExecutionRequest,
  type ExecutionResult,
} from "./execution.js";
import { createExecutionId } from "./identifiers.js";
import { createToolCallId, now } from "@ai-desktop/shared";

describe("ai-core execution: Execution Contracts (Docker-free)", () => {
  it("validates an ExecutionRequest with isolated resource limits", () => {
    const req: ExecutionRequest = {
      id: createExecutionId(),
      relatedToolCallId: createToolCallId(),
      mode: "sandboxed",
      command: "pnpm test",
      args: ["--run"],
      workingDirectory: "/sandbox/repo",
      environmentVariables: { CI: "true" },
      resourceLimits: {
        timeoutMs: 30000,
        memoryLimitMb: 512,
        networkAllowed: false,
      },
      timestamp: now(),
    };

    expect(ExecutionRequestSchema.safeParse(req).success).toBe(true);
  });

  it("validates ExecutionResult with metrics", () => {
    const res: ExecutionResult = {
      executionId: createExecutionId(),
      exitCode: 0,
      stdout: "Tests passed\n",
      stderr: "",
      durationMs: 1250,
      timedOut: false,
      resourceUsage: {
        peakMemoryMb: 120,
        cpuTimeMs: 890,
      },
      timestamp: now(),
    };

    expect(ExecutionResultSchema.safeParse(res).success).toBe(true);
  });

  it("rejects invalid execution modes", () => {
    const req = {
      id: createExecutionId(),
      mode: "docker_daemon", // Forbidden! ai-core is engine-agnostic
      command: "ls",
      args: [],
      timestamp: now(),
    };

    expect(ExecutionRequestSchema.safeParse(req).success).toBe(false);
  });
});
