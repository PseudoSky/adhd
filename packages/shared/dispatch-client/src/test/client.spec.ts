import type { DagJson, DagSnapshot, DispatchLogEntry } from '@adhd/dispatch-spec';
import type { IDagSerializer } from '../lib/serializer.js';
import { DagClient, createDagClient } from '../lib/client.js';

class InMemorySerializer implements IDagSerializer {
  private dag: DagJson | null = null;
  private snapshot: DagSnapshot | null = null;

  async readDag(): Promise<DagJson | null> {
    return this.dag ? JSON.parse(JSON.stringify(this.dag)) : null;
  }
  async writeDag(dag: DagJson): Promise<void> {
    this.dag = JSON.parse(JSON.stringify(dag));
  }
  async readSnapshot(): Promise<DagSnapshot | null> {
    return this.snapshot ? JSON.parse(JSON.stringify(this.snapshot)) : null;
  }
  async writeSnapshot(snapshot: DagSnapshot): Promise<void> {
    this.snapshot = JSON.parse(JSON.stringify(snapshot));
  }
}

function makeTestDag(): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'brownfield',
    description: 'Test plan',
    problem: 'Test problem',
    approach: 'Test approach',
    executor: 'test-executor',
    phases: ['alpha', 'beta'],
    terminal: 'beta',
    optimization: {
      sentinel_fanout: { enabled: false, write_multiplier: 1, read_multiplier: 1, hit_probability: 0 },
      b_per_tier: { Haiku: 8000, Sonnet: 15000, Opus: 27000 },
      context_window_per_tier: { Haiku: 16000, Sonnet: 16000, Opus: 32000 },
      context_window_override: null,
      b_override: null,
    },
    providers: {},
    effort_max_tokens: { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 },
    milestones: {
      alpha: {
        description: 'Alpha milestone',
        authored_by: 'test',
        pending: null,
        triggered_by: null,
        phase: 'alpha',
        depends_on: [],
        agent: null,
        model: null,
        effort: null,
        two_stage: false,
        read_only: [],
        guard: null,
      },
      beta: {
        description: 'Beta milestone',
        authored_by: 'test',
        pending: 'some-pending',
        triggered_by: null,
        phase: 'beta',
        depends_on: ['alpha'],
        agent: null,
        model: null,
        effort: null,
        two_stage: false,
        read_only: [],
        guard: null,
      },
    },
    operations: [
      {
        id: 'op-1',
        milestone: 'alpha',
        depends_on: [],
        type: 'generative',
        action: 'create',
        file: 'test.ts',
        symbol: null,
        provenance: null,
        confidence: null,
        audit_check: null,
        criteria: [],
        tool: null,
        args: null,
        guard: null,
        to_file: null,
        to_symbol: null,
        ki_estimate: null,
        ki_source: null,
        authored_by: 'test',
        status: 'pending',
        shape: null,
      },
    ],
    dispatch_log: [],
  };
}

