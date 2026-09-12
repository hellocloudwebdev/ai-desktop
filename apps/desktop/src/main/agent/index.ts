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
