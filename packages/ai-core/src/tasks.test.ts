import { describe, expect, it } from "vitest";
import { TaskNodeSchema, TaskSchema, type Task, type TaskNode } from "./tasks.js";
import { createTaskNodeId } from "./identifiers.js";
import { createConversationId, createTaskId, now } from "@ai-desktop/shared";

describe("ai-core tasks: Task Graph Contracts", () => {
  it("validates an individual TaskNode with dependencies", () => {
    const taskId = createTaskId();
    const node1Id = createTaskNodeId();
    const node2Id = createTaskNodeId();

    const node2: TaskNode = {
      id: node2Id,
      taskId,
      title: "Run build",
      description: "Compile TypeScript packages",
      status: "pending",
      dependencies: [node1Id],
      createdAt: now(),
    };

    expect(TaskNodeSchema.safeParse(node2).success).toBe(true);
  });

  it("validates a complete Task graph model", () => {
    const taskId = createTaskId();
    const node1Id = createTaskNodeId();
    const node2Id = createTaskNodeId();

    const node1: TaskNode = {
      id: node1Id,
      taskId,
      title: "Install dependencies",
      status: "completed",
      dependencies: [],
      createdAt: now(),
      completedAt: now(),
    };

    const node2: TaskNode = {
      id: node2Id,
      taskId,
      title: "Run tests",
      status: "running",
      dependencies: [node1Id],
      createdAt: now(),
      startedAt: now(),
    };

    const task: Task = {
      id: taskId,
      conversationId: createConversationId(),
      title: "Verify workspace build",
      status: "running",
      nodes: {
        [node1Id]: node1,
        [node2Id]: node2,
      },
      rootNodeIds: [node1Id],
      createdAt: now(),
    };

    expect(TaskSchema.safeParse(task).success).toBe(true);
  });
});
