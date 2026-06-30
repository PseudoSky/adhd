import type { DagJson, DagSnapshot, DispatchLogEntry } from '@adhd/dispatch-spec';
import type { IDagSerializer } from './serializer';
import { DagClient, createDagClient } from './client';
import { describe, it, expect, beforeEach } from 'vitest';

class InMemorySerializer implements IDagSerializer {
  private dag: DagJson | null = null;
  private snapshot: DagSnapshot | null = null;

  setDag(dag: DagJson): void {
    this.dag = dag;
  }

  setSnapshot(snapshot: DagSnapshot): void {
    this.snapshot = snapshot;
  }

  async readDag(): Promise<DagJson | null> {
    return this.dag;
  }

  async writeDag(dag: DagJson): Promise<void> {
    this.dag = JSON.parse(JSON.stringify(dag));
  }

  async readSnapshot(): Promise<DagSnapshot | null> {
    return this.snapshot;
  }

  async writeSnapshot(snapshot: DagSnapshot): Promise<void> {
    this.snapshot = JSON.parse(JSON.stringify(snapshot));
  }
}

function makeFixtureDag(): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'brownfield',
    description: 'test',
    problem: 'test',
    approach: 'test',
    executor: 'test',
    phases: ['phase1'],
    terminal: 'op-d',
    optimization: {
      sentinel_fanout: { enabled: false, write_multiplier: 0, read_multiplier: 0, hit_probability: 0 },
      b_per_tier: {},
      context_window_per_tier: {},
      context_window_override: null,
      b_override: null,
    },
    providers: {},
    effort_max_tokens: {},
    milestones: {
      'm1': {
        description: 'milestone one',
        authored_by: 'test',
        pending: 'op-b',
        triggered_by: null,
        phase: 'phase1',
        depends_on: [],
        agent: null,
        model: null,
        effort: null,
        two_stage: false,
        read_only: [],
        guard: null,
      },
      'm2': {
        description: 'milestone two',
        authored_by: 'test',
        pending: 'op-d',
        triggered_by: null,
        phase: 'phase1',
        depends_on: ['m1'],
        agent: null,
        model: null,
        effort: null,
        two_stage: false,
        read_only: [],
        guard: null,
      },
    },
    operations: [
      { id: 'op-a', milestone: 'm1', depends_on: [], type: 'automated', action: 'create', file: null, symbol: null, provenance: null, confidence: null, audit_check: null, criteria: [], tool: null, args: null, guard: null, to_file: null, to_symbol: null, ki_estimate: null, ki_source: null, authored_by: 'test', status: 'complete', shape: null },
      { id: 'op-b', milestone: 'm1', depends_on: ['op-a'], type: 'automated', action: 'create', file: null, symbol: null, provenance: null, confidence: null, audit_check: null, criteria: [], tool: null, args: null, guard: null, to_file: null, to_symbol: null, ki_estimate: null, ki_source: null, authored_by: 'test', status: 'pending', shape: null },
      { id: 'op-c', milestone: 'm2', depends_on: ['op-b'], type: 'automated', action: 'create', file: null, symbol: null, provenance: null, confidence: null, audit_check: null, criteria: [], tool: null, args: null, guard: null, to_file: null, to_symbol: null, ki_estimate: null, ki_source: null, authored_by: 'test', status: 'complete', shape: null },
      { id: 'op-d', milestone: 'm2', depends_on: ['op-c'], type: 'automated', action: 'create', file: null, symbol: null, provenance: null, confidence: null, audit_check: null, criteria: [], tool: null, args: null, guard: null, to_file: null, to_symbol: null, ki_estimate: null, ki_source: null, authored_by: 'test', status: 'pending', shape: null },
    ],
    dispatch_log: [],
  };
}

describe('DagClient', () => {
  let serializer: InMemorySerializer;
  let client: DagClient;

  beforeEach(() => {
    serializer = new InMemorySerializer();
    client = new DagClient(serializer);
  });

  describe('load', () => {
    it('loads dag and populates caches', async () => {
      serializer.setDag(makeFixtureDag());
      const dag = await client.load();
      expect(dag.plan_kind).toBe('brownfield');
      const op = await client.getOperation('op-a');
      expect(op).toBeDefined();
      expect(op!.status).toBe('complete');
      const ms = await client.getMilestone('m1');
      expect(ms).toBeDefined();
      expect(ms!.pending).toBe('op-b');
    });

    it('throws when no dag exists', async () => {
      await expect(client.load()).rejects.toThrow('No DagJson found');
    });
  });

  describe('getOperation', () => {
    it('returns undefined for missing operation', async () => {
      serializer.setDag(makeFixtureDag());
      const op = await client.getOperation('nonexistent');
      expect(op).toBeUndefined();
    });

    it('auto-loads dag on first access', async () => {
      serializer.setDag(makeFixtureDag());
      const op = await client.getOperation('op-a');
      expect(op).toBeDefined();
      expect(op!.id).toBe('op-a');
    });
  });

  describe('getMilestone', () => {
    it('returns undefined for missing milestone', async () => {
      serializer.setDag(makeFixtureDag());
      const ms = await client.getMilestone('nonexistent');
      expect(ms).toBeUndefined();
    });
  });

  describe('updateOperationStatus', () => {
    it('updates status and persists', async () => {
      serializer.setDag(makeFixtureDag());
      await client.updateOperationStatus('op-b', 'complete');
      const op = await client.getOperation('op-b');
      expect(op!.status).toBe('complete');
      const saved = await serializer.readDag();
      const ops = Array.isArray(saved!.operations) ? saved!.operations : Object.values(saved!.operations);
      const found = ops.find(o => o.id === 'op-b');
      expect(found!.status).toBe('complete');
    });

    it('throws for unknown operation', async () => {
      serializer.setDag(makeFixtureDag());
      await expect(client.updateOperationStatus('nope', 'complete')).rejects.toThrow('Operation nope not found');
    });
  });

  describe('clearPending', () => {
    it('clears milestone pending field', async () => {
      serializer.setDag(makeFixtureDag());
      await client.clearPending('m1');
      const ms = await client.getMilestone('m1');
      expect(ms!.pending).toBeNull();
    });

    it('throws for unknown milestone', async () => {
      serializer.setDag(makeFixtureDag());
      await expect(client.clearPending('nope')).rejects.toThrow('Milestone nope not found');
    });
  });

  describe('appendDispatchLog', () => {
    it('appends entry and persists', async () => {
      serializer.setDag(makeFixtureDag());
      const entry: DispatchLogEntry = {
        id: 'log-1',
        kind: 'execution',
        provider: 'anthropic',
        model: 'claude-3',
        agent: 'test-agent',
        effort: 'medium',
        started_at: '2024-01-01T00:00:00Z',
        completed_at: null,
        operations: ['op-b'],
        turns: [],
        results: [],
        notes: [],
      };
      await client.appendDispatchLog(entry);
      const saved = await serializer.readDag();
      expect(saved!.dispatch_log).toHaveLength(1);
      expect(saved!.dispatch_log[0].id).toBe('log-1');
    });
  });

  describe('getEligibleMilestones', () => {
    it('returns milestones whose pending op deps are met', async () => {
      serializer.setDag(makeFixtureDag());
      const eligible = await client.getEligibleMilestones();
      expect(eligible).toContain('m1');
      expect(eligible).not.toContain('m2');
    });
  });

  describe('createDagClient factory', () => {
    it('returns a DagClient instance', () => {
      const c = createDagClient(serializer);
      expect(c).toBeInstanceOf(DagClient);
    });
  });
});
