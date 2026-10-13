// PARITY-INSTRUMENT-ONLY
// R11 experiment design "backlog-operator" (SCOPE-R11-backlog-operator-task, owner-directed). Private, unpublished measurement instrument. See README.md "R11: the backlog-operator design".
//
// Owner direction (verbatim, 2026-10-13): "no, the experiment design I told you to use, where an agent dispatches backlog operator using agent mcp, gets a random ticket, implements it, etc. only arms b and c. those are the experiments I want you to run"
// Owner design (verbatim): "dispatch the performance agent on each experiment group providing only verbatim \"<ORIGINAL_PROMPT>\", dispatch each from a worktree cwd. then pause for further instruction."
// Owner target flow (SCOPE-R11-stop-condition, verbatim): "you can stop experiments when b and c both successfully build a ticket e2e dispatch backlog operator to get the ticket fully implemented dispatch review on the code revise and backlog operator again transitioning. once that full flow is verified and the quality is ready to merge we're good"
// Owner prompt update (SCOPE-R11-prompt-update, verbatim): "that is the target, get the experiment prompts updated" -> the ONE exported TASK_PROMPT below carries the full flow.
//
// What a group is: ONE agent-mcp task to the agent named `performance` whose prompt is TASK_PROMPT and nothing else, run with a real git worktree as its cwd. `performance` reaches the agents
// named `backlog-operator` and `review` through agent-mcp's own in-process `agent` + `task` tools (nativeTooling.dispatch), and `backlog-operator` carries the backlog MCP server (mcpServers.backlog,
// the same stdio mechanism the r2info server uses). All three system prompts are the roster files' bodies, verbatim (~/.claude/agents/performance.md, backlog-operator.md, review.md); `review` is
// read-only (Read/Grep/Glob -> fs readOnly) and registered identically in both groups (R11 AC10). The flow-stage detector (flow-stages.mjs, R11 AC11) reads the five stages from state. Groups: B (claudecli provider) and C
// (anthropic provider) ONLY; arm A is refused. Groups differ in the provider and nothing else; the per-group config fact table (record.config) states it and identicalGroupsCheck() enforces it.
//
// LIVE SPEND GATE: real-provider execution happens ONLY behind `drive.mjs --live --yes --round R11` (the existing live gate: tracked ledger, owner approval quoted in ledger.approvedBy, hard cap 2 =
// one run per group, gates before any reservation). Named owner of that gate: nix (repo owner). Nothing here is wired into CI or any nx target. The harness never writes the backlog (its reader is
// restricted to read verbs and never passes --allow-production-write), never removes a worktree, and signals only processes it spawned (drive.mjs sweepOwned / OwnedRegistry).
//
// Pure functions + a dependency-injected runner: this module imports no drive.mjs symbol (drive.mjs hands it a `host`), so it has no import cycle and every rule is unit-testable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as L from './lib.mjs';
import * as LG from './ledger.mjs';
import * as EV from './evidence.mjs';
import * as FS from './flow-stages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };
const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/** The dry run's fake backlog: two unblocked items and one blocked (status 'blocked' is never in the ready view). */
export const DEFAULT_FAKE_ITEMS = Object.freeze([
  { uid: 'fake-0001', title: 'Dry-run item one', status: 'open', priority: 'p2' },
  { uid: 'fake-0002', title: 'Dry-run item two', status: 'open', priority: 'p3' },
  { uid: 'fake-0003', title: 'Dry-run blocked item', status: 'blocked', priority: 'p1' },
]);
export class DesignError extends Error { constructor(m) { super(m); this.name = 'DesignError'; } }

// ----------------------------------------------------------------------------------------------------------------
// Constants (the owner's words are data here, never paraphrased)
// ----------------------------------------------------------------------------------------------------------------
export const DESIGN_ID = 'backlog-operator';
export const SCOPE_ID = 'SCOPE-R11-backlog-operator-task';
/** The scope-log entries that govern this round: the design, the owner's stop condition, and the prompt update (every one must be a heading in the experiment log; ledger.scopeChanges lists them). */
export const SCOPE_IDS = Object.freeze([SCOPE_ID, 'SCOPE-R11-stop-condition', 'SCOPE-R11-prompt-update']);
/** The owner's ORIGINAL design sentence (SCOPE-R11-backlog-operator-task). Kept only so OWNER_DESIGN quotes the owner's message verbatim; it is no longer what the performance agent is handed. */
export const ORIGINAL_PROMPT = 'Have the backlog operator select a random item from the backlog that is unblocked then execute it commit when complete and have the same backlog operator transition the item before you return';
/**
 * R11 AC2: the ONLY text the performance agent is handed (SCOPE-R11-prompt-update; owner: "that is the target, get the experiment prompts updated"). Defined ONCE, here: the driver, the dry run, analyze,
 * the self-check and every test import this constant. No leading/trailing text, no trailing newline, no trailing period, no hints.
 */
export const TASK_PROMPT = 'Have the backlog operator select a random item from the backlog that is unblocked then execute it and commit when complete. Then dispatch a review on the code, revise it based on the review and commit, and have the same backlog operator transition the item before you return';
/** The owner message that approves this round (ledger.approvedBy) and records the A-first gate waiver (ledger.profile.armAWaiver). */
export const OWNER_DIRECTION = 'no, the experiment design I told you to use, where an agent dispatches backlog operator using agent mcp, gets a random ticket, implements it, etc. only arms b and c. those are the experiments I want you to run';
export const OWNER_DESIGN = `dispatch the performance agent on each experiment group providing only verbatim "${ORIGINAL_PROMPT}", dispatch each from a worktree cwd. then pause for further instruction.`;
export const OWNER_TARGET = "you can stop experiments when b and c both successfully build a ticket e2e dispatch backlog operator to get the ticket fully implemented dispatch review on the code revise and backlog operator again transitioning. once that full flow is verified and the quality is ready to merge we're good";
export const OWNER_PROMPT_UPDATE = 'that is the target, get the experiment prompts updated';
export const PARENT_AGENT = FS.AGENT_NAMES.parent;
export const DELEGATE_AGENT = FS.AGENT_NAMES.operator;
/** R11 AC10: the read-only reviewer the performance agent may dispatch through agent-mcp; registered identically in both groups. */
export const REVIEW_AGENT = FS.AGENT_NAMES.reviewer;
/** The roster files a group uses (system prompt = file body, verbatim). */
export const ROSTER_NAMES = Object.freeze([PARENT_AGENT, DELEGATE_AGENT, REVIEW_AGENT]);
export const PAUSE_LINE = 'PAUSED: awaiting owner instruction';
export const DESIGN_ARMS = Object.freeze(['B', 'C']);
/** Identical for both groups (R11 AC4). The deadline is the harness wait bound: on expiry ONE task_cancel is sent, the server is closed, nothing is retried. */
export const LIMITS = Object.freeze({ maxToolLoops: 200, deadlineMs: 60 * 60 * 1000 });
/** Where the roster lives on this machine; PARITY_AGENTS_DIR / --agents-dir override it (the offline tests and the dry run point at a fixture roster). */
export const DEFAULT_AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
/** The roster tool names that have an agent-mcp equivalent. Anything else is recorded as unmapped (never silently dropped). */
const FS_READ = new Set(['Read', 'Glob', 'Grep']); const FS_WRITE = new Set(['Edit', 'Write', 'MultiEdit']);
/** The reference fs server's mutating tools. `nativeTooling.fs.readOnly` is RESERVED in the product (not enforced: agent-base-types FsBuiltinOverrides.readOnly), so a read-only roster agent is expressed through the tool-name gate. */
export const FS_WRITE_TOOLS = Object.freeze(['write_file', 'edit_file', 'create_directory', 'move_file']);

// ----------------------------------------------------------------------------------------------------------------
// Roster: the agent files are the system prompts, verbatim
// ----------------------------------------------------------------------------------------------------------------
function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  return t;
}
const csv = (v) => (v == null ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));
/**
 * Split an agent file into its front matter (top-level `key: value` lines) and its BODY, the exact text after the closing `---` line (no trimming: the sha of the system prompt is the sha of these bytes).
 * @returns {{name:string, description:string, tools:string[], disallowedTools:string[], model:string|null, body:string, bodySha256:string, fileSha256:string}}
 */
export function parseAgentFile(text, where = 'agent file') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new DesignError(`${where}: no YAML front matter (--- ... ---) found`);
  const fm = {}; for (const line of m[1].split(/\r?\n/)) { const k = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line); if (k) fm[k[1]] = unquote(k[2]); }
  if (!fm.name) throw new DesignError(`${where}: front matter has no name`);
  const body = text.slice(m[0].length);
  if (!body.trim()) throw new DesignError(`${where}: empty body (no system prompt)`);
  return { name: fm.name, description: fm.description ?? '', tools: csv(fm.tools), disallowedTools: csv(fm.disallowedTools), model: fm.model ?? null, body, bodySha256: sha256(body), fileSha256: sha256(text) };
}
/** Load the roster agents of the design (performance, backlog-operator, review) from `dir`. Throws a DesignError naming the missing file. */
export function loadRoster({ dir = DEFAULT_AGENTS_DIR, names = ROSTER_NAMES } = {}) {
  const out = {};
  for (const n of names) {
    const file = path.join(dir, `${n}.md`); const text = readIf(file);
    if (text == null) throw new DesignError(`roster file ${file} is not readable: the design uses the ${n} agent's prompt body verbatim (set PARITY_AGENTS_DIR or --agents-dir)`);
    const a = parseAgentFile(text, file);
    if (a.name !== n) throw new DesignError(`${file}: front matter name ${JSON.stringify(a.name)} is not ${JSON.stringify(n)}`);
    out[n] = { ...a, file };
  }
  return out;
}

/**
 * Map a roster agent's tool list onto the agent-mcp definition surface (nativeTooling builtins + mcpServers). Pure.
 *  Read/Glob/Grep -> fs; Edit/Write -> fs with writes (a roster with only read tools -> fs with the mutating tools gated off: `fs.disallowedTools`); Bash -> shell; Task -> dispatch (the in-process agent/task tools);
 *  mcp__backlog__* -> mcpServers.backlog. Every other roster tool is listed in `unmapped` with the reason (no agent-mcp equivalent in this design), never dropped silently.
 *  A native member the roster does NOT list is set to an explicit `false`: the product treats an absent member as ENABLED (agent-core-native-tooling resolveFs/resolveShell/resolveDispatch), which would hand
 *  the read-only `review` agent a shell, a writable fs and the dispatch tools (measured in the R11 dry run).
 * @returns {{nativeTooling:object, mcp:string[], unmapped:{tool:string, why:string}[], configured:string[]}}
 */
