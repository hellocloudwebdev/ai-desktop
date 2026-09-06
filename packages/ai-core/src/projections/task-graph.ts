// PR5: packages/ai-core — Task Graph Projection Layer
//
// Pure, deterministic projection reconstructing the task graph DAG from task events.
//
// Invariants:
//   - Pure function with no I/O, no persistence, no side effects.
//   - Input events are never mutated.
//   - Preserves DAG invariants:
//       1. No self-dependency
//       2. All referenced dependency nodes must exist
//       3. No cyclic dependencies
//   - Handles dynamic replanning events (task.replan).

import type { TaskId, Timestamp } from "@ai-desktop/shared";
import type { TaskNodeId } from "../identifiers.js";
import type { AIEvent } from "../events.js";
import type { TaskNode, TaskNodeStatus, TaskStatus } from "../tasks.js";
import { prepareEventStream } from "./helpers.js";
import { TaskGraphError } from "../errors.js";

interface MutableNodeState {
  id: TaskNodeId;
  taskId: TaskId;
  parentId?: TaskNodeId;
  goal: string;
  title: string;
  description?: string;
  status: TaskNodeStatus;
  dependsOn: Set<TaskNodeId>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectedTaskGraph {
  readonly taskId: TaskId;
  readonly title?: string;
  readonly status: TaskStatus;
  readonly nodes: readonly TaskNode[];
  readonly nodeMap: ReadonlyMap<TaskNodeId, TaskNode>;
  readonly rootNodeIds: readonly TaskNodeId[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  getNode(id: TaskNodeId): TaskNode | undefined;
  getDependencies(id: TaskNodeId): readonly TaskNode[];
  getDependents(id: TaskNodeId): readonly TaskNode[];
  getExecutionOrder(): readonly TaskNodeId[];
}

/**
 * Validates DAG invariants across the node collection:
 *   1. No node depends on itself.
 *   2. Every referenced dependency exists in the node collection.
 *   3. The graph contains zero cycles (Kahn's topological sort verification).
 *
 * Throws TaskGraphError deterministically if any invariant is violated.
 */
function validateDagInvariants(nodeMap: Map<TaskNodeId, MutableNodeState>): TaskNodeId[] {
  // 1. Self-dependency check & 2. Missing dependency reference check
  for (const [nodeId, node] of nodeMap.entries()) {
    for (const depId of node.dependsOn) {
      if (depId === nodeId) {
        throw new TaskGraphError(
          `DAG invariant violation: Self-dependency detected in node "${nodeId}"`,
        );
      }
      if (!nodeMap.has(depId)) {
        throw new TaskGraphError(
          `DAG invariant violation: Missing dependency reference. Node "${nodeId}" depends on non-existent node "${depId}"`,
        );
      }
    }
  }

  // 3. Cycle detection using Kahn's algorithm (indegree counting)
  // Edge is: dep -> node (node dependsOn dep, so dep must execute before node)
  const inDegree = new Map<TaskNodeId, number>();
  const adjacency = new Map<TaskNodeId, TaskNodeId[]>();

  for (const nodeId of nodeMap.keys()) {
    inDegree.set(nodeId, 0);
    adjacency.set(nodeId, []);
  }

  for (const [nodeId, node] of nodeMap.entries()) {
    for (const depId of node.dependsOn) {
      inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1);
      adjacency.get(depId)?.push(nodeId);
    }
  }

  const queue: TaskNodeId[] = [];
  for (const [nodeId, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(nodeId);
    }
  }

  const topologicalOrder: TaskNodeId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    topologicalOrder.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, nextDegree);
      if (nextDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (topologicalOrder.length !== nodeMap.size) {
    const unvisited = Array.from(nodeMap.keys()).filter((id) => !topologicalOrder.includes(id));
    throw new TaskGraphError(
      `DAG invariant violation: Cycle detected in task graph involving node(s): ${unvisited.join(", ")}`,
    );
  }

  return topologicalOrder;
}

function toReadonlyTaskNode(state: MutableNodeState): TaskNode {
  return {
    id: state.id,
    taskId: state.taskId,
    parentId: state.parentId,
    goal: state.goal,
    title: state.title,
    description: state.description,
    status: state.status,
    dependsOn: Object.freeze(Array.from(state.dependsOn)),
    dependencies: Object.freeze(Array.from(state.dependsOn)),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    result: state.result,
    error: state.error,
    metadata: state.metadata ? Object.freeze({ ...state.metadata }) : undefined,
  };
}

/**
 * Projects an authoritative event history into a DAG TaskGraph read model.
 *
 * @param events All events in the stream.
 * @param targetTaskId The TaskId of the task graph to reconstruct.
 */
export function projectTaskGraph(
  events: readonly AIEvent[],
  targetTaskId: TaskId,
): ProjectedTaskGraph {
  const sortedEvents = prepareEventStream(events);
  const taskEvents = sortedEvents.filter(
    (e) => "taskId" in e && (e as { taskId?: string }).taskId === targetTaskId,
  );

  if (taskEvents.length === 0) {
    throw new TaskGraphError(`No events found for task "${targetTaskId}"`);
  }

  let title: string | undefined;
  let status: TaskStatus = "pending";
  let createdAt = taskEvents[0].timestamp as Timestamp;
  let updatedAt = taskEvents[0].timestamp as Timestamp;
  const rootNodeIds: TaskNodeId[] = [];
  const nodeMap = new Map<TaskNodeId, MutableNodeState>();

  for (const event of taskEvents) {
    const ts = event.timestamp as Timestamp;
    updatedAt = ts;

    switch (event.type) {
      case "task.created": {
        title = event.title;
        status = "pending";
        createdAt = ts;
        for (const rootId of event.rootNodeIds) {
          if (!rootNodeIds.includes(rootId)) {
            rootNodeIds.push(rootId);
          }
        }
        break;
      }

      case "task.started": {
        status = "active";
        break;
      }

      case "task.subtask.created": {
        const nodeId = event.nodeId;
        const dependsOnSet = new Set<TaskNodeId>(event.dependsOn ?? []);
        nodeMap.set(nodeId, {
          id: nodeId,
          taskId: targetTaskId,
          parentId: event.parentId,
          goal: event.goal,
          title: event.goal,
          status: event.status ?? "pending",
          dependsOn: dependsOnSet,
          createdAt: ts,
          updatedAt: ts,
          metadata: event.metadata ? { ...event.metadata } : undefined,
        });

        if (dependsOnSet.size === 0 && !rootNodeIds.includes(nodeId)) {
          rootNodeIds.push(nodeId);
        }
        break;
      }

      case "task.node.started": {
        const node = nodeMap.get(event.taskNodeId);
        if (node) {
          node.status = "active";
          node.startedAt = ts;
          node.updatedAt = ts;
        }
        break;
      }

      case "task.node.completed": {
        const node = nodeMap.get(event.taskNodeId);
        if (node) {
          node.status = "completed";
          node.completedAt = ts;
          node.result = event.result;
          node.updatedAt = ts;
        }
        break;
      }

      case "task.node.failed": {
        const node = nodeMap.get(event.taskNodeId);
        if (node) {
          node.status = "failed";
          node.error = event.error;
          node.updatedAt = ts;
        }
        break;
      }

      case "task.progress": {
        if (event.nodeId) {
          const node = nodeMap.get(event.nodeId);
          if (node) {
            if (event.status) node.status = event.status;
            node.updatedAt = ts;
          }
        }
        break;
      }

      case "task.blocked": {
        if (event.nodeId) {
          const node = nodeMap.get(event.nodeId);
          if (node) {
            node.status = "blocked";
            node.updatedAt = ts;
          }
        } else {
          status = "blocked";
        }
        break;
      }

      case "task.replan": {
        // Section 28.10: Re-planning is an event-driven state transition
        if (event.removedNodeIds) {
          for (const removedId of event.removedNodeIds) {
            nodeMap.delete(removedId);
            // Remove deleted node from rootNodeIds if present
            const rootIdx = rootNodeIds.indexOf(removedId);
            if (rootIdx !== -1) {
              rootNodeIds.splice(rootIdx, 1);
            }
            // Remove deleted node from other nodes' dependsOn
            for (const remaining of nodeMap.values()) {
              remaining.dependsOn.delete(removedId);
            }
          }
        }

        if (event.addedNodes) {
          for (const added of event.addedNodes) {
            const deps = added.dependsOn ?? added.dependencies ?? [];
            nodeMap.set(added.id, {
              id: added.id,
              taskId: targetTaskId,
              parentId: added.parentId,
              goal: added.goal ?? added.title ?? "",
              title: added.title ?? added.goal ?? "",
              description: added.description,
              status: added.status,
              dependsOn: new Set(deps),
              createdAt: added.createdAt as Timestamp,
              updatedAt: ts,
              result: added.result,
              error: added.error,
              metadata: added.metadata ? { ...added.metadata } : undefined,
            });
          }
        }

        if (event.updatedDependencies) {
          for (const [nodeIdStr, newDeps] of Object.entries(event.updatedDependencies)) {
            const targetNode = nodeMap.get(nodeIdStr as TaskNodeId);
            if (targetNode) {
              targetNode.dependsOn = new Set(newDeps);
              targetNode.updatedAt = ts;
            }
          }
        }
        break;
      }

      case "task.completed": {
        status = "completed";
        break;
      }

      case "task.failed": {
        status = "failed";
        break;
      }

      case "task.cancelled": {
        status = "cancelled";
        break;
      }

      default:
        break;
    }
  }

  // Validate DAG invariants and obtain topological order
  const topologicalOrder = validateDagInvariants(nodeMap);

  const readonlyMap = new Map<TaskNodeId, TaskNode>();
  const readonlyList: TaskNode[] = [];

  for (const id of topologicalOrder) {
    const raw = nodeMap.get(id)!;
    const readonlyNode = toReadonlyTaskNode(raw);
    readonlyMap.set(id, readonlyNode);
    readonlyList.push(readonlyNode);
  }

  return {
    taskId: targetTaskId,
    title,
    status,
    nodes: Object.freeze(readonlyList),
    nodeMap: readonlyMap,
    rootNodeIds: Object.freeze([...rootNodeIds]),
    createdAt,
    updatedAt,
    getNode(id: TaskNodeId): TaskNode | undefined {
      return readonlyMap.get(id);
    },
    getDependencies(id: TaskNodeId): readonly TaskNode[] {
      const node = readonlyMap.get(id);
      if (!node) return [];
      return (node.dependsOn ?? [])
        .map((depId) => readonlyMap.get(depId))
        .filter((n): n is TaskNode => n !== undefined);
    },
    getDependents(id: TaskNodeId): readonly TaskNode[] {
      return readonlyList.filter((n) => (n.dependsOn ?? []).includes(id));
    },
    getExecutionOrder(): readonly TaskNodeId[] {
      return topologicalOrder;
    },
  };
}
