#!/usr/bin/env node
/**
 * Actionable Store demo — acceptance runner.
 *
 * Seeds the isolated fixture (fixture/seed.sh), then drives every numbered
 * DEMO.md beat through the SHIPPED CLI (`entrypoint/backlog/dist/index.js`).
 * A concurrent `nx build backlog` swaps dist/ non-atomically; a CLI call that
 * lands in that window is retried (see `cli`), so a build cannot tear a beat. Prints one line per beat and a
 * final beats/requirements/capabilities tally.
 *
 * A beat is:
 *   PASS          — every assertion held.
 *   FAIL          — an assertion did not hold (a regression; exit 1).
 *   NOW-RUNNABLE  — the beat was CARRIED as NOT-RUNNABLE, but its in-beat
 *                   assertion now evaluates and holds (a fixed defect). A beat
 *                   whose FULL claim still has an unseedable part reports a
 *                   residual note and is counted as PARTIAL, not fully proven.
 *   SKIP          — genuinely unexecutable: no assertion could be evaluated
 *                   (a missing backend / verb). The reason is printed. Causes
 *                   are classified in DEMO.md §7.3.
 *
 * A NOT-RUNNABLE classification NEVER suppresses an evaluable assertion: the
 * beat still runs and reports the outcome. "A kept assertion that is never
 * evaluated is a comment."
 *
 * Usage (from the repo root):
 *   node docs/plan/actionable-store/demo/fixture/run.mjs
 *
 * It never touches the production store: seed.sh points every invocation at
 * tmp/actionable-store-demo/demo.db via ADHD_BACKLOG_DATABASE_PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const BIN = join(REPO_ROOT, 'entrypoint/backlog/dist/index.js');
const DEMO_DIR = join(REPO_ROOT, 'tmp/actionable-store-demo');
const NODE = process.execPath; // absolute — never rely on a mutable PATH symlink

/**
 * Sleep without a shell, so a retry can outlast a concurrent build's brief
 * `dist/` swap. `Atomics.wait` on the main thread is permitted in Node.
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- seed -----------------------------------------------------------------
process.stderr.write('seeding fixture…\n');
execFileSync('bash', [join(HERE, 'seed.sh')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_BIN: NODE },
});

const env = {};
for (const line of readFileSync(join(DEMO_DIR, 'fixture.env'), 'utf8').split('\n')) {
  const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const F = env; // fixture name -> uid

const D = { ...process.env, ...env, ADHD_BACKLOG_DATABASE_PATH: env.ADHD_BACKLOG_DATABASE_PATH, ADHD_BACKLOG_EMBEDDING_ENABLED: 'false' };

function cli(...argv) {
  // A concurrent `nx build backlog` swaps `dist/` non-atomically (nx's
  // cache-restore is a `remove(dist); copy(cached, dist)`; a real `vite build`
  // wipes it). A call unlucky enough to land in that ~150ms window dies with a
  // torn-dist signature (ENOENT / Cannot find module). That is a build artifact,
  // not a behavioural failure — retry before recording it.
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync(NODE, [BIN, ...argv], { cwd: REPO_ROOT, env: D, encoding: 'utf8' });
    const torn = r.error != null || /Cannot find module|MODULE_NOT_FOUND|ENOENT/.test(r.stderr ?? '');
    if (!torn) return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
    sleepMs(300);
  }
  return { out: '', err: 'cli: dist/ was torn by a concurrent build across 4 attempts', rc: 1 };
}
function J(s) { try { return JSON.parse(s); } catch { return undefined; } }

/**
 * The bare sha256 hex of a tracked blob at HEAD — the EXACT content-address
 * form `checkAnchor`'s full-resolve rung compares against (no `sha256:`
 * prefix; that prefix is never stripped, so a prefixed digest can never
 * match). The digest is what makes "verified" non-vacuous: without it the
 * cheap present-untouched rung returns `verified/changed_since` without ever
 * reading the digest, and a no-op content-address passes.
 */
function digestAtHead(rel) {
  const blob = execFileSync('git', ['-C', REPO_ROOT, 'cat-file', '-p', `HEAD:${rel}`], { encoding: 'utf8' });
  return createHash('sha256').update(blob).digest('hex');
}

// ---- assertion helpers ----------------------------------------------------
const results = [];
function record(id, title, status, detail = '', residual = false) { results.push({ id, title, status, detail, residual }); }

let current = null;
let residualClaimFlag = false;
function beat(id, title) { current = { id, title, checks: [] }; residualClaimFlag = false; }
function ok(name, cond, detail = '') { current.checks.push({ name, pass: !!cond, detail }); }
/**
 * Declare that the beat's in-beat assertion can pass while its FULL claim still
 * has an unseedable part (e.g. 5.1's ambiguity case). Coverage then keeps the
 * beat PARTIAL rather than letting a passing sub-assertion overclaim it.
 */
function residualClaim() { residualClaimFlag = true; }
function finish(notRunnable = undefined) {
  const failed = current.checks.filter((c) => !c.pass);
  if (failed.length) {
    const detail = failed.map((c) => `${c.name}${c.detail ? ' — ' + c.detail : ''}`).join('; ');
    record(current.id, current.title, 'FAIL', notRunnable ? `${detail} — (carried as not-runnable: ${notRunnable})` : detail);
  } else if (notRunnable) {
    if (current.checks.length === 0) {
      record(current.id, current.title, 'SKIP', notRunnable);
    } else {
      record(current.id, current.title, 'NOW-RUNNABLE', notRunnable, residualClaimFlag);
    }
  } else {
    record(current.id, current.title, 'PASS');
  }
  current = null;
  residualClaimFlag = false;
}

// ---- beats ----------------------------------------------------------------
// B0 — cold start
{
  beat('B0', 'Cold start: store reachable & ready');
  const sp = cli('sandbox-path');
  const spj = J(sp.out);
  ok('sandbox-path names an isolated store under repo tmp/', (spj?.dbPath ?? '').includes('/tmp/actionable-store-demo/'), sp.out.trim());
  const sc = cli('store-check');
  ok('store-check exits 0', sc.rc === 0, `rc=${sc.rc}`);
  const probe = cli('serve', '--probe');
  const pj = J(probe.out);
  ok('serve --probe reports ready', probe.rc === 0 && pj?.state === 'ready', probe.out.trim());
  const q = cli('backlog', 'query', '--input', '{"view":"projects","limit":5}');
  const qj = J(q.out);
  ok('query view:projects answers ok', qj?.ok === true && Array.isArray(qj.data?.items), q.out.trim());
  finish();
}

