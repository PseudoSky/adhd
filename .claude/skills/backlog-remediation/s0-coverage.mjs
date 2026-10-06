#!/usr/bin/env node
/**
 * s0-coverage — the S0 "100% coverage, zero duplicates" gate, computable on the
 * CURRENT store (backlog 025d3239 D-AC5).
 *
 * The old S0 clustered "mechanically by id family" (`DEBT-DISPATCH-*`) and keyed
 * every stage on `humanId`. Neither exists any more: identity is the global `uid`.
 * This script clusters mechanically by `<project>/<component>/<kind>` (all three
 * are store fields, so the clustering is reproducible), pulls EVERY open item
 * through the paginated `query`, and asserts the flattened uid set equals the
 * pulled uid set with zero duplicates.
 *
 *   node .claude/skills/backlog-remediation/s0-coverage.mjs --dry-run            # prints the number, writes nothing
 *   node .claude/skills/backlog-remediation/s0-coverage.mjs --out tmp/backlog-run # writes clusters.json (only on 100%)
 *   node .claude/skills/backlog-remediation/s0-coverage.mjs --input items.json    # offline, items instead of a store pull
 *
 * Prints `S0 coverage: <clustered>/<pulled> (<pct>%) duplicates=<n>`; exit 1 when
 * coverage is not exactly 100% or any uid is clustered twice.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cluster key for one item — every part is a store field. */
export function clusterKey(item) {
  return `${item.project ?? 'no-project'}/${item.component ?? 'no-component'}/${item.kind ?? 'no-kind'}`;
}

/** @returns {Record<string,string[]>} cluster key -> uids */
export function clusterByUid(items) {
  const clusters = {};
  for (const item of items) (clusters[clusterKey(item)] ??= []).push(item.uid);
  return clusters;
}

/**
 * The S0 gate: flattened cluster uid set == pulled uid set, zero duplicates.
 * @param {Record<string,string[]>} clusters
 * @param {string[]} pulledUids
 */
export function assertCoverage(clusters, pulledUids) {
  const flat = Object.values(clusters).flat();
  const seen = new Set();
  const duplicates = [];
  for (const u of flat) (seen.has(u) ? duplicates.push(u) : seen.add(u));
  const pulled = new Set(pulledUids);
  const missing = [...pulled].filter((u) => !seen.has(u));
  const extra = [...seen].filter((u) => !pulled.has(u));
  const ok = duplicates.length === 0 && missing.length === 0 && extra.length === 0;
  const pct = pulled.size === 0 ? 100 : (100 * (pulled.size - missing.length)) / pulled.size;
  return { ok, pulled: pulled.size, clustered: seen.size, duplicates, missing, extra, pct };
}

/** Pull every open item through the paginated `query` (the `adhd-backlog` CLI, as a consumer would). */
export function pullOpenItems(bin = 'adhd-backlog') {
  const items = [];
  let after;
  for (;;) {
    const input = { filter: { status: 'open' }, fields: ['uid', 'title', 'project', 'component', 'kind'], limit: 200, ...(after ? { after } : {}) };
    const r = spawnSync(bin, ['backlog', 'query', '--input', JSON.stringify(input)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${bin} query failed (exit ${r.status}): ${r.stderr}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('{"ok"'));
    if (!line) throw new Error(`${bin} query returned no result line`);
    const data = JSON.parse(line).data;
    items.push(...data.items);
    if (!data.hasMore) return items;
    after = data.nextCursor;
  }
}

function main(argv) {
  const arg = (n) => (argv.indexOf(n) > -1 ? argv[argv.indexOf(n) + 1] : undefined);
  const input = arg('--input');
  const items = input ? JSON.parse(readFileSync(input, 'utf8')) : pullOpenItems();
  const clusters = clusterByUid(items);
  const cov = assertCoverage(clusters, items.map((i) => i.uid));
  console.log(`S0 coverage: ${cov.clustered}/${cov.pulled} (${cov.pct.toFixed(1)}%) duplicates=${cov.duplicates.length} clusters=${Object.keys(clusters).length}`);
  if (!cov.ok) {
    console.error(`S0 gate FAILED — missing ${cov.missing.length}, unexpected ${cov.extra.length}, duplicated ${cov.duplicates.length}; do not proceed`);
    return 1;
  }
  const out = arg('--out');
  if (out && !argv.includes('--dry-run')) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'clusters.json'), JSON.stringify(clusters, null, 2));
    console.log(`wrote ${join(out, 'clusters.json')}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
