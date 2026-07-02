import type {
  DagJson,
  DagSnapshot,
  IOptimizerDeps,
} from '@adhd/dispatch-spec';

export function snapshot(dag: DagJson, deps: IOptimizerDeps): DagSnapshot {
  return {} as DagSnapshot;
}
