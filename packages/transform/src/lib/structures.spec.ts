import { Stack, Queue } from './structures'
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
      expect(queue.toArray()).toEqual([3,2,1]);
    });
  
    function preEnqueue(q: Queue<number>) {
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);
    }
});
  
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
      expect(stack.toArray()).toEqual([3,2,1]);
    });
  
    function prePush(s: Stack<number>) {
      s.push(1);
      s.push(2);
      s.push(3);
    }
  });