import { describe, expect, it } from "vitest";
import {
  BACKGROUND_EVENT_TYPES,
  MAX_BACKGROUND_ERROR_LENGTH,
  MAX_BACKGROUND_INPUT_LENGTH,
  MAX_BACKGROUND_QUEUE,
  MAX_BACKGROUND_RESULT_LENGTH,
  MAX_BACKGROUND_TASKS,
  MAX_BACKGROUND_TASKS_PER_PROJECT,
  MAX_BACKGROUND_TITLE_LENGTH,
  STATUS_TRANSITIONS,
  assertNoSecrets,
  backgroundEventType,
  classifyRecovery,
  isLegalBackgroundTransition,
  toBackgroundError,
  BackgroundTaskInputSchema,
  BackgroundTaskProjectionSchema,
  BackgroundTaskRecordSchema,
  BackgroundTaskStatusSchema,
  BackgroundExecutionModeSchema,
  RecoveryDispositionSchema,
} from "./background-tasks.js";
import { createTaskNodeId } from "./identifiers.js";
import { createConversationId, createTaskId } from "@ai-desktop/shared";

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    taskId: createTaskId(),
    conversationId: createConversationId(),
    projectId: "proj-1",
    title: "Backfill embeddings",
    goal: "Rebuild the project search index in the background",
    mode: "background",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
    ...overrides,
  };
}

describe("background-tasks: BackgroundExecutionModeSchema", () => {
  it("accepts foreground and background", () => {
    expect(BackgroundExecutionModeSchema.safeParse("foreground").success).toBe(true);
    expect(BackgroundExecutionModeSchema.safeParse("background").success).toBe(true);
  });

  it("rejects execution.ts modes (sandboxed/host/container)", () => {
    for (const mode of ["sandboxed", "host", "container", ""]) {
      expect(BackgroundExecutionModeSchema.safeParse(mode).success).toBe(false);
    }
  });
});

describe("background-tasks: status transitions", () => {
  it("allows queued -> running", () => {
    expect(isLegalBackgroundTransition("queued", "running")).toBe(true);
  });

  it("allows queued -> cancelled", () => {
    expect(isLegalBackgroundTransition("queued", "cancelled")).toBe(true);
  });

  it("allows the full running fan-out", () => {
    for (const to of [
      "waiting_permission",
      "waiting_input",
      "paused",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      expect(isLegalBackgroundTransition("running", to)).toBe(true);
    }
  });

  it("allows waiting states to resume, pause, or cancel", () => {
    for (const from of ["waiting_permission", "waiting_input"] as const) {
      expect(isLegalBackgroundTransition(from, "running")).toBe(true);
      expect(isLegalBackgroundTransition(from, "paused")).toBe(true);
      expect(isLegalBackgroundTransition(from, "cancelled")).toBe(true);
    }
  });

  it("restores paused via queued, never directly to running", () => {
    expect(isLegalBackgroundTransition("paused", "queued")).toBe(true);
    expect(isLegalBackgroundTransition("paused", "cancelled")).toBe(true);
    expect(isLegalBackgroundTransition("paused", "running")).toBe(false);
  });

  it("allows cancelling -> cancelled or failed only", () => {
    expect(isLegalBackgroundTransition("cancelling", "cancelled")).toBe(true);
    expect(isLegalBackgroundTransition("cancelling", "failed")).toBe(true);
    expect(isLegalBackgroundTransition("cancelling", "running")).toBe(false);
    expect(isLegalBackgroundTransition("cancelling", "queued")).toBe(false);
  });

  it("terminal states fan out to nothing", () => {
    for (const from of ["completed", "failed", "cancelled"] as const) {
      expect(STATUS_TRANSITIONS[from]).toEqual([]);
      for (const to of BackgroundTaskStatusSchema.options) {
        expect(isLegalBackgroundTransition(from, to)).toBe(false);
      }
    }
  });

  it("rejects illegal jumps (queued -> completed, running -> queued)", () => {
    expect(isLegalBackgroundTransition("queued", "completed")).toBe(false);
    expect(isLegalBackgroundTransition("queued", "running")).toBe(true);
    expect(isLegalBackgroundTransition("running", "queued")).toBe(false);
    expect(isLegalBackgroundTransition("waiting_permission", "completed")).toBe(false);
  });

  it("rejects self-transitions", () => {
    for (const status of BackgroundTaskStatusSchema.options) {
      expect(isLegalBackgroundTransition(status, status)).toBe(false);
    }
  });
});

describe("background-tasks: recovery classification", () => {
  it("marks fresh queued/running tasks resumable", () => {
    expect(classifyRecovery({ status: "queued", attempt: 0 }).valueOf()).toBe("resumable");
    expect(classifyRecovery({ status: "running", attempt: 1 }).valueOf()).toBe("resumable");
  });

  it("requires approval for retried queued/running tasks", () => {
    expect(classifyRecovery({ status: "running", attempt: 2 }).valueOf()).toBe("requires_approval");
    expect(classifyRecovery({ status: "queued", attempt: 5 }).valueOf()).toBe("requires_approval");
  });

  it("requires approval for waiting_permission and waiting_input", () => {
    expect(classifyRecovery({ status: "waiting_permission", attempt: 0 }).valueOf()).toBe(
      "requires_approval",
    );
    expect(classifyRecovery({ status: "waiting_input", attempt: 0 }).valueOf()).toBe(
      "requires_approval",
    );
  });

  it("requires approval for cancelling and paused", () => {
    expect(classifyRecovery({ status: "cancelling", attempt: 0 }).valueOf()).toBe(
      "requires_approval",
    );
    expect(classifyRecovery({ status: "paused", attempt: 0 }).valueOf()).toBe("requires_approval");
  });

  it("abandons terminal tasks", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(classifyRecovery({ status, attempt: 0 }).valueOf()).toBe("abandoned");
    }
  });

  it("validates the RecoveryDispositionSchema enum", () => {
    expect(RecoveryDispositionSchema.safeParse("resumable").success).toBe(true);
    expect(RecoveryDispositionSchema.safeParse("requires_approval").success).toBe(true);
    expect(RecoveryDispositionSchema.safeParse("abandoned").success).toBe(true);
    expect(RecoveryDispositionSchema.safeParse("retry").success).toBe(false);
  });
});

