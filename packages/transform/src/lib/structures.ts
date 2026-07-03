export interface ObjectType<T> {
  [key: number]: T;
}

export interface EventCallbacks<T> {
  onPush?: (value: T) => void;
  onPop?: (value: T | undefined) => void;
  onClear?: () => void;
}

export interface EventCallbacksQueue<T> {
  onEnqueue?: (value: T) => void;
  onDequeue?: (value: T | undefined) => void;
  onClear?: () => void;
}

export class Stack<T> {
  private _stack: ObjectType<T>;
  private _count: number;
  private _callbacks?: EventCallbacks<T>;

  constructor(callbacks?: EventCallbacks<T>) {
    this._stack = {};
    this._count = 0;
    this._callbacks = callbacks;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  get size(): number {
    return this._count;
  }

  push(value: T): void {
    this._stack[this._count] = value;
    this._count++;
    this._callbacks?.onPush?.(value);
  }

  pop(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    this._count--;
    const value = this._stack[this._count];
    delete this._stack[this._count];
    this._callbacks?.onPop?.(value);
    return value;
  }

  peek(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    return this._stack[this._count - 1];
  }

  clear(): void {
    this._stack = {};
    this._count = 0;
    this._callbacks?.onClear?.();
  }

  toArray(): T[] {
    if (this.isEmpty) {
      return [];
    }
    const values: T[] = [];
    for (let i = 0; i < this._count; i++) {
      values.unshift(this._stack[i]);
    }
    return values;
  }
}

export class Queue<T> {
  private _queue: ObjectType<T>;
  private _head: number;
  private _tail: number;
  private _callbacks?: EventCallbacksQueue<T>;

  constructor(data?: T[], callbacks?: EventCallbacksQueue<T>) {
    this._queue = {};
    this._head = 0;
    this._tail = 0;
    this._callbacks = callbacks;
    data?.forEach(d => this.enqueue(d))
  }

  get isEmpty() {
    return this.length === 0;
  }

  get length() {
    return this._tail - this._head;
  }

  enqueue(value: T): void {
    this._queue[this._tail] = value;
    this._tail++;
    this._callbacks?.onEnqueue?.(value);
  }

  dequeue(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    const value = this._queue[this._head];
    delete this._queue[this._head];
    this._head++;
    this._callbacks?.onDequeue?.(value);
    return value;
  }

  peek(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    return this._queue[this._head];
  }

  toArray(): T[] {
    if (this.isEmpty) {
      return [];
    }
    const values: T[] = [];
    for (let i = this._head; i < this._tail; i++) {
      values.unshift(this._queue[i]);
    }
    return values;
  }

  clear(): void {
    this._queue = {};
    this._head = 0;
    this._tail = 0;
    this._callbacks?.onClear?.();
  }
}

/**
 * Counter class for tracking values by key.
 * Generic type T represents the type of value being counted.
 * Automatically extracts keys from data using countBy function if provided.
 */
export class Counter<T = unknown> {
  private _counters: Record<string, number> = {};
  private _countBy?: (value: T) => string;

  constructor(countBy?: (value: T) => string) {
    this._countBy = countBy;
  }

  /**
   * Increment counter for a value by the given amount (default 1).
   * If countBy is defined, uses it to extract the key; otherwise uses 'total'.
   */
  increment(value: T, amount = 1): void {
    const key = this._countBy ? this._countBy(value) : 'total';
    this._counters[key] = (this._counters[key] ?? 0) + amount;
  }

  /**
   * Decrement counter for a value by the given amount (default 1).
   * If countBy is defined, uses it to extract the key; otherwise uses 'total'.
   */
  decrement(value: T, amount = 1): void {
    const key = this._countBy ? this._countBy(value) : 'total';
    this._counters[key] = (this._counters[key] ?? 0) - amount;
  }

  /**
   * Get the current value for a key.
   * If countBy is defined, uses it to extract the key; otherwise uses 'total'.
   */
  value(value: T): number {
    const key = this._countBy ? this._countBy(value) : 'total';
    return this._counters[key] ?? 0;
  }

  /**
   * Reset a specific key's counter to 0.
   */
  reset(key: string): void {
    this._counters[key] = 0;
  }

  /**
   * Get all counters as a JSON object.
   */
  toJson(): Record<string, number> {
    return { ...this._counters };
  }

  /**
   * Clear all counters.
   */
  clear(): void {
    this._counters = {};
  }
}

export default {
  Stack,
  Queue,
  Counter,
};