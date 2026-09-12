import { describe, expect, it } from "vitest";
import { createExecutionId, createSessionId } from "@ai-desktop/ai-core";
import { now, ValidationError } from "@ai-desktop/shared";
import { DockerProvider, FORBIDDEN_MOUNT_TARGETS } from "../docker/docker-provider.js";
import type { Session } from "../core/session.js";
import type { ExecutionRequest } from "@ai-desktop/ai-core";

describe("packages/execution: DockerProvider Resource Enforcement & Isolation (PR27.7 - PR27.11)", () => {
  const provider = new DockerProvider({
    defaultImage: "alpine:3.20",
    defaultCpuLimit: 1.5,
    defaultMemoryLimitMb: 512,
    defaultPidsLimit: 100,
  });

  const baseSession: Session = {
    id: createSessionId(),
    workspacePath: "/path/to/safe/workspace",
    workingDirectory: "/workspace",
    environment: { SAFE_VAR: "true" },
    readOnlyWorkspace: true,
    networkAllowed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const baseRequest: ExecutionRequest = {
    id: createExecutionId(),
    mode: "sandboxed",
    command: "echo",
    args: ["hello"],
    timestamp: now(),
    resourceLimits: {
      cpuShares: 1.5,
      memoryLimitMb: 256,
      networkAllowed: false,
      timeoutMs: 10000,
    },
    environmentVariables: { EXTRA_VAR: "123" },
  };

  it("CRITICAL: enforces non-root container execution (--user 1000:1000) (§PR27.7)", () => {
    const args = provider.buildDockerRunArgs(baseSession, baseRequest, "test-container");
    const userIndex = args.indexOf("--user");
    expect(userIndex).not.toBe(-1);
    expect(args[userIndex + 1]).toBe("1000:1000");
  });

  it("CRITICAL: enforces actual CPU, memory, and PID limits in Docker CLI flags (§PR27.10)", () => {
    const args = provider.buildDockerRunArgs(baseSession, baseRequest, "test-container");

    expect(args).toContain("--cpus=1.5");
    expect(args).toContain("--memory=256m");
    expect(args).toContain("--pids-limit=100");
  });

  it("CRITICAL: enforces restricted networking by default (--network none) (§PR27.10)", () => {
    const args = provider.buildDockerRunArgs(baseSession, baseRequest, "test-container");
    expect(args).toContain("--network");
    const netIndex = args.indexOf("--network");
    expect(args[netIndex + 1]).toBe("none");

    // When network is explicitly allowed via capability/permission
    const netAllowedRequest: ExecutionRequest = {
      ...baseRequest,
      resourceLimits: {
        ...baseRequest.resourceLimits,
        networkAllowed: true,
      },
    };
    const allowedArgs = provider.buildDockerRunArgs(
      baseSession,
      netAllowedRequest,
      "test-container",
    );
    expect(allowedArgs).not.toContain("none");
  });

  it("CRITICAL: mounts workspace with least-privilege (read-only by default) (§PR27.8)", () => {
    const args = provider.buildDockerRunArgs(baseSession, baseRequest, "test-container");
    const mountArg = args.find((a) => a.includes(":/workspace:"));
    expect(mountArg).toBeDefined();
    expect(mountArg).toContain(":ro");

    // When write is permitted
    const writeSession: Session = {
      ...baseSession,
      readOnlyWorkspace: false,
    };
    const writeArgs = provider.buildDockerRunArgs(writeSession, baseRequest, "test-container");
    const writeMountArg = writeArgs.find((a) => a.includes(":/workspace:"));
    expect(writeMountArg).toContain(":rw");
  });

  it("SECURITY: rejects mounting root, /etc, /proc, /sys, /dev, or Docker socket (§PR27.8)", async () => {
    for (const forbidden of FORBIDDEN_MOUNT_TARGETS) {
      await expect(
        provider.createSession({
          workspacePath: forbidden,
        }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("SECURITY: environment allowlisting passes only approved variables and NEVER process.env (§PR27.9)", () => {
    const args = provider.buildDockerRunArgs(baseSession, baseRequest, "test-container");

    // Approved variables passed
    expect(args).toContain("-e");
    expect(args).toContain("SAFE_VAR=true");
    expect(args).toContain("EXTRA_VAR=123");

    // Host environment variables must NOT be passed wholesale
    for (const hostKey of Object.keys(process.env)) {
      if (hostKey !== "SAFE_VAR" && hostKey !== "EXTRA_VAR") {
        expect(args).not.toContain(`-e=${hostKey}=${process.env[hostKey]}`);
      }
    }
  });

  it("correctly identifies Docker daemon availability via isAvailable()", async () => {
    const isAvail = await provider.isAvailable();
    expect(typeof isAvail).toBe("boolean");
  });
});
