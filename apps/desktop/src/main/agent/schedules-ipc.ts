// PR44: apps/desktop — Schedule IPC Handlers (thin typed delegation)
//
// Exactly 9 typed channels (list/get/create/update/enable/disable/delete/
// run-now/runs) over DesktopSchedulerService. Zod schemas in
// @ai-desktop/shared validate in main before any handler executes; errors
// serialize as safe {code,message} envelopes via IpcRegistry (service errors
// already carry a "CODE: message" prefix, never stacks or secrets).
//
// There is intentionally NO schedules:execute channel — execution flows
// through the agent tool router (existing background-task path with
// PermissionManager mediation), never through IPC. The renderer receives
// normalized projections only.

import {
  IPC_CHANNELS,
  SchedulesCreateCommandSchema,
  SchedulesDeleteCommandSchema,
  SchedulesDisableCommandSchema,
  SchedulesEnableCommandSchema,
  SchedulesGetCommandSchema,
  SchedulesListCommandSchema,
  SchedulesRunNowCommandSchema,
  SchedulesRunsCommandSchema,
  SchedulesUpdateCommandSchema,
} from "@ai-desktop/shared";
import type { IpcRegistry } from "../ipc/index.js";
import type { DesktopSchedulerService } from "./scheduler-service.js";

export interface SchedulesIpcDependencies {
  readonly schedulerService: DesktopSchedulerService;
}

/**
 * Registers the 9 schedule commands on the registry. Fails closed when the
 * service is absent. No Electron WebContents state is consulted.
 */
export function registerScheduleHandlers(
  registry: IpcRegistry,
  deps: SchedulesIpcDependencies,
): void {
  if (!deps.schedulerService) {
    throw new Error("SchedulerService is not available");
  }
  const service = deps.schedulerService;

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_LIST,
    SchedulesListCommandSchema,
    async (input) => {
      const schedules = await service.list(input.projectId);
      return { schedules };
    },
  );

  registry.registerCommand(IPC_CHANNELS.SCHEDULES_GET, SchedulesGetCommandSchema, async (input) => {
    const schedule = await service.get(input.scheduleId, input.projectId);
    return { schedule };
  });

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_CREATE,
    SchedulesCreateCommandSchema,
    async (input) => {
      const schedule = await service.create({
        projectId: input.projectId,
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.missedPolicy !== undefined ? { missedPolicy: input.missedPolicy } : {}),
        ...(input.overlapPolicy !== undefined ? { overlapPolicy: input.overlapPolicy } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      return { schedule };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_UPDATE,
    SchedulesUpdateCommandSchema,
    async (input) => {
      const schedule = await service.update(input.scheduleId, input.projectId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.missedPolicy !== undefined ? { missedPolicy: input.missedPolicy } : {}),
        ...(input.overlapPolicy !== undefined ? { overlapPolicy: input.overlapPolicy } : {}),
      });
      return { schedule };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_ENABLE,
    SchedulesEnableCommandSchema,
    async (input) => {
      const schedule = await service.enable(input.scheduleId, input.projectId);
      return { schedule };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_DISABLE,
    SchedulesDisableCommandSchema,
    async (input) => {
      const schedule = await service.disable(input.scheduleId, input.projectId);
      return { schedule };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_DELETE,
    SchedulesDeleteCommandSchema,
    async (input) => {
      const outcome = await service.delete(input.scheduleId, input.projectId);
      return { deleted: outcome.deleted, scheduleId: outcome.scheduleId };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_RUN_NOW,
    SchedulesRunNowCommandSchema,
    async (input) => {
      const outcome = await service.runNow(input.scheduleId, input.projectId);
      return { schedule: outcome.schedule, run: outcome.run };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.SCHEDULES_RUNS,
    SchedulesRunsCommandSchema,
    async (input) => {
      const runs = await service.listRuns(
        input.scheduleId,
        input.projectId,
        input.limit ?? undefined,
      );
      return { runs };
    },
  );
}