describe("background-tasks: secret guard", () => {
  it("passes clean payloads", () => {
    expect(() => assertNoSecrets({ goal: "Rebuild the index", projectId: "p1" })).not.toThrow();
    expect(() => assertNoSecrets("plain background goal text")).not.toThrow();
  });

  it("refuses api_key material with a secret-refused prefix", () => {
    expect(() => assertNoSecrets({ config: "api_key=sk-ant-abc123" })).toThrow(/secret-refused/);
  });

  it("refuses nested tokens, passwords, and authorization headers", () => {
    expect(() => assertNoSecrets({ nested: { deep: { value: "refresh_token=xyz" } } })).toThrow(
      /secret-refused/,
    );
    expect(() => assertNoSecrets("db password=hunter2-secret")).toThrow(/secret-refused/);
    expect(() => assertNoSecrets("Authorization: Bearer abc.def.ghi")).toThrow(/secret-refused/);
  });

  it("matches oauth, credential, and secret variants", () => {
    expect(() => assertNoSecrets("oauth refresh flow")).toThrow(/secret-refused/);
    expect(() => assertNoSecrets({ k: "credential blob" })).toThrow(/secret-refused/);
    expect(() => assertNoSecrets("my-secret-value")).toThrow(/secret-refused/);
  });

  it("never echoes the offending value in the error message", () => {
    const sensitive = "api_key=SUPER-SENSITIVE-VALUE-12345";
    try {
      assertNoSecrets(sensitive);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPER-SENSITIVE-VALUE-12345");
    }
  });
});

describe("background-tasks: error helper", () => {
  it("returns the {code, message} shape", () => {
    expect(toBackgroundError("not-found", "missing")).toEqual({
      code: "not-found",
      message: "missing",
    });
    expect(toBackgroundError("queue-full", "queue is full").code).toBe("queue-full");
  });

  it("rejects unknown codes", () => {
    expect(() => toBackgroundError("nope" as never, "bad")).toThrow();
  });
});

describe("background-tasks: record schema", () => {
  it("accepts a minimal valid record with attempt default", () => {
    const parsed = BackgroundTaskRecordSchema.parse(makeRecord());
    expect(parsed.attempt).toBe(0);
    expect(parsed.mode).toBe("background");
  });

  it("accepts optional lifecycle fields", () => {
    const ts = new Date().toISOString();
    const parsed = BackgroundTaskRecordSchema.parse(
      makeRecord({
        status: "completed",
        startedAt: ts,
        completedAt: ts,
        attempt: 2,
        lastError: "boom",
        resultSummary: "done",
        nodeCount: 3,
      }),
    );
    expect(parsed.completedAt).toBe(ts);
    expect(parsed.nodeCount).toBe(3);
  });

  it("rejects missing projectId and empty/overlong titles", () => {
    expect(() => BackgroundTaskRecordSchema.parse(makeRecord({ projectId: "" }))).toThrow();
    expect(() => BackgroundTaskRecordSchema.parse(makeRecord({ title: "" }))).toThrow();
    expect(() =>
      BackgroundTaskRecordSchema.parse(makeRecord({ title: "t".repeat(121) })),
    ).toThrow();
  });

  it("enforces boundary lengths on goal, lastError, and resultSummary", () => {
    expect(() =>
      BackgroundTaskRecordSchema.parse(makeRecord({ goal: "g".repeat(4001) })),
    ).toThrow();
    expect(() =>
      BackgroundTaskRecordSchema.parse(makeRecord({ lastError: "e".repeat(2001) })),
    ).toThrow();
    expect(() =>
      BackgroundTaskRecordSchema.parse(makeRecord({ resultSummary: "r".repeat(8001) })),
    ).toThrow();
    expect(
      BackgroundTaskRecordSchema.safeParse(makeRecord({ resultSummary: "r".repeat(8000) })).success,
    ).toBe(true);
  });

  it("rejects negative attempts, node counts, and non-positive schema versions", () => {
    expect(() => BackgroundTaskRecordSchema.parse(makeRecord({ attempt: -1 }))).toThrow();
    expect(() => BackgroundTaskRecordSchema.parse(makeRecord({ nodeCount: -1 }))).toThrow();
    expect(() => BackgroundTaskRecordSchema.parse(makeRecord({ schemaVersion: 0 }))).toThrow();
  });

  it("rejects non-background modes", () => {
    expect(() => BackgroundTaskRecordSchema.parse(makeRecord({ mode: "foreground" }))).toThrow();
  });
});

