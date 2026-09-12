import { describe, expect, it } from "vitest";
import { createExecutionId, type ExecutionRequest } from "@ai-desktop/ai-core";
import { now, ValidationError } from "@ai-desktop/shared";
import { LocalProcessSandboxProvider } from "../local/local-sandbox-provider.js";
import { MAX_EXECUTION_OUTPUT_BYTES } from "../docker/docker-provider.js";

describe("packages/execution: LocalProcessSandboxProvider Lifecycle & Containment (PR27.10, PR27.11, PR27.12)", () => {
  const provider = new LocalProcessSandboxProvider();

  it("executes command and captures stdout and exit code cleanly", async () => {
    const session = await provider.createSession({
      workspacePath: process.cwd(),
      readOnlyWorkspace: true,
    });

    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "node",
      args: ["-e", 'console.log("Execution output test");'],
      timestamp: now(),
    };

    const res = await provider.execute(session, request);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Execution output test");
    expect(res.timedOut).toBe(false);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr independently without merging into stdout", async () => {
    const session = await provider.createSession({
      workspacePath: process.cwd(),
    });

    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "node",
      args: ["-e", 'console.error("Error to stderr"); console.log("Normal to stdout");'],
      timestamp: now(),
    };

    const res = await provider.execute(session, request);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Normal to stdout");
    expect(res.stderr).toContain("Error to stderr");
    // Streams remain separate!
    expect(res.stdout).not.toContain("Error to stderr");
  });

  it("terminates process on hard wall-clock timeout and records timedOut: true (§PR27.11)", async () => {
    const session = await provider.createSession({
      workspacePath: process.cwd(),
    });

    // Active long-running child process
    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000);"],
      timestamp: now(),
      resourceLimits: {
        timeoutMs: 150, // 150ms timeout
        networkAllowed: false,
      },
    };

    const res = await provider.execute(session, request);

    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(-1);
  });

  it("cancels execution promptly via AbortSignal (§PR27.11)", async () => {
    const session = await provider.createSession({
      workspacePath: process.cwd(),
    });

    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "node",
      args: ["-e", "setTimeout(() => console.log('Done'), 5000);"],
      timestamp: now(),
      resourceLimits: {
        timeoutMs: 10000,
        networkAllowed: false,
      },
    };

    const abortController = new AbortController();
    setTimeout(() => {
      abortController.abort("User cancelled execution");
    }, 50);

    const res = await provider.execute(session, request, abortController.signal);

    expect(res.exitCode).toBe(130);
    expect(res.timedOut).toBe(false);
  });

  it("enforces global 256 KB result ceiling with explicit truncation marker (§PR27.12)", async () => {
    const session = await provider.createSession({
      workspacePath: process.cwd(),
    });

    // Output generating 300 KB of text
    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "node",
      args: ["-e", 'process.stdout.write("Z".repeat(300 * 1024));'],
      timestamp: now(),
    };

    const res = await provider.execute(session, request);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("[Output exceeded 256KB ceiling; truncated to 262,144 bytes]");
    expect(Buffer.byteLength(res.stdout, "utf8")).toBeLessThanOrEqual(
      MAX_EXECUTION_OUTPUT_BYTES + 200,
    );
  });

  it("SECURITY: environment allowlisting passes only approved variables", async () => {
    const session = await provider.createSession({
      workspacePath: process.cwd(),
      environment: { APPROVED_CONFIG: "allowed_val" },
    });

    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "node",
      args: [
        "-e",
        "console.log(JSON.stringify({ approved: process.env.APPROVED_CONFIG, extra: process.env.EXTRA_KEY, leakedHost: process.env.LEAKED_HOST_VAR }));",
      ],
      environmentVariables: { EXTRA_KEY: "extra_val" },
      timestamp: now(),
    };

    // Set a dummy host variable in parent process
    process.env.LEAKED_HOST_VAR = "secret_host_value";

    const res = await provider.execute(session, request);
    const parsed = JSON.parse(res.stdout);

    expect(parsed.approved).toBe("allowed_val");
    expect(parsed.extra).toBe("extra_val");
    // Host environment variables not in allowlist must NOT be leaked into sandbox!
    expect(parsed.leakedHost).toBeUndefined();

    delete process.env.LEAKED_HOST_VAR;
  });

  it("SECURITY: rejects forbidden mount targets", async () => {
    await expect(
      provider.createSession({
        workspacePath: "/etc",
      }),
    ).rejects.toThrow(ValidationError);
  });
});
