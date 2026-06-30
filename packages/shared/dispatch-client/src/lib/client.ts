import type { DagJson, DagSnapshot, OperationDag, MilestoneDag, OperationStatus, DispatchLogEntry } from '@adhd/dispatch-spec';
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

  constructor(private readonly serializer: IDagSerializer) {}

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
    return this._dag!.operations.find(o => o.id === id);
  }

  async updateOperationStatus(id: string, status: OperationStatus): Promise<void> {
    await this.ensureLoaded();
    const op = this._dag!.operations.find(o => o.id === id);
    if (!op) throw new Error(`Operation ${id} not found`);
    op.status = status;
    await this.serializer.writeDag(this._dag!);
  }

  async getMilestone(slug: string): Promise<MilestoneDag | undefined> {
    await this.ensureLoaded();
    return this._dag!.milestones[slug];
  }

  async clearPending(slug: string): Promise<void> {
    await this.ensureLoaded();
    const ms = this._dag!.milestones[slug];
    if (!ms) throw new Error(`Milestone ${slug} not found`);
    ms.pending = null;
    await this.serializer.writeDag(this._dag!);
  }

  async appendDispatchLog(entry: DispatchLogEntry): Promise<void> {
    await this.ensureLoaded();
    this._dag!.dispatch_log.push(entry);
    await this.serializer.writeDag(this._dag!);
  }

  async getEligibleMilestones(): Promise<string[]> {
    await this.ensureLoaded();
    const eligible: string[] = [];
    for (const [slug, ms] of Object.entries(this._dag!.milestones)) {
      if (ms.pending !== null) continue;
      const depsSatisfied = ms.depends_on.every(dep => {
        const depMs = this._dag!.milestones[dep];
        return depMs && depMs.pending === null;
      });
      if (depsSatisfied) eligible.push(slug);
    }
    return eligible;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this._dag) await this.load();
  }
}

export function createDagClient(serializer: IDagSerializer): IDagClient {
  return new DagClient(serializer);
}
