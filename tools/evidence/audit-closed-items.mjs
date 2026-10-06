#!/usr/bin/env node
/**
 * audit-closed-items — report resolved/closed backlog items that carry NO commit
 * citation (backlog 65788fd8, 2e8f9646). AGENTS.md: a completed item is resolved
 * "with a citation recording what changed, why, and the commit reference".
 *
 *   node tools/evidence/audit-closed-items.mjs --input items.json [--repo <dir>]
 *   adhd-backlog backlog query --input '{...,"fields":["uid","title","status","citations","auditTrail"]}' | node tools/evidence/audit-closed-items.mjs
 *
 * Reads the backlog `query` JSON (or a bare array of items). An item is CITED
 * only when a citation `file`/`context` or an audit-trail `note` names a 7-40 hex
 * sha that RESOLVES TO A COMMIT in `--repo` (default cwd) — a hex-looking string
 * that is not a commit does not count, and unresolved is reported (2e8f9646: the
 * old audit counted a grep hit, not an assertion). Both `resolved` and `closed`
 * statuses are audited. Exit 1 when any audited item lacks a commit citation.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TERMINAL = new Set(['resolved', 'closed']);
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

/** True when `sha` names a commit in the repo at `cwd`. */
export function isCommitIn(cwd) {
  return (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' }).status === 0;
}

function textsOf(item) {
  const out = [];
  for (const c of item.citations ?? []) out.push(c.file, c.context);
  for (const a of item.auditTrail ?? []) out.push(a.note);
  return out.filter((t) => typeof t === 'string');
}

/**
 * @param {Array<{uid:string,title?:string,status?:string,citations?:any[],auditTrail?:any[]}>} items
 * @param {(sha:string)=>boolean} isCommit
 * @returns {{ audited: number, uncited: Array<{uid:string,title:string,status:string,reason:string}> }}
 */
export function auditClosedItems(items, isCommit) {
  const uncited = [];
  let audited = 0;
  for (const item of items) {
    if (!TERMINAL.has(String(item.status))) continue;
    audited++;
    const candidates = new Set();
    for (const t of textsOf(item)) for (const m of t.matchAll(SHA_RE)) candidates.add(m[0]);
    if ([...candidates].some(isCommit)) continue;
    uncited.push({
      uid: item.uid,
      title: item.title ?? '',
      status: String(item.status),
      reason: candidates.size === 0 ? 'no commit sha in any citation or audit note' : `sha-like text (${[...candidates].join(', ')}) does not resolve to a commit`,
    });
  }
  return { audited, uncited };
}

function readInput(argv) {
  const i = argv.indexOf('--input');
  const raw = i > -1 ? readFileSync(argv[i + 1], 'utf8') : readFileSync(0, 'utf8');
  // The backlog CLI may print diagnostic JSON lines before the result; take the line carrying `ok`.
  const line = raw.split('\n').find((l) => l.startsWith('{"ok"')) ?? raw;
  const parsed = JSON.parse(line);
  return Array.isArray(parsed) ? parsed : parsed?.data?.items ?? [];
}

function main(argv) {
  const ri = argv.indexOf('--repo');
  const repo = ri > -1 ? argv[ri + 1] : process.cwd();
  const items = readInput(argv);
  const { audited, uncited } = auditClosedItems(items, isCommitIn(repo));
  console.error(`audit-closed-items: ${audited} resolved/closed item(s) audited, ${uncited.length} without a commit citation`);
  for (const u of uncited) console.error(`  ✖ ${u.uid.slice(0, 8)} [${u.status}] ${u.title.slice(0, 80)} — ${u.reason}`);
  return uncited.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
