import { describe, expect, it } from "vitest";
import { projectTaskGraph } from "../task-graph.js";
import {
  createConversationId,
  createTaskId,
  now,
  type ConversationId,
  type TaskId,
} from "@ai-desktop/shared";
import { createEventId, createTaskNodeId, type TaskNodeId } from "../../identifiers.js";
import type {
  AIEvent,
  TaskBlockedEvent,
  TaskCreatedEvent,
  TaskNodeCompletedEvent,
  TaskNodeStartedEvent,
  TaskReplanEvent,
  TaskStartedEvent,
  TaskSubtaskCreatedEvent,
} from "../../events.js";
import type { TaskNodeStatus } from "../../tasks.js";
import { TaskGraphError } from "../../errors.js";

function makeSubtaskCreated(
  convId: ConversationId,
  taskId: TaskId,
  seq: number,
  nodeId: TaskNodeId,
  goal: string,
  dependsOn: TaskNodeId[] = [],
  status: TaskNodeStatus = "pending",
): TaskSubtaskCreatedEvent {
  return {
    eventId: createEventId(),
    conversationId: convId,
    sequence: seq,
    schemaVersion: 1,
    timestamp: now(),
    type: "task.subtask.created",
    category: "extension",
    taskId,
    nodeId,
    goal,
    dependsOn,
    status,
  };
}