// 1.1 — short reference
{
  beat('1.1', 'Resolve a short reference to exactly one item');
  const full = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.C5 }));
  const fj = J(full.out);
  ok('full uid resolves', fj?.ok === true && fj.data.uid === F.C5, full.out.trim());
  ok('card is C5/FEAT/open/HIGH', fj?.data?.kind === 'FEAT' && fj?.data?.status === 'open' && fj?.data?.priority === 'HIGH');
  const prefix = F.C5.slice(0, 8);
  const pre = cli('backlog', 'get', '--input', JSON.stringify({ uid: prefix }));
  const pj = J(pre.out);
  ok('8-char prefix resolves to the same item', pj?.ok === true && pj.data.uid === F.C5, pre.out.trim());
  finish();
}

// 1.2 — catalogs
{
  beat('1.2', 'Read the catalog instead of guessing a legal value');
  const c = cli('backlog', 'query', '--input', '{"view":"catalogs","limit":5}');
  const cj = J(c.out);
  ok('view:catalogs returns terms[]', cj?.ok === true && cj.data?.view === 'catalogs' && Array.isArray(cj.data.terms), c.out.trim());
  ok('a kind term carries name+lifecycle', (cj?.data?.terms ?? []).some((t) => t.catalog === 'kind' && t.lifecycle === 'active'));
  finish();
}

// 1.3 — plan members in dependency order
{
  beat('1.3', "List a plan's members and order them");
  const call = () => cli('backlog', 'query', '--input', JSON.stringify({ view: 'order', filter: { plan: F.PLAN }, limit: 50 }));
  const a = call(); const aj = J(a.out);
  const order = aj?.data?.order?.order;
  ok('order is the shipped {ok,order} object', aj?.ok === true && aj?.data?.order?.ok === true && Array.isArray(order), a.out.trim());
  ok('order includes both plan members', Array.isArray(order) && order.includes(F.CHILD1) && order.includes(F.CHILD2));
  const b = call();
  ok('deterministic across runs', a.out === b.out);
  finish();
}

// 1.4 — dependent-weight order tiebreak (C2 AC4)
{
  beat('1.4', 'Dependent weight breaks an order tie, deterministically');
  const call = () => cli('backlog', 'query', '--input', '{"view":"order","filter":{"kind":"SPIKE"},"limit":50}');
  const orderOf = (o) => J(o.out)?.data?.order?.order ?? [];
  const a = call();
  const oa = orderOf(a);
  const iX = oa.indexOf(F.AC2_X); const iY = oa.indexOf(F.AC2_Y);
  ok('both equal-in-degree nodes are in the order', iX >= 0 && iY >= 0, a.out.trim().slice(0, 200));
  // X has 2 transitive dependents (D1→D2); Y has 1 (D3). The dependent-count
  // key must order X first — priority is equal, so only uid could decide it,
  // and a uid/FIFO order would flip between the two runs below.
  ok('the node with MORE transitive dependents comes first',
    iX >= 0 && iY >= 0 && iX < iY, `order=${JSON.stringify(oa)} X@${iX} Y@${iY}`);
  const card = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.AC2_X, fields: ['blocksOut', 'dependents'] }));
  const cj = J(card.out)?.data;
  ok('the card exposes blocksOut + the numeric dependents count',
    Array.isArray(cj?.blocksOut) && (cj?.blocksOut?.length ?? 0) >= 1 && cj?.dependents === 2, card.out.trim());
  // Flip the weights: give Y three transitive dependents (D4→D5) so the
  // dependent-count key must now order Y first. If the order were not
  // dependent-count-driven the sequence would NOT flip (uid/priority constant).
  cli('backlog', 'relate', '--input', JSON.stringify({ sourceUid: F.AC2_Y, targetUid: F.AC2_D4, rel: 'blocks', action: 'add', by: 'operator:otto-1' }));
  cli('backlog', 'relate', '--input', JSON.stringify({ sourceUid: F.AC2_D4, targetUid: F.AC2_D5, rel: 'blocks', action: 'add', by: 'operator:otto-1' }));
  const b = call();
  const ob = orderOf(b);
  const jX = ob.indexOf(F.AC2_X); const jY = ob.indexOf(F.AC2_Y);
  ok('swapping the dependent weights flips the order (now Y first)',
    jX >= 0 && jY >= 0 && jY < jX, `order=${JSON.stringify(ob)} X@${jX} Y@${jY}`);
  finish();
}

// 2.1 — derived verdict + typed reason
{
  beat('2.1', 'Ask what may be worked, and get reasons');
  const g = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.PLAN, fields: ['verdict'] }));
  const gj = J(g.out);
  const v = gj?.data?.verdict;
  ok('actionable is false while blocked', v?.actionable === false, g.out.trim());
  const blocked = (v?.conditions ?? []).find((c) => c.type === 'Blocked');
  ok('Blocked condition status is the string "True"', blocked?.status === 'True', JSON.stringify(blocked));
  ok('the Blocked condition names the blocker uid', blocked?.subject === F.BLOCKER);
  ok('severity block + code BlockedBy', blocked?.severity === 'block' && blocked?.code === 'BlockedBy');
  finish();
}

// 2.2 — claim blocked work refused
{
  beat('2.2', 'Claim blocked work — and be refused, loudly');
  const c = cli('backlog', 'claim', '--input', JSON.stringify({ uid: F.BLOCKED, by: 'dispatcher:dee-1', action: 'claim' }));
  const cj = J(c.out);
  ok('non-zero exit + precondition_failed', c.rc !== 0 && cj?.error?.code === 'precondition_failed', `rc=${c.rc} ${c.out.trim()}`);
  ok('the refusal names the blocking uid', (cj?.error?.message ?? '').includes(F.BLOCKER), c.out.trim());
  const g = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.BLOCKED }));
  const gj = J(g.out);
  ok('item was not claimed', gj?.data?.status === 'open' && gj?.data?.claimedBy === undefined, g.out.trim());
  finish();
}

// 2.3 — attest anchored evidence (identity unchanged); REAL digest
{
  beat('2.3', 'Back a finding with evidence that survives review');
  const rel = 'entrypoint/backlog/src/write/create-issue.ts';
  const a = cli('backlog', 'attest', '--input', JSON.stringify({
    subject: { id: F.RESEARCH, revision: 0 },
    claim: { kind: 'source-reading', body: 'similarity scan is project-scoped' },
    anchor: { locator: `path:${rel}`, digest: digestAtHead(rel) },
    by: 'researcher:rex-1',
  }));
  const aj = J(a.out);
  ok('attest ok, separate attestationUid', aj?.ok === true && typeof aj.data?.attestationUid === 'string', a.out.trim());
  ok('check.state verified via changed_since', aj?.data?.check?.state === 'verified' && aj?.data?.check?.method === 'changed_since', JSON.stringify(aj?.data?.check));
  ok('check carries checked_at/checked_by, never absent', typeof aj?.data?.check?.checked_at === 'string' && aj?.data?.check?.checked_by === 'researcher:rex-1');
  const g = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.RESEARCH }));
  ok('subject uid unchanged', J(g.out)?.data?.uid === F.RESEARCH);
  finish();
}

