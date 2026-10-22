/**
 * guards: the operation surface `adhd-policy` starts from drifts from the ir-cache artifact contract or from live extraction (a second extraction path), a stale or version-mismatched artifact is served instead of rejected with a reason, an unverifiable artifact is used without a warning, or the baked-artifact start-up loads the extractor (ts-morph).
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R12, §3 R12 (parity proof); adhd ADR-0017 D5
 * red-run: 2026-10-21 controls: ir.ts without the formatVersion check -> 1 failed (version test); without the sameDeps check -> 1 failed (staleness test); `import './ir-live'` at the top of ir.ts -> 1 failed (lazy-load test).
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operation } from '@adhd/apigen-core-client';
import { createSingleFileBackend, CURRENT_FORMAT_VERSION, type CachedExtractEntry } from '@adhd/apigen-plugin-ir-cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bakedIrArtifactPath,
  expectedExtractorVersion,
  extractPolicyOperations,
  inspectBakedIr,
  locateClientApi,
  policyDistDir,
  POLICY_IR_ARTIFACT_FILENAME,
  writeBakedIr,
} from '../../wrapper/ir';
import { extractPolicyOperationsLive } from '../../wrapper/ir-live';
import { withTmpDir } from '../helpers/tmp';

// The two seams the unit lane can reach without a subprocess: whether the client declarations resolve (the module
// resolver is wrapped so '@adhd/policy-core-client' can be made unfindable), and whether the extractor module loads.
const seams = vi.hoisted(() => ({ hideClient: false, irLiveLoads: 0 }));
vi.mock('node:module', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:module')>();
  return {
    ...real,
    createRequire: (from: string | URL) => {
      const inner = real.createRequire(from);
      const wrapped = ((id: string) => inner(id)) as NodeJS.Require;
      Object.assign(wrapped, inner);
      wrapped.resolve = Object.assign(
        (id: string, options?: { paths?: string[] }) => {
          if (seams.hideClient && id.startsWith('@adhd/policy-core-client')) throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
          return inner.resolve(id, options);
        },
        { paths: inner.resolve.paths.bind(inner.resolve) }
      );
      return wrapped;
    },
  };
});

vi.setConfig({ testTimeout: 90_000 });

beforeEach(() => {
  seams.hideClient = false;
});

async function readEntry(file: string): Promise<CachedExtractEntry> {
  const entry = await createSingleFileBackend(file).get('');
  if (entry === undefined) throw new Error(`${file} is not a readable ir-cache entry`);
  return entry;
}

describe('the baked artifact is an ir-cache entry (R12)', () => {
  it('a baked file reads back through the ir-cache single-file backend with the current format and extractor version', async () => {
    await withTmpDir('t-r12-entry', async (dir) => {
      const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
      await writeBakedIr(file);
      const entry = await readEntry(file);
      expect(entry.formatVersion).toBe(CURRENT_FORMAT_VERSION);
      expect(entry.extractorVersion).toBe(expectedExtractorVersion());
      expect(entry.operations.map((op) => op.id).sort()).toEqual(
        ['policy/check', 'policy/compile', 'policy/doctor', 'policy/draft', 'policy/evaluate', 'policy/explain', 'policy/narrow', 'policy/resolve', 'policy/show', 'policy/verify']
      );
      expect(Object.keys(entry.artifactSource?.deps ?? {})).toContain('service/api.d.ts');
    });
  });

  it('parity: the baked operations deep-equal a live extraction of the same declarations (one extraction path)', async () => {
    await withTmpDir('t-r12-parity', async (dir) => {
      const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
      await writeBakedIr(file);
      const client = locateClientApi();
      if (client === undefined) throw new Error('the built @adhd/policy-core-client declarations are required (nx build policy-core-client)');
      const live = await extractPolicyOperationsLive(client.apiDts);
      expect((await readEntry(file)).operations).toEqual(JSON.parse(JSON.stringify(live)));
    });
  });

  it('parity: the artifact the build shipped in dist/ deep-equals a fresh bake, and the reader accepts it as current', async () => {
    const shipped = bakedIrArtifactPath(policyDistDir());
    await withTmpDir('t-r12-shipped', async (dir) => {
      const fresh = join(dir, POLICY_IR_ARTIFACT_FILENAME);
      await writeBakedIr(fresh);
      const built = await readEntry(shipped); // throws (red) when the build did not produce dist/api.ir.json
      expect(built.operations).toEqual((await readEntry(fresh)).operations);
      expect(built.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    });
    const inspected = await inspectBakedIr(policyDistDir());
    expect('operations' in inspected).toBe(true);
    expect('stalenessUnchecked' in inspected).toBe(false);
  });
});

describe('a baked artifact is used only when it is current (R12)', () => {
  async function mutated(dir: string, change: (entry: CachedExtractEntry) => void): Promise<void> {
    const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
    await writeBakedIr(file);
    const entry = JSON.parse(await readFile(file, 'utf8')) as CachedExtractEntry;
    change(entry);
    await writeFile(file, JSON.stringify(entry));
  }

  it('an artifact with a corrupted format version is rejected with a message naming both versions, and the start-up warns once then extracts live', async () => {
    await withTmpDir('t-r12-version', async (dir) => {
      await mutated(dir, (entry) => void (entry.formatVersion = CURRENT_FORMAT_VERSION + 1));
      const inspected = await inspectBakedIr(dir);
      expect('reason' in inspected && inspected.reason).toBe(`artifact format ${CURRENT_FORMAT_VERSION + 1} is not ${CURRENT_FORMAT_VERSION}`);
      const lines: string[] = [];
      const operations = await extractPolicyOperations((line) => void lines.push(line), dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`artifact format ${CURRENT_FORMAT_VERSION + 1}`);
      expect(operations.map((op) => op.id)).toContain('policy/check');
    });
  });

  it('a changed hash for one real .d.ts file, a recorded file that no longer exists and a new .d.ts the artifact never saw are each stale', async () => {
    const reasons: string[] = [];
    for (const change of [
      (entry: CachedExtractEntry) => {
        const deps = entry.artifactSource?.deps as Record<string, string>;
        const key = Object.keys(deps).find((name) => name !== 'service/api.d.ts') ?? 'service/api.d.ts';
        deps[key] = `${deps[key]?.slice(0, -4) ?? ''}dead`;
      },
      (entry: CachedExtractEntry) => void ((entry.artifactSource?.deps as Record<string, string>)['gone/removed.d.ts'] = 'abc123'),
      (entry: CachedExtractEntry) => void delete (entry.artifactSource?.deps as Record<string, string>)['service/api.d.ts'],
    ]) {
      await withTmpDir('t-r12-stale', async (dir) => {
        await mutated(dir, change);
        const inspected = await inspectBakedIr(dir);
        reasons.push('reason' in inspected ? inspected.reason : 'ACCEPTED');
      });
    }
    expect(reasons).toEqual(Array(3).fill('the @adhd/policy-core-client declarations changed since the artifact was baked'));
  });

  it('an unchanged artifact is accepted with no warning', async () => {
    await withTmpDir('t-r12-fresh', async (dir) => {
      await mutated(dir, () => undefined);
      const lines: string[] = [];
      expect((await extractPolicyOperations((line) => void lines.push(line), dir)).length).toBeGreaterThan(0);
      expect(lines).toEqual([]);
    });
  });
});

describe('the client declarations cannot be found (R12)', () => {
  it('a baked artifact is still served, with exactly one warning that staleness was not checked', async () => {
    await withTmpDir('t-r12-noclient', async (dir) => {
      const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
      await writeBakedIr(file);
      seams.hideClient = true;
      expect(locateClientApi()).toBeUndefined();
      const inspected = await inspectBakedIr(dir);
      expect(inspected).toMatchObject({ stalenessUnchecked: true });
      const lines: string[] = [];
      const operations: Operation[] = await extractPolicyOperations((line) => void lines.push(line), dir);
      expect(operations.length).toBeGreaterThan(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/without checking it for staleness/);
    });
  });

  it('with no artifact either, start-up fails telling the user to build policy-core-client', async () => {
    await withTmpDir('t-r12-noclient-noartifact', async (dir) => {
      seams.hideClient = true;
      await expect(extractPolicyOperations(() => undefined, dir)).rejects.toThrow(/nx build policy-core-client/);
    });
  });
});

describe('the baked-artifact start-up never loads the extractor (R12)', () => {
  it('reading a current artifact does not import ir-live; falling back to live extraction does', async () => {
    await withTmpDir('t-r12-lazy', async (dir) => {
      await copyFile(bakedIrArtifactPath(policyDistDir()), join(dir, POLICY_IR_ARTIFACT_FILENAME));
      vi.resetModules();
      seams.irLiveLoads = 0;
      // doMock registers a factory for the fresh module graph; it runs exactly when something imports ir-live.
      vi.doMock('../../wrapper/ir-live', async (importOriginal) => {
        seams.irLiveLoads += 1;
        return await importOriginal<typeof import('../../wrapper/ir-live')>();
      });
      const fresh = await import('../../wrapper/ir');
      const baked = await fresh.extractPolicyOperations(() => undefined, dir);
      expect(baked.length).toBeGreaterThan(0);
      expect(seams.irLiveLoads).toBe(0);
      await writeFile(join(dir, POLICY_IR_ARTIFACT_FILENAME), '{not json');
      await fresh.extractPolicyOperations(() => undefined, dir);
      expect(seams.irLiveLoads).toBe(1);
      vi.doUnmock('../../wrapper/ir-live');
    });
  });
});
