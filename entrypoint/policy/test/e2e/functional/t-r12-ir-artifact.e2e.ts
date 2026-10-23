/**
 * guards: the baked operation surface drifts from a live extraction of the client declarations (a second extraction path), `writeBakedIr` / the hidden `ir-artifact` subcommand bake an artifact the reader rejects, the artifact shipped in dist/ differs from a fresh bake, or a stale artifact's fall-back to live extraction loses operations.
 * tier: X
 * gap: This cannot be observed at tier S because the property is the equality of the real ts-morph extraction of the built @adhd/policy-core-client declarations with the baked artifact; each extraction takes seconds and a stub of the extractor would assert only against itself. Tier S (`t-r12-ir-artifact.spec.ts`) serves the extractor from the shipped artifact and proves the reader, staleness and lazy-load rules.
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R12, §3 R12 (parity proof); adhd ADR-0017 D5; docs/decisions/0009-test-lanes-unit-vs-e2e.md
 * item: test-maintenance (policy:test slow specs shrunk, real-extraction cases moved here)
 * red-run: carried from the cases moved out of the unit lane (assertions unchanged): 2026-10-21 controls: ir.ts without the formatVersion check -> 1 failed; without the sameDeps check -> 1 failed.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSingleFileBackend, CURRENT_FORMAT_VERSION, type CachedExtractEntry } from '@adhd/apigen-plugin-ir-cache';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bakedIrArtifactPath,
  expectedExtractorVersion,
  extractPolicyOperations,
  locateClientApi,
  policyDistDir,
  POLICY_IR_ARTIFACT_FILENAME,
  POLICY_IR_FORMAT_VERSION,
  writeBakedIr,
} from '../../../src/wrapper/ir';
import { extractPolicyOperationsLive } from '../../../src/wrapper/ir-live';
import { runIrArtifact } from '../../../src/wrapper/ir-artifact';
import { withTmpDir, useScratchDirs } from '../../helpers/tmp';

// A cold ts-morph extraction takes seconds; this lane exists for exactly that (ADR 0009).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const scratch = useScratchDirs('t-r12-e2e');

async function readEntry(file: string): Promise<CachedExtractEntry> {
  const entry = await createSingleFileBackend(file).get('');
  if (entry === undefined) throw new Error(`${file} is not a readable ir-cache entry`);
  return entry;
}

/** One real bake for the file; cases read it. */
let baked: string;
beforeAll(async () => {
  baked = join(await scratch.fresh('bake'), POLICY_IR_ARTIFACT_FILENAME);
  await writeBakedIr(baked);
});

describe('a real bake (R12)', () => {
  it('a baked file reads back through the ir-cache single-file backend with the current format and extractor version', async () => {
    const entry = await readEntry(baked);
    expect(entry.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(entry.extractorVersion).toBe(expectedExtractorVersion());
    expect(entry.operations.map((op) => op.id).sort()).toEqual(
      ['policy/check', 'policy/compile', 'policy/doctor', 'policy/draft', 'policy/evaluate', 'policy/explain', 'policy/narrow', 'policy/resolve', 'policy/show', 'policy/verify']
    );
    expect(Object.keys(entry.artifactSource?.deps ?? {})).toContain('service/api.d.ts');
  });

  it('parity: the baked operations deep-equal a live extraction of the same declarations (one extraction path)', async () => {
    const client = locateClientApi();
    if (client === undefined) throw new Error('the built @adhd/policy-core-client declarations are required (nx build policy-core-client)');
    const live = await extractPolicyOperationsLive(client.apiDts);
    expect((await readEntry(baked)).operations).toEqual(JSON.parse(JSON.stringify(live)));
  });

  it('parity: the artifact the build shipped in dist/ deep-equals a fresh bake', async () => {
    const built = await readEntry(bakedIrArtifactPath(policyDistDir())); // throws (red) when the build did not produce dist/api.ir.json
    expect(built.operations).toEqual((await readEntry(baked)).operations);
    expect(built.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });

  it('a stale artifact warns once and the live fall-back yields the operations; no artifact is silent and equals the baked surface', async () => {
    await withTmpDir('t-r12-fallback', async (dir) => {
      const file = join(dir, POLICY_IR_ARTIFACT_FILENAME);
      await writeFile(file, JSON.stringify({ formatVersion: 0 }));
      const lines: string[] = [];
      const operations = await extractPolicyOperations((line) => void lines.push(line), dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^@adhd\/policy: ignoring the baked operation surface \(.+\); extracting live$/);
      expect(operations.some((op) => op.path[op.path.length - 1]?.raw === 'check')).toBe(true);

      await rm(file);
      const quiet: string[] = [];
      const live = await extractPolicyOperations((line) => void quiet.push(line), dir);
      expect(quiet).toEqual([]);
      await writeFile(file, await readFile(baked, 'utf8'));
      const fromArtifact = await extractPolicyOperations((line) => void quiet.push(line), dir);
      expect(quiet).toEqual([]);
      expect(fromArtifact).toEqual(live);
    });
  });
});

describe('the hidden ir-artifact subcommand (E10)', () => {
  it('E10 --out under dist/ bakes an artifact that is then usable, and the file is removed afterwards', async () => {
    const target = join(policyDistDir(), `.ir-artifact-e2e-${process.pid}.json`);
    try {
      const err: string[] = [];
      const code = await runIrArtifact(['--out', target], { cwd: process.cwd(), stderr: (t) => void err.push(t) });
      expect(err.join('')).toBe('');
      expect(code).toBe(0);
      const entry = JSON.parse(await readFile(target, 'utf8')) as { formatVersion: number; operations: { kind: string }[] };
      expect(entry.formatVersion).toBe(POLICY_IR_FORMAT_VERSION);
      expect(entry.operations.length).toBeGreaterThan(0);
    } finally {
      await rm(target, { force: true });
    }
    expect(existsSync(target)).toBe(false);
  });
});