// 2.4 — sibling-repo citation (a GENUINE second registered work tree)
{
  beat('2.4', 'A sibling-repo citation is verified, not falsely refuted');
  const r = cli('backlog', 'recheck', '--input', JSON.stringify({ attestationUid: F.CROSS_ATT, by: 'dispatcher:dee-1' }));
  const rj = J(r.out);
  const latest = rj?.data?.checks?.[rj.data.checks.length - 1];
  ok('recheck appends (history readable)', Array.isArray(rj?.data?.checks) && rj.data.checks.length >= 2, r.out.trim());
  // The seeded anchor lives in a SECOND registered project root — a real git
  // work tree beside the demo store (its own .git), NOT a tracked file of this
  // repo. Its absolute path is absent from THIS repo's HEAD, so only
  // sibling-root resolution can verify it; a subject-root-only ladder reports
  // stale/unknown (the pre-fix false refutation).
  const siblingEvidence = String(F.CROSS_ANCHOR).replace(/^path:/, '');
  const siblingRoot = dirname(siblingEvidence);
  ok('the anchor points into the seeded sibling work tree (a real second git work tree)',
    String(F.CROSS_ANCHOR).startsWith(`path:${join(DEMO_DIR, 'sibling-repo')}/`) &&
      existsSync(join(siblingRoot, '.git')),
    String(F.CROSS_ANCHOR));
  const inThisRepo = spawnSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', `HEAD:${relative(REPO_ROOT, siblingEvidence)}`], { encoding: 'utf8' });
  ok("the anchor is ABSENT from THIS repo's HEAD (only sibling-root resolution can verify it)",
    inThisRepo.status !== 0, `git cat-file -e exit=${inThisRepo.status}`);
  ok("resolves against the citation's OWN (sibling) project root — verified via changed_since",
    latest?.state === 'verified' && latest?.method === 'changed_since',
    JSON.stringify(latest));
  finish();
}

// 2.5 — the anchor digest is a real content-address (FIXED digest, with control)
{
  beat('2.5', 'An anchor digest is a real content-address, not a placeholder');
  // The sibling file changed after filing, so the changed-since rung hands off
  // to the FULL re-resolve, which hashes HEAD and compares it to the digest.
  const g = cli('backlog', 'recheck', '--input', JSON.stringify({ attestationUid: F.DIGEST_GOOD, by: 'dispatcher:dee-1' }));
  const gl = J(g.out)?.data?.checks?.at(-1);
  ok('a real digest matches the HEAD blob at the full-resolve rung → verified',
    gl?.state === 'verified' && gl?.method === 'full_resolve', JSON.stringify(gl));
  // Negative control: the SAME rung, a WRONG digest → stale. If the digest were
  // not read (a placeholder), full_resolve could never report stale here.
  const b = cli('backlog', 'recheck', '--input', JSON.stringify({ attestationUid: F.DIGEST_BAD, by: 'dispatcher:dee-1' }));
  const bl = J(b.out)?.data?.checks?.at(-1);
  ok('a wrong digest is reported stale at the full-resolve rung (the digest is read, not a no-op)',
    bl?.state === 'stale' && bl?.method === 'full_resolve', JSON.stringify(bl));
  finish();
}

// 2.6 — the honest floor (REQ-014)
{
  beat('2.6', 'The honest floor: an un-obligated item is actionable by default');
  const g = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.CLAIM_1, fields: ['verdict'] }));
  const gj = J(g.out);
  const v = gj?.data?.verdict;
  ok('an un-obligated, unblocked item reads actionable:true', v?.actionable === true, g.out.trim());
  const missing = (v?.conditions ?? []).find((c) => c.code === 'MissingObligation');
  ok('it carries a warn-severity MissingObligation condition (the honest floor, never a block)',
    missing?.severity === 'warn' && missing?.status === 'True', JSON.stringify(missing));
  finish();
}

// 3.1 — spec revision is a pointer, not churn
{
  beat('3.1', "Axl's spec lands in the ticket, not beside it");
  const g0 = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.C5, fields: ['spec'] }));
  ok('get fields:["spec"] returns data.spec.spec_revision == base rev', J(g0.out)?.data?.spec?.spec_revision === F.C5_REV0, g0.out.trim());
  const ap = cli('backlog', 'spec-append', '--input', JSON.stringify({
    uid: F.C5, fragment: '## AC1\n- proof', base_revision: F.C5_REV0, by: 'architect:axl-1',
  }));
  const apj = J(ap.out);
  ok('append advances to a NEW revision uid', apj?.ok === true && apj.data.spec_revision !== F.C5_REV0 && apj.data.revision_seq === 2, ap.out.trim());
  ok('ticket uid preserved', apj?.data?.uid === F.C5);
  const chkOld = cli('backlog', 'spec-check', '--input', JSON.stringify({ uid: F.C5, token: F.C5_TOK0 }));
  const co = J(chkOld.out)?.data;
  ok('older token reads stale (method token, reason older-token)', co?.state === 'stale' && co?.method === 'token' && co?.reason === 'older-token', JSON.stringify(co));
  const chkNone = cli('backlog', 'spec-check', '--input', JSON.stringify({ uid: F.C5 }));
  const cn = J(chkNone.out)?.data;
  ok('absent token reads stale (method none), never fresh', cn?.state === 'stale' && cn?.method === 'none' && cn?.reason === 'no-token-supplied', JSON.stringify(cn));
  finish();
}

// 3.2 — declare a typed obligation before building
{
  beat('3.2', 'Axl declares the obligation before building');
  const o = cli('backlog', 'obligate', '--input', JSON.stringify({
    uid: F.C5, applies_to: { to: 'closed' },
    requirement: { op: 'evidence', kind: 'published-artifact', min: 1 },
    on_fail: 'block', by: 'architect:axl-1',
  }));
  const oj = J(o.out);
  ok('obligate ok, returns obligationUid', oj?.ok === true && typeof oj.data?.obligationUid === 'string', o.out.trim());
  const g = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.C5, fields: ['obligations'] }));
  const ob = J(g.out)?.data?.obligations ?? [];
  ok('obligation reads back as the closed predicate', ob.length >= 1 && ob[0].requirement?.op === 'evidence' && ob[0].requirement?.kind === 'published-artifact' && ob[0].applies_to?.to === 'closed');
  const bad = cli('backlog', 'obligate', '--input', JSON.stringify({ uid: F.C5, requirement: { op: 'evidence', kind: 'x' }, on_fail: 'block', by: 'architect:axl-1' }));
  ok('omitting applies_to is rejected', bad.rc !== 0, bad.out.trim() + bad.err.trim().slice(0, 120));
  finish();
}

