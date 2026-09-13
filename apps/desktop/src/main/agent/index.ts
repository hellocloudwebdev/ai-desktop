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
