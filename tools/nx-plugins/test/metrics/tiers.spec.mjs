/**
 * tiers.spec.mjs: the per-tier duration budgets match the standard that states them, and a test file's tier is resolved
 * from its header, falling back to the file-name rule.
 *
 * guards: a budget drifts from docs/standards/testing.md, or a headed test file is reported under the wrong tier.
 * tier: S (injected source readers; reads one repository document).
 * cites: 595965cc T37.AC1 (each tier has a budget), T37.AC2 (the report lists tests over budget by tier).
 * teeth: red 2026-10-15: `node --test tiers.spec.mjs` -> exit 1 with TIER_BUDGETS.S.p95Ms set to 150 (1 case) and with resolveTier
 *   ignoring the header (2 cases) (authorship was not separated).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inferTierFromName, resolveTier, TIER_BUDGETS } from './tiers.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('TIER_BUDGETS', () => {
  it('holds the numbers of the standard: S 100 ms p95 and 1 s split-or-fix, P 10 s, H 2 min, X metered', () => {
    assert.deepEqual({ ...TIER_BUDGETS.S }, { p95Ms: 100, splitOrFixMs: 1000 });
    assert.equal(TIER_BUDGETS.P.p95Ms, 10_000);
    assert.equal(TIER_BUDGETS.H.p95Ms, 120_000);
    assert.equal(TIER_BUDGETS.X.p95Ms, null);
  });

  it('DRIFT GUARD: docs/standards/testing.md still states those numbers', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/standards/testing.md'), 'utf8');
    assert.match(doc, /\(100 ms p95, 1 s\)/, 'tier S ceiling line');
    assert.match(doc, /\*\*Tier P\*\*[\s\S]*?Budget 10 s per test/, 'tier P budget');
    assert.match(doc, /\*\*Tier H\*\*[\s\S]*?Budget when it exists: 2 min/, 'tier H budget');
  });
});

describe('inferTierFromName', () => {
  it('names the e2e files tier P and every other test file tier S (testing.md section 1)', () => {
    assert.equal(inferTierFromName('/r/a/b.e2e.ts'), 'P');
    assert.equal(inferTierFromName('/r/a/b.e2e.test.ts'), 'P');
    assert.equal(inferTierFromName('/r/a/b.spec.ts'), 'S');
    assert.equal(inferTierFromName('/r/a/b.spec.mjs'), 'S');
  });
});

describe('resolveTier', () => {
  const header = (tier) => `/**\n * x\n * guards: g\n * tier: ${tier}\n * cites: c\n */\nexport {};\n`;
  it('reads the tier line of the header', () => {
    assert.deepEqual(resolveTier('/r/a.spec.ts', () => header('P (spawns git)')), { tier: 'P', tierSource: 'header' });
    assert.deepEqual(resolveTier('/r/a.spec.ts', () => header('S')), { tier: 'S', tierSource: 'header' });
    assert.deepEqual(resolveTier('/r/a.e2e.ts', () => header('H')), { tier: 'H', tierSource: 'header' }, 'the header outranks the file name');
  });
  it('falls back to the file name, marked inferred, when the header is absent, invalid or unreadable', () => {
    assert.deepEqual(resolveTier('/r/a.spec.ts', () => 'export {};\n'), { tier: 'S', tierSource: 'inferred' });
    assert.deepEqual(resolveTier('/r/a.e2e.ts', () => 'export {};\n'), { tier: 'P', tierSource: 'inferred' });
    assert.deepEqual(resolveTier('/r/a.spec.ts', () => header('Z')), { tier: 'S', tierSource: 'inferred' });
    assert.deepEqual(resolveTier('/r/a.e2e.ts', () => { throw new Error('ENOENT'); }), { tier: 'P', tierSource: 'inferred' });
  });
  it('resolves the tier of this very file from its own header', () => {
    assert.deepEqual(resolveTier(fileURLToPath(import.meta.url)), { tier: 'S', tierSource: 'header' });
  });
});
