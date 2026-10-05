#!/usr/bin/env node
/**
 * Regression pin for backlog 62535ce7 — nx `test` MUST hash the OUTPUT of the
 * tasks it `dependsOn`.
 *
 * THE BUG. `nx.json`'s `targetDefaults.test.inputs` were
 * `["default", "^production", {externalDependencies:[…]}]`. `^production` hashes
 * the SOURCE of the test project's Nx project-graph dependencies, but a `test`
 * target can `dependsOn` a task of a project OUTSIDE its project graph — e.g.
 * `entrypoint/dispatch-cli` spawns `entrypoint/agent-mcp`'s BUILT entry as an
 * external MCP boundary and names `agent-mcp:dist-manifest` in its
 * `test.dependsOn`, while importing nothing from agent-mcp (no graph edge). The
 * task-dependsOn REBUILDS agent-mcp/dist, yet the consumer test's hash did not
 * change, so Nx served a STALE cached PASS across a real rebuild (reproduced in
 * dispatch-2026-10-04-9c4e, bucket-h).
 *
 * THE FIX. Add a `{ dependentTasksOutputFiles: "**\/*", transitive: true }` input
 * to `test` inputs, so the materialized outputs of the test task's (transitive)
 * task-graph dependencies are folded into its hash. `transitive: true` is
 * REQUIRED, not stylistic: the direct dependency `agent-mcp:dist-manifest`
 * resolves NO outputs (its @adhd/nx-build:manifest executor declares none), so a
 * non-transitive glob matches nothing — the artifact is materialized by the
 * transitive `agent-mcp:build`, which declares `{projectRoot}/dist`.
 *
 * WHY A CONFIG PIN, NOT A CACHE-EXECUTION TEST. Exercising Nx's real task
 * hasher/cache in-process needs a synthetic project graph + task graph and
 * pokes at Nx internals; the behavioural proof is captured out-of-band (a real
 * `agent-mcp` source change → `nx run dispatch-cli:test` re-ran instead of
 * serving `[local cache]`; the exact task hashes were read from Nx's own
 * `.nx/workspace-data/*.db` `task_details` table). This spec is the cheap,
 * revert-failing guard that the input is not silently removed.
 *
 * Run: node --test tools/nx-plugins/build/test-hashes-dependent-build-outputs.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const REPO_ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
const nxJson = JSON.parse(readFileSync(join(REPO_ROOT, 'nx.json'), 'utf8'));
const testInputs = nxJson.targetDefaults?.test?.inputs ?? [];

test('nx.json test inputs hash dependent-task build outputs (62535ce7)', () => {
  const entry = testInputs.find(
    (i) => i && typeof i === 'object' && 'dependentTasksOutputFiles' in i,
  );
  assert.ok(
    entry,
    'targetDefaults.test.inputs MUST include a { dependentTasksOutputFiles } entry so a ' +
      "task-dependsOn dependency's BUILD OUTPUT is in the test hash — otherwise a spawned " +
      `artifact rebuild serves a stale cached PASS (62535ce7). Got: ${JSON.stringify(testInputs)}`,
  );
  assert.equal(
    typeof entry.dependentTasksOutputFiles,
    'string',
    'dependentTasksOutputFiles must be a glob STRING (nx schema requires it), not a boolean',
  );
  assert.equal(
    entry.transitive,
    true,
    'transitive:true is REQUIRED — the direct dependency agent-mcp:dist-manifest declares no ' +
      'outputs; the artifact is materialized by the transitive agent-mcp:build',
  );
});