describe("projections: Task Graph Reconstruction & Invariants", () => {
  it("reconstructs a DAG task graph from subtask creation events", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const nodeA = createTaskNodeId();
    const nodeB = createTaskNodeId();
    const nodeC = createTaskNodeId();

    // Graph structure: A -> B -> C (C depends on B, B depends on A)
    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.created",
        category: "extension",
        taskId,
        title: "Build Feature X",
        rootNodeIds: [nodeA],
      } as TaskCreatedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 1,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.started",
        category: "extension",
        taskId,
      } as TaskStartedEvent,
      makeSubtaskCreated(convId, taskId, 2, nodeA, "Step A: Setup"),
      makeSubtaskCreated(convId, taskId, 3, nodeB, "Step B: Implement", [nodeA]),
      makeSubtaskCreated(convId, taskId, 4, nodeC, "Step C: Test", [nodeB]),
    ];

    const graph = projectTaskGraph(events, taskId);

    expect(graph.taskId).toBe(taskId);
    expect(graph.title).toBe("Build Feature X");
    expect(graph.status).toBe("active");
    expect(graph.nodes).toHaveLength(3);

    // Topological execution order check
    const order = graph.getExecutionOrder();
    expect(order).toEqual([nodeA, nodeB, nodeC]);

    // Graph query helpers
    const bNode = graph.getNode(nodeB);
    expect(bNode?.goal).toBe("Step B: Implement");

    const depsOfB = graph.getDependencies(nodeB);
    expect(depsOfB.map((n) => n.id)).toEqual([nodeA]);

    const dependentsOfB = graph.getDependents(nodeB);
    expect(dependentsOfB.map((n) => n.id)).toEqual([nodeC]);
  });

  it("handles node status transitions (active, completed, failed, blocked)", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const nodeA = createTaskNodeId();
    const nodeB = createTaskNodeId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.created",
        category: "extension",
        taskId,
        title: "Status Transitions",
        rootNodeIds: [nodeA],
      } as TaskCreatedEvent,
      makeSubtaskCreated(convId, taskId, 1, nodeA, "Task A"),
      makeSubtaskCreated(convId, taskId, 2, nodeB, "Task B", [nodeA]),
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 3,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.node.started",
        category: "extension",
        taskId,
        taskNodeId: nodeA,
      } as TaskNodeStartedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 4,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.node.completed",
        category: "extension",
        taskId,
        taskNodeId: nodeA,
        result: { done: true },
      } as TaskNodeCompletedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 5,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.blocked",
        category: "extension",
        taskId,
        nodeId: nodeB,
        reason: "Waiting for environment approval",
      } as TaskBlockedEvent,
    ];

    const graph = projectTaskGraph(events, taskId);

    const projectedA = graph.getNode(nodeA);
    expect(projectedA?.status).toBe("completed");
    expect(projectedA?.result).toEqual({ done: true });

    const projectedB = graph.getNode(nodeB);
    expect(projectedB?.status).toBe("blocked");
  });

  it("handles dynamic replanning (task.replan) by updating nodes and dependencies", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const nodeA = createTaskNodeId();
    const nodeB = createTaskNodeId();
    const nodeC = createTaskNodeId(); // will be added via replan

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.created",
        category: "extension",
        taskId,
        title: "Replan Task",
        rootNodeIds: [nodeA],
      } as TaskCreatedEvent,
      makeSubtaskCreated(convId, taskId, 1, nodeA, "Initial Node A"),
      makeSubtaskCreated(convId, taskId, 2, nodeB, "Initial Node B", [nodeA]),
      // Replan event: removes nodeB and introduces nodeC depending on nodeA
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 3,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.replan",
        category: "extension",
        taskId,
        reason: "Architecture changed, replacing B with C",
        removedNodeIds: [nodeB],
        addedNodes: [
          {
            id: nodeC,
            taskId,
            goal: "Replacement Node C",
            title: "Replacement Node C",
            status: "pending",
            dependsOn: [nodeA],
            dependencies: [nodeA],
            createdAt: now(),
          },
        ],
      } as TaskReplanEvent,
    ];

    const graph = projectTaskGraph(events, taskId);

    expect(graph.getNode(nodeB)).toBeUndefined();
    expect(graph.getNode(nodeC)).toBeDefined();
    expect(graph.getNode(nodeC)?.goal).toBe("Replacement Node C");

    const order = graph.getExecutionOrder();
    expect(order).toEqual([nodeA, nodeC]);
  });

  describe("DAG Invariant Enforcements", () => {
    it("fails deterministically on self-dependency", () => {
      const convId = createConversationId();
      const taskId = createTaskId();
      const nodeA = createTaskNodeId();

      const events: AIEvent[] = [
        {
          eventId: createEventId(),
          conversationId: convId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "task.created",
          category: "extension",
          taskId,
          title: "Self Dep Task",
          rootNodeIds: [nodeA],
        } as TaskCreatedEvent,
        makeSubtaskCreated(convId, taskId, 1, nodeA, "Self depending node", [nodeA]),
      ];

      expect(() => projectTaskGraph(events, taskId)).toThrow(TaskGraphError);
      expect(() => projectTaskGraph(events, taskId)).toThrow(/Self-dependency/);
    });

    it("fails deterministically on cyclic dependency (A -> B -> A)", () => {
      const convId = createConversationId();
      const taskId = createTaskId();
      const nodeA = createTaskNodeId();
      const nodeB = createTaskNodeId();

      const events: AIEvent[] = [
        {
          eventId: createEventId(),
          conversationId: convId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "task.created",
          category: "extension",
          taskId,
          title: "Cycle Task",
          rootNodeIds: [nodeA],
        } as TaskCreatedEvent,
        makeSubtaskCreated(convId, taskId, 1, nodeA, "Node A", [nodeB]),
        makeSubtaskCreated(convId, taskId, 2, nodeB, "Node B", [nodeA]),
      ];

      expect(() => projectTaskGraph(events, taskId)).toThrow(TaskGraphError);
      expect(() => projectTaskGraph(events, taskId)).toThrow(/Cycle detected/);
    });

    it("fails deterministically on missing dependency reference", () => {
      const convId = createConversationId();
      const taskId = createTaskId();
      const nodeA = createTaskNodeId();
      const nonExistentNode = createTaskNodeId();

      const events: AIEvent[] = [
        {
          eventId: createEventId(),
          conversationId: convId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "task.created",
          category: "extension",
          taskId,
          title: "Missing Dep Task",
          rootNodeIds: [nodeA],
        } as TaskCreatedEvent,
        makeSubtaskCreated(convId, taskId, 1, nodeA, "Node A", [nonExistentNode]),
      ];

      expect(() => projectTaskGraph(events, taskId)).toThrow(TaskGraphError);
      expect(() => projectTaskGraph(events, taskId)).toThrow(/Missing dependency reference/);
    });
  });
});