describe("background-tasks: input schema", () => {
  it("accepts a minimal start input", () => {
    const parsed = BackgroundTaskInputSchema.parse({ projectId: "p1", goal: "do things" });
    expect(parsed.projectId).toBe("p1");
  });

  it("accepts all optional start fields", () => {
    const parsed = BackgroundTaskInputSchema.parse({
      projectId: "p1",
      title: "Nightly job",
      goal: "do things",
      conversationId: createConversationId(),
      modelId: "claude-4",
      systemPrompt: "Be helpful",
      maxNodeIterations: 12,
    });
    expect(parsed.maxNodeIterations).toBe(12);
  });

  it("rejects out-of-range maxNodeIterations and overlong prompts", () => {
    expect(() =>
      BackgroundTaskInputSchema.parse({ projectId: "p1", goal: "g", maxNodeIterations: 0 }),
    ).toThrow();
    expect(() =>
      BackgroundTaskInputSchema.parse({ projectId: "p1", goal: "g", maxNodeIterations: 51 }),
    ).toThrow();
    expect(() =>
      BackgroundTaskInputSchema.parse({
        projectId: "p1",
        goal: "g",
        systemPrompt: "s".repeat(8001),
      }),
    ).toThrow();
  });
});

describe("background-tasks: projection schema", () => {
  it("accepts a renderer-safe projection with a current node", () => {
    const ts = new Date().toISOString();
    const parsed = BackgroundTaskProjectionSchema.parse({
      taskId: createTaskId(),
      projectId: "p1",
      title: "Nightly job",
      status: "running",
      mode: "background",
      createdAt: ts,
      updatedAt: ts,
      attempt: 1,
      currentNode: { id: createTaskNodeId(), goal: "index files", status: "running" },
    });
    expect(parsed.currentNode?.status).toBe("running");
  });

  it("rejects unknown statuses and overlong titles", () => {
    const ts = new Date().toISOString();
    const base = {
      taskId: createTaskId(),
      projectId: "p1",
      title: "ok",
      status: "running",
      mode: "background",
      createdAt: ts,
      updatedAt: ts,
    };
    expect(BackgroundTaskProjectionSchema.safeParse({ ...base, status: "active" }).success).toBe(
      false,
    );
    expect(
      BackgroundTaskProjectionSchema.safeParse({ ...base, title: "t".repeat(121) }).success,
    ).toBe(false);
  });
});

describe("background-tasks: event allowlist", () => {
  it("builds task.background.* names for allowlisted types", () => {
    expect(backgroundEventType("started")).toBe("task.background.started");
    expect(backgroundEventType("recovered")).toBe("task.background.recovered");
    expect(BACKGROUND_EVENT_TYPES).toHaveLength(10);
  });

  it("rejects non-allowlisted types", () => {
    expect(() => backgroundEventType("progress")).toThrow();
    expect(() => backgroundEventType("")).toThrow();
  });
});

describe("background-tasks: constants sanity", () => {
  it("keeps concurrency caps ordered global > per-project", () => {
    expect(MAX_BACKGROUND_TASKS).toBe(4);
    expect(MAX_BACKGROUND_TASKS_PER_PROJECT).toBe(2);
    expect(MAX_BACKGROUND_QUEUE).toBe(16);
    expect(MAX_BACKGROUND_QUEUE).toBeGreaterThan(MAX_BACKGROUND_TASKS);
    expect(MAX_BACKGROUND_TASKS).toBeGreaterThan(MAX_BACKGROUND_TASKS_PER_PROJECT);
  });

  it("keeps text bounds consistent with neighbour contracts", () => {
    expect(MAX_BACKGROUND_TITLE_LENGTH).toBe(120);
    expect(MAX_BACKGROUND_INPUT_LENGTH).toBe(2000);
    expect(MAX_BACKGROUND_ERROR_LENGTH).toBe(2000);
    expect(MAX_BACKGROUND_RESULT_LENGTH).toBe(8000);
    expect(MAX_BACKGROUND_RESULT_LENGTH).toBeGreaterThan(MAX_BACKGROUND_ERROR_LENGTH);
  });
});
