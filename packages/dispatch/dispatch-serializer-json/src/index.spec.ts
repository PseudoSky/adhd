import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { DagJson, DagSnapshot } from '@adhd/dispatch-base-spec';
import { createJsonFileSerializer, normalizeDag } from './index';

// Pass-through wrapper around the three fs calls the atomic write makes, so the
// 0b80a7b5 AC1 cases below can observe temp paths and inject failures. Every
// hook is null by default, which makes every other test in this file run
// against the real fs unchanged.
const fsHooks = vi.hoisted(() => ({
  beforeWrite: null as null | ((p: string) => void),
  beforeRename: null as null | ((from: string, to: string) => void),
  beforeRm: null as null | ((p: string) => void),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsHooks.beforeWrite?.(String(args[0]));
      return actual.writeFileSync(...args);
    },
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      fsHooks.beforeRename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      fsHooks.beforeRm?.(String(args[0]));
      return actual.rmSync(...args);
    },
  };
});

// Repo-canonical ephemeral root (CLAUDE.md): write-only test artifacts go under
// <repo>/tmp/<package>/ — gitignored, removed on teardown. Output path only;
// never an input, so it cannot create nx cache blindness.
const TMP_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../tmp/dispatch-serializer-json'
);

beforeEach(() => {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('createJsonFileSerializer', () => {
  describe('normalizeDag', () => {
    it('should return array format unchanged', () => {
      const dag: DagJson = {
        operations: [
          {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        ],
        milestones: {},
        dispatch_log: [],
      };

      const result = normalizeDag(dag);
      expect(Array.isArray(result.operations)).toBe(true);
      expect(result.operations).toEqual(dag.operations);
    });

    it('should convert object format to array format', () => {
      const dag = {
        operations: {
          op1: {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        },
        milestones: {},
        dispatch_log: [],
      } as unknown as DagJson;

      const result = normalizeDag(dag);
      expect(Array.isArray(result.operations)).toBe(true);
      expect((result.operations as Array<unknown>).length).toBe(1);
      expect((result.operations as Array<unknown>)[0].id).toBe('op1');
    });
  });

  describe('readDag', () => {
    it('should return null when file does not exist', async () => {
      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'nonexistent'));
      const dag = await serializer.readDag();
      expect(dag).toBeNull();
    });

    it('should throw on malformed JSON', async () => {
      const filePath = path.join(TMP_DIR, 'malformed.dag.json');
      fs.writeFileSync(filePath, 'invalid json{', 'utf-8');

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'malformed'));
      await expect(serializer.readDag()).rejects.toThrow();
    });

    it('should read and parse valid DAG JSON', async () => {
      const testDag: DagJson = {
        operations: [
          {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        ],
        milestones: {
          ms1: {
            description: 'Test milestone',
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
            depends_on: [],
            pending: null,
          },
        },
        dispatch_log: [],
      };

      const filePath = path.join(TMP_DIR, 'valid.dag.json');
      fs.writeFileSync(filePath, JSON.stringify(testDag), 'utf-8');

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'valid'));
      const dag = await serializer.readDag();
      expect(dag).not.toBeNull();
      expect((dag.operations as Array<unknown>)[0].id).toBe('op1');
    });

    it('should normalize object-format operations to array', async () => {
      const testDag = {
        operations: {
          op1: {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        },
        milestones: {},
        dispatch_log: [],
      };

      const filePath = path.join(TMP_DIR, 'legacy.dag.json');
      fs.writeFileSync(filePath, JSON.stringify(testDag), 'utf-8');

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'legacy'));
      const dag = await serializer.readDag();
      expect(dag).not.toBeNull();
      expect(Array.isArray(dag.operations)).toBe(true);
      expect((dag.operations as Array<unknown>).length).toBe(1);
    });
  });

  describe('writeDag', () => {
    it('should write DAG atomically', async () => {
      const testDag: DagJson = {
        operations: [
          {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        ],
        milestones: {},
        dispatch_log: [],
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'write-test'));
      await serializer.writeDag(testDag);

      const filePath = path.join(TMP_DIR, 'write-test.dag.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect((parsed.operations as Array<unknown>).length).toBe(1);
    });

    it('should overwrite existing file atomically', async () => {
      const filePath = path.join(TMP_DIR, 'overwrite-test.dag.json');

      const dag1: DagJson = {
        operations: [
          {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        ],
        milestones: {},
        dispatch_log: [],
      };

      const dag2: DagJson = {
        operations: [
          {
            id: 'op2',
            milestone: 'ms2',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test2.ts',
            symbol: 'test2',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 200,
            ki_source: 'estimate',
          },
        ],
        milestones: {},
        dispatch_log: [],
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'overwrite-test'));

      await serializer.writeDag(dag1);
      let content = fs.readFileSync(filePath, 'utf-8');
      let parsed = JSON.parse(content);
      expect((parsed.operations as Array<unknown>)[0].id).toBe('op1');

      await serializer.writeDag(dag2);
      content = fs.readFileSync(filePath, 'utf-8');
      parsed = JSON.parse(content);
      expect((parsed.operations as Array<unknown>)[0].id).toBe('op2');
    });
  });

  describe('readSnapshot', () => {
    it('should return null when snapshot does not exist', async () => {
      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'no-snapshot'));
      const snapshot = await serializer.readSnapshot();
      expect(snapshot).toBeNull();
    });

    it('should throw on malformed snapshot JSON', async () => {
      const filePath = path.join(TMP_DIR, 'bad-snapshot.snapshot.json');
      fs.writeFileSync(filePath, 'invalid{json', 'utf-8');

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'bad-snapshot'));
      await expect(serializer.readSnapshot()).rejects.toThrow();
    });

    it('should read and parse valid snapshot JSON', async () => {
      const testSnapshot: DagSnapshot = {
        dag_id: 'test-dag',
        milestone_slug: 'test-milestone',
        milestone_status: 'active',
        operations_total: 5,
        operations_completed: 2,
        operations_failed: 0,
        operations_pending: 3,
        dispatch_log_length: 10,
        active_operation_id: 'op1',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T01:00:00Z',
      };

      const filePath = path.join(TMP_DIR, 'valid-snapshot.snapshot.json');
      fs.writeFileSync(filePath, JSON.stringify(testSnapshot), 'utf-8');

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'valid-snapshot'));
      const snapshot = await serializer.readSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.dag_id).toBe('test-dag');
    });
  });

  describe('writeSnapshot', () => {
    it('should write snapshot atomically', async () => {
      const testSnapshot: DagSnapshot = {
        dag_id: 'test-dag',
        milestone_slug: 'test-milestone',
        milestone_status: 'active',
        operations_total: 5,
        operations_completed: 2,
        operations_failed: 0,
        operations_pending: 3,
        dispatch_log_length: 10,
        active_operation_id: 'op1',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T01:00:00Z',
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'write-snapshot-test'));
      await serializer.writeSnapshot(testSnapshot);

      const filePath = path.join(TMP_DIR, 'write-snapshot-test.snapshot.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as DagSnapshot;
      expect(parsed.dag_id).toBe('test-dag');
    });
  });

  describe('round-trip', () => {
    it('should round-trip DAG with write and read', async () => {
      const testDag: DagJson = {
        operations: [
          {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
          {
            id: 'op2',
            milestone: 'ms1',
            depends_on: ['op1'],
            type: 'generative',
            action: 'create',
            file: 'test2.ts',
            symbol: 'test2',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 200,
            ki_source: 'estimate',
          },
        ],
        milestones: {
          ms1: {
            description: 'Test milestone',
            guard: null,
            ki_estimate: 300,
            ki_source: 'estimate',
            depends_on: [],
            pending: null,
          },
        },
        dispatch_log: [],
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'round-trip'));
      await serializer.writeDag(testDag);
      const readDag = await serializer.readDag();

      expect(readDag).not.toBeNull();
      expect((readDag.operations as Array<unknown>).length).toBe(2);
      expect((readDag.operations as Array<unknown>)[0].id).toBe('op1');
      expect((readDag.operations as Array<unknown>)[1].id).toBe('op2');
    });

    it('should round-trip snapshot with write and read', async () => {
      const testSnapshot: DagSnapshot = {
        dag_id: 'test-dag',
        milestone_slug: 'test-milestone',
        milestone_status: 'active',
        operations_total: 5,
        operations_completed: 2,
        operations_failed: 0,
        operations_pending: 3,
        dispatch_log_length: 10,
        active_operation_id: 'op1',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T01:00:00Z',
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'round-trip-snapshot'));
      await serializer.writeSnapshot(testSnapshot);
      const readSnapshot = await serializer.readSnapshot();

      expect(readSnapshot).not.toBeNull();
      expect(readSnapshot?.dag_id).toBe('test-dag');
      expect(readSnapshot?.operations_total).toBe(5);
    });
  });

  describe('atomicity', () => {
    it('should not create partial files on write', async () => {
      const testDag: DagJson = {
        operations: [],
        milestones: {},
        dispatch_log: [],
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'atomicity-test'));
      await serializer.writeDag(testDag);

      const filePath = path.join(TMP_DIR, 'atomicity-test.dag.json');
      const tempPath = path.join(TMP_DIR, '.atomicity-test.dag.json.tmp');

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('should handle concurrent writes safely', async () => {
      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'concurrent-test'));

      const dag1: DagJson = {
        operations: [
          {
            id: 'op1',
            milestone: 'ms1',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test.ts',
            symbol: 'test',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 100,
            ki_source: 'estimate',
          },
        ],
        milestones: {},
        dispatch_log: [],
      };

      const dag2: DagJson = {
        operations: [
          {
            id: 'op2',
            milestone: 'ms2',
            depends_on: [],
            type: 'generative',
            action: 'create',
            file: 'test2.ts',
            symbol: 'test2',
            provenance: 'manual',
            confidence: 'documented',
            audit_check: null,
            criteria: [],
            authored_by: 'test',
            status: 'pending',
            shape: { kind: 'script', ops: [] },
            guard: null,
            ki_estimate: 200,
            ki_source: 'estimate',
          },
        ],
        milestones: {},
        dispatch_log: [],
      };

      await Promise.all([
        serializer.writeDag(dag1),
        serializer.writeDag(dag2),
      ]);

      const filePath = path.join(TMP_DIR, 'concurrent-test.dag.json');
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as DagJson;

      expect((parsed.operations as Array<unknown>).length).toBe(1);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('negative control', () => {
    it('should FAIL if read() returns null on malformed JSON (negative control)', async () => {
      const filePath = path.join(TMP_DIR, 'negative-control.dag.json');
      fs.writeFileSync(filePath, 'invalid json{', 'utf-8');

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'negative-control'));

      // This should throw, not return null
      let threw = false;
      try {
        await serializer.readDag();
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
    });

    it('should FAIL if writeDag does not create file (negative control)', async () => {
      const testDag: DagJson = {
        operations: [],
        milestones: {},
        dispatch_log: [],
      };

      const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'negative-write'));
      await serializer.writeDag(testDag);

      const filePath = path.join(TMP_DIR, 'negative-write.dag.json');
      let fileExists = false;
      try {
        fileExists = fs.existsSync(filePath);
      } catch {
        fileExists = false;
      }

      expect(fileExists).toBe(true);
    });
  });
});

