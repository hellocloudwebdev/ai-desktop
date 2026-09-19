// PR46: apps/desktop — IPC Security Suite (adversarial, stub-driven)
//
// Covers the main-side dispatch hardening in main/ipc (registry + security
// helpers) without Electron: malformed/oversized/wrong-project/wrong-entity/
// unauthorized/stale/duplicate/sender-mismatch/unexpected-fields/
// secret-leakage, plus unknown-channel/collision/forbidden-channel proofs and
// canonical security.ipc.rejected emission (storage.append + bus.publish).

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { SecurityEventSchema } from "@ai-desktop/ai-core";
import { EventBus } from "@ai-desktop/agent-runtime";
import { IpcRegistry, type IpcSecuritySink } from "../main/ipc/index.js";
import {
  checkProjectIsolation,
  createSecurityIpcRejectedEvent,
  emitSecurityIpcRejected,
  estimatePayloadBytes,
  extractSecurityContext,
  isForbiddenIpcChannel,
  maxPayloadBytesForChannel,
  sanitizeErrorMessage,
  scrubSecurityReason,
  validateIpcSender,
  IpcRequestTracker,
  IPC_MAX_PAYLOAD_BYTES_DEFAULT,
  SECURITY_AUDIT_CONVERSATION_ID,
} from "../main/ipc/security.js";
import { InMemoryEventRepository } from "./test-helpers.js";

const PASS_SCHEMA = {
  safeParse: (data: unknown) => ({ success: true as const, data }),
};

function makeSender(destroyed: boolean): { isDestroyed: () => boolean; once: () => void } {
  return { isDestroyed: () => destroyed, once: () => undefined };
}

function makeEvent(destroyed = false): { sender: ReturnType<typeof makeSender> } {
  return { sender: makeSender(destroyed) };
}

function asInvokeEvent(event: unknown): Parameters<IpcRegistry["invokeCommand"]>[2] {
  return event as Parameters<IpcRegistry["invokeCommand"]>[2];
}

function collectSink(): { reports: Parameters<IpcSecuritySink>[0][]; sink: IpcSecuritySink } {
  const reports: Parameters<IpcSecuritySink>[0][] = [];
  return {
    reports,
    sink: (report) => {
      reports.push(report);
    },
  };
}

describe("ipc-security: channel allowlist contains no execute/eval/spawn", () => {
  it("every canonical IPC channel passes the forbidden-segment guard", () => {
    const offenders = Object.values(IPC_CHANNELS).filter((channel) =>
      isForbiddenIpcChannel(channel),
    );
    expect(offenders).toEqual([]);
  });

  it("the forbidden-segment guard is exact (no retrieval/interval false positives)", () => {
    expect(isForbiddenIpcChannel("agent:execute")).toBe(true);
    expect(isForbiddenIpcChannel("tool:eval")).toBe(true);
    expect(isForbiddenIpcChannel("proc:spawn")).toBe(true);
    expect(isForbiddenIpcChannel("chat:send")).toBe(false);
    expect(isForbiddenIpcChannel("documents:search")).toBe(false);
  });

  it("refuses to register a generic execute channel", () => {
    const registry = new IpcRegistry();
    try {
      expect(() => registry.registerCommand("tool:execute", PASS_SCHEMA, () => ({}))).toThrow(
        /Forbidden IPC channel/,
      );
      expect(() => registry.registerCommand("shell:spawn", PASS_SCHEMA, () => ({}))).toThrow(
        /Forbidden IPC channel/,
      );
    } finally {
      registry.destroy();
    }
  });

  it("still rejects channel collisions", () => {
    const registry = new IpcRegistry();
    try {
      registry.registerCommand("test:collision", PASS_SCHEMA, () => ({}));
      expect(() => registry.registerCommand("test:collision", PASS_SCHEMA, () => ({}))).toThrow(
        /Channel collision/,
      );
    } finally {
      registry.destroy();
    }
  });

  it("unknown channels fail closed and audit", async () => {
    const registry = new IpcRegistry();
    const { reports, sink } = collectSink();
    registry.setSecuritySink(sink);
    try {
      await expect(registry.invokeCommand("nope:missing", {})).rejects.toThrow(
        /No handler registered/,
      );
      expect(reports).toHaveLength(1);
      expect(reports[0].code).toBe("UNKNOWN_CHANNEL");
      expect(reports[0].channel).toBe("nope:missing");
    } finally {
      registry.destroy();
    }
  });
});