// 3.3 — parallel claim (FIXED: a close-scoped obligation no longer refuses the claim)
{
  beat('3.3', 'The fleet works in parallel, and the store keeps them honest');
  // The demo claims an item that beat 3.2 just obligated toward `closed`.
  const c = cli('backlog', 'claim', '--input', JSON.stringify({ uid: F.C5, by: 'backend:bo-1', action: 'claim' }));
  const cj = J(c.out);
  ok("the demo's obligated claim succeeds (proof-due-at-close declared BEFORE building)", cj?.ok === true, c.out.trim());
  // Supporting evidence: the lease protocol itself works on un-obligated items.
  const probe = cli('batch', 'action', '--input', JSON.stringify({
    operation: 'backlog/claim', mode: 'parallel',
    items: [
      { input: { uid: F.CLAIM_1, by: 'backend:bo-1', action: 'claim' } },
      { input: { uid: F.CLAIM_2, by: 'test:tess-1', action: 'claim' } },
    ],
  }));
  const pj = J(probe.out);
  const probeOk = Array.isArray(pj) && pj.length === 2 && pj.every((r) => r.value?.ok === true);
  ok('two un-obligated items are claimed in parallel (the lease mechanism itself)', probeOk, probe.out.trim().slice(0, 200));
  finish();
}

// 3.4 — record a finding against a ticket in flight; REAL digest
{
  beat('3.4', 'Record a finding against a ticket in flight');
  const rel = 'entrypoint/backlog/src/write/transition.ts';
  // Read the ACTUAL `revision` counter (via the verdict — its only card
  // surface) — not `status`, which is what a prior revision of this beat
  // wrongly read while claiming to assert the revision.
  const revisionOf = (uid) => J(cli('backlog', 'get', '--input', JSON.stringify({ uid, fields: ['verdict'] })).out)?.data?.verdict?.revision;
  const before = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.C3 }));
  const beforeRev = revisionOf(F.C3);
  const a = cli('backlog', 'attest', '--input', JSON.stringify({
    subject: { id: F.C3, revision: 1 },
    claim: { kind: 'reproduction', body: 'two-process latch reproduces the race' },
    anchor: { locator: `path:${rel}`, digest: digestAtHead(rel) },
    by: 'researcher:rex-1',
  }));
  const aj = J(a.out);
  const after = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.C3 }));
  const afterRev = revisionOf(F.C3);
  ok('attest ok (observed revision 1)', aj?.ok === true && aj?.data?.subject?.revision === 1, a.out.trim());
  ok('ticket uid byte-identical before/after', J(before.out)?.data?.uid === J(after.out)?.data?.uid && J(after.out)?.data?.uid === F.C3);
  ok('attest does NOT bump the subject revision — the `revision` counter is unchanged',
    typeof beforeRev === 'number' && beforeRev === afterRev,
    `before=${beforeRev} after=${afterRev}`);
  finish();
}

// 3.5 — the revision counter is real: mutating writes bump it, supersede mints a new node (DESIGN §2 P4; C6)
{
  beat('3.5', 'Every mutating write bumps the revision counter — and a body edit mints a new node');
  const mk = (title) => J(cli('backlog', 'create', '--input', JSON.stringify({
    title, body: 'revision-counter probe', project: 'adhd', kind: 'FEAT', status: 'open',
    priority: 'HIGH', by: 'operator:otto-1', duplicateAction: 'force',
  })).out)?.data?.uid;
  const revOf = (uid) => J(cli('backlog', 'get', '--input', JSON.stringify({ uid, fields: ['verdict'] })).out)?.data?.verdict?.revision;
  const u = mk('Revision counter probe');
  ok('create seeds revision 0 (a never-mutated issue)', revOf(u) === 0, `rev=${revOf(u)}`);
  cli('backlog', 'update', '--input', JSON.stringify({ uid: u, by: 'operator:otto-1', priority: 'LOW' }));
  ok('update (in-place) bumps +1', revOf(u) === 1, `rev=${revOf(u)}`);
  cli('backlog', 'claim', '--input', JSON.stringify({ uid: u, by: 'backend:bo-1', action: 'claim' }));
  ok('claim bumps +1', revOf(u) === 2, `rev=${revOf(u)}`);
  cli('backlog', 'claim', '--input', JSON.stringify({ uid: u, by: 'backend:bo-1', action: 'release' }));
  ok('release bumps +1', revOf(u) === 3, `rev=${revOf(u)}`);
  const tgt = mk('Revision counter relate target');
  cli('backlog', 'relate', '--input', JSON.stringify({ sourceUid: u, targetUid: tgt, rel: 'blocks', action: 'add', by: 'operator:otto-1' }));
  ok('relate (as source) bumps +1', revOf(u) === 4, `rev=${revOf(u)}`);
  cli('backlog', 'upsert-component', '--input', JSON.stringify({ project: 'adhd', name: 'demo-other', path: 'demo/other', by: 'operator:otto-1' }));
  cli('backlog', 'move', '--input', JSON.stringify({ uid: u, by: 'operator:otto-1', toComponent: 'demo-other' }));
  ok('move (to a different component) bumps +1', revOf(u) === 5, `rev=${revOf(u)}`);
  cli('backlog', 'transition', '--input', JSON.stringify({ uid: u, by: 'operator:otto-1', toStatus: 'closed', note: 'revision probe' }));
  ok('transition bumps +1', revOf(u) === 6, `rev=${revOf(u)}`);
  // A body edit supersedes: a NEW node is minted carrying nextRevision.
  const fresh = mk('Revision supersede probe');
  const priorRev = revOf(fresh);
  const sup = cli('backlog', 'update', '--input', JSON.stringify({ uid: fresh, by: 'operator:otto-1', body: 'superseded body' }));
  const supj = J(sup.out);
  const newUid = supj?.data?.uid;
  ok('a body edit mints a NEW uid (supersede, never an in-place identity rewrite)',
    supj?.ok === true && typeof newUid === 'string' && newUid !== fresh, JSON.stringify(supj));
  ok('the superseding node carries nextRevision (prior + 1)', revOf(newUid) === priorRev + 1, `prior=${priorRev} new=${revOf(newUid)}`);
  finish();
}

