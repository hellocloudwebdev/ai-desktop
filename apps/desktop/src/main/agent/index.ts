// PR29.16: apps/desktop — Agent Service Barrel

export { AgentService } from "./agent-service.js";
export {
  DesktopModelInvoker,
  DesktopToolRouter,
  DesktopMemoryProvider,
  DesktopPermissionGateway,
  DesktopEventSink,
} from "./agent-service.js";
export type {
  AgentServiceDeps,
  DesktopModelAdapterDeps,
  DesktopToolRouterDeps,
  DesktopMemoryProviderDeps,
  DesktopPermissionGatewayDeps,
  DesktopEventSinkDeps,
} from "./agent-service.js";
export {
  CodingToolExecutor,
  buildCodingToolDefinition,
  buildAllCodingToolDefinitions,
  computeCodingToolHash,
  codingResourceFor,
} from "./coding-tools.js";
export type { CodingToolExecutorDeps, ExecuteCodingToolOptions } from "./coding-tools.js";
export { CodingAgentService, CODING_AGENT_SYSTEM_PROMPT } from "./coding-agent-service.js";
export type {
  CodingAgentServiceDeps,
  StartCodingTaskInput,
  CodingTaskOutcome,
} from "./coding-agent-service.js";
export {
  DesktopBackgroundTaskService,
  BackgroundTaskServiceError,
} from "./background-task-service.js";
export type {
  BackgroundAgentDelegate,
  BackgroundEventTransport,
  BackgroundTaskProjection,
  BackgroundTaskRecoverySummary,
  BackgroundTaskStore,
  DesktopBackgroundTaskServiceDeps,
  StartBackgroundTaskInput,
} from "./background-task-service.js";
export { registerBackgroundTaskHandlers } from "./background-tasks-ipc.js";
export type { BackgroundTasksIpcDependencies } from "./background-tasks-ipc.js";
export {
  DesktopSchedulerService,
  SchedulerServiceError,
  computeScheduleNextRun,
  MAX_SCHEDULES_TOTAL,
  MAX_CONCURRENT_SCHEDULE_RUNS,
  MIN_SCHEDULE_INTERVAL_MS,
  MAX_SCHEDULE_CATCH_UP,
  MAX_SCHEDULE_RUN_HISTORY,
  DEFAULT_SCHEDULER_TICK_MS,
  SCHEDULE_SCHEMA_VERSION,
} from "./scheduler-service.js";
export type {
  ScheduleKind,
  ScheduleSpec,
  ScheduleSpecInput,
  ScheduleOnceConfig,
  ScheduleDelayConfig,
  ScheduleIntervalConfig,
  ScheduleDailyConfig,
  ScheduleWeeklyConfig,
  ScheduleMissedPolicy,
  ScheduleOverlapPolicy,
  ScheduleRunTrigger,
  ScheduleRunStatus,
  SchedulerBackgroundDelegate,
  ScheduleStore,
  ScheduleRunStore,
  ScheduleRunPatch,
  SchedulerEventTransport,
  DesktopSchedulerServiceDeps,
  CreateScheduleInput,
  UpdateScheduleInput,
  ScheduleProjection,
  ScheduledRunProjection,
  SchedulerRecoverySummary,
} from "./scheduler-service.js";
export { registerScheduleHandlers } from "./schedules-ipc.js";
export type { SchedulesIpcDependencies } from "./schedules-ipc.js";
