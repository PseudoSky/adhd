// PARITY-INSTRUMENT-ONLY
// Dry-run only: a dependency-free stand-in for the `adhd-backlog` CLI (R12, SCOPE-R12-backlog-cli). It replaces the fake backlog MCP server of R11: the backlog-operator now runs `adhd-backlog <verb> --input '<json>'`
// through its SHELL tool, so the stand-in is a node-shebang executable named exactly `adhd-backlog` (generated per group by backlog-operator.mjs writeFakeBacklogCli, with its state and log paths embedded because
// the shell server hands its children PATH only). MAKES NO NETWORK CALL and never touches the real backlog store.
// It mimics the parts of the real CLI the experiment depends on, each measured against adhd-backlog 1.0.16:
//   - one success/failure envelope line on stdout (`{"ok":true,"data":...,"meta":...}` / `{"ok":false,"error":{code,message}}` with a non-zero exit) and a structured log line on stderr
//   - `--input <json>` is the only argument carrier; `get <uid>` also takes the uid positionally; a unique 8+ hex-char uid prefix is accepted
//   - the typed production-write gate: claim / transition (and every other write verb) are REFUSED without `--allow-production-write`, with the real refusal text (it names the flag)
//   - `query` views: `ready` IGNORES offset (the real view cannot be paged: measured), `list` honours limit/offset with `filter.project` (uid or name) and `filter.status: "open"` = every non-terminal status; `projects`, `components`
//   - items carry project / component as UIDS (the real CLI returns uids, names come from the registry views) and `blockers`
import fs from 'node:fs';

export const TERMINAL = /^(closed|done|fixed|resolved|duplicate|invalid|superseded)$/i;
const WRITE = new Set(['claim', 'transition', 'create', 'update', 'relate', 'delete', 'remove', 'restore', 'move']);
const REFUSAL = (verb) => `Refused: "${verb}" would write to the live PRODUCTION store and no explicit production-write opt-in was passed. Re-run with the typed opt-in — \`--allow-production-write\` on the CLI (and in the \`serve\` server args, e.g. \`.mcp.json\`) — or point the command at an isolated store (--namespace sandbox).`;

/**
 * Run the stand-in once. @returns {number} the exit code. `io.out(line)` / `io.err(line)` receive the stdout / stderr lines.
 */
