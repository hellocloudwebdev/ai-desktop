// PR43: packages/agent-runtime — Bounded FIFO Background Queue
//
// Thin in-memory FIFO used by BackgroundTaskManager to order queued tasks.
// Bounded by MAX_BACKGROUND_QUEUE (ai-core); overflow is signalled to the
// caller as { code: 'queue-full' } — the queue itself never grows unbounded.
//
// No distributed queue, no persistence, no Electron/Prisma/fs/network.
// Only local types; safe for in-process use.

export class BackgroundQueue<T> {
  private readonly _items: T[] = [];
  private readonly _maxSize: number;

  constructor(maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(`BackgroundQueue maxSize must be a positive integer (got ${maxSize})`);
    }
    this._maxSize = maxSize;
  }

  get maxSize(): number {
    return this._maxSize;
  }

  get size(): number {
    return this._items.length;
  }

  isFull(): boolean {
    return this._items.length >= this._maxSize;
  }

  isEmpty(): boolean {
    return this._items.length === 0;
  }

  /**
   * Enqueues an item. Returns true on success, false when the bound is hit
   * (caller surfaces `queue-full`; the item is dropped, never evicts).
   */
  enqueue(item: T): boolean {
    if (this.isFull()) return false;
    this._items.push(item);
    return true;
  }

  /** Dequeues the oldest item (FIFO) or undefined when empty. */
  dequeue(): T | undefined {
    return this._items.shift();
  }

  /** Peeks at the oldest item without removing it. */
  peek(): T | undefined {
    return this._items[0];
  }

  toArray(): T[] {
    return [...this._items];
  }

  clear(): void {
    this._items.length = 0;
  }
}