const isReadOnlyFs = (v) => v != null && typeof v === 'object' && FS_WRITE_TOOLS.every((x) => (v.disallowedTools ?? []).includes(x));
export function toolSurface(agent) {
  const t = agent.tools; const has = (set) => t.some((x) => set.has(x));
  const writes = has(FS_WRITE) && !agent.disallowedTools.some((x) => FS_WRITE.has(x) && !t.includes(x));
  const nativeTooling = { fs: false, shell: false, dispatch: false }; const mcp = []; const unmapped = [];
  if (has(FS_READ) || has(FS_WRITE)) nativeTooling.fs = writes || (has(FS_WRITE) && !agent.disallowedTools.includes('Edit')) ? true : { disallowedTools: [...FS_WRITE_TOOLS] };
  if (t.includes('Bash')) nativeTooling.shell = true;
  if (t.includes('Task')) nativeTooling.dispatch = true;
  for (const x of t) {
    if (FS_READ.has(x) || FS_WRITE.has(x) || x === 'Bash' || x === 'Task') continue;
    if (/^mcp__backlog__/.test(x)) { if (!mcp.includes('backlog')) mcp.push('backlog'); continue; }
    unmapped.push({ tool: x, why: /^mcp__/.test(x) ? 'MCP server not part of this design (not attached)' : 'no agent-mcp equivalent in this design' });
  }
  const configured = [...Object.entries(nativeTooling).filter(([, v]) => v).map(([k, v]) => (isReadOnlyFs(v) ? `${k}:readOnly` : k)), ...mcp.map((m) => `mcp:${m}`)].sort();
  return { nativeTooling, mcp, unmapped, configured };
}

/**
 * The agent_create payload of one roster agent for one group. `provider` is the group's provider object (drive.providerFor); `backlogServer` is the stdio config attached to agents whose roster tool
 * list carries mcp__backlog__*. Same function for B and C: only `provider` differs (R11 AC4). Pure.
 */
export function agentDefinition({ agent, provider, backlogServer, maxToolLoops = LIMITS.maxToolLoops }) {
  const s = toolSurface(agent);
  const def = { name: agent.name, description: agent.description, provider, systemPrompt: agent.body, maxToolLoops, nativeTooling: s.nativeTooling, nativeWebTools: false };   // nativeWebTools false: no roster agent lists a web tool (the product default advertises web_search/web_fetch to every Anthropic agent)
  if (s.mcp.includes('backlog')) { if (!backlogServer) throw new DesignError(`${agent.name}: the roster tool list names mcp__backlog__* but no backlog MCP server config was supplied`); def.mcpServers = { backlog: backlogServer }; }
  return def;
}
/** The configured tool names of a definition AS SENT (builtins + MCP servers), sorted: the unit the identical-groups check compares. */
export function configuredTools(def) {
  const nt = def.nativeTooling ?? {};
  return [...Object.entries(nt).filter(([, v]) => v).map(([k, v]) => (isReadOnlyFs(v) ? `${k}:readOnly` : k)), ...Object.keys(def.mcpServers ?? {}).map((m) => `mcp:${m}`)].sort();
}

// ----------------------------------------------------------------------------------------------------------------
// The backlog MCP server attached to backlog-operator
// ----------------------------------------------------------------------------------------------------------------
/** Resolve `adhd-backlog` on PATH to its real path and read the package version next to it. Pure over injected `env` / `exists`. */
export function resolveBacklogBinary({ env = process.env, name = 'adhd-backlog', exists = fs.existsSync, realpath = fs.realpathSync, readFile = readIf } = {}) {
  for (const d of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, name); if (!exists(p)) continue;
    let real = p; try { real = realpath(p); } catch { /* keep the link path */ }
    let version = null; for (let dir = path.dirname(real), i = 0; i < 4 && version == null; dir = path.dirname(dir), i++) { try { const j = JSON.parse(readFile(path.join(dir, 'package.json')) ?? 'null'); if (j?.name && /backlog/.test(j.name)) version = j.version ?? null; } catch { /* next */ } }
    return { path: p, realpath: real, version };
  }
  return null;
}
/**
 * stdio MCP config of the backlog server, in the agent-mcp `mcpServers` shape. Live: the installed `adhd-backlog serve --transport mcp --allow-production-write` (the owner's .mcp.json
 * `backlog-published` entry launches `npx @adhd/backlog@latest serve --transport mcp --allow-production-write`: same server, same flags; the installed binary is used so the run needs no network and its version is recorded). Dry: the fake server.
 */
export function backlogServerConfig({ dry = false, binary = null, env = process.env, fakeScript = path.join(HERE, 'dryrun', 'fake-backlog-server.mjs'), fakeItems = null, fakeLog = null } = {}) {
  if (dry) return { transport: 'stdio', command: process.execPath, args: [fakeScript], env: { R2_BACKLOG_ITEMS: fakeItems ?? '', R2_BACKLOG_LOG: fakeLog ?? '' } };
  if (!binary) throw new DesignError('adhd-backlog is not on PATH: the backlog-operator cannot be given its backlog MCP server');
  return { transport: 'stdio', command: binary.path, args: ['serve', '--transport', 'mcp', '--allow-production-write'] };   // no env key: exactly like the owner's .mcp.json `backlog-published` entry (agent-mcp's stdio client supplies the SDK default env + its curated subprocess env)
}