describe("ipc-security: malformed input never reaches handlers", () => {
  const failingSchema = {
    safeParse: () => ({
      success: false as const,
      error: { issues: [{ path: ["content"], message: "Required" }] },
    }),
  };

  it("returns VALIDATION_ERROR, skips the handler, and audits", async () => {
    const registry = new IpcRegistry();
    const { reports, sink } = collectSink();
    registry.setSecuritySink(sink);
    const handler = vi.fn().mockReturnValue({});
    try {
      registry.registerCommand("test:malformed", failingSchema, handler);
      const res = await registry.invokeCommand("test:malformed", { nope: true });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_ERROR");
      }
      expect(handler).not.toHaveBeenCalled();
      expect(reports).toHaveLength(1);
      expect(reports[0].code).toBe("VALIDATION_ERROR");
    } finally {
      registry.destroy();
    }
  });

  it("rejects strict-schema unexpected fields", async () => {
    const strictSchema = {
      safeParse: (data: unknown) => {
        if (typeof data !== "object" || data === null) {
          return { success: false as const, error: { issues: [{ path: [], message: "object" }] } };
        }
        const keys = Object.keys(data);
        if (keys.some((key) => key !== "projectId")) {
          return {
            success: false as const,
            error: { issues: [{ path: [], message: "unexpected field" }] },
          };
        }
        return { success: true as const, data };
      },
    };
    const registry = new IpcRegistry();
    try {
      registry.registerCommand("test:strict", strictSchema, (input) => input);
      const bad = await registry.invokeCommand("test:strict", {
        projectId: "p1",
        __proto__: { polluted: true },
        extra: "nope",
      });
      expect(bad.ok).toBe(false);
      const good = await registry.invokeCommand("test:strict", { projectId: "p1" });
      expect(good.ok).toBe(true);
    } finally {
      registry.destroy();
    }
  });
});

describe("ipc-security: oversized payloads rejected before handlers", () => {
  it("rejects envelopes beyond the default 1 MiB cap", async () => {
    const registry = new IpcRegistry();
    const { reports, sink } = collectSink();
    registry.setSecuritySink(sink);
    const handler = vi.fn().mockReturnValue({});
    try {
      registry.registerCommand("test:sized", PASS_SCHEMA, handler);
      const big = { blob: "x".repeat(IPC_MAX_PAYLOAD_BYTES_DEFAULT + 64) };
      expect(estimatePayloadBytes(big)).toBeGreaterThan(IPC_MAX_PAYLOAD_BYTES_DEFAULT);
      const res = await registry.invokeCommand("test:sized", big);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("OVERSIZED_PAYLOAD");
      }
      expect(handler).not.toHaveBeenCalled();
      expect(reports[0].code).toBe("OVERSIZED_PAYLOAD");
    } finally {
      registry.destroy();
    }
  });

  it("binary channels carry higher caps (extends, never duplicates, Zod maxima)", async () => {
    expect(maxPayloadBytesForChannel("chat:send")).toBe(IPC_MAX_PAYLOAD_BYTES_DEFAULT);
    expect(maxPayloadBytesForChannel("documents:ingest")).toBeGreaterThan(
      IPC_MAX_PAYLOAD_BYTES_DEFAULT,
    );
    expect(maxPayloadBytesForChannel("attachments:upload")).toBeGreaterThan(
      IPC_MAX_PAYLOAD_BYTES_DEFAULT,
    );
    const registry = new IpcRegistry();
    try {
      const handler = vi.fn().mockReturnValue({ ok: true });
      registry.registerCommand("documents:ingest", PASS_SCHEMA, handler);
      const twoMb = { blob: "y".repeat(2_000_000) };
      const res = await registry.invokeCommand("documents:ingest", twoMb);
      expect(res.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      registry.destroy();
    }
  });
});

