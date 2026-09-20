// PR43: packages/agent-runtime — BackgroundQueue unit tests

import { describe, expect, it } from "vitest";
import { BackgroundQueue } from "../runtime/background-queue.js";

describe("BackgroundQueue: FIFO ordering", () => {
  it("dequeues in insertion order", () => {
    const q = new BackgroundQueue<string>(4);
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    expect(q.dequeue()).toBe("a");
    expect(q.dequeue()).toBe("b");
    expect(q.dequeue()).toBe("c");
    expect(q.dequeue()).toBeUndefined();
  });

  it("peek does not remove", () => {
    const q = new BackgroundQueue<number>(2);
    q.enqueue(1);
    expect(q.peek()).toBe(1);
    expect(q.size).toBe(1);
    expect(q.dequeue()).toBe(1);
  });
});

describe("BackgroundQueue: bounded", () => {
  it("rejects overflow without evicting", () => {
    const q = new BackgroundQueue<string>(2);
    expect(q.enqueue("a")).toBe(true);
    expect(q.enqueue("b")).toBe(true);
    expect(q.isFull()).toBe(true);
    expect(q.enqueue("c")).toBe(false);
    expect(q.size).toBe(2);
    expect(q.toArray()).toEqual(["a", "b"]);
  });

  it("tracks empty/full/size/clear", () => {
    const q = new BackgroundQueue<string>(2);
    expect(q.isEmpty()).toBe(true);
    q.enqueue("x");
    expect(q.isEmpty()).toBe(false);
    expect(q.size).toBe(1);
    q.clear();
    expect(q.isEmpty()).toBe(true);
    expect(q.size).toBe(0);
  });

  it("rejects non-positive bounds", () => {
    expect(() => new BackgroundQueue<string>(0)).toThrow(RangeError);
    expect(() => new BackgroundQueue<string>(-1)).toThrow(RangeError);
  });

  it("holds up to MAX_BACKGROUND_QUEUE entries", async () => {
    const { MAX_BACKGROUND_QUEUE } = await import("@ai-desktop/ai-core");
    const q = new BackgroundQueue<number>(MAX_BACKGROUND_QUEUE);
    for (let i = 0; i < MAX_BACKGROUND_QUEUE; i++) {
      expect(q.enqueue(i)).toBe(true);
    }
    expect(q.isFull()).toBe(true);
    expect(q.enqueue(999)).toBe(false);
  }, 15000);
});
