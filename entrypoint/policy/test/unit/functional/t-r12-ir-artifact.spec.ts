/**
 * guards: the operation surface `adhd-policy` starts from drifts from the ir-cache artifact contract or from live extraction (a second extraction path), a stale or version-mismatched artifact is served instead of rejected with a reason, an unverifiable artifact is used without a warning, or the baked-artifact start-up loads the extractor (ts-morph).
 * tier: S
 * not-covered: the real ts-morph extraction (baking, parity of the baked operations with a live extraction, the E10 bake) is tier X: `t-r12-ir-artifact.e2e.ts`. This file serves the extractor from a stub built on the shipped artifact so the fall-back and lazy-load behaviour is observable in well under a second.
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R12, §3 R12 (parity proof); adhd ADR-0017 D5
 * red-run: 2026-10-21 controls: ir.ts without the formatVersion check -> 1 failed (version test); without the sameDeps check -> 1 failed (staleness test); `import './ir-live'` at the top of ir.ts -> 1 failed (lazy-load test).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operation } from '@adhd/apigen-core-client';
import { createSingleFileBackend, CURRENT_FORMAT_VERSION, type CachedExtractEntry } from '@adhd/apigen-plugin-ir-cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expectedExtractorVersion,
  extractPolicyOperations,
  inspectBakedIr,
  locateClientApi,
  policyDistDir,
  POLICY_IR_ARTIFACT_FILENAME,
} from '../../../src/wrapper/ir';
import { shippedBakedIrText, stubbedIrLive } from '../../helpers/baked-ir';
import { withTmpDir } from '../../helpers/tmp';

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

// The extractor module (ts-morph, seconds per extraction) is replaced by a stub that serves the shipped artifact's operations and counts loads; the real extraction, and its parity with the baked artifact, run in the e2e lane (t-r12-ir-artifact.e2e.ts).
vi.mock('../../../src/wrapper/ir-live', () => stubbedIrLive({ onLoad: () => void (seams.irLiveLoads += 1) }));

beforeEach(() => {
  seams.hideClient = false;
});

async function readEntry(file: string): Promise<CachedExtractEntry> {
  const entry = await createSingleFileBackend(file).get('');
  if (entry === undefined) throw new Error(`${file} is not a readable ir-cache entry`);
  return entry;
}

describe('the shipped artifact is an ir-cache entry (R12)', () => {
  it('the artifact in dist/ reads back through the ir-cache single-file backend with the current format and extractor version', async () => {
    await withTmpDir('t-r12-entry', async (dir) => {
      const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
      await writeFile(file, await shippedBakedIrText());
      const entry = await readEntry(file);
      expect(entry.formatVersion).toBe(CURRENT_FORMAT_VERSION);
      expect(entry.extractorVersion).toBe(expectedExtractorVersion());
      expect(entry.operations.map((op) => op.id).sort()).toEqual(
        ['policy/check', 'policy/compile', 'policy/doctor', 'policy/draft', 'policy/evaluate', 'policy/explain', 'policy/narrow', 'policy/resolve', 'policy/show', 'policy/verify']
      );
      expect(Object.keys(entry.artifactSource?.deps ?? {})).toContain('service/api.d.ts');
    });
  });

  it('the reader accepts the artifact the build shipped in dist/ as current', async () => {
    const inspected = await inspectBakedIr(policyDistDir());
    expect('operations' in inspected).toBe(true);
    expect('stalenessUnchecked' in inspected).toBe(false);
  });
});

describe('a baked artifact is used only when it is current (R12)', () => {
  async function mutated(dir: string, change: (entry: CachedExtractEntry) => void): Promise<void> {
    const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
    await writeFile(file, await shippedBakedIrText());
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
      await writeFile(file, await shippedBakedIrText());
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
      await writeFile(join(dir, POLICY_IR_ARTIFACT_FILENAME), await shippedBakedIrText());
      vi.resetModules();
      seams.irLiveLoads = 0;
      // doMock registers a factory for the fresh module graph; it runs exactly when something imports ir-live.
      vi.doMock('../../../src/wrapper/ir-live', () => stubbedIrLive({ onLoad: () => void (seams.irLiveLoads += 1) }));
      const fresh = await import('../../../src/wrapper/ir');
      const baked = await fresh.extractPolicyOperations(() => undefined, dir);
      expect(baked.length).toBeGreaterThan(0);
      expect(seams.irLiveLoads).toBe(0);
      await writeFile(join(dir, POLICY_IR_ARTIFACT_FILENAME), '{not json');
      await fresh.extractPolicyOperations(() => undefined, dir);
      expect(seams.irLiveLoads).toBe(1);
      vi.doUnmock('../../../src/wrapper/ir-live');
    });
  });
});
