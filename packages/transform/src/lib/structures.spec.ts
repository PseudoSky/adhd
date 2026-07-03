import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Counter, EventCallbacks, EventCallbacksQueue, Queue, Stack } from './structures';

describe('Stack', () => {
  let stack: Stack<number>;
  beforeEach(() => {
    stack = new Stack();
  });

  it('1. Empty stack', () => {
    expect(stack.size).toBe(0);
    expect(stack.isEmpty).toBe(true);
  });

  it('2. Push', () => {
    stack.push(1);
    expect(stack.size).toBe(1);
    stack.push(2);
    expect(stack.size).toBe(2);
    stack.push(3);
    expect(stack.size).toBe(3);
  });

  it('3. Pop', () => {
    prePush(stack);
    expect(stack.pop()).toBe(3);
    expect(stack.pop()).toBe(2);
    expect(stack.pop()).toBe(1);
    expect(stack.pop()).toBe(undefined);
    expect(stack.isEmpty).toBe(true);
    expect(stack.size).toBe(0);
  });

  it('4. Peek', () => {
    prePush(stack);
    expect(stack.peek()).toBe(3);
  });

  it('5. Clear', () => {
    prePush(stack);
    stack.clear();
    expect(stack.isEmpty).toBe(true);
    expect(stack.size).toBe(0);
  });

  it('6. To Array', () => {
    prePush(stack);
    expect(stack.toArray()).toEqual([3, 2, 1]);
  });

  function prePush(s: Stack<number>) {
    s.push(1);
    s.push(2);
    s.push(3);
  }
});

describe('Stack with Callbacks', () => {
  it('should call onPush callback', () => {
    const pushSpy = vi.fn();
    const callbacks: EventCallbacks<number> = { onPush: pushSpy };
    const stack = new Stack(callbacks);

    stack.push(5);
    expect(pushSpy).toHaveBeenCalledWith(5);
  });

  it('should call onPop callback', () => {
    const popSpy = vi.fn();
    const callbacks: EventCallbacks<number> = { onPop: popSpy };
    const stack = new Stack(callbacks);

    stack.push(10);
    const result = stack.pop();

    expect(popSpy).toHaveBeenCalledWith(10);
    expect(result).toBe(10);
  });

  it('should call onClear callback', () => {
    const clearSpy = vi.fn();
    const callbacks: EventCallbacks<number> = { onClear: clearSpy };
    const stack = new Stack(callbacks);

    stack.push(1);
    stack.clear();

    expect(clearSpy).toHaveBeenCalled();
    expect(stack.isEmpty).toBe(true);
  });

  it('should not call onPop if stack is empty', () => {
    const popSpy = vi.fn();
    const callbacks: EventCallbacks<number> = { onPop: popSpy };
    const stack = new Stack(callbacks);

    stack.pop();

    expect(popSpy).not.toHaveBeenCalled();
  });
});

describe('Queue', () => {
  let queue: Queue<number>;
  beforeEach(() => {
    queue = new Queue();
  });

  it('1. Empty queue', () => {
    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });

  it('2. Enqueue', () => {
    queue.enqueue(1);
    expect(queue.length).toBe(1);
    queue.enqueue(2);
    expect(queue.length).toBe(2);
    queue.enqueue(3);
    expect(queue.length).toBe(3);
  });

  it('3. Dequeue', () => {
    preEnqueue(queue);
    expect(queue.dequeue()).toBe(1);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBe(undefined);
    expect(queue.isEmpty).toBe(true);
    expect(queue.length).toBe(0);
  });

  it('4. Peek', () => {
    preEnqueue(queue);
    expect(queue.peek()).toBe(1);
  });

  it('5. Clear', () => {
    preEnqueue(queue);
    queue.clear();
    expect(queue.isEmpty).toBe(true);
    expect(queue.length).toBe(0);
  });

  it('6. To Array', () => {
    preEnqueue(queue);
    expect(queue.toArray()).toEqual([3, 2, 1]);
  });

  function preEnqueue(q: Queue<number>) {
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
  }
});