// 3.6 — a batch is ungated only as an OUTER verb; each inner claim/transition still gates (DESIGN §2 P3)
{
  beat('3.6', 'A batch gates each inner claim/transition — the gated item is refused, the free one proceeds');
  const claimBatch = cli('batch', 'action', '--input', JSON.stringify({
    operation: 'backlog/claim', mode: 'parallel',
    items: [
      { input: { uid: F.BATCH_BLOCKED, by: 'dispatcher:dee-1', action: 'claim' } },
      { input: { uid: F.BATCH_FREE, by: 'test:tess-1', action: 'claim' } },
    ],
  }));
  const cb = J(claimBatch.out);
  ok('claim batch: the blocked inner item is refused by its OWN gate',
    Array.isArray(cb) && cb[0]?.value?.ok === false && cb[0]?.value?.error?.code === 'precondition_failed',
    JSON.stringify(cb?.[0]));
  ok('claim batch: the refusal names the blocker', (cb?.[0]?.value?.error?.message ?? '').includes(F.BLOCKER));
  ok('claim batch: the FREE inner item in the SAME batch succeeds',
    cb?.[1]?.value?.ok === true && cb?.[1]?.value?.data?.status === 'claimed', JSON.stringify(cb?.[1]));
  const blockedCard = J(cli('backlog', 'get', '--input', JSON.stringify({ uid: F.BATCH_BLOCKED })).out)?.data;
  ok('the refused item was not claimed (no partial state)', blockedCard?.status === 'open' && !blockedCard?.claimedBy);
  const transBatch = cli('batch', 'action', '--input', JSON.stringify({
    operation: 'backlog/transition', mode: 'parallel',
    items: [
      { input: { uid: F.BATCH_OBLIGATED, by: 'dispatcher:dee-1', toStatus: 'closed', note: 'batch probe' } },
      { input: { uid: F.BATCH_FREE2, by: 'dispatcher:dee-1', toStatus: 'closed', note: 'batch probe' } },
    ],
  }));
  const tb = J(transBatch.out);
  ok('transition batch: the obligated inner item is refused by its OWN gate (EvidenceUnverified)',
    Array.isArray(tb) && tb[0]?.value?.ok === false && (tb[0]?.value?.error?.message ?? '').includes('EvidenceUnverified'),
    JSON.stringify(tb?.[0]));
  ok('transition batch: the FREE inner item in the SAME batch closes',
    tb?.[1]?.value?.ok === true && tb?.[1]?.value?.data?.toStatus === 'closed', JSON.stringify(tb?.[1]));
  const oblCard = J(cli('backlog', 'get', '--input', JSON.stringify({ uid: F.BATCH_OBLIGATED })).out)?.data;
  ok('the refused item was not closed (status unchanged on re-read)', oblCard?.status === 'open', JSON.stringify(oblCard));
  finish();
}

// 4 — the gate that will not call a merge done; REAL digest
{
  beat('4', 'The gate that will not call a merge "done"');
  const t1 = cli('backlog', 'transition', '--input', JSON.stringify({
    uid: F.COMMITREF, by: 'dispatcher:dee-1', toStatus: 'closed', note: 'merged',
    citations: [{ file: 'package.json', lines: '1-1' }],
  }));
  const t1j = J(t1.out);
  ok('step 1 refused with EvidenceUnverified naming published-artifact',
    t1j?.error?.code === 'precondition_failed' &&
      (t1j?.error?.message ?? '').includes('EvidenceUnverified') &&
      (t1j?.error?.message ?? '').includes('published-artifact'),
    t1.out.trim());
  const mid = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.COMMITREF }));
  ok('status unchanged on disk after the refusal (nothing soft-closed)', J(mid.out)?.data?.status === 'open');
  const rel = 'entrypoint/backlog/package.json';
  const at = cli('backlog', 'attest', '--input', JSON.stringify({
    subject: { id: F.COMMITREF, revision: 2 },
    claim: { kind: 'published-artifact', body: '@adhd/backlog@1.0.5' },
    anchor: { locator: `path:${rel}`, digest: digestAtHead(rel) },
    by: 'backend:bo-1',
  }));
  ok('registry-free mechanical anchor verifies (path:)', J(at.out)?.data?.check?.state === 'verified', at.out.trim());
  const t2 = cli('backlog', 'transition', '--input', JSON.stringify({
    uid: F.COMMITREF, by: 'dispatcher:dee-1', toStatus: 'closed', note: 'published',
  }));
  const t2j = J(t2.out);
  ok('step 3 succeeds and records the transition', t2j?.ok === true && t2j.data.toStatus === 'closed' && typeof t2j.data.transitionUid === 'string', t2.out.trim());
  const fin = cli('backlog', 'get', '--input', JSON.stringify({ uid: F.COMMITREF }));
  ok('item is closed', J(fin.out)?.data?.status === 'closed');
  finish();
}

// 5.1 — ambiguous prefix (assertion evaluated; ambiguity half is a scope gap)
{
  beat('5.1', 'An ambiguous prefix is refused, not guessed');
  const short = cli('backlog', 'get', '--input', '{"uid":"4fc"}');
  ok('a sub-8-char prefix is refused (invalid_argument, not item_not_found)',
    J(short.out)?.error?.code === 'invalid_argument', short.out.trim());
  // The beat's FULL claim — a genuine `ambiguous_reference` naming every
  // candidate — cannot be exercised here: it needs two live nodes sharing an
  // 8-hex prefix, and the shipped write API mints crypto.randomUUID() with no
  // override, so the isolated fixture cannot seed a collision deterministically.
  residualClaim();
  finish('the too-short refusal holds (NOW-RUNNABLE); a genuine `ambiguous_reference` needs two live nodes sharing an 8-hex prefix, which this isolated fixture cannot seed deterministically — that half remains a scope gap (UNRESOLVED.md §2.2/§4).');
}

// 5.2 — cycle named, not hung on
{
  beat('5.2', 'A dependency cycle is named, not hung on');
  cli('backlog', 'relate', '--input', JSON.stringify({ sourceUid: F.CYCLE_A, targetUid: F.CYCLE_B, rel: 'blocks', action: 'add', by: 'operator:otto-1' }));
  cli('backlog', 'relate', '--input', JSON.stringify({ sourceUid: F.CYCLE_B, targetUid: F.CYCLE_A, rel: 'blocks', action: 'add', by: 'operator:otto-1' }));
  const o = cli('backlog', 'query', '--input', '{"view":"order","filter":{"kind":"FEAT"},"limit":50}');
  const oj = J(o.out);
  const ord = oj?.data?.order;
  ok('envelope ok:true; the cycle rides inside data.order', oj?.ok === true && ord?.ok === false, o.out.trim().slice(0, 300));
  ok('the cycle names both members', Array.isArray(ord?.cycle) && ord.cycle.includes(F.CYCLE_A) && ord.cycle.includes(F.CYCLE_B));
  finish();
}

