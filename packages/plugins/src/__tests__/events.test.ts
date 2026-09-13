import { describe, expect, it } from "vitest";
import { ExtensionCustomEventSchema } from "@ai-desktop/ai-core";
import { buildExtensionCustomEvent, validateExtensionEvent } from "../core/extension-events.js";

describe("packages/plugins: extension events (PR32)", () => {
  it("builds a valid extension.custom event", () => {
    const res = buildExtensionCustomEvent({
      extensionId: "ext-a",
      extensionName: "Ext A",
      eventName: "sync.done",
      payload: { ok: true },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.type).toBe("extension.custom");
    expect(res.value.category).toBe("extension");
    expect(res.value.extensionName).toBe("Ext A");
    // ai-core schema accepts the built event
    expect(ExtensionCustomEventSchema.safeParse(res.value).success).toBe(true);
  });

  it("accepts event names with dots/dashes/underscores", () => {
    const res = buildExtensionCustomEvent({
      extensionId: "ext-a",
      extensionName: "Ext A",
      eventName: "a.b-c_d9",
      payload: null,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects bad event names (uppercase, empty, too long)", () => {
    for (const bad of ["BadName", "", "A", "a".repeat(65), "-lead"]) {
      const res = buildExtensionCustomEvent({
        extensionId: "ext-a",
        extensionName: "Ext A",
        eventName: bad,
        payload: {},
      });
      expect(res.ok, `eventName "${bad}" should fail`).toBe(false);
    }
  });

  it("rejects oversized payloads (>64KB JSON)", () => {
    const res = buildExtensionCustomEvent({
      extensionId: "ext-a",
      extensionName: "Ext A",
      eventName: "big",
      payload: { blob: "x".repeat(70 * 1024) },
    });
    expect(res.ok).toBe(false);
  });

  it("validateExtensionEvent accepts extension.custom and rejects task.completed", () => {
    const good = buildExtensionCustomEvent({
      extensionId: "ext-a",
      extensionName: "Ext A",
      eventName: "ping",
      payload: { n: 1 },
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(validateExtensionEvent(good.value).ok).toBe(true);
    }
    // A forged core/capability event must NOT validate as an extension event.
    const forged = {
      eventId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA",
      conversationId: "01JBBBBBBBBBBBBBBBBBBBBBBBBB",
      sequence: 0,
      schemaVersion: 1,
      timestamp: new Date(0).toISOString(),
      type: "task.completed",
      category: "extension",
    };
    expect(validateExtensionEvent(forged).ok).toBe(false);
  });

  it("FORGERY IMPOSSIBLE: factory hardcodes type/category so task.completed cannot be produced", () => {
    // The factory takes no type/category input — even a hostile caller passing
    // extra fields gets an extension.custom event back.
    const hostile = {
      extensionId: "ext-a",
      extensionName: "Ext A",
      eventName: "pwn",
      payload: {},
      type: "task.completed",
      category: "core",
    } as unknown as Parameters<typeof buildExtensionCustomEvent>[0];
    const res = buildExtensionCustomEvent(hostile);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.type).toBe("extension.custom");
    expect(res.value.category).toBe("extension");
  });
});
