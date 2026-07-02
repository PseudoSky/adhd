import type {
  DagJson,
  DagSnapshot,
  DispatchLogEntry,
  MilestoneDag,
  OperationDag,
  OperationStatus,
} from '@adhd/dispatch-spec';
import type { IDagSerializer } from './serializer.js';

export interface IDagClient {
  load(): Promise<DagJson>;
  getSnapshot(): Promise<DagSnapshot | null>;
  saveDag(dag: DagJson): Promise<void>;
  saveSnapshot(snapshot: DagSnapshot): Promise<void>;
  getOperation(id: string): Promise<OperationDag | undefined>;
  updateOperationStatus(id: string, status: OperationStatus): Promise<void>;
  getMilestone(slug: string): Promise<MilestoneDag | undefined>;
  clearPending(slug: string): Promise<void>;
  appendDispatchLog(entry: DispatchLogEntry): Promise<void>;
  getEligibleMilestones(): Promise<string[]>;
}

function normalizeDag(dag: DagJson): DagJson {
  if (Array.isArray(dag.operations)) return dag;
  return { ...dag, operations: Object.values(dag.operations) };
}

export class DagClient implements IDagClient {
  private _dag: DagJson | null = null;

  constructor(private readonly serializer: IDagSerializer) { }

  async load(): Promise<DagJson> {
    const dag = await this.serializer.readDag();
    if (!dag) throw new Error('No dag found — call saveDag first');
    this._dag = normalizeDag(dag);
    return this._dag;
  }

  async getSnapshot(): Promise<DagSnapshot | null> {
    return this.serializer.readSnapshot();
  }

  async saveDag(dag: DagJson): Promise<void> {
    this._dag = normalizeDag(dag);
    await this.serializer.writeDag(this._dag);
  }

  async saveSnapshot(snapshot: DagSnapshot): Promise<void> {
    await this.serializer.writeSnapshot(snapshot);
  }

  async getOperation(id: string): Promise<OperationDag | undefined> {
    await this.ensureLoaded();
    const ops = this.dag.operations as OperationDag[];
    return ops.find((o: OperationDag) => o.id === id);
  }

  async updateOperationStatus(
    id: string,
    status: OperationStatus
  ): Promise<void> {
    await this.ensureLoaded();
    const ops = this.dag.operations as OperationDag[];
    const op = ops.find((o: OperationDag) => o.id === id);
    if (!op) throw new Error(`Operation ${id} not found`);
    op.status = status;
    await this.serializer.writeDag(this.dag);
  }

  async getMilestone(slug: string): Promise<MilestoneDag | undefined> {
    await this.ensureLoaded();
    return this.dag.milestones[slug];
  }

  async clearPending(slug: string): Promise<void> {
    await this.ensureLoaded();
    const ms = this.dag.milestones[slug];
    if (!ms) throw new Error(`Milestone ${slug} not found`);
    ms.pending = null;
    await this.serializer.writeDag(this.dag);
  }

  async appendDispatchLog(entry: DispatchLogEntry): Promise<void> {
    await this.ensureLoaded();
    this.dag.dispatch_log.push(entry);
    await this.serializer.writeDag(this.dag);
  }

  async getEligibleMilestones(): Promise<string[]> {
    await this.ensureLoaded();
    const eligible: string[] = [];
    const milestones = this.dag.milestones;
    for (const slug of Object.keys(milestones)) {
      const ms = milestones[slug];
      if (ms.pending !== null) continue;
      const depsSatisfied = ms.depends_on.every((dep: string) =>
        this.isMilestoneComplete(dep)
      );
      if (depsSatisfied) eligible.push(slug);
    }
    return eligible;
  }

  /**
   * Derives whether a milestone has completed.
   *
   * `MilestoneDag` carries no `status` field of its own — a milestone's
   * `pending` field only tells us whether *its own* dispatch is queued
   * ("waiting to run"), not whether a milestone it depends on actually
   * finished. Completion has to be derived from data the dag already
   * records: the operations owned by the milestone
   * (`OperationDag.milestone === slug`) and the `dispatch_log` entries
   * appended via `appendDispatchLog()` as those operations are dispatched.
   *
   * A milestone is complete iff every operation it owns has at least one
   * `DispatchResult` — across all `dispatch_log` entries — recording that
   * operation's id with `status: 'complete'`. A milestone with zero
   * operations is never considered complete (nothing has run to prove
   * it), and a failed/skipped/in-flight result (or no result at all)
   * correctly leaves the milestone — and anything depending on it —
   * incomplete.
   *
   * This reads only `this.dag` (operations + dispatch_log), which
   * `getEligibleMilestones()` has already loaded via `ensureLoaded()` —
   * no extra I/O. A cached `DagSnapshot` (whose `MilestoneSnapshot.status`
   * would be an equally valid, likely cheaper, completion signal) is not
   * consulted here because `DagClient` does not currently cache one
   * in-memory; `getSnapshot()` always re-reads from the serializer, and
   * this method must stay synchronous with the already-loaded dag.
   */
  private isMilestoneComplete(slug: string): boolean {
    const ops = (this.dag.operations as OperationDag[]).filter(
      (op) => op.milestone === slug
    );
    if (ops.length === 0) return false;
    const completedOpIds = new Set<string>();
    for (const entry of this.dag.dispatch_log) {
      for (const result of entry.results) {
        if (result.status === 'complete') completedOpIds.add(result.op_id);
      }
    }
    return ops.every((op) => completedOpIds.has(op.id));
  }

  private get dag(): DagJson {
    if (!this._dag) throw new Error('Not loaded — call load() first');
    return this._dag;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this._dag) await this.load();
  }
}

export function createDagClient(serializer: IDagSerializer): IDagClient {
  return new DagClient(serializer);
}