// ----------------------------------------------------------------------------------------------------------------
// Backlog state, READ-ONLY (R11 AC6): the harness never writes the backlog
// ----------------------------------------------------------------------------------------------------------------
export const READ_ONLY_VERBS = Object.freeze(['query', 'get', 'search', 'report', 'lookup']);
/** The real runner: `adhd-backlog <verb> --input <json>`; no --allow-production-write, ever. Returns the parsed envelope ({ok, data, meta} | {ok:false, error}). */
export function cliBacklogRunner({ binary, spawn = spawnSync, timeoutMs = 60_000 }) {
  return async (verb, input) => {
    const r = spawn(binary, [verb, '--input', JSON.stringify(input)], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
    const line = String(r.stdout ?? '').split('\n').find((l) => l.startsWith('{"ok"'));
    if (!line) return { ok: false, error: { code: 'no_envelope', message: `adhd-backlog ${verb} exit ${r.status}: ${String(r.stderr || r.stdout || r.error?.message || '').slice(0, 300)}` } };
    try { return JSON.parse(line); } catch (e) { return { ok: false, error: { code: 'bad_json', message: String(e.message) } }; }
  };
}
/** A reader that REFUSES every verb except the read verbs, whatever runner stands behind it. */
export function makeBacklogReader(run) {
  return { call: async (verb, input) => { if (!READ_ONLY_VERBS.includes(verb)) throw new DesignError(`the backlog reader is read-only: refused verb "${verb}" (allowed: ${READ_ONLY_VERBS.join(', ')}); the harness never writes the backlog`); return run(verb, input); } };
}
/** Dry-run reader over the fake backlog's state file (statuses only; `open` = ready). */
export function fakeBacklogRunner(itemsFile) {
  return async (verb, input) => {
    let items = []; try { items = JSON.parse(fs.readFileSync(itemsFile, 'utf8')); } catch { /* none */ }
    if (verb === 'query') { const pool = input?.view === 'ready' ? items.filter((i) => i.status === 'open') : items; const off = input?.offset ?? 0; const lim = input?.limit ?? 50; const page = pool.slice(off, off + lim); return { ok: true, data: { view: input?.view ?? 'list', items: page.map((i) => ({ uid: i.uid, title: i.title, status: i.status, priority: i.priority, updatedAt: i.updatedAt ?? null })) }, meta: { total: pool.length, returned: page.length, limit: lim, total_relation: 'eq', has_more: off + lim < pool.length } }; }
    if (verb === 'get') { const it = items.find((i) => i.uid === input?.uid); return it ? { ok: true, data: { ...it, auditTrail: [] } } : { ok: false, error: { code: 'not_found', message: String(input?.uid) } }; }
    return { ok: false, error: { code: 'unsupported', message: verb } };
  };
}
/**
 * Before-state: the READY (unblocked) view, paged with `offset` until the backend says there is no more (`meta.has_more`), bounded at `maxPages` pages. Real shape (adhd-backlog 1.0.16, read-only):
 * `{"ok":true,"data":{"view":"ready","items":[...]},"meta":{"total":501,"returned":500,"limit":500,"total_relation":"gte","has_more":true}}`. `complete` is false only when the page bound was hit.
 */
export async function snapshotBefore(reader, { pageSize = 500, maxPages = 20 } = {}) {
  const at = nowIso(); const ready = []; let total = null; let hasMore = false;
  for (let page = 0; page < maxPages; page++) {
    let r;
    try { r = await reader.call('query', { view: 'ready', limit: pageSize, offset: page * pageSize, fields: ['uid', 'title', 'status', 'priority', 'updatedAt'] }); } catch (e) { return { at, error: String(e.message ?? e), ready, complete: false }; }
    if (!r?.ok) return { at, error: `${r?.error?.code}: ${r?.error?.message}`, ready, complete: false };
    const items = r.data?.items ?? []; total = r.meta?.total ?? total;
    ready.push(...items.map((i) => ({ uid: i.uid, title: i.title, status: i.status, priority: i.priority ?? null, updatedAt: i.updatedAt ?? null })));
    hasMore = r.meta?.has_more === true; if (!hasMore || items.length === 0) { hasMore = hasMore && items.length > 0; break; }
  }
  return { at, readyTotal: ready.length, readyTotalReported: total, statusCounts: ready.reduce((m, i) => { m[i.status] = (m[i.status] || 0) + 1; return m; }, {}), ready, complete: !hasMore };
}
/** After-state of the items the agent touched: status, updatedAt and the tail of the audit trail (`get`, read-only). */
export async function snapshotAfter(reader, uids) {
  const at = nowIso(); const items = [];
  for (const uid of uids) {
    let r; try { r = await reader.call('get', { uid, fields: ['uid', 'title', 'status', 'updatedAt', 'auditTrail'], lastN: 5 }); } catch (e) { items.push({ uid, error: String(e.message ?? e) }); continue; }
    if (!r?.ok) { items.push({ uid, error: `${r?.error?.code}: ${r?.error?.message}` }); continue; }
    const d = r.data ?? {}; items.push({ uid, title: d.title ?? null, status: d.status ?? null, updatedAt: d.updatedAt ?? null, auditTail: Array.isArray(d.auditTrail) ? d.auditTrail.slice(-5) : [] });
  }
  return { at, items };
}
/** The uid a backlog tool call acts on, under any of the envelopes ({data:{input:{uid}}}, {input:{uid}}, {uid}). */
export function uidOfCall(input) { const o = input ?? {}; return o?.data?.input?.uid ?? o?.input?.uid ?? o?.uid ?? null; }
const toStatusOf = (input) => input?.data?.input?.toStatus ?? input?.input?.toStatus ?? input?.toStatus ?? null;
/**
 * R11 AC6/AC7: which item the run picked, from the backlog-operator's OWN backlog tool calls (a before/after diff of a live production store would include other writers' changes).
 * Pure over normalised calls ({name, input, isError, resultText}). `picked` = the uid of the last non-error backlog_transition, else the last non-error backlog_claim, else null.
 */
export function pickedFromCalls(calls) {
  const named = (re) => calls.filter((c) => re.test(String(c.name))).map((c) => ({ uid: uidOfCall(c.input), toStatus: toStatusOf(c.input), isError: c.isError === true }));
  const transitions = named(/(^|__)backlog_transition$/); const claims = named(/(^|__)backlog_claim$/);
  const other = calls.filter((c) => /(^|__)backlog_/.test(String(c.name)) && !/(transition|claim)$/.test(String(c.name))).length;
  const ok = (xs) => xs.filter((x) => !x.isError && x.uid);
  const picked = ok(transitions).at(-1)?.uid ?? ok(claims).at(-1)?.uid ?? null;
  return { picked, transitions, claims, otherBacklogCalls: other, distinctUids: [...new Set([...transitions, ...claims].map((x) => x.uid).filter(Boolean))], source: 'backlog-operator tool_use inputs (API log / wire)' };
}
/** The item's before/after status and whether it was in the pre-run ready (unblocked) view. */
export function transitionFact({ before, after, picked, transitions }) {
  if (!picked) return { picked: null, note: 'no backlog item was picked (no successful backlog_claim / backlog_transition call)' };
  const was = (before?.ready ?? []).find((i) => i.uid === picked); const a = (after?.items ?? []).find((i) => i.uid === picked);
  const tr = (transitions ?? []).filter((t) => t.uid === picked && !t.isError).at(-1) ?? null;
  return { picked, title: a?.title ?? was?.title ?? null, wasInReadyViewBefore: was != null, readySnapshotComplete: before?.complete === true, statusBefore: was?.status ?? null, statusAfter: a?.status ?? null, requestedStatus: tr?.toStatus ?? null,
    transitioned: tr != null && a?.status != null && was?.status != null ? a.status !== was.status : tr != null ? 'unknown (no before-status: the item was not in the ready snapshot)' : false, auditTail: a?.auditTail ?? [], afterError: a?.error ?? null };
}

// ----------------------------------------------------------------------------------------------------------------
// Worktrees (R11 AC3): real `git worktree add`, own branch off the current HEAD, never removed by the harness
// ----------------------------------------------------------------------------------------------------------------
const git = (cwd, args, spawn = spawnSync) => { const r = spawn('git', ['-C', cwd, ...args], { encoding: 'utf8' }); return { status: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }; };
/** The MAIN checkout of the repo `repoRoot` belongs to (a linked worktree's `--git-common-dir` points at <main>/.git). */
export function mainCheckoutOf(repoRoot) { const r = git(repoRoot, ['rev-parse', '--git-common-dir']); if (r.status !== 0 || !r.out) throw new DesignError(`${repoRoot} is not a git checkout: ${r.err}`); return path.dirname(path.resolve(repoRoot, r.out)); }
/** The round's worktree plan: <mainRoot>/.worktrees/<round>-<arm> on branch parity/<round>-<arm>. */
export function worktreePlan({ round, arms, mainRoot }) { return arms.map((arm) => ({ arm, path: path.join(mainRoot, '.worktrees', `${String(round).toLowerCase()}-${arm}`), branch: `parity/${String(round).toLowerCase()}-${arm}` })); }
/** Refusals checked BEFORE any reservation: base branch is not main, the path and the branch are free. Returns the reasons (empty = free). */
export function worktreeFreeReasons({ repoRoot, plan }) {
  const reasons = []; const head = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (!head || head === 'HEAD') reasons.push(`${repoRoot} has a detached HEAD: the group branches are cut from a named branch`); else if (/^(main|master)$/.test(head)) reasons.push(`the instrument runs on branch ${head}: the R11 worktrees are cut from the plan branch, never from main`);
  for (const w of plan) {
    if (fs.existsSync(w.path)) reasons.push(`worktree path ${w.path} already exists (the harness never removes a worktree: owner decides)`);
    if (git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${w.branch}`]).status === 0) reasons.push(`branch ${w.branch} already exists (the harness never deletes a branch: owner decides)`);
  }
  return reasons;
}
/** `git worktree add <path> -b <branch> <baseSha>`. Refuses when the path or branch exists. Returns the worktree record (base sha, head sha, branch, path). */
export function createWorktree({ repoRoot, wt, baseSha }) {
  const bad = worktreeFreeReasons({ repoRoot, plan: [wt] }).filter((r) => !/branch (main|master)|instrument runs on branch/.test(r)); if (bad.length) throw new DesignError(bad.join('; '));
  fs.mkdirSync(path.dirname(wt.path), { recursive: true });
  const r = git(repoRoot, ['worktree', 'add', wt.path, '-b', wt.branch, baseSha]);
  if (r.status !== 0) throw new DesignError(`git worktree add ${wt.path} -b ${wt.branch} ${baseSha} failed: ${r.err}`);
  const head = git(wt.path, ['rev-parse', 'HEAD']).out;
  if (head !== baseSha) throw new DesignError(`worktree ${wt.path} HEAD ${head} is not the base ${baseSha}`);
  return { path: wt.path, branch: wt.branch, baseSha, headAtCreate: head, createdAt: nowIso() };
}
/**
 * The extra sandbox WRITE set that makes `git commit` possible from a linked worktree. The worktree cwd is writable (agent-mcp adds the dispatch cwd to the srt policy), but a linked
 * worktree's git state lives in the MAIN checkout's .git: measured in the R11 dry run, `git commit` there fails with "Unable to create '<main>/.git/worktrees/<name>/index.lock': Operation
 * not permitted" under the default policy. The harness grants the narrowest set that a commit needs, identically to both groups, through agent-mcp's own operator config
 * (agent.shell.sandbox.extraAllowWrite + extraAllowWriteRoots, via the server env; no product change): the group's own gitdir, the shared object store, the `parity/` branch namespace
 * (ref + reflog) and packed-refs (+ its lock: `git commit` locks it on every ref update; measured). The default entry (the backlog data dir) is kept because setting the variable replaces the default list.
 */
export function gitWriteSet({ mainRoot, wtName }) {
  const g = path.join(mainRoot, '.git');
  return { root: g, entries: [path.join(g, 'worktrees', wtName), path.join(g, 'objects'), path.join(g, 'refs', 'heads', 'parity'), path.join(g, 'logs', 'refs', 'heads', 'parity'), path.join(g, 'packed-refs'), path.join(g, 'packed-refs.lock')] };
}
export function sandboxWriteEnv(set, { keepDefaults = ['~/.adhd/backlog/production/data'] } = {}) {
  for (const x of [set.root, ...set.entries]) if (/[,*?[\]{}]/.test(x)) throw new DesignError(`sandbox write path ${x} contains a character the comma-separated config cannot carry`);
  return { ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE_ROOTS: set.root, ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE: [...keepDefaults, ...set.entries].join(',') };
}
/** What the group left in its worktree: the commits made after the base, uncommitted changes, hooks path, and whether node_modules exists (the pre-commit hook hazard). */
export function worktreeFacts({ wtPath, baseSha }) {
  const log = git(wtPath, ['log', '--reverse', '--format=%H%x09%ct%x09%s', `${baseSha}..HEAD`]);
  const commits = log.out ? log.out.split('\n').map((l) => { const [sha, ct, ...s] = l.split('\t'); const f = git(wtPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).out; return { sha, subject: s.join('\t'), ts: Number.isFinite(Number(ct)) ? Number(ct) : null, files: f ? f.split('\n') : [] }; }) : [];   // oldest first; ts = committer time (epoch s); files = the paths the commit touches (R11 AC11)
  const files = git(wtPath, ['diff', '--name-only', `${baseSha}..HEAD`]).out; const st = git(wtPath, ['status', '--porcelain']).out;
  return { path: wtPath, branch: git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).out, baseSha, headSha: git(wtPath, ['rev-parse', 'HEAD']).out, commits, changedFiles: files ? files.split('\n') : [], uncommitted: st ? st.split('\n') : [],
    hooksPath: git(wtPath, ['config', '--get', 'core.hooksPath']).out || null, nodeModulesPresent: fs.existsSync(path.join(wtPath, 'node_modules')) };
}
/** Files in the worktree cwd that a claude child (arm B) loads as project context: B runs `--setting-sources project --strict-mcp-config` there; arm C's anthropic provider loads none of them. */
export function projectContextFacts(wtPath) {
  const present = ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json'].filter((f) => fs.existsSync(path.join(wtPath, f)));
  return { files: present, B: 'claudecli spawns `claude -p --strict-mcp-config --setting-sources project --system-prompt <agent prompt>` with the worktree as cwd: project settings/hooks and CLAUDE.md memory under it can load; .mcp.json is NOT loaded (strict)', C: 'the anthropic provider sends only the agent system prompt and the offered tools: no project file is read into context' };
}

// ----------------------------------------------------------------------------------------------------------------
// Per-group config fact table (R11 AC4) and the identical-groups rule
// ----------------------------------------------------------------------------------------------------------------
/** @param {{arm:string, defs:Record<string,object>, roster:Record<string,object>, model:string, providerType:string, effort:string|null, thinking:any, cwd:string, limits?:object}} a */
export function groupConfigFacts({ arm, defs, roster, model, providerType, effort, thinking, cwd, limits = LIMITS }) {
  return { arm, provider: providerType, model, effort: effort ?? null, thinking: thinking === undefined ? '(not set by the harness: the provider default governs)' : thinking, cwd, limits: { ...limits },
    systemPromptSha256: Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, sha256(d.systemPrompt)])), rosterBodySha256: Object.fromEntries(Object.entries(roster).map(([n, a]) => [n, a.bodySha256])),
    tools: Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, configuredTools(d)])), unmappedRosterTools: Object.fromEntries(Object.entries(roster).map(([n, a]) => [n, toolSurface(a).unmapped])),
    maxToolLoops: Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.maxToolLoops])) };
}
/** Groups B and C must carry the same prompts, tool lists, model, effort and limits: only the provider (and the cwd, which is each group's own worktree) may differ. */
export function identicalGroupsCheck(a, b) {
  const reasons = []; const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const k of ['systemPromptSha256', 'rosterBodySha256', 'tools', 'maxToolLoops', 'model', 'effort', 'limits']) if (!eq(a[k], b[k])) reasons.push(`${k} differs between ${a.arm} and ${b.arm}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
  if (a.provider === b.provider) reasons.push(`both groups use provider ${a.provider}: the groups must differ in the provider`);
  if (a.cwd === b.cwd) reasons.push('both groups share one cwd: each group has its own worktree');
  return { ok: reasons.length === 0, reasons };
}

// ----------------------------------------------------------------------------------------------------------------
// Verbatim prompt (R11 AC2)
// ----------------------------------------------------------------------------------------------------------------
/** The exact `task` tool arguments the harness submits to agent-mcp. `prompt` is the owner's sentence and nothing else; session_id / cwd / background are transport mechanics. */
export function taskPayload({ sessionId, cwd }) { return { session_id: sessionId, prompt: TASK_PROMPT, background: true, cwd }; }
/** Throws unless the submitted payload's prompt is byte-identical to the owner's sentence and the payload carries no other text field. */
export function assertVerbatimPayload(p) {
  if (typeof p?.prompt !== 'string' || Buffer.compare(Buffer.from(p.prompt, 'utf8'), Buffer.from(TASK_PROMPT, 'utf8')) !== 0) throw new DesignError(`task prompt is not byte-identical to the owner's sentence: ${JSON.stringify(p?.prompt)}`);
  const extra = Object.keys(p).filter((k) => !['session_id', 'prompt', 'background', 'cwd'].includes(k)); if (extra.length) throw new DesignError(`task payload carries extra field(s) ${extra.join(', ')}`);
  return true;
}
export const promptFact = () => ({ text: TASK_PROMPT, bytes: Buffer.byteLength(TASK_PROMPT, 'utf8'), sha256: sha256(TASK_PROMPT), source: 'SCOPE-R11-prompt-update (owner: "that is the target, get the experiment prompts updated"); the single exported TASK_PROMPT constant', addedText: 'none (no system hint, no leading or trailing text)' });

// ----------------------------------------------------------------------------------------------------------------
// Scenario sha (the scope gate must compare something): prompt + both roster bodies + the definitions
// ----------------------------------------------------------------------------------------------------------------
export function scenarioShaOf({ roster, defsByArm = null }) {
  return sha256(JSON.stringify({ design: DESIGN_ID, prompt: TASK_PROMPT, roster: Object.fromEntries(Object.entries(roster).map(([n, a]) => [n, a.bodySha256])), limits: LIMITS, tools: Object.fromEntries(Object.entries(roster).map(([n, a]) => [n, toolSurface(a).configured])), defs: defsByArm }));
}

// ----------------------------------------------------------------------------------------------------------------
// Failure explanation (the record must name the failing step; "I can't tell why" is not acceptable)
// ----------------------------------------------------------------------------------------------------------------
const TERMINAL_BAD = new Set(['failed', 'cancelled', 'canceled', 'timeout', 'timed_out', 'awaiting_input']);
/**
 * Name the step that failed, from the evidence the run left. Pure over already-extracted facts:
 *  {harnessFailure, submit:{taskId, text}, final:{status, error, result}, timedOut, tasks:[{id, agent, status, error, createdAt, depth}], toolErrors:[{task, name, text}], wireErrors:[{seq, status, task}],
 *   mcpErrors:[{name, text}], stderrTail, backlogCalls, transitions, commits, dispatched}
 * @returns {{failedStep:string|null, detail:string|null, evidence:string[], gaps:string[]}} `failedStep` is set when the run failed; `gaps` lists ways a COMPLETED run did not do the job.
 */
export function explainFailure(f) {
  const evidence = []; const gaps = [];
  const short = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  if (f.harnessFailure) return { failedStep: 'harness', detail: short(f.harnessFailure, 500), evidence: [short(f.stderrTail, 400)].filter(Boolean), gaps };
  if (!f.submit?.taskId) return { failedStep: 'task-submit', detail: short(f.submit?.text) || 'the task call returned no task_id', evidence: (f.mcpErrors ?? []).map((e) => `${e.name}: ${short(e.text, 160)}`), gaps };
  const bad = (f.tasks ?? []).filter((t) => TERMINAL_BAD.has(t.status)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const failedTask = bad.find((t) => (t.depth ?? 0) > 0) ?? bad[0] ?? null;
  const rootBad = f.final && f.final.status !== 'completed';
  if (f.timedOut || rootBad || failedTask) {
    const step = f.timedOut ? `deadline: the ${PARENT_AGENT} task had not finished when the harness wait bound expired (task_cancel sent once)` : failedTask ? `task ${failedTask.agent ?? '?'} (${String(failedTask.id).slice(0, 8)}) ended ${failedTask.status}` : `task ${PARENT_AGENT} ended ${f.final?.status}`;
    const te = (f.toolErrors ?? []).filter((t) => !failedTask || t.task === failedTask.id).at(-1) ?? (f.toolErrors ?? []).at(-1);
    if (te) evidence.push(`last tool error (trace): ${te.name}: ${short(te.text, 200)}`);
    const we = (f.wireErrors ?? []).at(-1); if (we) evidence.push(`model request #${we.seq} answered HTTP ${we.status} (wire capture)`);
    for (const t of bad) evidence.push(`task ${t.agent ?? '?'} ${String(t.id).slice(0, 8)}: ${t.status}${t.error ? ` (${short(t.error, 200)})` : ''}`);
    if (f.stderrTail) evidence.push(`server stderr tail: ${short(f.stderrTail, 240)}`);
    return { failedStep: step, detail: short(failedTask?.error ?? f.final?.error ?? te?.text ?? we?.status ?? 'no error text recorded'), evidence, gaps };
  }
  for (const e of (f.errorTexts ?? []).slice(-3)) evidence.push(`tool output that looks like a failure: ${e.name}: ${short(e.text, 260)}`);   // a completed run whose tool results carried a refusal (sandbox, hook, permission) names it here
  if (!f.dispatched) gaps.push(`${PARENT_AGENT} did not dispatch ${DELEGATE_AGENT} through agent-mcp (no child task)`);
  if (f.dispatched && !(f.backlogCalls > 0)) gaps.push(`${DELEGATE_AGENT} made no backlog tool call`);
  if (f.dispatched && f.backlogCalls > 0 && !(f.transitions?.length)) gaps.push('no backlog_transition call was made');
  if ((f.transitions ?? []).length && (f.transitions ?? []).every((t) => t.isError)) gaps.push('every backlog_transition call returned an error');
  if (!(f.commits > 0)) gaps.push('no commit was made in the group worktree');
  return { failedStep: null, detail: null, evidence, gaps };
}

// ----------------------------------------------------------------------------------------------------------------
// Task-level facts from the run logs
// ----------------------------------------------------------------------------------------------------------------
const rd = (x, n = 6) => Math.round(x * 10 ** n) / 10 ** n;
/** Tool-call counts by name (and by category) of one call list. */
export function toolCounts(calls) { const byName = {}; const byCategory = {}; for (const c of calls) { byName[c.name] = (byName[c.name] || 0) + 1; const k = L.toolCategoryOf(c.name); byCategory[k] = (byCategory[k] || 0) + 1; } return { total: calls.length, byName, byCategory, errors: calls.filter((c) => c.isError === true).length }; }
const sumUsd = (turns) => (turns.length && turns.some((t) => t.usd == null) ? null : rd(turns.reduce((s, t) => s + (t.usd ?? 0), 0)));
/**
 * Per-task facts for every task of the run: the agent (via its session), depth, status, window, turns, tokens, tool counts, cost, the tools OFFERED to the model (B: the claude init tools; C: the
 * request's tools), and the call list (for the picked-item and failure analysis). `streamFor(taskId)` = drive.streamForTask bound to the arm and API log.
 */
export function taskFacts({ tasks, sessions, streamFor }) {
  const agentOf = new Map((sessions ?? []).map((s) => [s.id ?? s.session_id, s.agentName ?? s.agent_name ?? s.agent ?? s.name ?? null]));
  const rows = tasks.map((t) => {
    const agent = t.agentName ?? t.agent_name ?? agentOf.get(t.sessionId ?? t.session_id) ?? null;
    let s = null; try { s = streamFor(t.id); } catch (e) { s = { error: String(e.message ?? e), turns: [], calls: [], tools: [] }; }
    const turns = s.turns ?? []; const calls = s.calls ?? [];
    return { taskId: t.id, agent, sessionId: t.sessionId ?? t.session_id ?? null, parentTaskId: t.parentTaskId ?? null, depth: t.recursionDepth ?? 0, status: t.status, error: t.error ?? null, createdAt: t.createdAt ?? null, completedAt: t.completedAt ?? null,
      turns: turns.length, models: [...new Set(turns.map((x) => x.model).filter(Boolean))], tokens: L.sumNorm(turns), costUsd: sumUsd(turns), toolCounts: toolCounts(calls), offeredTools: [...(s.tools ?? [])].sort(), calls: calls.map((c) => ({ name: c.name, input: c.input, isError: c.isError ?? null, resultText: c.resultText == null ? null : String(c.resultText).slice(0, 1500) })), streamError: s.error ?? null };
  });
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export function totalsOfTasks(rows) { const costs = rows.map((r) => r.costUsd); return { tasks: rows.length, turns: rows.reduce((a, r) => a + r.turns, 0), toolCalls: rows.reduce((a, r) => a + r.toolCounts.total, 0), costUsd: costs.some((c) => c == null) ? null : rd(costs.reduce((a, c) => a + c, 0)), tokens: L.sumNorm(rows.flatMap((r) => (r.turns ? [r.tokens] : []).map((x) => x))) }; }

// ----------------------------------------------------------------------------------------------------------------
// Design gates (replace the judge-credential and web-preflight gates; all zero-model)
// ----------------------------------------------------------------------------------------------------------------
/**
 * Design preflight (R11 AC1/AC6): worktree path and branch free, roster files readable (their shas are recorded), the backlog binary resolves and its sandbox-path reports the production store,
 * the built agent-mcp exists, the claude binary answers for B. Returns {ok, reasons, facts}; nothing is spawned except `claude --version` and `adhd-backlog sandbox-path` (no model call).
 */
export function designPreflight({ repoRoot, round, arms, pendingArms = arms, agentsDir, distEntry, claude, env = process.env, spawn = spawnSync, mainRoot = null }) {
  const reasons = []; const facts = {};
  try { mainRoot ??= mainCheckoutOf(repoRoot); facts.worktrees = worktreePlan({ round, arms, mainRoot }); reasons.push(...worktreeFreeReasons({ repoRoot, plan: facts.worktrees.filter((w) => pendingArms.includes(w.arm)) }));   // only arms with no ledger run: a resumed round (B ran, C pending) must not be wedged by B's own worktree
    facts.hooks = { hooksPath: git(repoRoot, ['config', '--get', 'core.hooksPath']).out || null, preCommit: (() => { const hp = git(repoRoot, ['config', '--get', 'core.hooksPath']).out; return hp ? fs.existsSync(path.join(repoRoot, hp, 'pre-commit')) : false; })(), repoNodeModules: fs.existsSync(path.join(repoRoot, 'node_modules')), note: 'a fresh linked worktree has no node_modules: a pre-commit hook that needs it can refuse the group commit (recorded per group in worktree.hooksPath / nodeModulesPresent; the harness never passes --no-verify and never edits hooks)' }; } catch (e) { reasons.push(String(e.message ?? e)); }
  try { const roster = loadRoster({ dir: agentsDir }); facts.roster = Object.fromEntries(Object.entries(roster).map(([n, a]) => [n, { file: a.file, bodySha256: a.bodySha256, tools: a.tools }])); } catch (e) { reasons.push(String(e.message ?? e)); }
  const bin = resolveBacklogBinary({ env }); facts.backlog = bin;
  if (!bin) reasons.push('adhd-backlog is not on PATH (the backlog MCP server and the read-only reader both need it)');
  else { const r = spawn(bin.path, ['sandbox-path'], { encoding: 'utf8', timeout: 30_000 }); const line = String(r.stdout ?? '').split('\n').find((l) => l.startsWith('{')); try { facts.backlogStore = JSON.parse(line); } catch { reasons.push(`adhd-backlog sandbox-path did not answer (exit ${r.status}): ${String(r.stderr).slice(0, 160)}`); } if (facts.backlogStore && facts.backlogStore.namespace !== 'production') reasons.push(`adhd-backlog resolves the ${facts.backlogStore.namespace} store, the design runs against production`); }
  if (!distEntry || !fs.existsSync(distEntry)) reasons.push(`built agent-mcp missing: ${distEntry}`);
  if (arms.includes('B')) { const v = spawn(claude, ['--version'], { encoding: 'utf8', timeout: 30_000 }); if (v.status !== 0) reasons.push(`claude binary ${claude} did not answer --version (arm B needs it)`); else facts.claudeVersion = String(v.stdout).trim(); }
  return { ok: reasons.length === 0, reasons, facts };
}

// ----------------------------------------------------------------------------------------------------------------
// Plan text (--print-plan --round R11): everything a reviewer needs before spending quota
// ----------------------------------------------------------------------------------------------------------------
export function planText({ round, profile, ledger, roster = null, rosterError = null, repoRoot, mainRoot = null, agentsDir, hostFacts }) {
  const out = []; const arms = profile.arms;
  out.push(`ROUND ${round} PLAN  design=${DESIGN_ID}  (${SCOPE_ID}; owner-directed; arms ${arms.join(',')} only, arm A is refused)`);
  out.push(`  owner direction: ${JSON.stringify(OWNER_DIRECTION)}`);
  out.push(`  owner design:    ${JSON.stringify(OWNER_DESIGN)}`);
  out.push(`  owner target (${SCOPE_IDS[1]}): ${JSON.stringify(OWNER_TARGET)}`, `  owner prompt update (${SCOPE_IDS[2]}): ${JSON.stringify(OWNER_PROMPT_UPDATE)}  -> the TASK PROMPT below supersedes the original design sentence`);
  out.push('', `TASK PROMPT (handed verbatim to the ${PARENT_AGENT} agent, ${Buffer.byteLength(TASK_PROMPT)} bytes, sha256 ${sha256(TASK_PROMPT).slice(0, 16)}; no other text): ${JSON.stringify(TASK_PROMPT)}`);
  out.push(`model runs: ${arms.length} planned, one per group (${arms.join(' -> ')}), serial, HARD CAP ${LG.capOf(ledger)}; ledger ${LG.ledgerPathFor(round)} has used ${ledger.runs.length}; no retry, no batching, no loop, not wired into CI or any nx target`);
  out.push(`A-FIRST GATE WAIVED (ledger.profile.armAWaiver, owner): ${JSON.stringify(profile.armAWaiver)}; the ledger's armA stays null`);
  out.push('', `AGENTS (system prompt = the roster file body, verbatim; roster dir ${agentsDir}):`);
  if (roster) for (const [n, a] of Object.entries(roster)) { const s = toolSurface(a); out.push(`  ${n}: ${a.file}  body sha256 ${a.bodySha256.slice(0, 16)}  roster tools [${a.tools.join(', ')}]${a.disallowedTools.length ? `  disallowed [${a.disallowedTools.join(', ')}]` : ''}`, `      agent-mcp surface: ${s.configured.join(', ')}${s.unmapped.length ? `  | no equivalent here: ${s.unmapped.map((u) => u.tool).join(', ')}` : ''}`); }
  else out.push(`  (roster unreadable: ${rosterError})`);
  out.push(`  ${PARENT_AGENT} reaches ${DELEGATE_AGENT} through agent-mcp's in-process agent + task tools (nativeTooling.dispatch), and so may reach ${REVIEW_AGENT} (read-only: fs readOnly, no shell, no dispatch; registered identically in both groups); ${DELEGATE_AGENT} carries the backlog MCP server (mcpServers.backlog, stdio).`);
  out.push(`FLOW STAGES (flow-stages.mjs, read from state: task records, the worktree git log, the backlog read-back; absent data is unknown, never pass): ${FS.STAGE_IDS.map((x) => `${x} ${FS.STAGE_NAMES[x]}`).join(' | ')}. The owner stops the experiments when B and C both show all five.`);
  out.push('', 'GROUPS (identical definitions; they differ in the provider):');
  for (const a of arms) out.push(`  ${a}: provider ${hostFacts.providers[a].type}  model ${hostFacts.models[a]}  effort ${profile.effort ?? '(not set)'}  thinking ${hostFacts.thinking[a] === undefined ? '(not set by the harness)' : JSON.stringify(hostFacts.thinking[a])}  maxToolLoops ${LIMITS.maxToolLoops}  deadline ${LIMITS.deadlineMs / 60000} min`);
  out.push(`  DIFFERENCES BEYOND THE PROVIDER (reported, not equalised): arm B's claude child runs in the worktree cwd with --setting-sources project --strict-mcp-config (project settings/hooks and CLAUDE.md can load; .mcp.json cannot); arm C sends only the agent prompt and tools. Thinking: this round's ledger does not list SCOPE-R10-thinking-parity, so arm C sends no thinking field while B's claude binary uses its own default.`);
  if (mainRoot) { const g = path.join(mainRoot, '.git');
    out.push('', 'SANDBOX WRITE WIDENING (so `git commit` can work from a linked worktree; identical for both groups; agent-mcp operator config via the server env, NO product code change):',
      `  the shell sandbox can write the worktree cwd by default, but a linked worktree keeps its git state in ${g}; measured in the dry run, the default policy refuses \`git commit\` there (index.lock: Operation not permitted).`,
      `  extraAllowWriteRoots: ${g}`, `  extraAllowWrite per group: ${g}/worktrees/<group worktree name>, ${g}/objects, ${g}/refs/heads/parity, ${g}/logs/refs/heads/parity, ${g}/packed-refs, ${g}/packed-refs.lock (+ the default backlog data dir)`,
      '  EXPOSURE: objects and packed-refs are shared by every branch of the repository (a packed ref such as refs/heads/main lives in packed-refs); the group can rewrite them through git. The harness does not widen anything else and never uses --no-verify.'); }
  if (hostFacts.hooks) out.push('', `PRE-COMMIT HOOK: core.hooksPath ${hostFacts.hooks.hooksPath ?? '(none)'}; the hook ${hostFacts.hooks.preCommit ? 'EXISTS and' : 'does not exist, so nothing'} runs in the group worktree on every commit, which has no node_modules (${hostFacts.hooks.note}).`);
  if (mainRoot) { const wts = worktreePlan({ round, arms, mainRoot }); out.push('', 'WORKTREES (created with `git worktree add` just before each group; never removed by the harness):', ...wts.map((w) => `  ${w.arm}: ${w.path}  branch ${w.branch}  (cut from the current HEAD of ${repoRoot})`)); }
  out.push('', 'RECORDED PER GROUP: wall (prompt handed to the product -> the product\'s own final result), cost/usage and tool counts per agent, wire capture and tracing evidence, the final text, the picked backlog item, its status before/after (read-only `adhd-backlog`), the commit shas (with files and times) in the worktree, the five flow stages with evidence pointers, the failing step (task, agent, last tool call, error text) when a group or a stage fails, repeated tool errors as a bug candidate. No judge, no hidden-test oracle.', `Ends with "${PAUSE_LINE}" and exit 0.`);
  return out.join('\n');
}

// ----------------------------------------------------------------------------------------------------------------
// Orchestration (dependency-injected: drive.mjs hands over `host`)
// ----------------------------------------------------------------------------------------------------------------
/** The design a round declares, or null (a missing / unreadable ledger is null: the legacy path decides). Fails closed on a malformed design. */
export function designOfRound(round, dir = LG.LEDGER_DIR) { try { return LG.designOf(LG.readLedger(round, dir)); } catch (e) { if (e instanceof LG.LedgerError && /ledger\.design/.test(e.message)) throw e; return null; } }

/**
 * Run ONE group (arm B or C) once. Never retries. A pre-spawn fault throws (the round stops); a fault after the run started is recorded in `record.harnessFailure` with the failing step.
 * deps: { reader (makeBacklogReader; dry runs get a per-group fake reader), repoRoot, mainRoot, baseSha, baseBranch, wtPlan, roster, binary, fakeItems }
 */
export async function runGroup({ ctx, host, deps }) {
  const arm = ctx.runDef.arm; const runId = ctx.spec.runId; const dry = ctx.dry;
  const record = { design: DESIGN_ID, round: ctx.opts.round, runId, arm, rep: 1, mode: dry ? 'dry-run' : 'live', startedAt: nowIso(), warnings: [], paused: true, env: host.envReport(ctx) };
  host.assignWorkDir(ctx);   // a work dir that has never been used (a finished run's dir is locked read-only by scanAndLock, so a reused one would not be writable or executable)
  fs.mkdirSync(ctx.runDir, { recursive: true }); fs.mkdirSync(ctx.work, { recursive: true });
  // 1. spawn-free preparation: the worktree and (dry) the fakes; a fault here reserves nothing
  const wt = deps.wtPlan.find((w) => w.arm === arm);
  const wtRec = createWorktree({ repoRoot: deps.repoRoot, wt, baseSha: deps.baseSha });
  ctx.repoDir = wt.path; ctx.design = DESIGN_ID;
  const writeSet = gitWriteSet({ mainRoot: deps.mainRoot, wtName: path.basename(wt.path) }); ctx.sandboxEnv = sandboxWriteEnv(writeSet);   // BEFORE the server env is built (serverEnv spreads ctx.sandboxEnv)
  record.worktree = { ...wtRec, mainRoot: deps.mainRoot, baseBranch: deps.baseBranch ?? null, projectContext: projectContextFacts(wt.path) };
  let fakeBacklog = null; let reader = deps.reader;
  if (dry) {   // a fresh fake backlog per group: the groups never see each other's transitions
    fakeBacklog = { items: path.join(ctx.work, 'backlog-items.json'), log: path.join(ctx.work, 'backlog-calls.log') };
    fs.writeFileSync(fakeBacklog.items, JSON.stringify(deps.fakeItems ?? DEFAULT_FAKE_ITEMS, null, 2)); fs.writeFileSync(fakeBacklog.log, '');
    reader = makeBacklogReader(fakeBacklogRunner(fakeBacklog.items)); record.fakeBacklog = fakeBacklog;
  }
  const t0 = Date.now(); let raw = null; let before = null; let defs = null;
  try {
    if (dry) await host.setupFakes(ctx);   // BEFORE providerFor: the fake claude shim becomes the arm B claude path
    // 2. definitions (identical but for the provider) and the fact table
    const provider = host.providerFor(ctx, arm); provider.timeoutMs = LIMITS.deadlineMs;
    const bl = backlogServerConfig({ dry, binary: deps.binary, fakeItems: fakeBacklog?.items, fakeLog: fakeBacklog?.log });
    defs = Object.fromEntries(Object.values(deps.roster).map((a) => [a.name, agentDefinition({ agent: a, provider, backlogServer: bl })]));
    record.config = groupConfigFacts({ arm, defs, roster: deps.roster, model: provider.model, providerType: provider.type, effort: host.effortOf(ctx), thinking: host.thinkingOf(ctx, arm), cwd: wt.path });
    record.config.backlogServer = { command: bl.command, args: bl.args, version: deps.binary?.version ?? null, realpath: deps.binary?.realpath ?? null, fake: dry };
    record.config.modelConfig = host.modelConfigFacts(ctx.profile, arm);
    record.config.sandboxWriteExtras = { why: 'git commit from a linked worktree writes into the main checkout .git; identical for both groups', ...writeSet, env: ctx.sandboxEnv };
    record.prompt = promptFact();
    // 3. read-only backlog state before, then the reservation (live): after this line the run is spent
    before = await snapshotBefore(reader); record.backlog = { before };
    if (!dry) { const mc = record.config.modelConfig; host.reserveModelRun(runId, { ledgerPath: ctx.ledgerPath, ...(mc ? { model: mc.id, modelSource: mc.envVar ? `env:${mc.envVar}` : 'json' } : {}) }); }   // a ModelRunCapError / LedgerError throws: the round stops, nothing spawned
    record.reservedAt = nowIso();
  } catch (e) { if (dry) await host.teardownFakes(ctx).catch(() => {}); record.harnessFailure = String(e.stack ?? e); throw Object.assign(e, { record }); }
  try {
    if (ctx.opts.capture) await host.startCapture(ctx);
    try { raw = await runOnServer({ ctx, host, defs, wt, record }); }
    finally { if (ctx.capture) { await ctx.capture.close(); ctx.capture = null; } if (dry) await host.teardownFakes(ctx); }
  } catch (e) { record.harnessFailure = String(e.stack ?? e); }
  record.finishedAt = nowIso(); record.runWallMs = Date.now() - t0;
  record.sweep = await host.sweepOwned(`after ${runId}`);
  await analyzeGroup({ ctx, host, deps: { ...deps, reader }, record, raw, before });
  if (ctx.captureInfo) record.capture = ctx.captureInfo;
  record.secretScan = { runDir: L.scanAndLock(ctx.runDir), work: L.scanAndLock(ctx.work) };
  if (record.secretScan.runDir.hits.length) record.warnings.push(`secret-shaped strings redacted in saved logs: ${JSON.stringify(record.secretScan.runDir.hits)}`);
  writeJson(path.join(ctx.runDir, 'record.json'), record);
  return record;
}

async function runOnServer({ ctx, host, defs, wt, record }) {
  const srv = await host.startServer(ctx); const raw = { toolNames: srv.tools.map((t) => t.name), serverEnvNames: Object.keys(srv.env).sort() };
  try {
    for (const name of [DELEGATE_AGENT, REVIEW_AGENT, PARENT_AGENT]) { const c = await srv.call('agent_create', defs[name]); if (c.isError) throw new Error(`agent_create ${name} failed: ${c.text.slice(0, 400)}`); }
    raw.storeLine = (srv.getStderr().match(/store=\S+\s+mode=\S+(?:\s+source=\S+)?/) || [null])[0];
    const s = await srv.call('agent', { name: PARENT_AGENT, cwd: wt.path }); const sessionId = s.json?.session_id; if (!sessionId) throw new Error(`agent (session) failed: ${s.text.slice(0, 300)}`);
    raw.sessionId = sessionId;
    const payload = taskPayload({ sessionId, cwd: wt.path }); assertVerbatimPayload(payload);
    const t0 = Date.now(); raw.submittedAt = t0;
    const t = await srv.call('task', payload, 120_000);
    raw.submit = { payload, response: t.json ?? t.text, taskId: t.json?.task_id ?? null, text: t.text.slice(0, 600) };
    if (!raw.submit.taskId) return raw;
    const w = await host.waitTaskFair(srv, raw.submit.taskId, LIMITS.deadlineMs);
    raw.final = w.r.json ?? w.r.text; raw.polls = w.polls.length; raw.timedOut = w.timedOut; raw.observedWallMs = w.wallMs; raw.observedAt = w.observedAt;
    if (w.timedOut) { raw.cancel = (await srv.call('task_cancel', { task_id: raw.submit.taskId }, 60_000)).json ?? null; raw.final = (await srv.call('result', { task_id: raw.submit.taskId }, 60_000)).json ?? raw.final; }   // ONE cancel, no retry
    const ce = Date.parse(raw.final?.completedAt); const end = Math.min(Math.max(Number.isFinite(ce) ? ce : w.observedAt, t0), w.observedAt);
    raw.window = { startMs: t0, engineEndMs: end, observedMs: w.observedAt, graded: end - t0 };
    await host.settleUsage(srv, [{ taskId: raw.submit.taskId }]);
    raw.usage = { byTask: (await srv.call('usage_query', { task_id: raw.submit.taskId, grain: 'task' })).json ?? null, byTurn: (await srv.call('usage_query', { task_id: raw.submit.taskId, grain: 'turn' })).json ?? null };
    raw.allTasks = (await srv.call('task_list', { limit: 500 })).json ?? null;
    raw.sessions = (await srv.call('session_list', {})).json ?? null;
    raw.agentList = (await srv.call('agent_list', {})).json ?? null;
    return raw;
  } finally {
    raw.bootMs = srv.bootMs; raw.stderrTail = srv.getStderr().slice(-4000); raw.shellEgress = host.egressFactOf(host.readIf(path.join(ctx.runDir, 'srt-policy.json')), srv.getStderr());
    record.mcpCalls = srv.calls.length; await srv.close();
  }
}

export const ERROR_LIKE = FS.ERROR_LIKE;   // defined in flow-stages.mjs (the detector and the failure naming share it)
export const errorSnippet = FS.errorSnippet;
const arr = (j) => (Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : Array.isArray(j?.items) ? j.items : Array.isArray(j?.sessions) ? j.sessions : Array.isArray(j?.tasks) ? j.tasks : []);

/** Everything computed AFTER the run from its logs, never from the model's own report. Fills the record in place; never throws (a failed analysis is a recorded warning). */
export async function analyzeGroup({ ctx, host, deps, record, raw, before }) {
  const arm = ctx.runDef.arm; const wt = record.worktree;
  try {
    const api = L.findApiLogs(path.join(ctx.runDir, 'logs')); const tasks = arr(raw?.allTasks); const sessions = arr(raw?.sessions);
    const rows = taskFacts({ tasks, sessions, streamFor: (id) => host.streamForTask(arm, api, id) });
    record.agents = rows.map(({ calls, ...r }) => r); record.toolCalls = rows.map((r) => ({ taskId: r.taskId, agent: r.agent, calls: r.calls.map((c) => ({ name: c.name, input: c.input, isError: c.isError, resultText: c.resultText == null ? null : String(c.resultText).slice(0, 400) })) })); record.totals = totalsOfTasks(rows);
    record.wire = host.wireFactsOf(ctx); record.thinkingWire = host.wireThinkingOf(ctx);
    record.model = host.modelFacts({ requested: record.config.model, resolved: [...new Set(rows.flatMap((r) => r.models))], sideModels: [], wire: record.wire });
    const opCalls = rows.filter((r) => r.agent === DELEGATE_AGENT).flatMap((r) => r.calls); const allCalls = rows.flatMap((r) => r.calls);
    const pick = pickedFromCalls(opCalls.length ? opCalls : allCalls);
    record.dispatch = { performanceTask: raw?.submit?.taskId ?? null, children: rows.filter((r) => r.parentTaskId).map((r) => ({ taskId: r.taskId, agent: r.agent, parentTaskId: r.parentTaskId, status: r.status })), viaAgentMcp: rows.some((r) => r.parentTaskId && r.agent === DELEGATE_AGENT) };
    const after = await snapshotAfter(deps.reader, pick.distinctUids); record.backlog = { ...record.backlog, after, calls: { transitions: pick.transitions, claims: pick.claims, otherBacklogCalls: pick.otherBacklogCalls, source: pick.source }, item: transitionFact({ before, after, picked: pick.picked, transitions: pick.transitions }) };
    record.worktree = { ...record.worktree, ...worktreeFacts({ wtPath: wt.path, baseSha: wt.baseSha }) };
    // timing: the product's own window (prompt handed -> the server's completedAt), like the fair-timing rule
    const win = raw?.window ?? null;
    record.wall = win ? { gradedMs: win.graded, observedMs: win.observedMs - win.startMs, basis: "prompt handed to the product (task call) -> the server's own completedAt of the performance task", bootMs: raw.bootMs ?? null } : { gradedMs: null, basis: 'no task window (the task was never submitted or never finished)' };
    record.usage = { total: record.totals, repoEstimateUsd: raw?.usage?.byTask?.summary?.est_cost_usd ?? null, byTask: raw?.usage?.byTask ?? null };
    record.result = { status: raw?.final?.status ?? null, finalText: String(raw?.final?.result ?? ''), error: raw?.final?.error ?? null, timedOut: raw?.timedOut === true, cancel: raw?.cancel ?? null };
    record.submitted = raw?.submit?.payload ?? null;
    record.agentListShape = raw?.agentList ? (arr(raw.agentList).map((a) => a.name)) : null;
    // evidence + failure naming
    let bundle = null; try { bundle = EV.buildBundle(ctx.runDir, { arm, record: { runId: record.runId, arm, wallMs: record.wall?.gradedMs ?? null, finishedAt: record.finishedAt } }).bundle; } catch (e) { record.warnings.push(`EVIDENCE bundle not built: ${String(e.message ?? e)}`); }
    if (ctx.trace) { try { record.evidence = EV.writeEvidence({ runDir: ctx.runDir, arm, record: { runId: ctx.spec.runId, arm, wallMs: record.wall?.gradedMs ?? null, finishedAt: record.finishedAt } }); if (!record.evidence.leakScan.ok) record.warnings.push(`EVIDENCE LEAK SCAN: ${JSON.stringify(record.evidence.leakScan.kinds)}`); } catch (e) { record.warnings.push(`EVIDENCE not written: ${String(e.message ?? e)}`); } }
    const mcpCalls = (() => { try { return JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'mcp-calls.json'), 'utf8')); } catch { return []; } })();
    record.failure = explainFailure({ harnessFailure: record.harnessFailure, submit: raw?.submit, final: raw?.final && typeof raw.final === 'object' ? raw.final : null, timedOut: raw?.timedOut, stderrTail: raw?.stderrTail,
      tasks: rows.map((r) => ({ id: r.taskId, agent: r.agent, status: r.status, error: r.error, createdAt: r.createdAt, depth: r.depth })),
      toolErrors: (bundle?.trace?.toolCalls ?? []).filter((t) => t.isError).map((t) => ({ task: t.task, name: t.name, text: '' })).concat(allCalls.filter((c) => c.isError === true).map((c) => ({ task: null, name: c.name, text: c.resultText }))),
      wireErrors: (bundle?.requests ?? []).filter((q) => q.status != null && q.status !== 200).map((q) => ({ seq: q.seq, status: q.status, task: q.task })),
      mcpErrors: mcpCalls.filter((c) => c.isError || c.thrown).map((c) => ({ name: c.name, text: c.thrown ?? c.text })),
      errorTexts: allCalls.filter((c) => c.resultText != null && ERROR_LIKE.test(String(c.resultText))).map((c) => ({ name: c.name, text: errorSnippet(c.resultText) })),
      dispatched: record.dispatch.viaAgentMcp, backlogCalls: opCalls.filter((c) => /(^|__)backlog_/.test(String(c.name))).length, transitions: pick.transitions, commits: record.worktree.commits.length });
    // R11 AC11/AC12: the five flow stages from STATE (task records, the worktree git log, the backlog read-back), the failing step per stage, and repeated tool errors
    const flowTasks = rows.length ? rows.map((r) => ({ taskId: r.taskId, agent: r.agent, sessionId: r.sessionId, parentTaskId: r.parentTaskId, status: r.status, error: r.error, createdAt: r.createdAt, completedAt: r.completedAt, calls: r.calls })) : null;
    record.flow = FS.detectFlow({ tasks: flowTasks, commits: record.worktree.commits, item: record.backlog.item });
    record.failure.stageFailures = FS.explainStages({ flow: record.flow, tasks: flowTasks });
    record.failure.repeatedToolErrors = FS.repeatedToolErrors(flowTasks);
    record.failure.bugCandidate = record.failure.repeatedToolErrors.length > 0;
    record.failure.flowStep = record.flow.flowComplete ? null : (record.failure.stageFailures[0]?.step ?? null);
    record.shellEgress = raw?.shellEgress ?? null;
    if (ctx.dry && host.dryEgressFact) { record.dryRunEgress = host.dryEgressFact(ctx); if (record.dryRunEgress.breach.length) record.warnings.push(`DRY-RUN EGRESS BREACH: ${JSON.stringify(record.dryRunEgress)}`); }
    if (raw?.storeLine && /mode=production/.test(raw.storeLine)) record.warnings.push(`SERVER REPORTS PRODUCTION STORE: ${raw.storeLine}`);
    record.observedTools = Object.fromEntries(rows.map((r) => [r.agent ?? r.taskId, r.offeredTools]));
  } catch (e) { record.warnings.push(`ANALYSIS FAILED: ${String(e.stack ?? e).split('\n').slice(0, 3).join(' | ')}`); record.failure ??= explainFailure({ harnessFailure: record.harnessFailure ?? String(e.message ?? e), submit: raw?.submit }); record.flow ??= FS.detectFlow({ tasks: null, commits: null, item: null }); }
  return record;
}

/**
 * Run the round: groups in profile order, each ONCE. Prints the per-group line and, last, PAUSE_LINE. Returns {records, exitCode, stopped}. exit 0 = both groups ran to a record (even if an
 * agent failed: that is a result); 1 = a pre-spawn fault or a harness failure stopped the round.
 */
export async function runDesignRound({ opts, dry, host, deps, log = console.log }) {
  const profile = host.roundProfile(opts); const arms = profile.arms; const records = []; let stopped = null;
  const check = LG.designOf(LG.readLedger(opts.round, opts.ledgerDir)); if (check !== DESIGN_ID) throw new DesignError(`round ${opts.round} does not declare design ${DESIGN_ID}`);
  if (arms.includes('A')) throw new DesignError(`arm A is not run in design ${DESIGN_ID} (owner: only arms B and C)`);
  log(`${dry ? 'DRY-RUN (no model call)' : 'LIVE'} design ${DESIGN_ID} plan: ${arms.join(' -> ')}  out=${opts.out}`);
  log(`ARM-A GATE WAIVED (ledger.profile.armAWaiver): ${profile.armAWaiver}`);
  for (const [i, arm] of arms.entries()) {
    const ctx = host.makeCtx({ ...opts }, null, { arm, rep: 1, position: i + 1 }, dry);
    const done = path.join(ctx.runDir, 'record.json');
    if (fs.existsSync(done)) { let prior = null; try { prior = JSON.parse(fs.readFileSync(done, 'utf8')); } catch { /* corrupt: do not rerun, stop */ } if (prior && !prior.aborted) { records.push(prior); log(`skip ${ctx.spec.runId}: record exists (a group runs once; no retry)`); continue; } stopped = `${ctx.spec.runId}: an unreadable or aborted record exists; not rerun (one run per group)`; break; }
    let rec;
    try { rec = await runGroup({ ctx, host, deps }); } catch (e) { stopped = `${ctx.spec.runId}: pre-spawn fault, nothing ran: ${String(e.message ?? e)}`; if (e.record) { records.push(e.record); } break; }
    records.push(rec); log(groupLine(rec));
    if (rec.dryRunEgress?.breach?.length) { stopped = `${rec.runId}: dry-run egress breach ${JSON.stringify(rec.dryRunEgress.breach)}`; break; }
    if (rec.harnessFailure) { stopped = `${rec.runId}: harness failure at step "${rec.failure?.failedStep}": ${rec.failure?.detail}`; break; }
  }
  if (stopped) log(`ROUND STOPPED: ${stopped}`);
  const cfgs = records.map((r) => r.config).filter(Boolean);
  const identicalGroups = cfgs.length >= 2 ? identicalGroupsCheck(cfgs[0], cfgs[1]) : null;
  if (identicalGroups) log(`IDENTICAL GROUPS (prompts, tools, model, effort, limits equal; only the provider and the worktree differ): ${identicalGroups.ok ? 'yes' : `NO - ${identicalGroups.reasons.join('; ')}`}`);
  writeJson(path.join(opts.out, 'SUMMARY.json'), { design: DESIGN_ID, round: opts.round, mode: dry ? 'dry-run' : 'live', groups: records.map(groupSummary), identicalGroups, stopped });
  log(PAUSE_LINE);
  return { records, stopped, exitCode: stopped ? 1 : 0 };
}
export function groupSummary(r) {
  return { runId: r.runId, arm: r.arm, provider: r.config?.provider, model: r.config?.model, status: r.result?.status ?? null, wallMs: r.wall?.gradedMs ?? null, costUsd: r.totals?.costUsd ?? null, toolCalls: r.totals?.toolCalls ?? null, picked: r.backlog?.item?.picked ?? null, statusBefore: r.backlog?.item?.statusBefore ?? null, statusAfter: r.backlog?.item?.statusAfter ?? null,
    commits: (r.worktree?.commits ?? []).map((c) => c.sha), failedStep: r.failure?.failedStep ?? null, gaps: r.failure?.gaps ?? [],
    flow: r.flow ? { stages: Object.fromEntries(FS.STAGE_IDS.map((x) => [x, r.flow.stages?.[x]?.status ?? 'unknown'])), flowComplete: r.flow.flowComplete === true, firstNotPassed: r.flow.firstNotPassed ?? null } : null, bugCandidate: r.failure?.bugCandidate === true };
}
export function groupLine(r) {
  const s = groupSummary(r);
  return `${s.runId} (${s.provider} ${s.model}): ${s.status ?? 'no task'}${s.failedStep ? ` | FAILED at step: ${s.failedStep}` : ''} | wall ${s.wallMs == null ? '-' : (s.wallMs / 1000).toFixed(1) + 's'} | cost ${s.costUsd == null ? '-' : '$' + s.costUsd.toFixed(4)} | picked ${s.picked ?? '-'} (${s.statusBefore ?? '?'} -> ${s.statusAfter ?? '?'}) | commits ${s.commits.length}${s.gaps.length ? ` | GAPS: ${s.gaps.join('; ')}` : ''}${s.flow ? ` | FLOW ${FS.flowLine(r.flow)}` : ''}${s.bugCandidate ? ' | BUG CANDIDATE: repeated tool errors' : ''}`;
}

// ----------------------------------------------------------------------------------------------------------------
// analyze <round> <runB> <runC> [--section ...]
// ----------------------------------------------------------------------------------------------------------------
export const SECTIONS = Object.freeze(['prompt', 'config', 'result', 'timing', 'usage', 'tools', 'worktree', 'backlog', 'flow', 'failure']);
const cell = (v) => (v == null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** Side-by-side per-group facts. Pure over two (or more) records. */
export function formatSideBySide(records, section = 'all') {
  const want = section === 'all' ? SECTIONS : [section]; const out = []; const ids = records.map((r) => r.runId);
  const row = (name, f) => `${name} | ${records.map((r) => cell(f(r))).join(' | ')}`;
  const sec = (title, rows) => { out.push(`== ${title.toUpperCase()} (${ids.join(' | ')}) ==`, ...rows, ''); };
  for (const s of want) {
    if (s === 'prompt') sec('prompt', [row('submitted prompt byte-identical to TASK_PROMPT', (r) => r.submitted?.prompt === TASK_PROMPT), row('prompt bytes', (r) => r.prompt?.bytes), row('prompt sha256', (r) => r.prompt?.sha256?.slice(0, 16)), row('task payload keys', (r) => Object.keys(r.submitted ?? {}).join(','))]);
    if (s === 'config') sec('config fact table', [row('provider', (r) => r.config?.provider), row('model', (r) => r.config?.model), row('effort', (r) => r.config?.effort), row('thinking', (r) => r.config?.thinking), row('cwd', (r) => r.config?.cwd), row('performance prompt sha', (r) => r.config?.systemPromptSha256?.[PARENT_AGENT]?.slice(0, 16)), row('backlog-operator prompt sha', (r) => r.config?.systemPromptSha256?.[DELEGATE_AGENT]?.slice(0, 16)), row('performance tools', (r) => r.config?.tools?.[PARENT_AGENT]?.join(',')), row('backlog-operator tools', (r) => r.config?.tools?.[DELEGATE_AGENT]?.join(',')), row('review prompt sha', (r) => r.config?.systemPromptSha256?.[REVIEW_AGENT]?.slice(0, 16)), row('review tools', (r) => r.config?.tools?.[REVIEW_AGENT]?.join(',')), row('limits', (r) => r.config?.limits)]);
    if (s === 'result') sec('result', [row('performance task status', (r) => r.result?.status), row('dispatched backlog-operator via agent-mcp', (r) => r.dispatch?.viaAgentMcp), row('final text', (r) => String(r.result?.finalText ?? '').replace(/\s+/g, ' ').slice(0, 240))]);
    if (s === 'timing') sec('timing (wall = prompt handed -> the product final result)', [row('wall ms (graded)', (r) => r.wall?.gradedMs), row('observed ms', (r) => r.wall?.observedMs), row('server boot ms', (r) => r.wall?.bootMs)]);
    if (s === 'usage') sec('cost / usage', [row('tasks', (r) => r.totals?.tasks), row('turns', (r) => r.totals?.turns), row('cost usd (rate card)', (r) => r.totals?.costUsd), row('cost usd (repo estimate)', (r) => r.usage?.repoEstimateUsd), ...[PARENT_AGENT, DELEGATE_AGENT, REVIEW_AGENT].map((a) => row(`${a} turns / cost usd`, (r) => { const x = (r.agents ?? []).filter((t) => t.agent === a); return x.length ? `${x.reduce((n, t) => n + t.turns, 0)} / ${x.every((t) => t.costUsd != null) ? x.reduce((n, t) => n + t.costUsd, 0).toFixed(6) : '-'}` : null; }))]);
    if (s === 'tools') sec('tool counts per agent (executed) and tools offered', [...[PARENT_AGENT, DELEGATE_AGENT, REVIEW_AGENT].flatMap((a) => [row(`${a} calls`, (r) => { const x = (r.agents ?? []).filter((t) => t.agent === a); return x.length ? JSON.stringify(x.reduce((m, t) => { for (const [k, v] of Object.entries(t.toolCounts.byName)) m[k] = (m[k] || 0) + v; return m; }, {})) : null; }), row(`${a} tools offered`, (r) => (r.observedTools?.[a] ?? []).length)])]);
    if (s === 'worktree') sec('worktree', [row('path', (r) => r.worktree?.path), row('branch', (r) => r.worktree?.branch), row('base sha', (r) => r.worktree?.baseSha), row('commit shas', (r) => (r.worktree?.commits ?? []).map((c) => c.sha.slice(0, 10)).join(',')), row('uncommitted', (r) => (r.worktree?.uncommitted ?? []).length), row('node_modules present / hooksPath', (r) => `${r.worktree?.nodeModulesPresent} / ${r.worktree?.hooksPath}`)]);
    if (s === 'backlog') sec('backlog', [row('ready items before', (r) => r.backlog?.before?.readyTotal), row('picked item uid', (r) => r.backlog?.item?.picked), row('was in the ready view before', (r) => r.backlog?.item?.wasInReadyViewBefore), row('status before -> after', (r) => `${r.backlog?.item?.statusBefore ?? '?'} -> ${r.backlog?.item?.statusAfter ?? '?'}`), row('transitioned', (r) => r.backlog?.item?.transitioned)]);
    if (s === 'flow') sec('flow stages (owner stop condition: all five pass in both groups; read from state, not from the agent report)', [row('flow complete', (r) => r.flow?.flowComplete === true), row('first stage not passed', (r) => r.flow?.firstNotPassed ?? 'none'),
      ...FS.STAGE_IDS.flatMap((x) => [row(`${x} ${FS.STAGE_NAMES[x]}`, (r) => r.flow?.stages?.[x]?.status ?? 'unknown'), row(`   ${x} detail`, (r) => r.flow?.stages?.[x]?.detail), row(`   ${x} evidence`, (r) => (r.flow?.stages?.[x]?.evidence ?? []).join(' ; '))])]);
    if (s === 'failure') sec('failure', [row('failing step', (r) => r.failure?.failedStep), row('detail', (r) => r.failure?.detail), row('first flow stage not passed', (r) => r.failure?.flowStep), row('gaps', (r) => (r.failure?.gaps ?? []).join('; ')), row('evidence', (r) => (r.failure?.evidence ?? []).join(' || ')),
      row('stage failures (task / agent / last tool call / error text)', (r) => (r.failure?.stageFailures ?? []).map((x) => `${x.stage} ${x.status}: ${x.task ? `${String(x.task.taskId).slice(0, 8)} ${x.task.agent}` : 'no task'} / ${x.lastToolCall?.name ?? '-'} / ${x.errorText ?? '-'}`).join(' || ')),
      row('BUG CANDIDATE: repeated tool errors', (r) => (r.failure?.repeatedToolErrors ?? []).map((x) => `${x.agent} ${x.tool} x${x.count}: ${x.sample}`).join(' || ') || 'none')]);
  }
  return out.join('\n');
}
/** CLI: `analyze <round> <runB> <runC> [--section s] [--out DIR]`. Reads `<tmpRoot>/live/out/runs/<id>/record.json` (or `<DIR>/runs/<id>/record.json`). Read-only. */
export function analyzeDesignCli(rest, { tmpRoot }) {
  const args = [...rest]; let section = 'all'; let outDir = null; const pos = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--section') section = args[++i]; else if (args[i] === '--out') outDir = path.resolve(args[++i]); else pos.push(args[i]); }
  if (section !== 'all' && !SECTIONS.includes(section)) return { code: 2, err: `unknown --section ${section} (known: ${SECTIONS.join(', ')}, all)` };
  const [round, ...ids] = pos; if (!round || ids.length < 1) return { code: 2, err: 'usage: analyze <round> <runB> <runC> [--section prompt|config|result|timing|usage|tools|worktree|backlog|flow|failure|all] [--out DIR]' };
  const root = outDir ?? path.join(tmpRoot(round), 'live/out'); const recs = [];
  for (const id of ids) { try { recs.push(JSON.parse(fs.readFileSync(path.join(root, 'runs', id, 'record.json'), 'utf8'))); } catch (e) { return { code: 1, err: `cannot read ${path.join(root, 'runs', id, 'record.json')}: ${e.code ?? e.message}` }; } }
  return { code: 0, out: formatSideBySide(recs, section) };
}
