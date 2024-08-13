export interface ObjectType<T> {
    [key: number]: T;
}

export class Stack<T> {
  private _stack: ObjectType<T>;
  private _count: number;

  constructor() {
    this._stack = {};
    this._count = 0;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  get size(): number {
    return this._count;
  }

  push(value: T) {
    this._stack[this._count] = value;
    this._count++;
  }

  pop(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    this._count--;
    const value = this._stack[this._count];
    delete this._stack[this._count];
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
  
    constructor(data?: T[] ) {
        this._queue = {};
        this._head = 0;
        this._tail = 0;
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
    }
  
    dequeue(): T | undefined {
      if (this.isEmpty) {
        return undefined;
      }
      const value = this._queue[this._head];
      delete this._queue[this._head];
      this._head++;
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
    }
  }