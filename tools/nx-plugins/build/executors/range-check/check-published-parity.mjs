#!/usr/bin/env node
/**
 * check-published-parity.mjs — fails (exit 1) when any publishable project's
 * source version is BEHIND what is published (backlog 420a7051).
 *
 *   node tools/nx-plugins/build/executors/range-check/check-published-parity.mjs            # offline: vs committed published-state.json (CI)
 *   node tools/nx-plugins/build/executors/range-check/check-published-parity.mjs --registry # live registry (release flow; needs network)
 *
 * Exit 0 — parity holds. Exit 1 — at least one project is behind.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { discoverReleaseSet, fetchRegistryVersions } = require('../../lib/range-resolvability');
const { checkParity, publishedFromState, formatViolation } = require('../../lib/published-parity');

const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};

/**
 * @param {{ workspaceRoot?: string, registry?: boolean, fetchVersions?: (names: string[]) => Promise<Map<string,string[]>> }} [opts]
 */
export async function runParity(opts = {}) {
  const root = opts.workspaceRoot || findRoot(dirname(fileURLToPath(import.meta.url)));
  const releaseSet = discoverReleaseSet(root);
  let published;
  if (opts.registry) {
    const names = releaseSet.map((p) => p.name);
    published = await (opts.fetchVersions || fetchRegistryVersions)(names);
  } else {
    const statePath = join(root, 'published-state.json');
    published = publishedFromState(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {});
  }
  return { ...checkParity(releaseSet, published), checked: releaseSet.length };
}

async function main() {
  const registry = process.argv.includes('--registry');
  const { ok, violations, checked } = await runParity({ registry });
  console.error(`published-parity: ${checked} publishable project(s) checked against ${registry ? 'the registry' : 'published-state.json'}.`);
  if (ok) {
    console.error('published-parity: OK — no source version is behind its published version.');
  } else {
    console.error(`published-parity: FAILED — ${violations.length} project(s) behind:`);
    for (const v of violations) console.error(`  ✖ ${formatViolation(v)}`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