// 5.3 — a truncated page can never read as complete
{
  beat('5.3', 'A truncated page can never read as complete');
  const q = cli('backlog', 'query', '--input', '{"view":"ready","limit":5}');
  const qj = J(q.out);
  const m = qj?.meta;
  ok('meta.returned equals items actually returned', m?.returned === qj?.data?.items?.length, JSON.stringify(m));
  ok('meta.has_more is present and boolean', typeof m?.has_more === 'boolean');
  ok('there is no meta.truncated on an item-list view', m?.truncated === undefined, JSON.stringify(m));
  finish();
}

// 5.4 — rank-derived score labelled (NOT-RUNNABLE: no embedding backend)
{
  beat('5.4', 'A rank-derived score is labelled, not mistaken for confidence');
  finish('requires the semantic/embedding backend. The demo fixture runs embedding.enabled:false for determinism (and the optional @adhd/sox-embedding-provider is not part of the default install); with it off, filter.semantic answers invalid_argument "semantic search is not configured". No assertion can be evaluated without the backend.');
}

// 5.5 — advertised surface is real
{
  beat('5.5', 'The advertised surface is real (no phantom verbs)');
  const help = cli('--help');
  const beats = (help.out.match(/^\s{2}backlog [a-z-]+/gm) ?? []).length;
  ok('help advertises the verb surface', beats >= 15, `verbs=${beats}`);
  const a = cli('backlog', 'attest', '--input', '{}');
  ok('attest with a missing required property is invalid_argument (not not_found)', a.rc !== 0 && a.err.includes('invalid_argument') && a.err.includes("required property 'subject'"), a.err.slice(0, 160));
  finish();
}

// 5.6 — similar items (NOT-RUNNABLE: no embedding backend)
{
  beat('5.6', 'Cross-project similar items are surfaced, never auto-linked');
  finish('requires the semantic/embedding backend: view:"similar" routes through the vector space and answers invalid_argument "semantic search is not configured" without it. No assertion can be evaluated without the backend.');
}

// 5.7 — deployed copy checked against source (NOT-RUNNABLE: no such verb)
{
  beat('5.7', 'The deployed copy is checked against its source');
  // A PROBE of an EXTERNAL, unimplemented feature (D-B lives in sox-ecosystem,
  // not this repo). It is not an assertion about THIS build, so it is reported
  // informationally and the beat SKIPs — it must not turn the runner red for
  // another repo's unimplemented verb.
  const v = spawnSync('soxe', ['verify', '--host', 'opencode'], { encoding: 'utf8' });
  const probe = ((v.stdout ?? '') + (v.stderr ?? '')).trim().split('\n')[0];
  process.stderr.write(`  [5.7 probe] soxe verify → ${probe || `(no output, exit ${v.status})`}\n`);
  finish('the D-B artifact-lifecycle `verify` command does not exist in the shipped soxe CLI (soxe reports: unknown verb \'verify\'); D-B is specified but unimplemented in sox-ecosystem. No assertion about THIS build can be evaluated.');
}

