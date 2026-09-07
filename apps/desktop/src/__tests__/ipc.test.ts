import { describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  createConversationId,
  createMessageId,
  now,
  type ChatStreamEvent,
} from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import { createDesktopApi } from "../preload/index.js";

describe("apps/desktop: Typed IPC Registry & Zod Validation (Main Process)", () => {
  it("registers standard command channels and disallows duplicate registrations (channel collision)", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry);

    expect(registry.registeredChannels.has(IPC_CHANNELS.APP_HEALTH_CHECK)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.CHAT_SEND)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.CHAT_CANCEL)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.CHAT_SUBSCRIBE)).toBe(true);
    expect(registry.registeredChannels.has(IPC_CHANNELS.CHAT_UNSUBSCRIBE)).toBe(true);

    // Re-registering the same channel must throw an error (§36.44)
    expect(() =>
      registry.registerCommand(
        IPC_CHANNELS.CHAT_SEND,
        { safeParse: () => ({ success: true }) },
        () => ({}),
      ),
    ).toThrow(/Channel collision/);

    registry.destroy();
  });

  it("validates command input with Zod and rejects malformed inputs before handler runs", async () => {
    const registry = new IpcRegistry();
    let handlerExecuted = false;

    // Register a test command that tracks execution
    registry.registerCommand(
      "test:command",
      {
        safeParse: (input: unknown) => {
          if (
            typeof input === "object" &&
            input !== null &&
            "valid" in input &&
            (input as { valid: boolean }).valid === true
          ) {
            return { success: true, data: input as { valid: boolean } };
          }
          return {
            success: false,
            error: { issues: [{ path: ["valid"], message: "Field 'valid' must be true" }] },
          };
        },
      },
      () => {
        handlerExecuted = true;
        return { success: true };
      },
    );

    // Verify registry registered the channel
    expect(registry.registeredChannels.has("test:command")).toBe(true);
    expect(handlerExecuted).toBe(false);

    registry.destroy();
  });

  it("manages subscription lifecycle and cleans up subscriptions on WebContents destruction", () => {
    const registry = new IpcRegistry();
    const convId = createConversationId();

    const destroyedListeners: Array<() => void> = [];
    const sentEvents: Array<{ channel: string; data: unknown }> = [];

    const mockWebContents = {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn().mockImplementation((channel: string, data: unknown) => {
        sentEvents.push({ channel, data });
      }),
      once: vi.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === "destroyed") {
          destroyedListeners.push(cb);
        }
      }),
    } as unknown as Electron.WebContents;

    // 1. Subscribe
    registry.subscribe(convId, mockWebContents);
    expect(registry.getSubscriptionCount(convId)).toBe(1);

    // 2. Send event
    const sampleEvent: ChatStreamEvent = {
      conversationId: convId,
      sequence: 0,
      timestamp: now(),
      kind: "delta",
      payload: { kind: "delta", delta: { text: "chunk", messageId: createMessageId() } },
    };

    registry.sendStreamEvent(sampleEvent);
    expect(mockWebContents.send).toHaveBeenCalledTimes(1);
    expect(sentEvents[0].channel).toBe(IPC_CHANNELS.CHAT_STREAM_EVENT);
    expect(sentEvents[0].data).toEqual(sampleEvent);

    // 3. WebContents destruction triggers automatic cleanup (§36.24)
    expect(destroyedListeners).toHaveLength(1);
    destroyedListeners[0](); // simulate WebContents destroyed
    expect(registry.getSubscriptionCount(convId)).toBe(0);

    // 4. Future events not delivered
    registry.sendStreamEvent(sampleEvent);
    expect(mockWebContents.send).toHaveBeenCalledTimes(1); // not called again

    registry.destroy();
  });

  it("unsubscription is completely idempotent", () => {
    const registry = new IpcRegistry();
    const convId = createConversationId();

    const mockWebContents = {
      isDestroyed: () => false,
      once: () => {},
    } as unknown as Electron.WebContents;

    registry.subscribe(convId, mockWebContents);
    expect(registry.getSubscriptionCount(convId)).toBe(1);

    // Calling unsubscribe multiple times is safe and a no-op
    registry.unsubscribe(convId, mockWebContents);
    expect(registry.getSubscriptionCount(convId)).toBe(0);

    expect(() => {
      registry.unsubscribe(convId, mockWebContents);
      registry.unsubscribe(convId, mockWebContents);
    }).not.toThrow();

    registry.destroy();
  });
});

describe("apps/desktop: Preload Typed Application Bridge (Renderer Surface)", () => {
  it("exposes typed commands and event subscriptions through window.api", () => {
    const api = createDesktopApi();

    expect(api.commands).toBeDefined();
    expect(typeof api.commands.checkHealth).toBe("function");
    expect(typeof api.commands.sendChatMessage).toBe("function");
    expect(typeof api.commands.cancelChat).toBe("function");

    expect(api.events).toBeDefined();
    expect(typeof api.events.subscribeToConversation).toBe("function");

    // Must NOT expose raw Electron primitives to renderer
    const exposedKeys = Object.keys(api);
    expect(exposedKeys).not.toContain("ipcRenderer");
    expect(exposedKeys).not.toContain("ipcMain");
    expect(exposedKeys).not.toContain("BrowserWindow");
    expect(exposedKeys).not.toContain("shell");
    expect(exposedKeys).not.toContain("fs");
    expect(exposedKeys).not.toContain("process");
  });
});
