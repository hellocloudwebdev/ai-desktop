// PR33.9: main — Surface Service (permission-gated surface lifecycle)
//
// Invariants:
//   1. The service never renders and never executes tool backends directly:
//      creation is permission-gated, actions route through the injected
//      ToolExecutor-like router (universal lifecycle preserved).
//   2. ToolResult-stamped descriptors are never trusted: the REGISTERED
//      binding definition is authoritative; hash mismatch means forgery.
//   3. Declaration never equals grant: surface.render and surface.interact go
//      through PermissionManager like any other capability.
//   4. Plugin surfaces additionally require the extension to be active and
//      project-enabled via the injected extension gate.

import {
  extractSurfaceDescriptor,
  validateSurfaceAction,
  validateSurfaceDescriptor,
  RENDERABLE_KINDS,
  MAX_SURFACE_ACTIONS,
  MAX_SURFACE_COLUMNS,
  MAX_SURFACE_DATA_BYTES,
  MAX_SURFACE_DESCRIPTOR_BYTES,
  MAX_SURFACE_FIELDS,
  MAX_SURFACE_ROWS,
  MAX_SURFACES_PER_TASK,
  type RichSurfaceDescriptor,
  type SurfaceAction,
  type SurfaceInstance,
  type SurfaceInstanceId,
  type SurfaceKind,
  type ToolResult,
} from "@ai-desktop/ai-core";
import { createToolCallId, now, ValidationError, type ToolCallId } from "@ai-desktop/shared";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { ConversationId } from "@ai-desktop/ai-core";

/** Minimal invoker shape: routes through the universal ToolInvoker lifecycle. */
export interface SurfaceToolInvoker {
  invoke(
    toolName: string,
    input: unknown,
    context: { toolCallId: ToolCallId; projectId?: string; conversationId?: unknown },
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}
import { SurfaceRegistry, getSurfaceDefinitionHash } from "./surface-registry.js";

export interface SurfaceSecurityPolicy {
  readonly allowedKinds?: readonly SurfaceKind[];
  readonly maxDataBytes?: number;
  readonly maxInstancesPerTask?: number;
}

export interface ExtensionSurfaceGate {
  isActive(extensionId: string): boolean | Promise<boolean>;
  isEnabledForProject(extensionId: string, projectId: string): boolean | Promise<boolean>;
}

export interface SurfaceServiceDeps {
  readonly permissionManager: PermissionManager;
  readonly toolRouter: SurfaceToolInvoker;
  readonly extensionGate?: ExtensionSurfaceGate;
  readonly registry?: SurfaceRegistry;
  readonly policy?: SurfaceSecurityPolicy;
}

interface ToolBinding {
  readonly descriptor: RichSurfaceDescriptor;
  readonly hash: string;
  readonly actions: SurfaceAction[];
}

function validateActionInput(
  inputSchema: Record<string, unknown> | undefined,
  input: unknown,
): void {
  const required = (inputSchema as { required?: unknown } | undefined)?.required;
  if (Array.isArray(required) && required.length > 0) {
    if (!input || typeof input !== "object") {
      throw new ValidationError(`Surface action input must be an object, received ${typeof input}`);
    }
    const obj = input as Record<string, unknown>;
    for (const field of required) {
      if (typeof field === "string" && !(field in obj)) {
        throw new ValidationError(`Missing required action parameter: "${field}"`);
      }
    }
  }
}

export class SurfaceService {
  private readonly _permissionManager: PermissionManager;
  private readonly _toolRouter: SurfaceToolInvoker;
  private readonly _extensionGate?: ExtensionSurfaceGate;
  private readonly _registry: SurfaceRegistry;
  private readonly _policy: Required<SurfaceSecurityPolicy>;
  private readonly _bindings = new Map<string, ToolBinding>();