// 5.8 — the list path's p95 bound, MEASURED (C6 AC5)
{
  beat('5.8', 'The list path is bounded to rungs 1–2, and its p95 is measured (C6 AC5)');
  const e = spawnSync(NODE, [
    'entrypoint/backlog/tools/with-dist-lock.mjs', 'npx', 'vitest', 'run',
    '--config', 'entrypoint/backlog/vitest.e2e.config.ts', 'verdict-list-bound',
  ], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' });
  const out = (e.stdout ?? '') + (e.stderr ?? '');
  const m = /\[C6 AC6\] N=(\d+) items \(returned (\d+)\); list-path p95 = ([\d.]+)ms over \d+ runs; maxRungObserved = (\d+)/.exec(out);
  ok('verdict-list-bound.e2e.ts runs green (exit 0)', e.status === 0, `rc=${e.status} ${out.trim().slice(-400)}`);
  ok('it reports an N-item list-path p95', m !== null, out.trim().slice(-400));
  ok('the list path never evaluates a rung beyond 2', m !== null && Number(m[4]) <= 2, m ? m[0] : 'no measurement captured');
  process.stderr.write(`  [5.8] ${m ? m[0] : 'no measurement captured'}\n`);
  finish();
}

// R1–R7 — DESIGN §3 refusals hold. A refusal is the ABSENCE of a feature, so
// each beat is a NEGATIVE CONTROL that asserts the refused thing cannot be
// done against the live build (not a positive capability beat).
{
  beat('R1', 'DESIGN §3 refuses a stored `ready`/`done` actionability — it is derived, never stored');
  const u = cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', actionable: true }));
  ok('`update` refuses a persisted `actionable` field (additionalProperties)',
    u.rc !== 0 && u.err.includes('invalid_argument') && u.err.includes('actionable'), u.err.trim().slice(0, 200));
  const c = cli('backlog', 'create', '--input', JSON.stringify({ title: 'stored-actionability probe', body: 'x', project: 'adhd', kind: 'FEAT', status: 'open', priority: 'HIGH', by: 'operator:otto-1', actionable: true }));
  ok('`create` refuses a persisted `actionable` field', c.rc !== 0 && c.err.includes('actionable'), c.err.trim().slice(0, 200));
  const v = J(cli('backlog', 'get', '--input', JSON.stringify({ uid: F.PLAN, fields: ['verdict'] })).out)?.data?.verdict;
  ok('actionability is instead DERIVED — the verdict carries a read-time `evaluated_at` + `revision`',
    typeof v?.evaluated_at === 'string' && typeof v?.revision === 'number', JSON.stringify(v));
  const good = cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', priority: 'HIGH' }));
  ok('control: the SAME verb accepts a real field (the refusal is specific to actionability)',
    good.rc === 0 && J(good.out)?.ok === true, good.out.trim().slice(0, 120));
  finish();
}

{
  beat('R2', 'DESIGN §3 refuses a per-project workflow/policy engine — the predicate core is closed (no CEL leaf)');
  const cel = cli('backlog', 'obligate', '--input', JSON.stringify({ uid: F.PLAN, applies_to: { to: 'closed' }, requirement: { op: 'cel', expr: 'x' }, on_fail: 'block', by: 'operator:otto-1' }));
  ok('a top-level `{op:"cel",…}` predicate is refused (not one of the six closed ops)',
    cel.rc !== 0 && cel.err.includes('invalid_argument') && cel.err.includes('oneOf'), cel.err.trim().slice(0, 200));
  const nested = cli('backlog', 'obligate', '--input', JSON.stringify({ uid: F.PLAN, applies_to: { to: 'closed' }, requirement: { op: 'all_of', of: [{ op: 'cel', expr: 'x' }] }, on_fail: 'block', by: 'operator:otto-1' }));
  ok('a CEL leaf nested inside `all_of` is refused too',
    nested.rc !== 0 && nested.err.includes('invalid_argument'), nested.err.trim().slice(0, 200));
  const good = cli('backlog', 'obligate', '--input', JSON.stringify({ uid: F.PLAN, applies_to: { to: 'closed' }, requirement: { op: 'evidence', kind: 'published-artifact', min: 1 }, on_fail: 'block', by: 'operator:otto-1' }));
  ok('control: a VALID predicate of the closed core is accepted (the refusal is the CEL leaf, not `obligate`)',
    good.rc === 0 && typeof J(good.out)?.data?.obligationUid === 'string', good.out.trim().slice(0, 140));
  finish();
}

{
  beat('R3', 'DESIGN §3 refuses waves/tiers/turn budgets — orchestration state is not persisted');
  const w = cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', wave: 'w1' }));
  const t = cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', tier: 1 }));
  const b = cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', budget: 5 }));
  ok('`update` refuses a `wave` field', w.rc !== 0 && w.err.includes('wave'), w.err.trim().slice(0, 120));
  ok('`update` refuses a `tier` field', t.rc !== 0 && t.err.includes('tier'), t.err.trim().slice(0, 120));
  ok('`update` refuses a `budget` field', b.rc !== 0 && b.err.includes('budget'), b.err.trim().slice(0, 120));
  const terms = J(cli('backlog', 'query', '--input', '{"view":"catalogs","limit":500}').out)?.data?.terms ?? [];
  ok('no wave/tier/budget term exists in any catalog (no persisted orchestration vocabulary)',
    !terms.some((x) => /^(wave|tier|budget)$/i.test(x.name)), '');
  finish();
}

{
  beat('R4', 'DESIGN §3 refuses acceptance prose as structured data — a prose citation mints nothing');
  const c = cli('backlog', 'create', '--input', JSON.stringify({ title: 'Prose Citations probe', body: 'A prose line.\n\nCitations: [path:docs/x.md:1, agent:someone]', project: 'adhd', kind: 'FEAT', status: 'open', priority: 'HIGH', by: 'operator:otto-1', duplicateAction: 'force' }));
  const uid = J(c.out)?.data?.uid;
  ok('the item is created and its body is stored verbatim', J(c.out)?.ok === true && typeof uid === 'string', c.out.trim().slice(0, 160));
  const card = J(cli('backlog', 'get', '--input', JSON.stringify({ uid, fields: ['citations', 'body'] })).out)?.data;
  ok('a prose `Citations:` line mints NO citation (citations stays empty)',
    Array.isArray(card?.citations) && card.citations.length === 0, JSON.stringify(card?.citations));
  ok('the prose itself is preserved in the body, untouched (never parsed into structure)',
    (card?.body ?? '').includes('Citations: [path:docs/x.md:1'), String(card?.body).slice(0, 80));
  finish();
}

{
  beat('R5', 'DESIGN §3 refuses markdown regeneration — nothing writes a BACKLOG.md projection');
  const help = cli('--help').out;
  ok('the verb surface advertises no render/regenerate/projection writer',
    !/^\s{2}backlog (render|regenerate|project|export|write)\b/m.test(help), '');
  const projection = join(REPO_ROOT, 'BACKLOG.md');
  const before = statSync(projection).mtimeMs;
  // A markdown-rendering READ and a real WRITE — neither may rewrite the projection.
  const md = J(cli('backlog', 'query', '--input', '{"view":"ready","format":"markdown","limit":1}').out)?.data?.markdown;
  ok('control: a markdown RENDER returns text on the wire (it just never writes a projection file)',
    typeof md === 'string' && md.length > 0, String(md).slice(0, 80));
  cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', assignee: 'operator:otto-1' }));
  const after = statSync(projection).mtimeMs;
  ok('the tracked BACKLOG.md projection is untouched by a markdown read + a write',
    before === after, `before=${before} after=${after}`);
  finish();
}

{
  beat('R6', 'DESIGN §3 refuses a new `kind` for a process stage — the vocabulary is governed');
  const s = cli('backlog', 'update', '--input', JSON.stringify({ uid: F.PLAN, by: 'operator:otto-1', stage: 'build' }));
  ok('`update` refuses a persisted `stage` field (no stage state)', s.rc !== 0 && s.err.includes('stage'), s.err.trim().slice(0, 120));
  const epic = cli('backlog', 'create', '--input', JSON.stringify({ title: 'stage-kind probe', body: 'x', project: 'adhd', kind: 'EPIC', status: 'open', priority: 'HIGH', by: 'operator:otto-1' }));
  const epicMsg = J(epic.out)?.error?.message ?? epic.err;
  ok('a retired process kind (`EPIC`) is refused on mint (governed vocabulary)',
    epic.rc !== 0 && /deprecated kind/i.test(epicMsg), epicMsg.slice(0, 200));
  const kinds = (J(cli('backlog', 'query', '--input', '{"view":"catalogs","catalog":"kind","limit":500}').out)?.data?.terms ?? []).map((x) => x.name);
  ok('the shipped kind catalog carries no stage term',
    !kinds.some((k) => /^(stage|phase)$/i.test(k)), JSON.stringify(kinds));
  const good = cli('backlog', 'create', '--input', JSON.stringify({ title: 'stage-kind control', body: 'x', project: 'adhd', kind: 'FEAT', status: 'open', priority: 'HIGH', by: 'operator:otto-1', duplicateAction: 'force' }));
  ok('control: `create` accepts an ordinary kind (the refusal is the retired process kind, not `create`)',
    good.rc === 0 && J(good.out)?.ok === true, good.out.trim().slice(0, 120));
  finish();
}

{
  beat('R7', 'DESIGN §3 refuses temp-file-rename atomicity — the store is a real SQLite transaction');
  const dbPath = J(cli('sandbox-path').out)?.dbPath ?? '';
  ok('the store resolves to a single SQLite file under the demo tmp/',
    dbPath.endsWith('.db') && dbPath.includes('/tmp/actionable-store-demo/'), dbPath);
  const magic = (() => { try { return readFileSync(dbPath).subarray(0, 16).toString('latin1'); } catch { return ''; } })();
  ok('the store file is SQLite ("SQLite format 3"), not a JSON doc rewritten by rename',
    magic.startsWith('SQLite format 3'), JSON.stringify(magic));
  const strays = readdirSync(DEMO_DIR).filter((f) => /\.(tmp|json)$/.test(f));
  ok('no temp/JSON artifact is written beside the store (no temp-file-rename pattern)',
    strays.length === 0, JSON.stringify(strays));
  finish();
}

// 6 — teardown
{
  beat('6', 'Teardown — back to zero');
  const sp = cli('sandbox-path');
  ok('store still resolves to the isolated fixture', (J(sp.out)?.dbPath ?? '').includes('/tmp/actionable-store-demo/'));
  const tracked = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', 'tmp'], { encoding: 'utf8' });
  ok('no demo artifact is tracked in the repo tree (every demo write lives under gitignored tmp/)',
    (tracked.stdout ?? '').trim() === '', tracked.stdout ?? '');
  finish();
}

// ---- tally ----------------------------------------------------------------
const reqOf = {
  '1.1': ['REQ-001'], '1.2': ['REQ-013'], '1.3': ['REQ-002', 'REQ-003', 'REQ-012'],
  '1.4': ['REQ-003', 'REQ-004'],
  '2.1': ['REQ-004', 'REQ-011', 'REQ-014'], '2.2': ['REQ-010'], '2.3': ['REQ-005', 'REQ-006'],
  '2.4': ['REQ-006'], '2.5': ['REQ-005', 'REQ-006'], '2.6': ['REQ-011', 'REQ-014'],
  '3.1': ['REQ-015', 'REQ-005'], '3.2': ['REQ-007'],
  '3.3': ['REQ-010', 'REQ-011'], '3.4': ['REQ-005', 'REQ-011'], '4': ['REQ-008', 'REQ-009'],
  '3.5': ['REQ-011'], '3.6': ['REQ-010', 'REQ-008'],
  '5.1': ['REQ-001'], '5.2': ['REQ-003'], '5.3': ['REQ-012'], '5.4': ['REQ-012'],
  '5.5': ['REQ-013'], '5.6': ['REQ-002'], '5.7': ['REQ-012'], '5.8': ['REQ-011'],
  // R1–R7 are DESIGN §3 REFUSAL negative controls — each asserts the refused
  // thing CANNOT be done. They add teeth to the requirement they defend and do
  // not by themselves prove a new capability.
  'R1': ['REQ-011'], 'R2': ['REQ-007'], 'R3': ['REQ-013'], 'R4': ['REQ-005'],
  'R5': ['REQ-015'], 'R6': ['REQ-013'], 'R7': ['REQ-008'],
  'B0': ['REQ-012'], '6': ['REQ-012'],
};
const capOf = {
  '1.1': ['CAP-001'], '1.2': ['CAP-008'], '1.3': ['CAP-001', 'CAP-002', 'CAP-007'],
  '1.4': ['CAP-002'],
  '2.1': ['CAP-002', 'CAP-006'], '2.2': ['CAP-006'], '2.3': ['CAP-003'], '2.4': ['CAP-003'],
  '2.5': ['CAP-003'], '2.6': ['CAP-006'],
  '3.1': ['CAP-003'], '3.2': ['CAP-004'], '3.3': ['CAP-006', 'CAP-007'], '3.4': ['CAP-003', 'CAP-006'],
  '4': ['CAP-005'], '5.1': ['CAP-001'], '5.2': ['CAP-002'], '5.3': ['CAP-007'],
  '5.4': ['CAP-007'], '5.5': ['CAP-008'], '5.6': ['CAP-001'], '5.7': ['CAP-007'], '5.8': ['CAP-006'],
  '3.5': ['CAP-006'], '3.6': ['CAP-006', 'CAP-005'],
  'R1': ['CAP-006'], 'R2': ['CAP-004'], 'R3': ['CAP-008'], 'R4': ['CAP-003'],
  'R5': ['CAP-003'], 'R6': ['CAP-008'], 'R7': ['CAP-005'],
  'B0': ['CAP-007'], '6': ['CAP-007'],
};

const pass = results.filter((r) => r.status === 'PASS');
const nowRunnable = results.filter((r) => r.status === 'NOW-RUNNABLE');
const fail = results.filter((r) => r.status === 'FAIL');
const skip = results.filter((r) => r.status === 'SKIP');

console.log('\n── beats ─────────────────────────────────────────────');
for (const r of results) {
  const mark = r.status === 'FAIL' ? '✗' : r.status === 'SKIP' ? '⏭' : '✓';
  const tag = r.status === 'SKIP' ? '  [NOT-RUNNABLE]' : r.status === 'NOW-RUNNABLE' ? '  [NOW-RUNNABLE]' : '';
  console.log(`${mark} ${r.id.padEnd(4)} ${r.title}${tag}`);
  if (r.status === 'FAIL') console.log(`     FAIL: ${r.detail}`);
  if (r.status === 'NOW-RUNNABLE' && r.residual) console.log(`     NOTE: ${r.detail}`);
}

// A requirement/capability is FULLY proven only when EVERY beat that proves it
// passed (PASS, or NOW-RUNNABLE with no residual claim gap). A beat that passed
// but carries a residual gap — or one that is SKIPped — makes the Req PARTIAL.
const provenIds = new Set([...pass, ...nowRunnable.filter((r) => !r.residual)].map((r) => r.id));
const evaluatedPassIds = new Set([...pass, ...nowRunnable].map((r) => r.id));
function coverage(map) {
  const all = new Set(Object.values(map).flat());
  const full = [], partial = [];
  for (const id of all) {
    const beatsFor = Object.entries(map).filter(([, v]) => v.includes(id)).map(([k]) => k);
    const proven = beatsFor.filter((b) => provenIds.has(b));
    const evaluated = beatsFor.filter((b) => evaluatedPassIds.has(b));
    if (evaluated.length === 0) continue;
    (proven.length === beatsFor.length ? full : partial).push(id);
  }
  return { full, partial };
}
const rc = coverage(reqOf), cc = coverage(capOf);
const residualCount = nowRunnable.filter((r) => r.residual).length;
console.log('── tally ─────────────────────────────────────────────');
console.log(`beats:        ${pass.length} passed, ${nowRunnable.length} now-runnable, ${fail.length} failed, ${skip.length} NOT-RUNNABLE  (of ${results.length})`);
if (nowRunnable.length) console.log(`              (now-runnable carry a fixed NOT-RUNNABLE classification; ${residualCount} still has a residual scope gap and counts as PARTIAL)`);
console.log(`requirements: ${rc.full.length} / 15 fully proven  (+${rc.partial.length} partial)`);
console.log(`capabilities: ${cc.full.length} / 8 fully proven  (+${cc.partial.length} partial)`);
console.log(`  fully proven requirements: ${rc.full.join(', ')}`);
console.log(`  partial requirements:      ${rc.partial.join(', ')}`);
console.log(`  fully proven capabilities: ${cc.full.join(', ')}`);
console.log(`  partial capabilities:      ${cc.partial.join(', ')}`);
if (fail.length) { console.log('\nFAILED beats:'); for (const r of fail) console.log(`  ${r.id}: ${r.detail}`); }
process.exit(fail.length ? 1 : 0);
