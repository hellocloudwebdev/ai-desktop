import { describe, expect, it } from "vitest";
import { createTaskId } from "@ai-desktop/shared";
import { TaskGraphError } from "@ai-desktop/ai-core";
import { TaskGraph, validateTaskGraph } from "../runtime/task-graph.js";

describe("packages/agent-runtime: TaskGraph DAG validation (PR29.3–29.4)", () => {
  it("accepts a valid linear chain A -> B -> C with correct execution order", () => {
    const graph = new TaskGraph(createTaskId());
    const a = graph.addNode({ goal: "Step A" });
    const b = graph.addNode({ goal: "Step B", dependsOn: [a.id] });
    const c = graph.addNode({ goal: "Step C", dependsOn: [b.id] });

    expect(graph.rootNodeIds).toEqual([a.id]);
    expect(graph.executionOrder()).toEqual([a.id, b.id, c.id]);
    expect(graph.readyNodes().map((n) => n.id)).toEqual([a.id]);
  });

  it("rejects self-dependency deterministically", () => {
    const graph = new TaskGraph(createTaskId());
    const a = graph.addNode({ goal: "Lonely" });
    expect(() => {
      // Bypass addNode's own guard path by validating a crafted map
      validateTaskGraph(new Map([[a.id, { dependsOn: [a.id] }]]));
    }).toThrow(TaskGraphError);
    expect(() => {
      graph.addNode({ goal: "Selfish", dependsOn: [a.id] });
      // Force self-loop via direct spec with own id is impossible (id auto-generated),
      // so validate the invariant function directly instead.
      validateTaskGraph(new Map([[a.id, { dependsOn: [a.id] }]]));
    }).toThrow(TaskGraphError);
  });

  it("rejects multi-node cycles A -> B -> A", () => {
    const graph = new TaskGraph(createTaskId());
    const a = graph.addNode({ goal: "A" });
    const b = graph.addNode({ goal: "B", dependsOn: [a.id] });
    // Introduce the back edge by crafting the validation input (addNode validates incrementally,
    // so a cycle can only arise through crafted maps or replan paths — both must be rejected).
    const cyclic = new Map([
      [a.id, { dependsOn: [b.id] }],
      [b.id, { dependsOn: [a.id] }],
    ]);
    expect(() => validateTaskGraph(cyclic)).toThrow(/Cycle detected/);
    // The live graph itself remains valid
    expect(graph.executionOrder()).toEqual([a.id, b.id]);
  });

  it("rejects missing dependency references", () => {
    const graph = new TaskGraph(createTaskId());
    expect(() =>
      graph.addNode({
        goal: "Orphan",
        dependsOn: ["01JBBBBBBBBBBBBBBBBBBBBBBBB" as never],
      }),
    ).toThrow(/Missing dependency reference/);
  });

  it("tracks ready nodes as dependencies complete", () => {
    const graph = new TaskGraph(createTaskId());
    const a = graph.addNode({ goal: "A" });
    const b = graph.addNode({ goal: "B", dependsOn: [a.id] });

    expect(graph.readyNodes().map((n) => n.id)).toEqual([a.id]);
    graph.setNodeStatus(a.id, "completed");
    expect(graph.readyNodes().map((n) => n.id)).toEqual([b.id]);
  });

  it("removes nodes and cleans dependents on replan", () => {
    const graph = new TaskGraph(createTaskId());
    const a = graph.addNode({ goal: "A" });
    const b = graph.addNode({ goal: "B", dependsOn: [a.id] });

    expect(graph.removeNode(a.id)).toBe(true);
    expect(graph.getNode(b.id)?.dependsOn).toEqual([]);
    expect(graph.removeNode(a.id)).toBe(false);
  });
});