describe("ipc-security: sender validation (spoofed/dying renderers fail closed)", () => {
  it("validateIpcSender rejects missing and destroyed senders", () => {
    expect(validateIpcSender({})).toEqual({ ok: false, reason: "missing sender" });
    expect(validateIpcSender({ sender: null })).toEqual({ ok: false, reason: "missing sender" });
    expect(validateIpcSender({ sender: makeSender(true) })).toEqual({
      ok: false,
      reason: "sender destroyed",
    });
    expect(validateIpcSender({ sender: makeSender(false) })).toEqual({ ok: true });
  });

  it("dispatcher rejects destroyed senders without running handlers", async () => {
    const registry = new IpcRegistry();
    const { reports, sink } = collectSink();
    registry.setSecuritySink(sink);
    const handler = vi.fn().mockReturnValue({});
    try {
      registry.registerCommand("test:sender", PASS_SCHEMA, handler);
      const res = await registry.invokeCommand(
        "test:sender",
        { a: 1 },
        asInvokeEvent(makeEvent(true)),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("SENDER_REJECTED");
      }
      expect(handler).not.toHaveBeenCalled();
      expect(reports[0].code).toBe("SENDER_REJECTED");
    } finally {
      registry.destroy();
    }
  });
});

describe("ipc-security: stale and duplicate requests", () => {
  it("replays of the same requestId are rejected without re-execution", async () => {
    const registry = new IpcRegistry();
    try {
      const handler = vi.fn().mockReturnValue({ done: true });
      registry.registerCommand("test:idempotent", PASS_SCHEMA, handler);
      const first = await registry.invokeCommand("test:idempotent", { requestId: "req-1" });
      expect(first.ok).toBe(true);
      const replay = await registry.invokeCommand("test:idempotent", { requestId: "req-1" });
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.error.code).toBe("DUPLICATE_REQUEST");
      }
      expect(handler).toHaveBeenCalledTimes(1);
      // A distinct requestId on the same channel still executes.
      const second = await registry.invokeCommand("test:idempotent", { requestId: "req-2" });
      expect(second.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      registry.destroy();
    }
  });

  it("stale timestamps are rejected (tracker unit proof)", () => {
    const tracker = new IpcRequestTracker();
    const now = Date.now();
    expect(tracker.check("c", { timestamp: new Date(now - 60_000).toISOString() }, now)).toEqual({
      ok: true,
    });
    const stale = tracker.check("c", { timestamp: new Date(now - 60 * 60_000).toISOString() }, now);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("STALE_REQUEST");
    }
  });

  it("inputs without requestId/timestamp pass through untouched", () => {
    const tracker = new IpcRequestTracker();
    expect(tracker.check("c", { plain: "payload" })).toEqual({ ok: true });
    expect(tracker.check("c", null)).toEqual({ ok: true });
  });
});