  constructor(deps: SurfaceServiceDeps) {
    this._permissionManager = deps.permissionManager;
    this._toolRouter = deps.toolRouter;
    this._extensionGate = deps.extensionGate;
    this._registry = deps.registry ?? new SurfaceRegistry(deps.policy?.maxInstancesPerTask);
    this._policy = {
      allowedKinds: deps.policy?.allowedKinds ?? RENDERABLE_KINDS,
      maxDataBytes: deps.policy?.maxDataBytes ?? MAX_SURFACE_DATA_BYTES,
      maxInstancesPerTask: deps.policy?.maxInstancesPerTask ?? MAX_SURFACES_PER_TASK,
    };
  }

  get registry(): SurfaceRegistry {
    return this._registry;
  }

  registerToolSurface(
    toolName: string,
    descriptorInput: unknown,
    origin: { source: "builtin" | "mcp" | "skill" | "plugin"; originId: string },
  ): RichSurfaceDescriptor {
    const descriptor = validateSurfaceDescriptor(descriptorInput);
    void origin;
    const hash = getSurfaceDefinitionHash({
      id: descriptor.id,
      version: descriptor.version,
      kind: descriptor.kind,
      ...(descriptor.title ? { title: descriptor.title } : {}),
      ...(descriptor.dataSchema ? { dataSchema: descriptor.dataSchema } : {}),
      ...(descriptor.interactionSchema ? { interactionSchema: descriptor.interactionSchema } : {}),
    });
    this._bindings.set(toolName, { descriptor, hash, actions: [] });
    return descriptor;
  }

  registerToolAction(toolName: string, actionInput: unknown): SurfaceAction {
    const binding = this._bindings.get(toolName);
    if (!binding) {
      throw new ValidationError(`No surface binding registered for tool "${toolName}"`);
    }
    if (binding.actions.length >= MAX_SURFACE_ACTIONS) {
      throw new ValidationError(
        `Action cap exceeded for tool "${toolName}" (${MAX_SURFACE_ACTIONS})`,
      );
    }
    const action = validateSurfaceAction(actionInput);
    this._bindings.set(toolName, { ...binding, actions: [...binding.actions, action] });
    return action;
  }

  async createFromToolResult(
    toolResult: ToolResult,
    context: { projectId?: string; conversationId?: unknown },
  ): Promise<SurfaceInstance | null> {
    const stamped = extractSurfaceDescriptor(toolResult.metadata);
    if (!stamped) return null;
    const binding = this._bindings.get(toolResult.toolName);
    if (!binding) return null;
    // Forgery check: the stamped descriptor must hash-match the binding.
    const stampedHash = getSurfaceDefinitionHash({
      id: stamped.id,
      version: stamped.version,
      kind: stamped.kind,
      ...(stamped.title ? { title: stamped.title } : {}),
      ...(stamped.dataSchema ? { dataSchema: stamped.dataSchema } : {}),
      ...(stamped.interactionSchema ? { interactionSchema: stamped.interactionSchema } : {}),
    });
    if (stampedHash !== binding.hash) return null;
    if (!this._policy.allowedKinds.includes(binding.descriptor.kind)) return null;

    // Host-side structural caps (defense in depth beyond the data-bytes
    // ceiling): descriptor bytes, table rows/columns, form fields.
    if (
      Buffer.byteLength(JSON.stringify(binding.descriptor), "utf8") > MAX_SURFACE_DESCRIPTOR_BYTES
    ) {
      return null;
    }
    if (!surfaceDataWithinCaps(toolResult.result)) return null;

    // Plugin gate: extension must be active and project-enabled.
    const extensionId = pluginExtensionIdFor(toolResult.toolName);
    if (extensionId && this._extensionGate) {
      const active = await this._extensionGate.isActive(extensionId);
      if (!active) return null;
      if (context.projectId) {
        const enabled = await this._extensionGate.isEnabledForProject(
          extensionId,
          context.projectId,
        );
        if (!enabled) return null;
      }
    }

    const dataBytes = Buffer.byteLength(JSON.stringify(toolResult.result ?? null), "utf8");
    if (dataBytes > this._policy.maxDataBytes) return null;

    const decision = await this._permissionManager.check(
      {
        capability: "surface",
        action: "render",
        resource: binding.descriptor.id,
        scope: "once",
        risk: "low",
        relatedToolCallIds: [toolResult.toolCallId],
      },
      {
        ...(context.projectId ? { projectId: context.projectId } : {}),
        ...(typeof context.conversationId === "string"
          ? { conversationId: context.conversationId }
          : {}),
      },
    );
    if (decision.kind !== "allow") return null;

    const instance = this._registry.register(binding.descriptor, {
      source: sourceForTool(toolResult.toolName),
      originId: toolResult.toolName,
      toolCallId: toolResult.toolCallId,
      ...(context.projectId ? { projectId: context.projectId } : {}),
    });
    this._registry.setStatus(instance.instanceId, "mounted");
    this._registry.setStatus(instance.instanceId, "active");
    return this._registry.resolve(instance.instanceId) ?? instance;
  }

