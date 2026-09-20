// PR47: apps/desktop — Secure Update IPC Descriptors
//
// zod-validated update channel descriptors. No direct ipcMain import — main
// registers these descriptors; tests invoke handlers directly. Errors are
// redacted before crossing the boundary.

import { z } from "zod";
import { redactSecrets } from "@ai-desktop/shared";
import { UpdateChannelSchema } from "./update-types.js";
import type { SecureUpdateService } from "./update-service.js";

export const UPDATE_IPC_CHANNELS = {
  CHECK: "updates:check",
  DOWNLOAD: "updates:download",
  INSTALL: "updates:install",
  STATE: "updates:state",
} as const;

export const UpdateCheckRequestSchema = z.object({
  channel: UpdateChannelSchema.optional(),
});

export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;

export const UpdateDownloadRequestSchema = z.object({});

export type UpdateDownloadRequest = z.infer<typeof UpdateDownloadRequestSchema>;

export const UpdateInstallRequestSchema = z.object({});

export type UpdateInstallRequest = z.infer<typeof UpdateInstallRequestSchema>;

export interface UpdateIpcHandlerDescriptor {
  readonly channel: string;
  handler(req: unknown): Promise<Record<string, unknown>>;
}

function toSafeIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactSecrets(raw).split("\n")[0]?.trim() ?? "";
  const capped = redacted.length > 500 ? redacted.slice(0, 500) : redacted;
  return capped.length > 0 ? capped : "update failed";
}

function snapshotPayload(service: SecureUpdateService): Record<string, unknown> {
  const snapshot = service.getSnapshot();
  const payload: Record<string, unknown> = {
    state: snapshot.state,
    recoverable: snapshot.recoverable,
  };
  if (snapshot.error !== null) {
    payload.error = snapshot.error;
  }
  if (snapshot.version !== null) {
    payload.version = snapshot.version;
  }
  return payload;
}

/**
 * Builds invoke-style handler descriptors delegating to the update service.
 * The STATE descriptor reports the current snapshot; STATE is broadcast over
 * webContents.send by main and is not registered as an invoke channel.
 */
export function createUpdateIpcHandlers(
  service: SecureUpdateService,
): UpdateIpcHandlerDescriptor[] {
  return [
    {
      channel: UPDATE_IPC_CHANNELS.CHECK,
      async handler(req: unknown): Promise<Record<string, unknown>> {
        try {
          UpdateCheckRequestSchema.parse(req ?? {});
          const state = await service.checkForUpdates();
          return { ...snapshotPayload(service), state };
        } catch (err) {
          return { state: "failed", error: toSafeIpcError(err), recoverable: true };
        }
      },
    },
    {
      channel: UPDATE_IPC_CHANNELS.DOWNLOAD,
      async handler(req: unknown): Promise<Record<string, unknown>> {
        try {
          UpdateDownloadRequestSchema.parse(req ?? {});
          const filePath = await service.downloadUpdate();
          return { ...snapshotPayload(service), filePath };
        } catch (err) {
          return { ...snapshotPayload(service), state: "failed", error: toSafeIpcError(err) };
        }
      },
    },
    {
      channel: UPDATE_IPC_CHANNELS.INSTALL,
      async handler(req: unknown): Promise<Record<string, unknown>> {
        try {
          UpdateInstallRequestSchema.parse(req ?? {});
          await service.quitAndInstall();
          return snapshotPayload(service);
        } catch (err) {
          return {
            ...snapshotPayload(service),
            state: service.getState(),
            error: toSafeIpcError(err),
          };
        }
      },
    },
    {
      channel: UPDATE_IPC_CHANNELS.STATE,
      async handler(): Promise<Record<string, unknown>> {
        return snapshotPayload(service);
      },
    },
  ];
}
