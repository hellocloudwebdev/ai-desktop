// PR29.3 & PR29.4: packages/agent-runtime — In-Memory TaskGraph & DAG Validation
//
// Invariants:
//   1. The graph is a DAG: no self-dependency, all references valid, zero cycles.
//   2. validateTaskGraph is pure, deterministic, and side-effect free.
//   3. Node statuses follow the canonical lifecycle subset (pending/active/blocked/completed/failed/cancelled).
//   4. Reuses existing TaskId/TaskNodeId branded identifiers from ai-core.

import {
  createTaskNodeId,
  TaskGraphError,
  type TaskId,
  type TaskNodeId,
} from "@ai-desktop/ai-core";
import type { AgentNodeStatus, TaskNodeSpec } from "./types.js";

export interface RuntimeTaskNode {
  readonly id: TaskNodeId;
  readonly taskId: TaskId;
  readonly parentId?: TaskNodeId;
  readonly goal: string;
  status: AgentNodeStatus;
  readonly dependsOn: readonly TaskNodeId[];
  attempts: number;
  result?: unknown;
  error?: string;
  readonly createdAt: number;
  updatedAt: number;
}

export interface TaskGraphSnapshot {
  readonly taskId: TaskId;
  readonly nodes: ReadonlyMap<TaskNodeId, RuntimeTaskNode>;
  readonly rootNodeIds: readonly TaskNodeId[];
}

/**
 * Pure DAG validation: rejects self-dependency, missing references, and cycles.
 * Deterministic and side-effect free; throws TaskGraphError on violation.
 */
export function validateTaskGraph(
  nodes: ReadonlyMap<TaskNodeId, { dependsOn: readonly TaskNodeId[] }>,
): TaskNodeId[] {
  for (const [nodeId, node] of nodes.entries()) {
    for (const depId of node.dependsOn) {
      if (depId === nodeId) {
        throw new TaskGraphError(
          `DAG invariant violation: Self-dependency detected in node "${nodeId}"`,
        );
      }
      if (!nodes.has(depId)) {
        throw new TaskGraphError(
          `DAG invariant violation: Missing dependency reference. Node "${nodeId}" depends on non-existent node "${depId}"`,
        );
      }
    }
  }

  // Kahn's topological sort for cycle detection
  const inDegree = new Map<TaskNodeId, number>();
  const adjacency = new Map<TaskNodeId, TaskNodeId[]>();
  for (const nodeId of nodes.keys()) {
    inDegree.set(nodeId, 0);
    adjacency.set(nodeId, []);
  }
  for (const [nodeId, node] of nodes.entries()) {
    for (const depId of node.dependsOn) {
      inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1);
      adjacency.get(depId)?.push(nodeId);
    }
  }

  const queue: TaskNodeId[] = [];
  for (const [nodeId, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(nodeId);
  }

  const order: TaskNodeId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const next = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, next);
      if (next === 0) queue.push(neighbor);
    }
  }

  if (order.length !== nodes.size) {
    const stuck = [...nodes.keys()].filter((id) => !order.includes(id));
    throw new TaskGraphError(
      `DAG invariant violation: Cycle detected involving node(s): ${stuck.join(", ")}`,
    );
  }

  return order;
}

export class TaskGraph {
  private readonly _taskId: TaskId;
  private readonly _nodes = new Map<TaskNodeId, RuntimeTaskNode>();
  private readonly _rootNodeIds: TaskNodeId[] = [];

  constructor(taskId: TaskId, specs: readonly TaskNodeSpec[] = []) {
    this._taskId = taskId;
    for (const spec of specs) {
      this.addNode(spec);
    }
  }

  get taskId(): TaskId {
    return this._taskId;
  }

  get rootNodeIds(): readonly TaskNodeId[] {
    return [...this._rootNodeIds];
  }

  get size(): number {
    return this._nodes.size;
  }

  addNode(spec: TaskNodeSpec & { id?: TaskNodeId }): RuntimeTaskNode {
    const id = spec.id ?? createTaskNodeId();
    if (this._nodes.has(id)) {
      throw new TaskGraphError(`Task graph already contains node "${id}"`);
    }
    const nowMs = Date.now();
    const node: RuntimeTaskNode = {
      id,
      taskId: this._taskId,
      parentId: spec.parentId,
      goal: spec.goal,
      status: "pending",
      dependsOn: [...(spec.dependsOn ?? [])],
      attempts: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this._nodes.set(id, node);
    if (node.dependsOn.length === 0 && !this._rootNodeIds.includes(id)) {
      this._rootNodeIds.push(id);
    }
    // Validate incrementally so violations surface at mutation time
    validateTaskGraph(this._nodes);
    return node;
  }

  removeNode(id: TaskNodeId): boolean {
    const existed = this._nodes.delete(id);
    if (!existed) return false;
    const rootIdx = this._rootNodeIds.indexOf(id);
    if (rootIdx !== -1) this._rootNodeIds.splice(rootIdx, 1);
    for (const node of this._nodes.values()) {
      const remaining = node.dependsOn.filter((dep) => dep !== id);
      if (remaining.length !== node.dependsOn.length) {
        (node as { dependsOn: readonly TaskNodeId[] }).dependsOn = remaining;
      }
    }
    return true;
  }

  getNode(id: TaskNodeId): RuntimeTaskNode | undefined {
    return this._nodes.get(id);
  }

  setNodeStatus(id: TaskNodeId, status: AgentNodeStatus): void {
    const node = this._nodes.get(id);
    if (!node) throw new TaskGraphError(`Unknown task node "${id}"`);
    node.status = status;
    node.updatedAt = Date.now();
  }

  recordAttempt(id: TaskNodeId): number {
    const node = this._nodes.get(id);
    if (!node) throw new TaskGraphError(`Unknown task node "${id}"`);
    node.attempts += 1;
    node.updatedAt = Date.now();
    return node.attempts;
  }

  setNodeResult(id: TaskNodeId, result: unknown): void {
    const node = this._nodes.get(id);
    if (!node) throw new TaskGraphError(`Unknown task node "${id}"`);
    node.result = result;
    node.updatedAt = Date.now();
  }

  setNodeError(id: TaskNodeId, error: string): void {
    const node = this._nodes.get(id);
    if (!node) throw new TaskGraphError(`Unknown task node "${id}"`);
    node.error = error;
    node.updatedAt = Date.now();
  }

  /** Nodes whose dependencies are all completed and which are still pending. */
  readyNodes(): RuntimeTaskNode[] {
    const ready: RuntimeTaskNode[] = [];
    for (const node of this._nodes.values()) {
      if (node.status !== "pending") continue;
      const depsMet = node.dependsOn.every(
        (depId) => this._nodes.get(depId)?.status === "completed",
      );
      if (depsMet) ready.push(node);
    }
    return ready;
  }

  getDependents(id: TaskNodeId): RuntimeTaskNode[] {
    return [...this._nodes.values()].filter((n) => n.dependsOn.includes(id));
  }

  executionOrder(): TaskNodeId[] {
    return validateTaskGraph(this._nodes);
  }

  snapshot(): TaskGraphSnapshot {
    return {
      taskId: this._taskId,
      nodes: new Map(this._nodes),
      rootNodeIds: [...this._rootNodeIds],
    };
  }

  allTerminal(): boolean {
    for (const node of this._nodes.values()) {
      if (node.status === "pending" || node.status === "active" || node.status === "blocked") {
        return false;
      }
    }
    return true;
  }

  hasFailed(): boolean {
    for (const node of this._nodes.values()) {
      if (node.status === "failed") return true;
    }
    return false;
  }
}
