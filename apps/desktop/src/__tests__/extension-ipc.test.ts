// PR32: apps/desktop — Extension IPC Dispatch Tests (desktop wiring)
//
// Validates the 8 extension IPC commands: Zod validation rejects bad ids
// (empty extensionId, empty sourceDir, missing projectId on project
// enable/disable), unknown commands surface, and the fallback path throws
// "ExtensionService is not available" when no service is wired.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";

function createRegistry(): IpcRegistry {
  const registry = new IpcRegistry();
  registerIpcHandlers(registry, {});
  return registry;
}

describe("apps/desktop: Extension IPC Dispatch (PR32)", () => {
  it("registers all 8 extension channels with exact names and no execute channel", () => {
    const registry = createRegistry();
    expect(IPC_CHANNELS.EXTENSION_LIST).toBe("extension:list");
    expect(IPC_CHANNELS.EXTENSION_GET).toBe("extension:get");
    expect(IPC_CHANNELS.EXTENSION_INSTALL).toBe("extension:install");
    expect(IPC_CHANNELS.EXTENSION_UNINSTALL).toBe("extension:uninstall");
    expect(IPC_CHANNELS.EXTENSION_ENABLE).toBe("extension:enable");
    expect(IPC_CHANNELS.EXTENSION_DISABLE).toBe("extension:disable");
    expect(IPC_CHANNELS.EXTENSION_PROJECT_ENABLE).toBe("extension:project-enable");
    expect(IPC_CHANNELS.EXTENSION_PROJECT_DISABLE).toBe("extension:project-disable");
    expect(registry.registeredChannels.has("extension:execute")).toBe(false);
    for (const channel of Object.values(IPC_CHANNELS).filter((c) =>
      String(c).startsWith("extension:"),
    )) {
      expect(registry.registeredChannels.has(channel)).toBe(true);
    }
  });

  it("validation: empty extensionId rejected on get/uninstall/enable/disable", async () => {
    const registry = createRegistry();
    for (const channel of [
      IPC_CHANNELS.EXTENSION_GET,
      IPC_CHANNELS.EXTENSION_UNINSTALL,
      IPC_CHANNELS.EXTENSION_ENABLE,
      IPC_CHANNELS.EXTENSION_DISABLE,
    ]) {
      const res = await registry.invokeCommand(channel, { extensionId: "" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_ERROR");
      }
    }
  });

  it("validation: empty sourceDir rejected on install; missing projectId rejected on project enable/disable", async () => {
    const registry = createRegistry();
    const installRes = await registry.invokeCommand(IPC_CHANNELS.EXTENSION_INSTALL, {
      sourceDir: "",
    });
    expect(installRes.ok).toBe(false);
    if (!installRes.ok) {
      expect(installRes.error.code).toBe("VALIDATION_ERROR");
    }

    const projectEnableRes = await registry.invokeCommand(IPC_CHANNELS.EXTENSION_PROJECT_ENABLE, {
      extensionId: "test-extension",
    });
    expect(projectEnableRes.ok).toBe(false);
    if (!projectEnableRes.ok) {
      expect(projectEnableRes.error.code).toBe("VALIDATION_ERROR");
    }

    const projectDisableRes = await registry.invokeCommand(IPC_CHANNELS.EXTENSION_PROJECT_DISABLE, {
      extensionId: "test-extension",
      projectId: "",
    });
    expect(projectDisableRes.ok).toBe(false);
    if (!projectDisableRes.ok) {
      expect(projectDisableRes.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("list accepts empty/omitted payload; unknown command surfaces", async () => {
    const registry = createRegistry();
    const listRes = await registry.invokeCommand<{ extensions: unknown[] }>(
      IPC_CHANNELS.EXTENSION_LIST,
      {},
    );
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.value.extensions).toEqual([]);
    }

    await expect(registry.invokeCommand("extension:execute", {})).rejects.toThrow(
      'No handler registered for channel "extension:execute"',
    );
  });

  it("fallback without a service: install/enable surface the unavailable error", async () => {
    const registry = createRegistry();
    const installRes = await registry.invokeCommand(IPC_CHANNELS.EXTENSION_INSTALL, {
      sourceDir: "D:/some/dir",
    });
    expect(installRes.ok).toBe(false);
    if (!installRes.ok) {
      expect(installRes.error.code).toBe("HANDLER_ERROR");
      expect(installRes.error.message).toContain("ExtensionService is not available");
    }

    const enableRes = await registry.invokeCommand(IPC_CHANNELS.EXTENSION_ENABLE, {
      extensionId: "test-extension",
    });
    expect(enableRes.ok).toBe(false);
    if (!enableRes.ok) {
      expect(enableRes.error.message).toContain("ExtensionService is not available");
    }
  });
});
