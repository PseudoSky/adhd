#!/usr/bin/env node
/**
 * Docs contract for the NAT_TOOL_LIVE env gate (backlog 90d07610 AC4).
 *
 * AGENTS.md "Live testing is mandatory": an env-gated test is legitimate only
 * when its approval (named owner) is surfaced in the project's README.md, its
 * AGENTS.md, AND the gated test file's own header. This spec drives the REAL
 * files: the set of test files that gate on NAT_TOOL_LIVE (`skipIf(!isLive)`
 * over `process.env['NAT_TOOL_LIVE']`) must equal the set of rows in BOTH
 * gate tables, and each file's header must name the owner.
 *
 * Negative control: the set-comparison helper is driven with a fabricated gated
 * file that has no table row and must report it (a gate that cannot go red
 * proves nothing).
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/nat-tool-live-docs.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PKG = 'entrypoint/agent-mcp';
const OWNER = 'pseudosky';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Files under `<PKG>/src` that gate a describe on NAT_TOOL_LIVE (repo-relative to PKG). */
function gatedFiles(root) {
  return walk(join(root, PKG, 'src'))
    .filter((f) => /\.test\.ts$/.test(f))
    .filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /process\.env\[['"]NAT_TOOL_LIVE['"]\]/.test(t) && /\.skipIf\(/.test(t);
    })
    .map((f) => f.slice(join(root, PKG).length + 1))
    .sort();
}

/** Test-file paths listed in the `NAT_TOOL_LIVE=1` rows of a markdown gate table. */
function tableFiles(md) {
  return [...md.matchAll(/^\|\s*`(src\/[^`]+\.test\.ts)`\s*\|\s*`NAT_TOOL_LIVE=1`/gm)].map((m) => m[1]).sort();
}

/** Returns { missingRows, staleRows } for gated-set vs table-set. */
export function diffGate(gated, table) {
  return {
    missingRows: gated.filter((f) => !table.includes(f)),
    staleRows: table.filter((f) => !gated.includes(f)),
  };
}

test('gate tables in README + AGENTS list exactly the NAT_TOOL_LIVE-gated files [90d07610 AC4]', () => {
  const gated = gatedFiles(REPO);
  assert.ok(gated.length >= 3, `expected the native-tooling + portability live files, got ${JSON.stringify(gated)}`);
  for (const doc of ['README.md', 'AGENTS.md']) {
    const table = tableFiles(readFileSync(join(REPO, PKG, doc), 'utf8'));
    assert.deepEqual(diffGate(gated, table), { missingRows: [], staleRows: [] }, `${PKG}/${doc} gate table drifted`);
  }
});

test('each gated file header names the owner [90d07610 AC4]', () => {
  for (const f of gatedFiles(REPO)) {
    const head = readFileSync(join(REPO, PKG, f), 'utf8').split('\n').slice(0, 40).join('\n');
    assert.match(head, new RegExp(`Approved by:?\\*{0,2}\\s*${OWNER}`), `${f} header lacks 'Approved by: ${OWNER}'`);
  }
});

test('README + AGENTS state the gate owner next to the table [90d07610 AC4]', () => {
  for (const doc of ['README.md', 'AGENTS.md']) {
    const t = readFileSync(join(REPO, PKG, doc), 'utf8');
    const i = t.indexOf('## Native-tooling adoption gate');
    assert.ok(i >= 0, `${doc} lacks the native-tooling gate section`);
    assert.match(t.slice(i, i + 4000), new RegExp(`Approved by:\\*{0,2}\\s*${OWNER}`), `${doc} gate section lacks the owner`);
  }
});

test('negative control: a gated file with no table row is reported [90d07610 AC4]', () => {
  const table = tableFiles(readFileSync(join(REPO, PKG, 'README.md'), 'utf8'));
  const d = diffGate([...gatedFiles(REPO), 'src/__tests__/integration/new-gated.e2e.test.ts'], table);
  assert.deepEqual(d.missingRows, ['src/__tests__/integration/new-gated.e2e.test.ts']);
  const d2 = diffGate(gatedFiles(REPO), [...table, 'src/__tests__/integration/gone.e2e.test.ts']);
  assert.deepEqual(d2.staleRows, ['src/__tests__/integration/gone.e2e.test.ts']);
});
