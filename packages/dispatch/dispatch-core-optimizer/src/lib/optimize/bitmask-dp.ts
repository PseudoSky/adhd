import type {
  DagSnapshot,
  DispatchUnit,
  IOptimizerDeps,
} from '@adhd/dispatch-spec';

export function optimize(
  snapshot: DagSnapshot,
  deps: IOptimizerDeps
): DispatchUnit[] {
  return [];
}