/**
 * 0b80a7b5 AC1 — unique temp name per write, no temp left behind.
 *
 * Failure mode: two writers of the same dag path share one fixed temp name, so
 * one rename finds the temp already consumed (ENOENT) or publishes a torn mix;
 * a failed write/rename strands a `.tmp`; a throwing cleanup replaces the real
 * error.
 * Tier: S (real fs under <repo>/tmp, pass-through fs wrapper at the top of this
 *   file; a nested synchronous writer plays the "second process" at a latch).
 * Item: 0b80a7b5 (slice D1), criterion AC1.
 * Red run: pending — authored under a no-run hold. Expected against the base
 *   (21ba12b3) index.ts: the unique-name test fails on `expected 1 to be 3`
 *   (one shared temp name); the interleaved-writers test fails because writer 1's
 *   rename rejects with ENOENT; the failure-cleanup tests fail on a stranded
 *   `.tmp` entry in the directory.
 */
describe('0b80a7b5 AC1 atomic write temp files', () => {
  const doc = (id: string): DagJson =>
    ({
      operations: [],
      milestones: {},
      dispatch_log: [{ id }],
    }) as unknown as DagJson;
  const dirEntries = () => fs.readdirSync(TMP_DIR).sort();
  const isTemp = (p: string) => path.basename(p).endsWith('.tmp');

  afterEach(() => {
    fsHooks.beforeWrite = null;
    fsHooks.beforeRename = null;
    fsHooks.beforeRm = null;
  });

  it('0b80a7b5 AC1: every write of the same dag path uses a different temp path, none of them the legacy fixed name, and none survives', async () => {
    const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'uniq'));
    const temps: string[] = [];
    fsHooks.beforeWrite = (p) => {
      if (isTemp(p)) temps.push(p);
    };

    await serializer.writeDag(doc('1'));
    await serializer.writeDag(doc('2'));
    await serializer.writeDag(doc('3'));

    expect(temps).toHaveLength(3);
    expect(new Set(temps).size).toBe(3);
    for (const t of temps) {
      expect(path.dirname(t)).toBe(TMP_DIR); // same dir => the rename stays atomic
      expect(path.basename(t)).not.toBe('.uniq.dag.json.tmp');
    }
    expect(dirEntries()).toEqual(['uniq.dag.json']);
  });

  it('0b80a7b5 AC1: two writers of one path interleaved at the rename latch both complete; the file is valid JSON of exactly one writer document; no .tmp remains', async () => {
    const dagPath = path.join(TMP_DIR, 'race');
    const writer1 = createJsonFileSerializer(dagPath);
    const writer2 = createJsonFileSerializer(dagPath);
    let inner: Promise<void> | null = null;
    let fired = false;
    fsHooks.beforeRename = (from) => {
      if (fired || !isTemp(from)) return;
      fired = true;
      // Writer 2 runs its whole write+rename while writer 1 sits between its
      // temp write and its rename.
      inner = writer2.writeDag(doc('writer-2'));
    };

    await expect(writer1.writeDag(doc('writer-1'))).resolves.toBeUndefined();
    await expect(inner).resolves.toBeUndefined();

    expect(fired).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(`${dagPath}.dag.json`, 'utf-8')) as DagJson;
    expect(['writer-1', 'writer-2']).toContain((onDisk.dispatch_log[0] as unknown as { id: string }).id);
    expect(onDisk.dispatch_log).toHaveLength(1); // one writer's document, not a mix
    expect(dirEntries()).toEqual(['race.dag.json']);
  });

  it('0b80a7b5 AC1: a rename failure leaves no .tmp behind and the original error propagates', async () => {
    const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'rename-fail'));
    fsHooks.beforeRename = () => {
      throw new Error('rename boom');
    };
    await expect(serializer.writeDag(doc('x'))).rejects.toThrow('rename boom');
    expect(dirEntries()).toEqual([]);
  });

  it('0b80a7b5 AC1: a write failure after the temp file was created leaves no .tmp behind', async () => {
    const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'write-fail'));
    fsHooks.beforeWrite = (p) => {
      if (!isTemp(p)) return;
      fs.closeSync(fs.openSync(p, 'w')); // the temp file now exists, then the write itself fails
      throw new Error('disk full');
    };
    await expect(serializer.writeDag(doc('x'))).rejects.toThrow('disk full');
    fsHooks.beforeWrite = null;
    expect(dirEntries()).toEqual([]);
  });

  it('0b80a7b5 AC1: a cleanup failure does not mask the primary error', async () => {
    const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'mask'));
    fsHooks.beforeRename = () => {
      throw new Error('primary rename failure');
    };
    fsHooks.beforeRm = (p) => {
      if (isTemp(p)) throw new Error('cleanup failure');
    };
    const err = await serializer.writeDag(doc('x')).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).not.toBeNull();
    expect(err?.message).toBe('primary rename failure');
  });

  it('0b80a7b5 AC1: snapshot writes use the same unique-temp, no-leftover path', async () => {
    const serializer = createJsonFileSerializer(path.join(TMP_DIR, 'snap'));
    const temps: string[] = [];
    fsHooks.beforeWrite = (p) => {
      if (isTemp(p)) temps.push(p);
    };
    const snapshot = { dag_id: 'd', operations_total: 0 } as unknown as DagSnapshot;
    await serializer.writeSnapshot(snapshot);
    await serializer.writeSnapshot(snapshot);
    expect(new Set(temps).size).toBe(2);
    expect(dirEntries().filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