describe('Queue with Callbacks', () => {
  it('should call onEnqueue callback', () => {
    const enqueueSpy = vi.fn();
    const callbacks: EventCallbacksQueue<number> = { onEnqueue: enqueueSpy };
    const queue = new Queue([], callbacks);

    queue.enqueue(5);
    expect(enqueueSpy).toHaveBeenCalledWith(5);
  });

  it('should call onDequeue callback', () => {
    const dequeueSpy = vi.fn();
    const callbacks: EventCallbacksQueue<number> = { onDequeue: dequeueSpy };
    const queue = new Queue([], callbacks);

    queue.enqueue(10);
    const result = queue.dequeue();

    expect(dequeueSpy).toHaveBeenCalledWith(10);
    expect(result).toBe(10);
  });

  it('should call onClear callback', () => {
    const clearSpy = vi.fn();
    const callbacks: EventCallbacksQueue<number> = { onClear: clearSpy };
    const queue = new Queue([], callbacks);

    queue.enqueue(1);
    queue.clear();

    expect(clearSpy).toHaveBeenCalled();
    expect(queue.isEmpty).toBe(true);
  });
});

describe('Counter', () => {
  it('should increment total when no countBy provided', () => {
    const counter = new Counter<string>();

    counter.increment('value1');
    counter.increment('value2');
    counter.decrement('value1');

    expect(counter.value('anything')).toBe(1); // total is 1 for any value
    expect(counter.toJson()).toEqual({ total: 1 });
  });

  it('should support custom increment amounts', () => {
    const counter = new Counter<string>();

    counter.increment('item', 5);
    counter.increment('item', 3);
    counter.decrement('item', 2);

    expect(counter.value('item')).toBe(6); // 5 + 3 - 2
  });

  it('should track by key when countBy provided', () => {
    interface Item {
      type: string;
      data: string;
    }
    const countBy = (value: Item) => value.type;
    const counter = new Counter<Item>(countBy);

    counter.increment({ type: 'site', data: 'x' });
    counter.increment({ type: 'local', data: 'y' });
    counter.increment({ type: 'site', data: 'z' });
    counter.decrement({ type: 'site', data: 'x' });

    const json = counter.toJson();
    expect(json['site']).toBe(1); // 2 increments - 1 decrement
    expect(json['local']).toBe(1);
  });

  it('should track with string extraction', () => {
    const countBy = (value: string) => value.split(':')[0];
    const counter = new Counter<string>(countBy);

    counter.increment('type1:data');
    counter.increment('type2:data');
    counter.decrement('type1:data');

    const json = counter.toJson();
    expect(json['type1']).toBe(0); // 1 - 1
    expect(json['type2']).toBe(1);
  });

  it('should reset a specific key by direct key name', () => {
    const counter = new Counter<string>((s) => s.split('-')[0]);

    counter.increment('a-item1', 5);
    counter.increment('b-item2', 3);
    counter.reset('a');

    expect(counter.value('a-anything')).toBe(0);
    expect(counter.toJson()).toEqual({ a: 0, b: 3 });
  });

  it('should handle negative values', () => {
    const counter = new Counter<string>();

    counter.increment('item', 10);
    counter.decrement('item', 15);

    expect(counter.value('item')).toBe(-5);
  });

  it('should handle tuples from Stack', () => {
    type Tuple = [string, unknown];
    const countBy = (value: Tuple) => value[0];
    const counter = new Counter<Tuple>(countBy);

    counter.increment(['site', 'data1']);
    counter.increment(['local', 'data2']);
    counter.increment(['site', 'data3']);
    counter.decrement(['site', 'data1']);

    const json = counter.toJson();
    expect(json['site']).toBe(1); // 2 - 1
    expect(json['local']).toBe(1);
  });

  it('should clear all counters', () => {
    const counter = new Counter<string>();

    counter.increment('a', 5);
    counter.increment('b', 3);
    counter.clear();

    expect(counter.toJson()).toEqual({});
  });
});