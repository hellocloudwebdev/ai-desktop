// PR33.6: main — Surface Registry (host-owned instance metadata)
//
// Invariants:
//   1. The registry manages approved surface instance metadata only; it never
//      executes code or renders anything.
//   2. Strict linear lifecycle: declared -> validated -> mounted -> active ->
//      disposed (disposed terminal). Invalid transitions fail (return false).
//   3. Per-toolCallId instance cap prevents surface-spam denial of service.

import { createHash } from "node:crypto";
import {
  createSurfaceInstanceId,
  validateSurfaceDescriptor,
  MAX_SURFACES_PER_TASK,
  type RichSurfaceDescriptor,
  type SurfaceId,
  type SurfaceInstance,
  type SurfaceInstanceId,
  type SurfaceProvenance,
  type SurfaceStatus,
} from "@ai-desktop/ai-core";
import { now, ValidationError } from "@ai-desktop/shared";

const STATUS_ORDER: readonly SurfaceStatus[] = [
  "declared",
  "validated",
  "mounted",
  "active",
  "disposed",
];

export function getSurfaceDefinitionHash(descriptor: {
  id: string;
  version: string;
  kind: string;
  title?: string;
  dataSchema?: Record<string, unknown>;
  interactionSchema?: Record<string, unknown>;
}): string {
  const content = JSON.stringify({
    id: descriptor.id,
    version: descriptor.version,
    kind: descriptor.kind,
    title: descriptor.title,
    dataSchema: descriptor.dataSchema,
    interactionSchema: descriptor.interactionSchema,
  });
  return createHash("sha256").update(content).digest("hex");
}

export class SurfaceRegistry {
  private readonly _instances = new Map<SurfaceInstanceId, SurfaceInstance>();
  private readonly _maxInstancesPerTask: number;

  constructor(maxInstancesPerTask: number = MAX_SURFACES_PER_TASK) {
    this._maxInstancesPerTask = maxInstancesPerTask;
  }

  register(descriptorInput: unknown, provenance: SurfaceProvenance): SurfaceInstance {
    const descriptor: RichSurfaceDescriptor = validateSurfaceDescriptor(descriptorInput);
    const siblings = [...this._instances.values()].filter(
      (s) => s.provenance.toolCallId === provenance.toolCallId,
    );
    if (siblings.length >= this._maxInstancesPerTask) {
      throw new ValidationError(
        `Surface cap exceeded for tool call "${provenance.toolCallId}" (${this._maxInstancesPerTask})`,
      );
    }
    const instance: SurfaceInstance = {
      instanceId: createSurfaceInstanceId(),
      descriptor,
      provenance,
      status: "validated",
      createdAt: now(),
    };
    this._instances.set(instance.instanceId, instance);
    return instance;
  }

  resolve(instanceId: SurfaceInstanceId): SurfaceInstance | undefined {
    return this._instances.get(instanceId);
  }

  resolveById(id: SurfaceId): SurfaceInstance[] {
    return [...this._instances.values()].filter((s) => s.descriptor.id === id);
  }

  listByProject(projectId: string): SurfaceInstance[] {
    return [...this._instances.values()].filter((s) => s.provenance.projectId === projectId);
  }

  listAll(): SurfaceInstance[] {
    return [...this._instances.values()];
  }

  listByToolCall(toolCallId: string): SurfaceInstance[] {
    return [...this._instances.values()].filter((s) => s.provenance.toolCallId === toolCallId);
  }

  setStatus(instanceId: SurfaceInstanceId, status: SurfaceStatus): boolean {
    const current = this._instances.get(instanceId);
    if (!current) return false;
    const fromIdx = STATUS_ORDER.indexOf(current.status);
    const toIdx = STATUS_ORDER.indexOf(status);
    if (toIdx !== fromIdx + 1) return false;
    this._instances.set(instanceId, { ...current, status, updatedAt: now() });
    return true;
  }

  dispose(instanceId: SurfaceInstanceId): boolean {
    const current = this._instances.get(instanceId);
    if (!current) return false;
    if (current.status === "disposed") return true;
    this._instances.set(instanceId, { ...current, status: "disposed", updatedAt: now() });
    return true;
  }

  unregister(instanceId: SurfaceInstanceId): boolean {
    return this._instances.delete(instanceId);
  }

  clear(): void {
    this._instances.clear();
  }
}
