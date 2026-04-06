import { Transform } from '@adhd/transform';
/**
 * Pipeline stack for tracking decompiled objects by type.
 * Tracks items through site, local, raw, link, map, source, and write stages.
 * Counter tracks active items in the stack by type.
 */
const { Stack, Counter } = Transform;
export class PipelineStack {
  private _stack: InstanceType<typeof Stack<[string, unknown]>>;
  private _counter: InstanceType<typeof Counter<[string, unknown]>>;

  constructor() {
    this._counter = new Counter<[string, unknown]>((value) => {
      // Extract type from [type, value] tuple
      return Array.isArray(value) ? (value[0] as string) : 'unknown';
    });

    this._stack = new Stack<[string, unknown]>({
      onPush: (value) => this._counter.increment(value),
      onPop: (value) => this._counter.decrement(value),
      onClear: () => this._counter.clear(),
    });
  }

  /**
   * Get current counter state showing active items by type.
   */
  public get counters(): Record<string, number> {
    return this._counter.toJson();
  }

  public push(type: string, value: unknown): void {
    this._stack.push([type, value]);
  }

  public pop(): [string, unknown] | null {
    return this._stack.pop() ?? null;
  }

  public hasMore(): boolean {
    return !this._stack.isEmpty;
  }

  /**
   * Check if stack is empty (no active items).
   */
  public isEmpty(): boolean {
    return this._stack.isEmpty;
  }
}

export default PipelineStack;
