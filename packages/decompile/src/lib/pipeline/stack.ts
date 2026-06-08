import { Transform } from '@adhd/transform';
import { RawSourceMap } from 'source-map';
/**
 * Pipeline stack for tracking decompiled objects by type.
 * Tracks items through site, local, raw, link, map, source, and write stages.
 * Counter tracks active items in the stack by type.
 */
const { Stack, Counter } = Transform;
export type StackItem = { path: string; data: string; mapping?: RawSourceMap }

export class PipelineStack {
  private _stack: InstanceType<typeof Stack<[string, StackItem]>>;
  private _counter: InstanceType<typeof Counter<[string, StackItem]>>;

  constructor() {
    this._counter = new Counter<[string, StackItem]>((value) => {
      // Extract type from [type, value] tuple
      return Array.isArray(value) ? (value[0] as string) : 'unknown';
    });

    this._stack = new Stack<[string, StackItem]>({
      onPush: (value): void => this._counter.increment(value),
      onPop: (value): void => { value !== undefined && this._counter.decrement(value); },
      onClear: (): void => this._counter.clear(),
    });
  }

  /**
   * Get current counter state showing active items by type.
   */
  public get counters(): Record<string, number> {
    return this._counter.toJson();
  }

  public push(type: string, value: StackItem): void {
    this._stack.push([type, value]);
  }

  public pop(): [string, StackItem] | null {
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