describe("ipc-security: project and entity isolation", () => {
  it("rejects control-character projectIds (smuggling markers)", async () => {
    expect(checkProjectIsolation({ projectId: "ok-project" })).toEqual({ ok: true });
    expect(checkProjectIsolation({ projectId: "bad\0project" }).ok).toBe(false);
    const registry = new IpcRegistry();
    try {
      registry.registerCommand("test:project", PASS_SCHEMA, (input) => input);
      const res = await registry.invokeCommand("test:project", { projectId: "bad\0project" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("PROJECT_ISOLATION");
      }
    } finally {
      registry.destroy();
    }
  });

  it("keeps per-project payloads isolated (no cross-talk between calls)", async () => {
    const registry = new IpcRegistry();
    try {
      const seen: unknown[] = [];
      registry.registerCommand("test:scoped", PASS_SCHEMA, (input) => {
        seen.push((input as { projectId?: string }).projectId);
        return { projectId: (input as { projectId?: string }).projectId };
      });
      const a = await registry.invokeCommand("test:scoped", { projectId: "project-a" });
      const b = await registry.invokeCommand("test:scoped", { projectId: "project-b" });
      expect(a.ok && b.ok).toBe(true);
      expect(seen).toEqual(["project-a", "project-b"]);
    } finally {
      registry.destroy();
    }
  });

  it("wrong-entity handlers fail closed with sanitized errors", async () => {
    const registry = new IpcRegistry();
    try {
      registry.registerCommand("test:entity", PASS_SCHEMA, () => {
        throw new Error('Unknown coding task "nope"');
      });
      const res = await registry.invokeCommand("test:entity", { taskId: "nope" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("HANDLER_ERROR");
        expect(res.error.message).toContain("Unknown coding task");
      }
    } finally {
      registry.destroy();
    }
  });
});

describe("ipc-security: safe error serialization (no stacks/secrets/paths)", () => {
  it("sanitizes multi-line stacks, secrets, and absolute paths", () => {
    const err = new Error(
      "boom api_key=sk-live-abcdef123456 at C:\\Users\\op\\secret\\app.js:10:5\n    at hidden (D:\\x\\y.js:1:1)",
    );
    err.stack = "Error: boom\n    at hidden (C:\\Users\\op\\secret\\app.js:10:5)";
    const clean = sanitizeErrorMessage(err);
    expect(clean).not.toContain("\n");
    expect(clean).not.toContain("sk-live-abcdef123456");
    expect(clean).not.toContain("C:\\Users");
    expect(clean.length).toBeLessThanOrEqual(500);
  });

  it("dispatcher never leaks handler stacks/secrets/paths", async () => {
    const registry = new IpcRegistry();
    try {
      registry.registerCommand("test:leak", PASS_SCHEMA, () => {
        throw new Error(
          "token abc eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl at /home/op/secret.key:1",
        );
      });
      const res = await registry.invokeCommand("test:leak", {});
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).not.toContain("/home/op/secret.key");
        expect(res.error.message).not.toContain("\n");
      }
    } finally {
      registry.destroy();
    }
  });

  it("scrubs security reasons to 1..500 chars", () => {
    expect(scrubSecurityReason("  spaced   out  ")).toBe("spaced out");
    expect(scrubSecurityReason("x".repeat(900)).length).toBe(500);
    expect(scrubSecurityReason("")).toBe("ipc rejected");
  });
});

describe("ipc-security: canonical security.ipc.rejected emission", () => {
  it("factory builds a bounded, secret-free, schema-valid event", () => {
    const event = createSecurityIpcRejectedEvent({
      channel: "chat:send",
      reason: "VALIDATION_ERROR: bad input api_key=secret123",
      projectId: "project-a",
      entityType: "message",
      entityId: "m-1",
    });
    expect(event.category).toBe("extension");
    expect(event.type).toBe("security.ipc.rejected");
    const parsed = SecurityEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    expect((event as unknown as { reason: string }).reason).not.toContain("secret123");
    expect(extractSecurityContext({ projectId: "p", messageId: "m" })).toEqual({
      projectId: "p",
      entityType: "message",
      entityId: "m",
    });
  });

  it("emit helper persists before delivery (storage.append then bus.publish)", async () => {
    const storage = new InMemoryEventRepository();
    const bus = new EventBus();
    const order: string[] = [];
    const trackingStorage = {
      append: async (event: never): Promise<void> => {
        order.push("append");
        await storage.append(event as never);
      },
      getByConversation: (conversationId: never): Promise<never[]> =>
        storage.getByConversation(conversationId as never) as Promise<never[]>,
    };
    const trackingBus = {
      publish: async (event: never): Promise<void> => {
        order.push("publish");
        await bus.publish(event as never);
      },
    };
    await emitSecurityIpcRejected(
      { storage: trackingStorage, bus: trackingBus },
      {
        channel: "chat:send",
        reason: "VALIDATION_ERROR: probe",
        conversationId: SECURITY_AUDIT_CONVERSATION_ID,
      },
    );
    expect(order).toEqual(["append", "publish"]);
    const stored = await storage.getByConversation(SECURITY_AUDIT_CONVERSATION_ID as never);
    expect(stored).toHaveLength(1);
    expect(SecurityEventSchema.safeParse(stored[0]).success).toBe(true);
  });

  it("emission is best-effort (storage loss never throws)", async () => {
    const failingStorage = {
      append: async (): Promise<void> => {
        throw new Error("disk gone");
      },
      getByConversation: async (): Promise<never[]> => [],
    };
    const bus = new EventBus();
    await expect(
      emitSecurityIpcRejected(
        {
          storage: failingStorage,
          bus: { publish: async (): Promise<void> => undefined },
        },
        { channel: "x", reason: "y" },
      ),
    ).resolves.toBeUndefined();
    void bus;
  });
});
