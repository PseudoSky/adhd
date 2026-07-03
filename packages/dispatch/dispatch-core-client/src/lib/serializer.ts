import type { DagJson, DagSnapshot } from '@adhd/dispatch-spec';

export interface IDagSerializer {
  readDag(): Promise<DagJson | null>;
  writeDag(dag: DagJson): Promise<void>;
  readSnapshot(): Promise<DagSnapshot | null>;
  writeSnapshot(snapshot: DagSnapshot): Promise<void>;
}
