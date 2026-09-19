// PR45: apps/desktop — Account IPC Handlers (thin typed delegation)
//
// Exactly 5 typed channels (get/sign-in/sign-out/refresh/device) over
// AccountService. Zod schemas in @ai-desktop/shared validate in main before
// any handler executes; errors serialize as safe {code,message} envelopes via
// IpcRegistry (service errors already carry a "CODE: message" prefix, never
// stacks or secrets).
//
// There is intentionally NO account:execute channel — sign-in carries
// displayName/email identity only; refresh tokens live exclusively in the OS
// SecretStore main-side and never cross IPC. The renderer receives
// normalized projections only (explicit field picks below; tokens, nonces,
// and SecretRefs can never leak through).

import {
  IPC_CHANNELS,
  AccountDeviceCommandSchema,
  AccountGetCommandSchema,
  AccountRefreshCommandSchema,
  AccountSignInCommandSchema,
  AccountSignOutCommandSchema,
} from "@ai-desktop/shared";
import type { IpcRegistry } from "../ipc/index.js";
import type { AccountProjection, AccountService, DeviceProjection } from "./account-service.js";

export interface AccountIpcDependencies {
  readonly accountService: AccountService;
}

/** Renderer-safe account pick: identity + session only, never secrets. */
function toSessionProjection(projection: AccountProjection): {
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly session: AccountProjection["session"];
  readonly deviceId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
} {
  return {
    accountId: projection.accountId,
    displayName: projection.displayName,
    ...(projection.email != null ? { email: projection.email } : {}),
    session: projection.session,
    ...(projection.deviceId != null ? { deviceId: projection.deviceId } : {}),
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
  };
}

/** Renderer-safe device pick: identifiers only, never secrets. */
function toDeviceProjection(projection: DeviceProjection): {
  readonly deviceId: string;
  readonly accountId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly lastSeenAt: string;
} {
  return {
    deviceId: projection.deviceId,
    accountId: projection.accountId,
    deviceName: projection.deviceName,
    platform: projection.platform,
    lastSeenAt: projection.lastSeenAt,
  };
}

/**
 * Registers the 5 account commands on the registry. Fails closed when the
 * service is absent. No Electron WebContents state is consulted.
 */
export function registerAccountHandlers(registry: IpcRegistry, deps: AccountIpcDependencies): void {
  if (!deps.accountService) {
    throw new Error("AccountService is not available");
  }
  const service = deps.accountService;

  registry.registerCommand(IPC_CHANNELS.ACCOUNT_GET, AccountGetCommandSchema, async () => {
    const account = await service.get();
    return { session: account ? toSessionProjection(account) : null };
  });

  registry.registerCommand(
    IPC_CHANNELS.ACCOUNT_SIGN_IN,
    AccountSignInCommandSchema,
    async (input) => {
      const account = await service.signIn({
        displayName: input.displayName,
        ...(input.email !== undefined ? { email: input.email } : {}),
      });
      return { session: toSessionProjection(account) };
    },
  );

  registry.registerCommand(IPC_CHANNELS.ACCOUNT_SIGN_OUT, AccountSignOutCommandSchema, async () => {
    const outcome = await service.signOut();
    return { ok: outcome.signedOut, accountId: outcome.accountId };
  });

  registry.registerCommand(IPC_CHANNELS.ACCOUNT_REFRESH, AccountRefreshCommandSchema, async () => {
    const account = await service.refresh();
    return { session: toSessionProjection(account) };
  });

  registry.registerCommand(IPC_CHANNELS.ACCOUNT_DEVICE, AccountDeviceCommandSchema, async () => {
    const device = await service.device();
    return { device: device ? toDeviceProjection(device) : null };
  });
}
