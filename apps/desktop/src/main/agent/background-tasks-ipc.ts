// PR43: apps/desktop — Background Task IPC Handlers (thin typed delegation)
//
// Exactly 7 typed channels (list/get/start/pause/resume/cancel/respond) over
// DesktopBackgroundTaskService. Zod schemas in @ai-desktop/shared validate in
// main before any handler runs; errors serialize as safe {code,message}
// envelopes via IpcRegistry (service errors already carry a "CODE: message"
// prefix, never stacks or secrets).
//
// There is intentionally NO background-tasks:execute channel — execution flows
// through the agent tool router (existing AgentService path with
// PermissionManager mediation), never through IPC. The renderer receives
// normalized projections only.

import {
  IPC_CHANNELS,
  BackgroundTasksCancelCommandSchema,
  BackgroundTasksGetCommandSchema,
  BackgroundTasksListCommandSchema,
  BackgroundTasksPauseCommandSchema,
  BackgroundTasksRespondCommandSchema,
  BackgroundTasksResumeCommandSchema,
  BackgroundTasksStartCommandSchema,
} from "@ai-desktop/shared";
import type { IpcRegistry } from "../ipc/index.js";
import type { DesktopBackgroundTaskService } from "./background-task-service.js";

export interface BackgroundTasksIpcDependencies {
  readonly backgroundTaskService: DesktopBackgroundTaskService;
}

/**
 * Registers the 7 background-task commands on the registry. Fails closed when
 * the service is absent. No Electron WebContents state is consulted.
 */
export function registerBackgroundTaskHandlers(
  registry: IpcRegistry,
  deps: BackgroundTasksIpcDependencies,
): void {
  if (!deps.backgroundTaskService) {
    throw new Error("BackgroundTaskService is not available");
  }
  const service = deps.backgroundTaskService;

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_LIST,
    BackgroundTasksListCommandSchema,
    async (input) => {
      const tasks = await service.list(input.projectId);
      return { tasks };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_GET,
    BackgroundTasksGetCommandSchema,
    async (input) => {
      const task = await service.get(input.taskId, input.projectId);
      return { task };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_START,
    BackgroundTasksStartCommandSchema,
    async (input) => {
      const task = await service.start({
        projectId: input.projectId,
        goal: input.goal,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.maxNodeIterations !== undefined
          ? { maxNodeIterations: input.maxNodeIterations }
          : {}),
      });
      return { task };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_PAUSE,
    BackgroundTasksPauseCommandSchema,
    async (input) => {
      const task = await service.pause(input.taskId, input.projectId);
      return { task };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_RESUME,
    BackgroundTasksResumeCommandSchema,
    async (input) => {
      const task = await service.resume(input.taskId, input.projectId);
      return { task };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_CANCEL,
    BackgroundTasksCancelCommandSchema,
    async (input) => {
      const outcome = await service.cancel(
        input.taskId,
        input.projectId,
        input.reason ?? undefined,
      );
      return { task: outcome.task, cancelled: outcome.cancelled };
    },
  );

  registry.registerCommand(
    IPC_CHANNELS.BACKGROUND_TASKS_RESPOND,
    BackgroundTasksRespondCommandSchema,
    async (input) => {
      const task = await service.respond(input.taskId, input.projectId, input.input);
      return { task };
    },
  );
}