export function runFakeCli(argv, { stateFile, logFile, now = () => new Date().toISOString(), io }) {
  const out = (o) => io.out(JSON.stringify(o)); const fail = (code, message) => { out({ ok: false, error: { code, message } }); return 1; };
  let allow = false; const toks = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow-production-write') { allow = true; continue; }
    if (argv[i] === '--namespace') { i++; continue; }
    toks.push(argv[i]);
  }
  const verb = toks[0] ?? null; let input = null; const pos = [];
  for (let i = 1; i < toks.length; i++) {
    if (toks[i] === '--input') { try { input = JSON.parse(toks[++i] ?? ''); } catch { return fail('invalid_argument', 'Invalid --input: not JSON'); } continue; }
    if (toks[i].startsWith('--')) { i++; continue; }
    pos.push(toks[i]);
  }
  const env = input?.input ?? input ?? {};
  io.err(JSON.stringify({ level: 30, time: Date.now(), pid: process.pid, command: `backlog ${verb}`, msg: `→ backlog ${verb}` }));
  const log = (extra) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ t: now(), verb, argv, allowProductionWrite: allow, ...extra }) + '\n'); };
  if (!verb) { log({ ok: false }); return fail('not_found', 'Unknown command'); }
  let state; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { log({ ok: false }); return fail('store_unavailable', `fake store unreadable: ${e.code ?? e.message}`); }
  const items = state.items ?? [];
  const findItem = (u) => { if (!u) return null; const exact = items.find((i) => i.uid === u); if (exact) return exact; if (u.length >= 8) { const m = items.filter((i) => i.uid.startsWith(u)); if (m.length === 1) return m[0]; } return null; };
  const projectUid = (v) => (state.projects ?? []).find((p) => p.uid === v || p.name === v)?.uid ?? v;
  const pick = (it, fields, lastN) => { if (!fields) return { uid: it.uid, title: it.title, status: it.status, priority: it.priority }; const o = { uid: it.uid }; for (const f of fields) { if (f === 'blockers') o.blockers = it.blockers ?? []; else if (f === 'auditTrail') o.auditTrail = (it.auditTrail ?? []).slice(-(lastN ?? 5)); else if (f in it) o[f] = it[f]; } return o; };
  const done = (ok, exitCode, extra) => { log({ ok, ...extra }); return exitCode; };

  if (WRITE.has(verb) && !allow) { out({ ok: false, error: { code: 'E_VALIDATION', message: REFUSAL(verb) } }); return done(false, 1, { refused: true }); }

  if (verb === 'query') {
    const view = env.view ?? 'list'; const f = env.filter ?? {}; const limit = env.limit ?? 50;
    if (limit > 1000) { out({ ok: false, error: { code: 'validation', message: `Invalid "limit": must be a positive integer ≤ 1000, got ${limit}` } }); return done(false, 1, {}); }
    if (view === 'projects') { out({ ok: true, data: { view, items: (state.projects ?? []).map((p) => ({ uid: p.uid, name: p.name, ...(p.path ? { path: p.path } : {}) })) } }); return done(true, 0, {}); }
    if (view === 'components') { const pu = f.project ? projectUid(f.project) : null; out({ ok: true, data: { view, items: (state.components ?? []).filter((c) => !pu || c.projectUid === pu).map((c) => ({ uid: c.uid, name: c.name, projectUid: c.projectUid })) } }); return done(true, 0, {}); }
    let pool = items.slice(); if (f.project) pool = pool.filter((i) => i.project === projectUid(f.project));
    if (view === 'ready') {
      pool = pool.filter((i) => ['open', 'partial', 'deferred', 'blocked', 'mixed', 'unknown'].includes(String(i.status).toLowerCase()) && (i.blockers ?? []).every((b) => TERMINAL.test(String(b.status))));
      const page = pool.slice(0, limit);   // offset is IGNORED by the real ready view
      out({ ok: true, data: { view, items: page.map((i) => pick(i, env.fields)) }, meta: { total: Math.min(pool.length, page.length + 1), returned: page.length, limit, total_relation: 'gte', has_more: page.length >= limit } }); return done(true, 0, { view });
    }
    if (f.status === 'open') pool = pool.filter((i) => !TERMINAL.test(String(i.status))); else if (typeof f.status === 'string' && f.status !== 'all') pool = pool.filter((i) => i.status === f.status);
    const off = env.offset ?? 0; const page = pool.slice(off, off + limit);
    out({ ok: true, data: { view: 'list', items: page.map((i) => pick(i, env.fields)) }, meta: { total: pool.length, returned: page.length, limit, offset: off } }); return done(true, 0, { view: 'list' });
  }
  if (verb === 'get') {
    const it = findItem(env.uid ?? pos[0]);
    if (!it) { out({ ok: false, error: { code: 'not_found', message: `no item ${env.uid ?? pos[0] ?? '(none)'}` } }); return done(false, 1, {}); }
    out({ ok: true, data: pick(it, env.fields, env.lastN) }); return done(true, 0, { uid: it.uid });
  }
  if (verb === 'claim' || verb === 'transition') {
    const it = findItem(env.uid);
    if (!it) { out({ ok: false, error: { code: 'not_found', message: `no item ${env.uid ?? '(none)'}` } }); return done(false, 1, {}); }
    if (!env.by || !/^[^:]+:[^:]+$/.test(String(env.by))) { out({ ok: false, error: { code: 'invalid_argument', message: '"by" must be a real identity "name:instance"' } }); return done(false, 1, {}); }
    if (verb === 'claim') { it.claimedBy = env.by; fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); out({ ok: true, data: { uid: it.uid, claimedBy: it.claimedBy } }); return done(true, 0, { uid: it.uid }); }
    const from = it.status; it.status = env.toStatus ?? it.status; (it.auditTrail ??= []).push({ action: 'transition', actor: env.by, from, to: it.status, note: env.note ?? null, at: now() });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); out({ ok: true, data: { uid: it.uid, from, to: it.status } }); return done(true, 0, { uid: it.uid, from, to: it.status });
  }
  return done(false, fail('not_found', `Unknown command: ${verb}`), {});
}

/** The bin entry: `main(process.argv.slice(2), {stateFile, logFile})` writes the stdout line to stdout, the structured log line to stderr, and returns the exit code. */
export function main(argv, { stateFile, logFile }) {
  return runFakeCli(argv, { stateFile, logFile, io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) } });
}
