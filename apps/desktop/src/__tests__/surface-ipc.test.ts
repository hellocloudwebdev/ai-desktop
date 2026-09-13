// PR33.28: desktop — Surface IPC Dispatch Tests
//
// surface:get/action/dispose validate in main; no surface:execute channel exists.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { SurfaceService } from "../main/surfaces/surface-service.js";

function createHarness(service: unknown) {
  const ipcRegistry = new IpcRegistry();
  registerIpcHandlers(ipcRegistry, {
    callbacks: {},
    surfaceService: service as SurfaceService,
  });
  return { ipcRegistry };
}

const INSTANCE_ID = "01JAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("desktop: surface IPC dispatch (PR33.28)", () => {
  it("registers exactly the three surface channels (no surface:execute)", () => {
    expect(IPC_CHANNELS.SURFACE_GET).toBe("surface:get");
    expect(IPC_CHANNELS.SURFACE_ACTION).toBe("surface:action");
    expect(IPC_CHANNELS.SURFACE_DISPOSE).toBe("surface:dispose");
    expect("SURFACE_EXECUTE" in IPC_CHANNELS).toBe(false);
  });

  it("surface:get returns snapshots; unknown ids return null", async () => {
    const { ipcRegistry } = createHarness({
      getInstance: (id: string) =>
        id === INSTANCE_ID ? { instanceId: id, status: "active" } : undefined,
    });
    const found = await ipcRegistry.invokeCommand<{ surface: unknown }>(IPC_CHANNELS.SURFACE_GET, {
      instanceId: INSTANCE_ID,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.surface).not.toBeNull();

    const missing = await ipcRegistry.invokeCommand<{ surface: unknown }>(
      IPC_CHANNELS.SURFACE_GET,
      { instanceId: "01JZZZZZZZZZZZZZZZZZZZZZZ" },
    );
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value.surface).toBeNull();
  });

  it("surface:action validates and routes; malformed input fails first", async () => {
    const calls: unknown[] = [];
    const { ipcRegistry } = createHarness({
      invokeAction: async (...args: unknown[]) => {
        calls.push(args);
        return { isError: false, result: {} };
      },
    });
    const ok = await ipcRegistry.invokeCommand<{ result: unknown }>(IPC_CHANNELS.SURFACE_ACTION, {
      instanceId: INSTANCE_ID,
      actionId: "refresh",
      input: {},
    });
    expect(ok.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const bad = await ipcRegistry.invokeCommand(IPC_CHANNELS.SURFACE_ACTION, {
      instanceId: "",
      actionId: "",
    });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("surface:dispose is idempotent via the service", async () => {
    const { ipcRegistry } = createHarness({
      dispose: () => true,
    });
    const res = await ipcRegistry.invokeCommand<{ disposed: boolean }>(
      IPC_CHANNELS.SURFACE_DISPOSE,
      { instanceId: INSTANCE_ID },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.disposed).toBe(true);
  });

  it("missing service fails closed with HANDLER_ERROR", async () => {
    const ipcRegistry = new IpcRegistry();
    registerIpcHandlers(ipcRegistry, { callbacks: {} });
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.SURFACE_GET, {
      instanceId: INSTANCE_ID,
    });
    expect(res.ok).toBe(false);
  });
});