describe('DagClient', () => {
  let serializer: InMemorySerializer;
  let client: DagClient;

  beforeEach(() => {
    serializer = new InMemorySerializer();
    client = createDagClient(serializer);
  });

  describe('load / saveDag', () => {
    it('throws when no dag has been saved', async () => {
      await expect(client.load()).rejects.toThrow('No dag found');
    });

    it('saves and loads a dag', async () => {
      const dag = makeTestDag();
      await client.saveDag(dag);
      const loaded = await client.load();
      expect(loaded.schema_version).toBe(4);
      expect(loaded.description).toBe('Test plan');
    });
  });

  describe('getOperation', () => {
    it('returns the operation by id', async () => {
      await client.saveDag(makeTestDag());
      const op = await client.getOperation('op-1');
      expect(op).toBeDefined();
      expect(op!.id).toBe('op-1');
      expect(op!.milestone).toBe('alpha');
    });

    it('returns undefined for unknown id', async () => {
      await client.saveDag(makeTestDag());
      const op = await client.getOperation('nonexistent');
      expect(op).toBeUndefined();
    });
  });

  describe('updateOperationStatus', () => {
    it('updates and persists the status', async () => {
      await client.saveDag(makeTestDag());
      await client.updateOperationStatus('op-1', 'complete');
      const op = await client.getOperation('op-1');
      expect(op!.status).toBe('complete');
    });

    it('throws for unknown operation', async () => {
      await client.saveDag(makeTestDag());
      await expect(client.updateOperationStatus('bad', 'complete')).rejects.toThrow('Operation bad not found');
    });
  });

  describe('getMilestone', () => {
    it('returns the milestone by slug', async () => {
      await client.saveDag(makeTestDag());
      const ms = await client.getMilestone('alpha');
      expect(ms).toBeDefined();
      expect(ms!.description).toBe('Alpha milestone');
    });

    it('returns undefined for unknown slug', async () => {
      await client.saveDag(makeTestDag());
      const ms = await client.getMilestone('nonexistent');
      expect(ms).toBeUndefined();
    });
  });

  describe('clearPending', () => {
    it('clears the pending field', async () => {
      await client.saveDag(makeTestDag());
      await client.clearPending('beta');
      const ms = await client.getMilestone('beta');
      expect(ms!.pending).toBeNull();
    });

    it('throws for unknown milestone', async () => {
      await client.saveDag(makeTestDag());
      await expect(client.clearPending('nonexistent')).rejects.toThrow('Milestone nonexistent not found');
    });
  });

  describe('getEligibleMilestones', () => {
    it('returns milestones with pending=null and deps satisfied', async () => {
      await client.saveDag(makeTestDag());
      const eligible = await client.getEligibleMilestones();
      expect(eligible).toEqual(['alpha']);
    });

    it('returns beta after clearing its pending and alpha is resolved', async () => {
      await client.saveDag(makeTestDag());
      await client.clearPending('beta');
      const eligible = await client.getEligibleMilestones();
      expect(eligible).toEqual(['alpha', 'beta']);
    });

    it('returns empty when all milestones have pending set', async () => {
      const dag = makeTestDag();
      dag.milestones.alpha.pending = 'some-pending';
      dag.milestones.beta.pending = 'other-pending';
      await client.saveDag(dag);
      const eligible = await client.getEligibleMilestones();
      expect(eligible).toEqual([]);
    });
  });

  describe('appendDispatchLog', () => {
    it('appends an entry and persists', async () => {
      await client.saveDag(makeTestDag());
      const entry: DispatchLogEntry = {
        id: 'log-1',
        kind: 'planning',
        provider: 'local',
        model: null,
        agent: 'test-agent',
        effort: null,
        started_at: '2024-01-01T00:00:00Z',
        completed_at: null,
        operations: ['op-1'],
        turns: [],
        results: [],
        notes: [],
      };
      await client.appendDispatchLog(entry);
      const entry2: DispatchLogEntry = {
        id: 'log-2',
        kind: 'execution',
        provider: 'local',
        model: null,
        agent: 'test-agent',
        effort: 'medium',
        started_at: '2024-01-01T01:00:00Z',
        completed_at: null,
        operations: ['op-1'],
        turns: [],
        results: [],
        notes: [],
      };
      await client.appendDispatchLog(entry2);
      const dag = await client.load();
      expect(dag.dispatch_log).toHaveLength(2);
      expect(dag.dispatch_log[0].id).toBe('log-1');
      expect(dag.dispatch_log[1].id).toBe('log-2');
    });
  });

  describe('getSnapshot / saveSnapshot', () => {
    it('returns null when no snapshot saved', async () => {
      const snap = await client.getSnapshot();
      expect(snap).toBeNull();
    });

    it('saves and retrieves a snapshot', async () => {
      const snapshot: DagSnapshot = {
        snapshot_at: '2024-01-01T00:00:00Z',
        snapshot_version: 1,
        plan: 'test',
        schema_version: 4,
        plan_kind: 'brownfield',
        description: 'snapshot test',
        problem: '',
        approach: '',
        executor: '',
        phases: [],
        terminal: '',
        optimization: {
          sentinel_fanout: { enabled: false, write_multiplier: 1, read_multiplier: 0, hit_probability: 0 },
          b_per_tier: { Haiku: 8000 },
          b_eff_per_tier: { Haiku: 8000 },
          context_window_per_tier: { Haiku: 16000 },
          context_window_override: null,
          b_override: null,
        },
        milestones: {},
        operations: [],
        pairwise_overlap: {},
        open_questions: [],
      };
      await client.saveSnapshot(snapshot);
      const retrieved = await client.getSnapshot();
      expect(retrieved).toBeDefined();
      expect(retrieved!.plan).toBe('test');
    });
  });

  describe('createDagClient factory', () => {
    it('returns a DagClient instance', () => {
      const client2 = createDagClient(serializer);
      expect(client2).toBeInstanceOf(DagClient);
    });
  });
});