  getInstance(instanceId: SurfaceInstanceId): SurfaceInstance | undefined {
    return this._registry.resolve(instanceId);
  }

  listByProject(projectId: string): SurfaceInstance[] {
    return this._registry.listByProject(projectId);
  }

  listAll(): SurfaceInstance[] {
    return this._registry.listAll();
  }

  async invokeAction(
    instanceId: SurfaceInstanceId,
    actionId: string,
    input: unknown,
    context: { projectId?: string; conversationId?: unknown; signal?: AbortSignal },
  ): Promise<ToolResult> {
    const instance = this._registry.resolve(instanceId);
    if (!instance || instance.status === "disposed") {
      throw new ValidationError(`Unknown or disposed surface "${instanceId}"`);
    }
    const binding = this._bindings.get(instance.provenance.originId);
    const action = binding?.actions.find((a) => a.actionId === actionId);
    if (!action) {
      throw new ValidationError(`Unknown action "${actionId}" for surface "${instanceId}"`);
    }
    validateActionInput(action.inputSchema, input);
    const decision = await this._permissionManager.check(
      {
        capability: "surface",
        action: "interact",
        resource: `${instance.descriptor.id}:${actionId}`,
        scope: "once",
        risk: "medium",
        relatedToolCallIds: [instance.provenance.toolCallId],
      },
      {
        ...(context.projectId ? { projectId: context.projectId } : {}),
        ...(typeof context.conversationId === "string"
          ? { conversationId: context.conversationId }
          : {}),
      },
    );
    if (decision.kind !== "allow") {
      return {
        toolCallId: createToolCallId(),
        toolName: action.toolName,
        result: `Surface action denied: ${decision.kind}`,
        isError: true,
        timestamp: now(),
      };
    }
    return this._toolRouter.invoke(
      action.toolName,
      input,
      {
        toolCallId: createToolCallId(),
        ...(context.projectId ? { projectId: context.projectId } : {}),
        ...(typeof context.conversationId === "string"
          ? { conversationId: context.conversationId as unknown as ConversationId }
          : {}),
      },
      context.signal,
    );
  }

  dispose(instanceId: SurfaceInstanceId): boolean {
    return this._registry.dispose(instanceId);
  }
}

function pluginExtensionIdFor(toolName: string): string | null {
  if (!toolName.startsWith("plugin:")) return null;
  const rest = toolName.slice("plugin:".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  return rest.slice(0, slash);
}

function sourceForTool(toolName: string): "builtin" | "mcp" | "skill" | "plugin" {
  if (toolName.startsWith("plugin:")) return "plugin";
  if (toolName.startsWith("skill:")) return "skill";
  if (toolName.startsWith("builtin:")) return "builtin";
  return "mcp";
}

/**
 * Host-side structural caps on result data: table rows/columns and form
 * field counts. Renderer truncation is display-only; this is the
 * enforcement point before a surface materializes.
 */
function surfaceDataWithinCaps(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const data = result as Record<string, unknown>;
  if (Array.isArray(data.rows) && data.rows.length > MAX_SURFACE_ROWS) return false;
  if (Array.isArray(data.columns) && data.columns.length > MAX_SURFACE_COLUMNS) return false;
  if (Array.isArray(data.fields) && data.fields.length > MAX_SURFACE_FIELDS) return false;
  if (Array.isArray(data.blocks) && data.blocks.length > MAX_SURFACE_ROWS) return false;
  return true;
}
