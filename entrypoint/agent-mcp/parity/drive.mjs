// PARITY-INSTRUMENT-ONLY
// CLI-parity experiment driver (entrypoint/agent-mcp/parity). Private, unpublished measurement instrument. See README.md.
//   node drive.mjs --self-check | --print-plan | --check-oracle | --check-lib | --dry-run | --live --yes   [options]
// --self-check / --print-plan / --check-* make NO model call and run NO `claude` binary.
// --live spends real quota and is hard-capped at MAX_MODEL_RUNS (3: one run per arm) per round across all invocations (durable per-round ledger, --round R<n>).
// --dry-run (owner-run only) drives all three arms end to end with fakes against the REAL built agent-mcp.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as L from './lib.mjs';
import * as F from './fixtures.mjs';
import * as O from './oracle.mjs';
import * as LG from './ledger.mjs';
import * as GT from './gate.mjs';
import * as DT from './detectors.mjs';
import * as PF from './preflight.mjs';
import * as MT from './metrics.mjs';
import * as GR from './grid.mjs';
import * as QL from './quality.mjs';
import * as JG from './judge.mjs';
import { ModelRunCapError } from './ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ----------------------------------------------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------------------------------------------
/** A round id names a tracked ledger file and a tmp directory: only `R<digits>` is accepted (no path separators, no `..`). */
export const ROUND_RE = /^R\d+$/;
function parseArgs(argv) {
  // Round 4: NO --arms / --batch / --keep-going: the plan is always the full seeded 6 runs, and the run cap lives in a durable ledger
  // that is keyed on nothing the command line can change (not --out, not --seed), so re-invoking differently cannot bypass it.
  const o = { round: ROUND, mode: null, out: null, seed: '20261011', wt: DEFAULT_WT, claude: 'claude', yes: false, degraded: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (['--self-check', '--print-plan', '--check-oracle', '--check-lib', '--dry-run', '--live'].includes(a)) o.mode = a.slice(2);
    else if (['preflight', 'verdict', 'grid'].includes(a)) o.mode = a; else if (a === '--round') { o.round = v(); if (!ROUND_RE.test(o.round)) { console.error(`--round must match ${ROUND_RE} (it names the ledger file and the tmp dir), got ${JSON.stringify(o.round)}`); process.exit(2); } }
    else if (a === '--out') o.out = path.resolve(v()); else if (a === '--seed') o.seed = v(); else if (a === '--wt') o.wt = path.resolve(v()); else if (a === '--claude') o.claude = v();
    else if (a === '--yes') o.yes = true; else if (a === '--degraded') o.degraded = v();
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  return o;
}

// ----------------------------------------------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------------------------------------------
const MODEL = F.PIN_MODEL;
/** The built agent-mcp lives in the repo root (the round-2 plan worktree no longer exists). */
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_WT = REPO_ROOT;
/** Raw output root (gitignored): repo-root tmp/agent-mcp/parity/<round>/ (AGENTS.md section 10). */
export const ROUND = "R5";
export const tmpRoot = (round = ROUND) => path.join(REPO_ROOT, 'tmp', 'agent-mcp', 'parity', round);
/** HARD CAP: total model runs (one run = one arm's full phase-1 + phase-2 session) this driver will ever start, across all invocations. */
export const MAX_MODEL_RUNS = LG.RUN_CAP;
/** Durable run ledger: lives next to the driver, NOT under --out, so it cannot be dodged by changing arguments. */
export const LEDGER_PATH = LG.ledgerPathFor(ROUND);
/**
 * ONE thinking setting for every arm: OFF.
 *  - Arm A (native `claude -p`): these two env vars are set in the spawn env of every `claude -p` turn (argvA has no thinking flag).
 *    claude 2.1.296 `kyo()` checks env MAX_THINKING_TOKENS before settings `alwaysThinkingEnabled`, and CLAUDE_CODE_DISABLE_THINKING
 *    removes the thinking parameter from the request outright (binary strings, cited in README.md), so the operator's settings cannot re-enable it.
 *  - Arm B (agent-mcp claudecli provider): the same vars are put in the agent-mcp SERVER env; claudecli.ts buildSubprocessEnv() copies
 *    process.env into every `claude` it spawns (claudecli.ts:818-833), so parent and worker `claude -p` children get them.
 *  - Arm C (agent-mcp anthropic provider): the provider sets no `thinking` request parameter at all (rg "thinking" anthropic.ts: no hit), i.e. thinking is OFF by construction.
 * The live invariant is checked on every run: any thinking block observed in any arm marks the run INVALID.
 */
export const THINKING_OFF_ENV = Object.freeze({ MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_THINKING: '1' });
export const THINKING_MECHANISM = Object.freeze({
  A: 'env MAX_THINKING_TOKENS=0 + CLAUDE_CODE_DISABLE_THINKING=1 in the `claude -p` spawn env (spawnClaudeTurn env = cleanEnv({...CLAUDECLI_PROVIDER_ENVS, ...THINKING_OFF_ENV}))',
  B: 'env MAX_THINKING_TOKENS=0 + CLAUDE_CODE_DISABLE_THINKING=1 in the agent-mcp server env, inherited by every claudecli `claude` child (claudecli.ts:818-833 copies process.env)',
  C: 'no `thinking` request parameter is ever sent by the anthropic provider (anthropic.ts has no "thinking" parameter): off by construction',
});
const MAX_TOOL_LOOPS = 40;                                                 // B/C; A (claude 2.1.296) has no --max-turns: recorded as an asymmetry
// R3: no curl/wget on the allowlist. B and C use only agent-mcp tools or MCP servers as shipped (no instrument-added web path).
export const SHELL_ALLOW = ['make', 'cat', 'ls', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'echo', 'diff', 'sort', 'uniq', 'tr', 'cut', 'basename', 'dirname'];
/** R3: the instrument adds NO srt domain (the per-run policy is written empty; agent-mcp's own defaults apply). */
export const SRT_EXTRA_DOMAINS = [];
/** R3: arm A runs the native default toolset (`claude --tools default`), nothing instrument-added. */
const A_TOOLS = 'default';
/** Declared web surface per arm as shipped (R3.AC5/AC6, R2.AC1). `probe` is set only for a fetch tool reachable at zero model cost; none is, as of this port (U5 open). */
export const WEB_SURFACE = Object.freeze({
  A: { tools: ['WebFetch', 'WebSearch'], why: 'native WebFetch makes a hidden small-model call: not a zero-model probe' },
  B: { tools: [], why: 'claudecli bridges only agent-mcp tools; the shipped shell exposes no fetch command by default (an arm that cannot fetch fails w1_web: product finding)' },
  C: { tools: ['web_fetch', 'web_search'], why: 'server-executed by the API: not probeable at zero model cost' },
});
const WORKER_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
const BUDGET_GUARD_USD = '1.50';
const PHASE_TIMEOUT_MS = 20 * 60 * 1000;
const GAP_MS = 12_000;
const RUN_ID = (arm, rep) => `${arm}${rep}`;

// ----------------------------------------------------------------------------------------------------------------
// Paths, isolation
// ----------------------------------------------------------------------------------------------------------------
const PROD_ROOT = path.join(os.homedir(), '.adhd', 'agent-mcp', 'production');
function fingerprint(root) {
  const h = crypto.createHash('sha256'); let files = 0, newest = 0;
  const walk = (d) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { const st = fs.statSync(p); h.update(`${path.relative(root, p)}|${st.size}|${Math.floor(st.mtimeMs)}\n`); files++; newest = Math.max(newest, st.mtimeMs); } catch { /* ignore */ } } } };
  walk(root); return { files, sha256: h.digest('hex'), newestMtimeMs: Math.floor(newest) };
}
/** The fixture cwd must not sit under any repo / agent-instruction file (a CLAUDE.md or .claude dir above it would leak into arm A). */
function ancestorLeaks(dir) {
  const leaks = []; let cur = path.resolve(dir);
  for (;;) {
    for (const n of ['.git', '.claude', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.adhd']) if (fs.existsSync(path.join(cur, n))) leaks.push(path.join(cur, n));
    const up = path.dirname(cur); if (up === cur) break; cur = up;
  }
  return leaks;
}

// ----------------------------------------------------------------------------------------------------------------
// Hidden suite (run by the DRIVER after each phase; lives outside the working directory)
// ----------------------------------------------------------------------------------------------------------------
function runHidden(hiddenDir, repoDir, names) {
  const out = {};
  for (const n of names) {
    const r = spawnSync(process.execPath, ['--test', path.join(hiddenDir, `${n}.test.mjs`)], { cwd: os.tmpdir(), env: L.cleanEnv({ R2_REPO: repoDir }), encoding: 'utf8', timeout: 60_000 });
    out[n] = r.status === 0;
  }
  // Round 4: the VISIBLE suite (`node --test` in the repo = what `make test` runs), as left by the arm: the only suite the agent can observe (s2_honest.tests_pass).
  const v = spawnSync(process.execPath, ['--test'], { cwd: repoDir, env: L.cleanEnv(), encoding: 'utf8', timeout: 60_000 });
  out.visible = v.status === 0;
  return out;
}
/** Files under the production root modified since `sinceMs` that mention this run (its work dir / agent names): attributable touches only. */
function productionTouches(root, sinceMs, needles) {
  const hits = []; const bufs = needles.map((n) => Buffer.from(n));
  const walk = (d) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); continue; } try { const st = fs.statSync(p); if (st.mtimeMs < sinceMs || st.size > 64 << 20) continue; const b = fs.readFileSync(p); if (bufs.some((n) => b.includes(n))) hits.push(path.relative(root, p)); } catch { /* ignore */ } } };
  walk(root); return hits;
}
const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const repoFilesOf = (repoDir) => Object.fromEntries(['docs/shipping.md', 'CHANGELOG.md', 'examples/usage.md', 'src/checkout.js', 'src/summary.js'].map((f) => [f, readIf(path.join(repoDir, f))]));

// ----------------------------------------------------------------------------------------------------------------
// Process ownership
// ----------------------------------------------------------------------------------------------------------------
const owned = new Set();
async function sweepOwned(tag) {
  const table = L.psTable();
  const desc = L.descendantsOf([...owned], table).map((p) => p.pid);
  const swept = await L.sweepPids([...owned, ...desc]);
  owned.clear();
  return { tag, swept };
}

// ----------------------------------------------------------------------------------------------------------------
// Shared per-run context
// ----------------------------------------------------------------------------------------------------------------
function makeCtx(opts, plan, runDef, dry) {
  const spec = F.makeSpec({ seed: opts.seed, arm: runDef.arm, rep: runDef.rep });
  const outRoot = opts.out ?? path.join(tmpRoot(opts.round ?? ROUND), 'live/out');
  const runDir = path.join(outRoot, 'runs', spec.runId);
  // The arm's cwd must sit outside any repo / agent-instruction file (ancestorLeaks): repo-root tmp/ is inside this checkout, so it lives under the OS temp dir.
  const work = opts.out ? path.join(outRoot, 'work', spec.runId) : path.join(os.tmpdir(), 'adhd-agent-mcp-parity', opts.round ?? ROUND, 'work', spec.runId);
  return { opts, dry, spec, runDef, runDir, work, repoDir: path.join(work, 'repo'), hiddenDir: path.join(work, 'hidden'), ticketFile: path.join(work, 'ticket.txt'),
    infoLog: path.join(work, 'info-calls.log'), prompts: F.prompts(), ledgerPath: LG.ledgerPathFor(opts.round ?? ROUND) };
}

// ----------------------------------------------------------------------------------------------------------------
// ARM A: native `claude -p` (A-MATCHED flags), stream-json in/out, phase 2 via --resume
// ----------------------------------------------------------------------------------------------------------------
function mcpConfigFor(ctx) {
  return { mcpServers: { r2info: { command: process.execPath, args: [path.join(HERE, 'info-server.mjs')], env: { R2_TICKET_FILE: ctx.ticketFile, R2_INFO_LOG: ctx.infoLog } } } };
}
function agentsJson(ctx) {
  return { worker: { description: 'General-purpose worker: reads, searches, edits and writes files and runs shell commands for the task it is given.', prompt: ctx.spec.systemPrompt, tools: WORKER_TOOLS } };
}
function argvA(ctx, mcpPath, resumeSid) {
  const a = ['-p', '--dangerously-skip-permissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', mcpPath,
    '--tools', A_TOOLS, '--setting-sources', 'project', '--system-prompt', ctx.spec.systemPrompt, '--agents', JSON.stringify(agentsJson(ctx)), '--max-budget-usd', BUDGET_GUARD_USD, '--model', MODEL];
  if (resumeSid) a.push('--resume', resumeSid);
  return a;
}
function spawnClaudeTurn({ claude, argv, cwd, env, prompt, outFile, errFile, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(claude, argv, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    owned.add(child.pid);
    const lines = []; let buf = ''; let resultSeen = false; let err = ''; let timedOut = false;
    const t0 = Date.now();
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); lines.push({ t: Date.now() - t0, line });
        if (line.includes('"type":"result"')) { try { if (JSON.parse(line).type === 'result') { resultSeen = true; try { child.stdin.end(); } catch { /* closed */ } } } catch { /* partial */ } } }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code, sig) => {
      clearTimeout(timer); if (buf.trim()) lines.push({ t: Date.now() - t0, line: buf });
      fs.writeFileSync(outFile, lines.map((l) => l.line).join('\n') + '\n'); fs.writeFileSync(errFile, err);
      resolve({ code, sig, timedOut, resultSeen, lines, wallMs: Date.now() - t0, stderr: err });
    });
  });
}
/** The exact env of every arm-A `claude -p` turn (thinking OFF via THINKING_OFF_ENV). */
export function armAEnv(ctx) { return L.cleanEnv({ ...L.CLAUDECLI_PROVIDER_ENVS, ...THINKING_OFF_ENV, ...(ctx.dry ? ctx.fakeEnv : {}) }); }
async function runArmA(ctx) {
  const claude = ctx.opts.claude;
  const mcpPath = path.join(ctx.runDir, 'mcp-config.json'); writeJson(mcpPath, mcpConfigFor(ctx));
  const env = armAEnv(ctx);
  const res = { phases: [], argv: [] };
  let sid = null;
  for (const phase of [1, 2]) {
    const argv = argvA(ctx, mcpPath, phase === 2 ? sid : null); res.argv.push(argv);
    const prompt = phase === 1 ? ctx.prompts.phase1 : ctx.prompts.phase2;
    const t = await spawnClaudeTurn({ claude, argv, cwd: ctx.repoDir, env, prompt, outFile: path.join(ctx.runDir, `A.phase${phase}.stream.jsonl`), errFile: path.join(ctx.runDir, `A.phase${phase}.stderr.txt`), timeoutMs: PHASE_TIMEOUT_MS });
    const events = L.parseJsonLines(t.lines.map((l) => l.line).join('\n'));
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    if (phase === 1) sid = init?.session_id ?? events.find((e) => e.session_id)?.session_id ?? null;
    res.phases.push({ phase, ...t, events, init, sid: init?.session_id ?? sid, hidden: runHidden(ctx.hiddenDir, ctx.repoDir, phase === 1 ? ['bugfix', 'feature'] : ['bugfix', 'feature', 'empty']), files: repoFilesOf(ctx.repoDir) });
    if (phase === 1 && !sid) break;
    if (t.timedOut || (!t.resultSeen && t.code !== 0)) break;
  }
  res.sid = sid;
  return res;
}

// ----------------------------------------------------------------------------------------------------------------
// ARMS B / C: the BUILT agent-mcp, driven over stdio JSON-RPC by a real MCP client (the way a host does)
// ----------------------------------------------------------------------------------------------------------------
async function loadSdk(wt) {
  const base = path.join(wt, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
  const { Client } = await import(pathToFileURL(path.join(base, 'client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(base, 'client/stdio.js')).href);
  return { Client, StdioClientTransport };
}
const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const textOf = (r) => (r?.content || []).map((c) => c.text ?? '').join('');

/** The exact env of the agent-mcp server (arms B and C). For B it is inherited by every claudecli `claude` child (thinking OFF). */
export function serverEnv(ctx, store, logs) {
  return L.cleanEnv({
    ...THINKING_OFF_ENV,
    ADHD_AGENT_DATABASE_PATH: path.join(store, 'agents.db'), ADHD_AGENT_REGISTRY_DB_PATH: path.join(store, 'registry.db'),
    ADHD_AGENT_TRANSPORT: 'stdio', ADHD_AGENT_SSE_ENABLED: 'false', ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true',
    ADHD_AGENT_LOGGING_DIR: logs, ADHD_AGENT_LOGGING_API: 'on', ADHD_AGENT_LOGGING_INSTANCE_LABEL: ctx.spec.runId,
    ADHD_AGENT_BUDGET_MAX_CALLS: '0', ADHD_AGENT_SRT_SETTINGS: path.join(ctx.runDir, 'srt-policy.json'),
    ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_ROOTS: JSON.stringify({ repo: ctx.repoDir }),
    ...(ctx.dry ? { ADHD_AGENT_ANTHROPIC_SECRET: 'dry-run-not-a-secret', ANTHROPIC_BASE_URL: ctx.fakeAnthropicUrl || 'http://127.0.0.1:9', NODE_OPTIONS: `--require ${path.join(HERE, 'dryrun/egress-guard.cjs')}`, R2_EGRESS_LOG: path.join(ctx.runDir, 'egress-blocked.log') } : {}),
  });
}
async function startServer(ctx) {
  const { Client, StdioClientTransport } = await loadSdk(ctx.opts.wt);
  const entry = path.join(ctx.opts.wt, 'entrypoint/agent-mcp/dist/src/index.js');
  if (!fs.existsSync(entry)) throw new Error(`built agent-mcp missing: ${entry} (run the nx build in the plan worktree)`);
  const store = path.join(ctx.runDir, 'store'); fs.mkdirSync(store, { recursive: true });
  const logs = path.join(ctx.runDir, 'logs');
  // pre-write the per-run srt policy so the allowlisted curl can reach example.com (operator-authored entries are preserved by provisionSrtPolicy)
  writeJson(path.join(ctx.runDir, 'srt-policy.json'), { network: { allowedDomains: [...SRT_EXTRA_DOMAINS], deniedDomains: [] } });
  const env = serverEnv(ctx, store, logs);
  const stderrFile = path.join(ctx.runDir, 'server.stderr.txt'); let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd: os.tmpdir(), stderr: 'pipe' });
  transport.stderr?.on('data', (d) => { stderr += d; });
  const client = new Client({ name: 'round2-driver', version: '1.0.0' }, { capabilities: {} });
  try { await client.connect(transport); } catch (e) { fs.writeFileSync(stderrFile, stderr); throw new Error(`agent-mcp failed to start: ${e.message}; stderr: ${stderr.slice(0, 800)}`); }
  if (transport.pid) owned.add(transport.pid);
  const calls = [];
  const call = async (name, args, timeoutMs = 120_000) => {
    const t0 = Date.now(); let r, thrown = null;
    try { r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }); } catch (e) { thrown = String(e.message || e); }
    const text = r ? textOf(r) : ''; const rec = { t: nowIso(), ms: Date.now() - t0, name, args, isError: !!r?.isError, thrown, text };
    calls.push(rec);
    return { text, json: tryJson(text), isError: !!r?.isError || !!thrown, thrown };
  };
  return { client, transport, call, calls, env, entry, stderrFile, getStderr: () => stderr, tools: (await client.listTools()).tools,
    close: async () => { try { await client.close(); } catch { /* ignore */ } fs.writeFileSync(stderrFile, stderr); writeJson(path.join(ctx.runDir, 'mcp-calls.json'), calls); } };
}

function providerFor(ctx, arm) {
  if (arm === 'B') return { type: 'claudecli', model: MODEL, claudePath: ctx.opts.claude, timeoutMs: 20 * 60 * 1000 };
  const p = { type: 'anthropic', model: MODEL, timeoutMs: 10 * 60 * 1000 };
  return p;
}
function agentDef(ctx, name, parent) {
  const def = { name, description: parent ? 'Round 2 parent agent' : 'Round 2 worker subagent', provider: providerFor(ctx, ctx.runDef.arm), systemPrompt: ctx.spec.systemPrompt, maxToolLoops: MAX_TOOL_LOOPS,
    nativeTooling: { fs: true, shell: { allowCommands: SHELL_ALLOW }, dispatch: true } };
  if (parent) def.mcpServers = { r2info: { transport: 'stdio', command: process.execPath, args: [path.join(HERE, 'info-server.mjs')], env: { R2_TICKET_FILE: ctx.ticketFile, R2_INFO_LOG: ctx.infoLog } } };
  return def;
}
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'awaiting_input', 'timeout', 'timed_out']);
async function waitTask(srv, taskId, deadlineMs) {
  const t0 = Date.now(); let last = null; const polls = [];
  for (;;) {
    const r = await srv.call('result', { task_id: taskId }, 60_000); last = r;
    const st = r.json?.status ?? null; polls.push(st);
    if (st && TERMINAL.has(st)) return { r, polls, timedOut: false, wallMs: Date.now() - t0 };
    if (Date.now() - t0 > deadlineMs) return { r, polls, timedOut: true, wallMs: Date.now() - t0 };
    await sleep(2500);
  }
}
async function runArmBC(ctx) {
  const arm = ctx.runDef.arm;
  const srv = await startServer(ctx);
  const res = { srv: null, phases: [], toolNames: srv.tools.map((t) => t.name), serverEnvNames: Object.keys(srv.env).sort() };
  try {
    const list = await srv.call('agent_list', {});
    const names = JSON.stringify(list.json ?? list.text);
    res.agentListShape = Array.isArray(list.json) ? 'array' : typeof list.json;
    const parentName = `r2-parent-${ctx.spec.runId}`;
    for (const [name, parent] of [['worker', false], [parentName, true]]) {
      const exists = names.includes(`"${name}"`) || names.includes(`\\"${name}\\"`);
      if (exists) { res.preexisting = (res.preexisting || []).concat(name); continue; }
      const c = await srv.call('agent_create', agentDef(ctx, name, parent)); if (c.isError) throw new Error(`agent_create ${name} failed: ${c.text.slice(0, 400)}`);
    }
    // the store must be the isolated one: the server reports it on stderr at startup
    res.storeLine = (srv.getStderr().match(/store=\S+\s+mode=\S+(?:\s+source=\S+)?/) || [null])[0];
    const s = await srv.call('agent', { name: parentName, cwd: ctx.repoDir }); const sessionId = s.json?.session_id; if (!sessionId) throw new Error(`agent (session) failed: ${s.text.slice(0, 300)}`);
    res.sessionId = sessionId;
    for (const phase of [1, 2]) {
      const prompt = phase === 1 ? ctx.prompts.phase1 : ctx.prompts.phase2;
      const t0 = Date.now();
      const t = await srv.call('task', { session_id: sessionId, prompt, background: true, cwd: ctx.repoDir }, 120_000);
      const taskId = t.json?.task_id; const ph = { phase, taskId, startMs: t0, submit: t.json ?? t.text };
      if (!taskId) { ph.harnessError = `task submit failed: ${t.text.slice(0, 300)}`; res.phases.push(ph); break; }
      const w = await waitTask(srv, taskId, PHASE_TIMEOUT_MS);
      ph.final = w.r.json ?? w.r.text; ph.status = w.r.json?.status ?? null; ph.polls = w.polls; ph.timedOut = w.timedOut; ph.wallMs = w.wallMs;
      if (ph.status !== 'completed') { const again = await srv.call('result', { task_id: taskId }, 60_000); ph.errorText = again.text.slice(0, 2000); }
      ph.hidden = runHidden(ctx.hiddenDir, ctx.repoDir, phase === 1 ? ['bugfix', 'feature'] : ['bugfix', 'feature', 'empty']); ph.files = repoFilesOf(ctx.repoDir);
      res.phases.push(ph);
      if (ph.status !== 'completed') break;
    }
    // accounting (read after the phases): subtree usage + task rows
    await sleep(1500);
    res.taskRows = []; res.usage = [];
    for (const ph of res.phases) if (ph.taskId) {
      res.usage.push({ phase: ph.phase, taskId: ph.taskId, byTask: (await srv.call('usage_query', { task_id: ph.taskId, grain: 'task' })).json ?? null, byTurn: (await srv.call('usage_query', { task_id: ph.taskId, grain: 'turn' })).json ?? null });
    }
    res.taskList = (await srv.call('task_list', { session_id: sessionId, limit: 200 })).json ?? null;
    res.allTasks = (await srv.call('task_list', { limit: 500 })).json ?? null;
  } finally {
    res.stderrTail = srv.getStderr().slice(-4000);
    await srv.close();
  }
  return res;
}

// ----------------------------------------------------------------------------------------------------------------
// Dry-run fakes
// ----------------------------------------------------------------------------------------------------------------
async function setupFakes(ctx) {
  const mode = ctx.opts.degraded || 'ideal';
  const state = path.join(ctx.work, 'fake-state'); fs.mkdirSync(state, { recursive: true });
  const shim = path.join(ctx.work, 'claude-shim.sh');
  fs.writeFileSync(shim, `#!/bin/sh\nexport R2_FAKE_STATE='${state}'\nexport R2_SDK_ROOT='${path.join(ctx.opts.wt, 'node_modules/@modelcontextprotocol/sdk/dist/esm')}'\nexport R2_FAKE_MODE='${mode}'\nexec '${process.execPath}' '${path.join(HERE, 'dryrun/fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
  ctx.opts = { ...ctx.opts, claude: shim };
  ctx.fakeEnv = {};
  ctx.fakeState = state;
  if (ctx.runDef.arm === 'C') {
    const { startFakeAnthropic } = await import(pathToFileURL(path.join(HERE, 'dryrun/fake-anthropic.mjs')).href);
    ctx.fake = await startFakeAnthropic({ mode, log: () => {} }); ctx.fakeAnthropicUrl = ctx.fake.url;
  }
}
async function teardownFakes(ctx) { if (ctx.fake) await ctx.fake.close(); }

// ----------------------------------------------------------------------------------------------------------------
// One run
// ----------------------------------------------------------------------------------------------------------------
async function prepare(ctx) {
  fs.mkdirSync(ctx.runDir, { recursive: true });
  const leaks = ancestorLeaks(ctx.work);
  if (leaks.length) throw new Error(`fixture directory sits under agent-instruction/repo files: ${leaks.join(', ')}`);
  ctx.expected = F.writeFixture({ repoDir: ctx.repoDir, hiddenDir: ctx.hiddenDir, ticketFile: ctx.ticketFile }, ctx.spec);
}

// ----------------------------------------------------------------------------------------------------------------
// HARD CAP: at most RUN_CAP (3) agent runs per round (parity/ledger.mjs; tracked per-round file, fail closed). Every live model-spawning path goes through rawRun().
/** Reserve one run BEFORE anything is spawned (delegates to ledger.reserveRun: approvedBy, A first, cap 3, extraRunReason for 4+). */
export function reserveModelRun(runId, { ledgerPath = LEDGER_PATH } = {}) {
  const round = path.basename(ledgerPath, '.json');
  return LG.reserveRun(round, { arm: String(runId)[0], runId, dir: path.dirname(ledgerPath) });
}
async function rawRun(ctx) {
  // The cap is enforced HERE, before the fixture is even written and before any process that could call a model is spawned.
  if (!ctx.dry) ctx.modelRun = reserveModelRun(ctx.spec.runId, { ledgerPath: ctx.ledgerPath ?? LEDGER_PATH });
  await prepare(ctx);
  if (ctx.dry) await setupFakes(ctx);
  try { return await (ctx.executor ?? (ctx.runDef.arm === 'A' ? runArmA : runArmBC))(ctx); }
  finally { if (ctx.dry) await teardownFakes(ctx); }
}

/** Idempotent resume: a run is finished only if its record exists and was NOT aborted (a pacing/cap abort wrote a record but ran nothing, and must be retried once the window resets). */
export function isFinishedRecord(recordPath) { try { const r = readJson(recordPath); return !r.aborted; } catch { return false; } }
/** Thinking invariant: ANY thinking block in ANY task of the run (parent or worker) while thinking is configured OFF invalidates the run. */
export function thinkingVerdict(metrics) {
  const parentTurns = (metrics.phases || []).reduce((a, m) => a + (m.thinkingTurns || 0), 0); const allTasks = metrics.thinkingBlocksAllTasks ?? 0;
  const n = Math.max(parentTurns, allTasks);
  return { configured: 'off', observedThinkingTurns: n, parentTurns, allTasks, ok: n === 0 };
}
/** Pacing gate: read the 5h/7d window via `claude -p /usage` (0 model calls, asserted by L.readUsageWindow). Refuses at session usage >= 60%, and fails CLOSED when the reading cannot be taken or parsed. */
export function gatePacing(read, rateLimitsSeen = []) {
  let reading;
  try { reading = read(); } catch (e) { return { ok: false, reading: null, verdict: { ok: false, reasons: [`/usage unreadable: ${String(e.message || e).slice(0, 200)}`], warnings: 0 } }; }
  if (!Number.isFinite(reading?.session_pct) || !Number.isFinite(reading?.week_pct)) return { ok: false, reading, verdict: { ok: false, reasons: ['/usage reading has no numeric session/week percentage'], warnings: 0 } };
  const verdict = L.pacingVerdict(reading, rateLimitsSeen);
  return { ok: verdict.ok, reading, verdict };
}


// ----------------------------------------------------------------------------------------------------------------
// Analysis (raw capture -> oracle observation + process metrics)
// ----------------------------------------------------------------------------------------------------------------
const CATEGORY = [['dispatch', /(^|__)(Agent|Task|agent|task)$/], ['shell', /(^|__)(Bash|shell_execute|shell)$/], ['edit', /(^|__)(Edit|edit_file)$/], ['write', /(^|__)(Write|write_file)$/], ['read', /(^|__)(Read|read_text_file|read_multiple_files|read_file)$/],
  ['search', /(^|__)(Glob|Grep|search_files|directory_tree|list_directory|list_allowed_directories)$/], ['mcp', /(^|__)get_ticket$/], ['web', /web_(fetch|search)|WebFetch|WebSearch/]];
const categoryOf = (name) => { const s = L.splitToolName(name); const base = s.server ? `${s.server}__${s.tool}` : s.tool; for (const [c, re] of CATEGORY) if (re.test(base) || re.test(s.tool)) return c; return 'other'; };
const tally = (calls) => { const t = {}; for (const c of calls) { const k = categoryOf(c.name); t[k] = (t[k] || 0) + 1; } return t; };
const rd = (x, n = 6) => Math.round(x * 10 ** n) / 10 ** n;
const sumUsd = (turns) => rd(turns.reduce((s, t) => s + t.usd, 0));

/** Analyse one claude stream-json phase (arm A directly; arm B per task from the API log). */
function cliPhase(events, { prior = null, perProcess = false } = {}) {
  const p = L.parseCliStream(events);
  // Arm A: the CLI's own modelUsage (parent + subagents), session-cumulative, is authoritative; the phase value is the increment over `prior`.
  // Arm B: every task is its own claude process (possibly several), so no cumulative arithmetic: scale to the last result's own output as before.
  const acc = perProcess ? null : L.cliPhaseAccounting(p.results, prior);
  const turns = L.reconcileCliOutput(L.turnsFromCliStream(p), perProcess ? p.result?.usage?.output_tokens : acc?.increment.out); const calls = L.callsFromCliStream(p);
  const parentTexts = p.assistantTexts.filter((t) => t.parent == null).map((t) => t.text);
  const r = p.result;
  const tools = p.init?.tools || [];
  return { p, acc, turns, calls, parentTexts, result: r, replyText: r ? String(r.result ?? '') : '', status: r ? (r.is_error ? 'failed' : 'completed') : 'failed',
    models: [...new Set([p.init?.model, ...Object.keys(r?.modelUsage || {}), ...turns.map((t) => t.model)].filter(Boolean))], tools,
    rate: p.rate.map(L.rateLimitFromCli), parallel: L.parallelFromCliEvents(events) };
}
function totalsOf(turns) { return L.sumNorm(turns); }

/** Run-level call list for the detectors (parent AND worker calls, tool_use ids, phase, depth); results capped like the observation's. */
function trimCalls(calls) { return calls.map((c) => ({ ...c, resultText: c.resultText == null ? null : String(c.resultText).slice(0, 600) })); }

function analyzeA(ctx, raw) {
  const e = ctx.expected; const obs = { arm: 'A', rep: ctx.spec.rep, phase1: null, phase2: null, hidden: { p1: {}, p2: {} }, files: {}, capabilities: {}, models: [], cache: {}, dispatch: {}, attr: null };
  const metrics = { phases: [], warnings: [] };
  const ph = [null, null]; let prior = null;
  raw.phases.forEach((pr, i) => {
    const a = cliPhase(pr.events, { prior }); ph[i] = a; if (a.acc) prior = a.acc.cumulative;
    const parentTurns = a.turns.filter((t) => t.parent == null), childTurns = a.turns.filter((t) => t.parent != null);
    // CLI total_cost_usd / modelUsage are session-cumulative: the phase cost is the increment over the previous phase.
    const cli = a.acc?.increment.usd ?? null; const recompute = sumUsd(a.turns);
    const diff = cli != null && recompute ? Math.abs(cli - recompute) / cli : null;
    if (cli != null && cli < 0) metrics.warnings.push(`phase ${i + 1}: CLI cost increment ${cli} is negative (cumulative assumption violated)`);
    if (diff != null && diff > 0.02) metrics.warnings.push(`phase ${i + 1}: CLI cost increment ${rd(cli)} vs tier-aware recompute ${recompute} (${rd(diff * 100, 1)}% apart)`);
    if (!a.result) metrics.warnings.push(`phase ${i + 1}: no result event (exit ${pr.code}, signal ${pr.sig}, timedOut ${pr.timedOut})`);
    const tot = totalsOf(a.turns);
    for (const w of L.tierAssertion('A', tot, totalsOf(parentTurns))) metrics.warnings.push(`phase ${i + 1}: ${w}`);
    metrics.phases.push({ phase: i + 1, sessionId: pr.sid, wallMs: pr.wallMs, exit: pr.code, turns: { parent: parentTurns.length, child: childTurns.length }, calls: { total: a.calls.length, byCategory: tally(a.calls), ...L.callMetrics(a.calls, {}, i + 1) },
      childCalls: L.callMetrics([...a.p.toolUses.values()].filter((t) => t.parent != null).map((t) => ({ name: t.name, input: t.input, isError: (a.p.toolResults.get(t.id) || {}).isError ?? null, resultText: (a.p.toolResults.get(t.id) || {}).text ?? null })), {}, i + 1).total,
      tokens: { parent: totalsOf(parentTurns), child: totalsOf(childTurns), total: tot }, costUsd: { parent: sumUsd(parentTurns), child: sumUsd(childTurns), total: recompute, cliReported: cli, cliCumulative: a.acc?.cumulative.usd ?? null, authoritative: cli ?? recompute, source: cli != null ? 'claude CLI total_cost_usd increment' : 'tier-aware recompute' },
      firstTurnContext: parentTurns[0]?.ctx ?? null, stopReasons: [...new Set(a.turns.map((t) => t.stop).filter(Boolean))], resultStop: a.result?.stop_reason ?? null, numTurnsCli: a.result?.num_turns ?? null, thinkingTurns: a.turns.filter((t) => t.thinkingBlock).length,
      parallel: a.parallel, rate: a.rate.filter(Boolean).slice(-1)[0] ?? null, errorText: a.status === 'failed' ? String(a.result?.result ?? pr.stderr).slice(0, 500) : null, denials: a.p.denials.length });
  });
  const mkPhase = (i) => ph[i] ? { status: ph[i].status, replyText: ph[i].replyText, assistantTexts: ph[i].parentTexts, calls: ph[i].calls, harnessError: null } : { status: 'not_run', replyText: '', assistantTexts: [], calls: [], harnessError: null };
  obs.phase1 = mkPhase(0); obs.phase2 = mkPhase(1);
  obs.hidden.p1 = { bugfix: raw.phases[0]?.hidden?.bugfix ?? null, feature: raw.phases[0]?.hidden?.feature ?? null, visible: raw.phases[0]?.hidden?.visible ?? null };
  obs.hidden.p2 = { bugfix: raw.phases[1]?.hidden?.bugfix ?? null, feature: raw.phases[1]?.hidden?.feature ?? null, empty: raw.phases[1]?.hidden?.empty ?? null, visible: raw.phases[1]?.hidden?.visible ?? null };
  obs.files = { 'docs/shipping.md': raw.phases[0]?.files?.['docs/shipping.md'] ?? null, 'CHANGELOG.md': raw.phases[0]?.files?.['CHANGELOG.md'] ?? null, 'src/checkout.js': raw.phases[0]?.files?.['src/checkout.js'] ?? null, 'src/summary.js': raw.phases[0]?.files?.['src/summary.js'] ?? null, 'examples/usage.md': raw.phases[1]?.files?.['examples/usage.md'] ?? null };
  obs.capabilities = webCapability('A', ph[0]?.tools || []);
  obs.models = [...new Set(ph.filter(Boolean).flatMap((a) => a.models))];
  // R1.AC2 (90758419 AC1): cache-carry inputs (phase-1 last parent turn cache_read + cache_create; phase-2 first parent turn cache_read).
  obs.cache = { firstTurnCacheRead: ph[0]?.turns.find((t) => t.parent == null)?.cr ?? null, gapSeconds: null, ...(ph[0] && ph[1] ? L.cacheCarryFromTurns(ph[0].turns, ph[1].turns) : {}) };
  // R1.AC6 (90758419 AC3): arm A parallelism by outcome (interleaved child event streams); native Agent returns instantly so the outstanding-counter alone cannot see it.
  const ci = ph[0] ? L.childrenInterleavedFromEvents(raw.phases[0].events || []) : null;
  obs.dispatch = { p1Workers: ph[0]?.parallel.runs ?? 0, p1Grandchildren: null, p2Workers: ph[1]?.parallel.runs ?? 0, p1Parallel: ph[0] ? { sameTurn: ph[0].parallel.sameTurn, overlapMs: null, interleaved: ci.interleaved, interleaveBasis: ci.basis, children: ci.children } : null };
  metrics.allCalls = trimCalls(ph.flatMap((a, i) => a ? L.allCallsFromCliStream(a.p).map((c) => ({ ...c, phase: i + 1 })) : []));
  if (ph[0]) { const parentOnly = sumUsd(ph[0].turns.filter((t) => t.parent == null)); obs.attr = { kind: 'native', childTurns: ph[0].turns.filter((t) => t.parent != null).length, cliCostUsd: ph[0].acc?.increment.usd ?? 0, parentOnlyUsd: parentOnly }; }
  metrics.thinkingBlocksAllTasks = ph.filter(Boolean).reduce((a, x) => a + x.turns.filter((t) => t.thinkingBlock).length, 0);   // parent + native subagent turns
  metrics.rateLimits = ph.filter(Boolean).flatMap((a) => a.rate).filter(Boolean);
  metrics.initTools = ph[0]?.tools ?? [];
  metrics.phase2Evidence = { resumeInit: raw.phases[1]?.init ? { session_id: raw.phases[1].init.session_id, sameSession: raw.phases[1].init.session_id === raw.sid } : null };
  return { obs, metrics };
}

/** Can this arm fetch a page at all? A web tool in its tool list, or (A) an unrestricted Bash, or a shell allowlist that admits curl/wget (B/C: SHELL_ALLOW). */
function webCapability(arm, tools) {
  // R3.AC4: no arm is exempt. w1_web is scored for every arm (web:true => scored); an arm that cannot fetch as shipped fails it
  // and the record carries webFinding "arm cannot fetch" (a product finding, not an instrument defect).
  const names = tools.map(String);
  const canFetch = names.some((t) => /(^|__)(web_fetch|WebFetch)$/.test(t)) || (WEB_SURFACE[arm]?.tools ?? []).some((t) => /^(web_fetch|WebFetch)$/.test(t));
  return { web: true, webVia: canFetch ? 'tool' : null, canFetch, webSurface: [...new Set([...(WEB_SURFACE[arm]?.tools ?? []), ...names.filter((t) => /(web_|Web)/.test(t))])] };
}
const rowsOf = (j) => (Array.isArray(j?.rows) ? j.rows : []);
function analyzeBC(ctx, raw) {
  const arm = ctx.runDef.arm; const e = ctx.expected;
  const obs = { arm, rep: ctx.spec.rep, phase1: null, phase2: null, hidden: { p1: {}, p2: {} }, files: {}, capabilities: {}, models: [], cache: {}, dispatch: {}, attr: null };
  const metrics = { phases: [], warnings: [] };
  const api = L.findApiLogs(path.join(ctx.runDir, 'logs'));
  metrics.thinkingBlocksAllTasks = L.thinkingBlocksInApiLogs(api);        // parent AND every worker/grandchild task
  const tasks = Array.isArray(raw.allTasks) ? raw.allTasks : Array.isArray(raw.taskList) ? raw.taskList : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kids = (id) => tasks.filter((t) => t.parentTaskId === id);
  const descendants = (id) => { const out = []; const st = [id]; while (st.length) { const x = st.pop(); for (const k of kids(x)) { out.push(k); st.push(k.id); } } return out; };
  const streamFor = (taskId) => {
    if (arm === 'B') { const c = L.cliEventsForTask(api, taskId); const a = cliPhase(c.events, { perProcess: true }); return { ...a, truncated: c.truncated, spawns: c.spawns, spawn: c.spawn, stdin: api.filter((x) => x.event === 'spawn.stdin' && x.task_id === taskId).map((x) => x.body) }; }
    const http = L.httpTurnsForTask(api, taskId);
    const turns = http.map((t, i) => { const n = L.normUsage(t.sse?.usage); return { idx: i + 1, id: t.sse?.id, parent: null, model: t.sse?.model, ...n, stop: t.sse?.stop, tools: (t.sse?.toolUses || []).map((u) => u.name), thinkingBlock: !!t.sse?.thinking, usd: L.priceNorm(n).usd }; });
    const calls = L.callsFromHttpTurns(http);
    return { http, turns, calls, parentTexts: http.flatMap((t) => t.sse?.texts || []), replyText: [...(http[http.length - 1]?.sse?.texts || [])].join('\n'), status: 'completed', models: [...new Set(http.map((t) => t.sse?.model).filter(Boolean))],
      tools: (http[0]?.body?.tools || []).map((t) => t.name || t.type), rate: http.map((t) => L.rateLimitFromHeaders(t.headers)), parallel: L.parallelFromHttpTurns(http), stopReasons: http.map((t) => t.sse?.stop), reqTruncated: http.some((t) => t.truncatedReq || t.truncatedResp) };
  };
  const ph = [null, null]; const allCalls = [];
  raw.phases.forEach((pr, i) => {
    if (!pr.taskId) return;
    const root = pr.taskId; const kidsRows = descendants(root);
    const s = streamFor(root); ph[i] = s;
    const childStreams = kidsRows.map((k) => ({ task: k, s: streamFor(k.id) }));
    allCalls.push(...s.calls.map((c) => ({ ...c, phase: i + 1, depth: 0 })), ...childStreams.flatMap((cs) => cs.s.calls.map((c) => ({ ...c, phase: i + 1, depth: cs.task.recursionDepth ?? 1 }))));
    const rows = rowsOf(raw.usage?.[i]?.byTask); const parentRow = rows.find((r) => r.task_id === root);
    const direct = parentRow ? parentRow.input_tokens + parentRow.output_tokens : null; const sum = raw.usage?.[i]?.byTask?.summary;
    const parentTurns = s.turns; const childTurnsAll = childStreams.flatMap((c) => c.s.turns);
    const totalTurns = [...parentTurns, ...childTurnsAll];
    const tot = totalsOf(totalTurns);
    for (const w of L.tierAssertion(arm, tot)) metrics.warnings.push(`phase ${i + 1}: ${w}`);
    if (!parentRow) pr.harnessError = pr.harnessError || `no usage row for task ${root} (a missing row is a harness error)`;
    if (s.truncated || s.reqTruncated) metrics.warnings.push(`phase ${i + 1}: API-log bodies were truncated`);
    const firstUsage = rows.find((r) => r.task_id === root)?.first_turn ?? null;
    const calls = s.calls; const runCalls = calls.filter((c) => L.isRunName(c.name));
    const rowsUsd = sum?.est_cost_usd ?? null;
    metrics.phases.push({ phase: i + 1, taskId: root, status: pr.status, wallMs: pr.wallMs, polls: pr.polls?.length, errorText: pr.errorText ?? null,
      turns: { parent: parentTurns.length, child: childTurnsAll.length }, calls: { total: calls.length, byCategory: tally(calls), ...L.callMetrics(calls, {}, i + 1), runCalls: runCalls.length },
      tokens: { parent: totalsOf(parentTurns), child: totalsOf(childTurnsAll), total: tot },
      costUsd: { parent: sumUsd(parentTurns), child: sumUsd(childTurnsAll), total: sumUsd(totalTurns), authoritative: sumUsd(totalTurns), repoEstimate: rowsUsd, cliReportedParent: parentRow?.cli_reported_cost_usd ?? null },
      firstTurnContext: parentTurns[0]?.ctx ?? null, firstTurnFromUsageQuery: firstUsage, stopReasons: [...new Set(parentTurns.map((t) => t.stop).filter(Boolean))],
      subtree: { taskCount: sum?.row_count ?? null, directTokens: direct, subtreeTokens: sum ? sum.input_tokens + sum.output_tokens : null, rootTaskIdOnRows: rows.map((r) => r.root_task_id) },
      children: kidsRows.map((k) => ({ id: k.id, parent: k.parentTaskId, depth: k.recursionDepth, status: k.status, createdAt: k.createdAt, completedAt: k.completedAt })),
      parallel: s.parallel, rate: s.rate.filter(Boolean).slice(-1)[0] ?? null, thinkingTurns: parentTurns.filter((t) => t.thinkingBlock).length, reasoningTokensRepo: parentRow?.reasoning_tokens ?? null, stdinBytes: (s.stdin || []).map((b) => b.length),
      childFailures: childStreams.filter((c) => c.task.status !== 'completed').map((c) => ({ id: c.task.id, status: c.task.status })) });
  });
  const mk = (i) => { const pr = raw.phases[i]; if (!pr) return { status: 'not_run', replyText: '', assistantTexts: [], calls: [], harnessError: null };
    return { status: pr.status ?? 'failed', replyText: String(pr.final?.result ?? ph[i]?.replyText ?? ''), assistantTexts: ph[i]?.parentTexts ?? [], calls: ph[i]?.calls ?? [], harnessError: pr.harnessError ?? null }; };
  obs.phase1 = mk(0); obs.phase2 = mk(1);
  obs.hidden.p1 = { bugfix: raw.phases[0]?.hidden?.bugfix ?? null, feature: raw.phases[0]?.hidden?.feature ?? null, visible: raw.phases[0]?.hidden?.visible ?? null };
  obs.hidden.p2 = { bugfix: raw.phases[1]?.hidden?.bugfix ?? null, feature: raw.phases[1]?.hidden?.feature ?? null, empty: raw.phases[1]?.hidden?.empty ?? null, visible: raw.phases[1]?.hidden?.visible ?? null };
  obs.files = { 'docs/shipping.md': raw.phases[0]?.files?.['docs/shipping.md'] ?? null, 'CHANGELOG.md': raw.phases[0]?.files?.['CHANGELOG.md'] ?? null, 'src/checkout.js': raw.phases[0]?.files?.['src/checkout.js'] ?? null, 'src/summary.js': raw.phases[0]?.files?.['src/summary.js'] ?? null, 'examples/usage.md': raw.phases[1]?.files?.['examples/usage.md'] ?? null };
  obs.capabilities = webCapability(arm, ph[0]?.tools || []);
  const respModels = [...new Set(raw.usage?.flatMap((u) => rowsOf(u.byTask).map((r) => r.response_model)).filter(Boolean))];
  obs.models = [...new Set([...respModels, ...ph.filter(Boolean).flatMap((s) => s.models)])];
  const first = ph[0]; const firstTurn = first?.turns[0];
  // R1.AC2 (90758419 AC1): B = cache numbers of the root-task streams; C = does the first phase-2 request contain the phase-1 get_ticket result (the cache fields stay unset for C so the oracle scores it on the request rule).
  obs.cache = { firstTurnCacheRead: firstTurn?.cr ?? null, gapSeconds: null, ...(arm === 'B' && ph[0] && ph[1] ? L.cacheCarryFromTurns(ph[0].turns, ph[1].turns) : {}), ...(arm === 'C' && ph[0] && ph[1] ? { phase2FirstRequestHasTicket: L.ticketCarriedToPhase2(ph[0].http, ph[1].http) } : {}) };
  metrics.allCalls = trimCalls(allCalls);
  const p1 = metrics.phases[0]; const p2 = metrics.phases[1];
  const depth1 = (p1?.children || []).filter((c) => c.depth === 1), depth2 = (p1?.children || []).filter((c) => c.depth >= 2);
  const ov = L.overlapMs(depth1.map((c) => ({ createdAt: c.createdAt, completedAt: c.completedAt })));
  obs.dispatch = { p1Workers: depth1.length, p1Grandchildren: depth2.length, p2Workers: (p2?.children || []).filter((c) => c.depth === 1).length, p1Parallel: first ? { sameTurn: first.parallel.sameTurn, overlapMs: ov } : null };
  if (p1) obs.attr = { kind: 'tree', taskCount: p1.subtree.taskCount, directTotal: p1.subtree.directTokens, subtreeTotal: p1.subtree.subtreeTokens, rootTaskId: null, childRows: (p1.children || []).map((c) => ({ parentTaskId: c.parent, depth: c.depth })) };
  metrics.rateLimits = ph.filter(Boolean).flatMap((s) => s.rate).filter(Boolean);
  metrics.initTools = first?.tools ?? [];
  metrics.toolNamesServer = raw.toolNames;
  metrics.phase2Evidence = { stdin: ph[1]?.stdin ?? null, sessionId: raw.sessionId, storeLine: raw.storeLine };
  metrics.warnings.push(...(raw.preexisting ? [`agents pre-existed in the isolated store: ${raw.preexisting}`] : []));
  return { obs, metrics };
}

// ----------------------------------------------------------------------------------------------------------------
// One full run
// ----------------------------------------------------------------------------------------------------------------
function envReport(ctx) {
  const gitSha = spawnSync('git', ['-C', ctx.opts.wt, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  const ver = ctx.dry ? 'fake' : spawnSync(ctx.opts.claude, ['--version'], { encoding: 'utf8', env: L.cleanEnv() }).stdout?.trim();
  return { node: process.version, claudeVersion: ver, agentMcpSha: gitSha, loadavg: os.loadavg(), platform: `${os.platform()} ${os.release()}` };
}
async function runOne(ctx, state) {
  const arm = ctx.runDef.arm;
  const record = { runId: ctx.spec.runId, arm, rep: ctx.spec.rep, mode: ctx.dry ? 'dry-run' : 'live', seed: ctx.opts.seed, startedAt: nowIso(), env: envReport(ctx), config: effectiveConfig(ctx), warnings: [] };
  // pacing: /usage is a local command (0 model calls, asserted); status from the rate-limit events/headers seen so far
  const usageReading = () => ctx.dry && !process.env.R2_DRY_REAL_USAGE ? { session_pct: 0, week_pct: 0, resets: null, model_calls: 0, at: nowIso(), stubbed: true } : L.readUsageWindow({ claude: ctx.dry ? (ctx.opts.realClaude || 'claude') : ctx.opts.claude, model: MODEL });
  const gate = gatePacing(usageReading, state.rateLimitsSeen);
  record.pacing = { before: gate.reading, verdict: gate.verdict };
  const verdict = gate.verdict;
  if (!verdict.ok && !ctx.dry) { record.aborted = verdict.reasons; writeJson(path.join(ctx.runDir, 'record.json'), record); return { record, aborted: true }; }
  if (!verdict.ok && ctx.dry) record.warnings.push(`pacing would abort a live run: ${verdict.reasons.join('; ')}`);
  const fp0 = fingerprint(PROD_ROOT); const t0 = Date.now();
  let raw, analysis;
  try {
    raw = await rawRun(ctx);
    analysis = arm === 'A' ? analyzeA(ctx, raw) : analyzeBC(ctx, raw);
  } catch (e) {
    if (e instanceof ModelRunCapError) { record.aborted = [e.message]; writeJson(path.join(ctx.runDir, 'record.json'), record); return { record, aborted: true }; }
    record.harnessFailure = String(e.stack || e);
  }
  record.wallMs = Date.now() - t0; record.finishedAt = nowIso();
  record.sweep = await sweepOwned(`after ${ctx.spec.runId}`);
  if (analysis) {
    const { obs, metrics } = analysis;
    obs.cache.gapSeconds = ctx.gapSeconds ?? null;
    record.observation = { ...obs, phase1: { ...obs.phase1, calls: obs.phase1.calls.map((c) => ({ ...c, resultText: (c.resultText || '').slice(0, 600) })) }, phase2: { ...obs.phase2, calls: obs.phase2.calls.map((c) => ({ ...c, resultText: (c.resultText || '').slice(0, 600) })) } };
    record.score = O.scoreObservation(obs, ctx.expected);
    record.metrics = metrics; record.warnings.push(...metrics.warnings);
    // thinking invariant: thinking is configured OFF on every arm; any thinking block observed means the equalisation did not hold => the run is INVALID (not scored as an arm result)
    record.thinkingInvariant = thinkingVerdict(metrics);
    record.webSurface = obs.capabilities?.webSurface ?? null;
    if (obs.capabilities && obs.capabilities.canFetch === false) record.webFinding = 'arm cannot fetch';
    if (!record.thinkingInvariant.ok) record.invalidRun = [`thinking blocks observed (${record.thinkingInvariant.observedThinkingTurns}, parent turns ${record.thinkingInvariant.parentTurns}, all tasks ${record.thinkingInvariant.allTasks}) while thinking is configured OFF on every arm`];
    state.rateLimitsSeen.push(...(metrics.rateLimits || []).slice(-2));
    if (raw.storeLine && /mode=production/.test(raw.storeLine)) record.warnings.push(`SERVER REPORTS PRODUCTION STORE: ${raw.storeLine}`);
  }
  if (ctx.dry) {
    const blocked = readIf(path.join(ctx.runDir, 'egress-blocked.log'));
    const urls = [...new Set(L.findApiLogs(path.join(ctx.runDir, 'logs')).filter((x) => x.event === 'http.request').map((x) => String(x.url)))];
    // The server also makes non-model housekeeping calls (model price catalog). The guard refuses it; it is recorded as info. Anything else non-loopback (above all a model endpoint) is a breach.
    const HOUSEKEEPING = /^(openrouter\.ai)$/;   // refused by the guard; the pip index is allowed by it and never reaches the log
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u); } };
    const blockedHosts = blocked ? [...new Set(blocked.trim().split('\n').map((l) => l.split(' BLOCKED ')[1]))] : [];
    const foreign = [...urls.map(hostOf), ...blockedHosts].filter((h) => h && h !== '127.0.0.1' && !HOUSEKEEPING.test(h));
    record.dryRunEgress = { blockedHosts, httpRequestUrls: urls, breach: [...new Set(foreign)] };
    if (foreign.length) { record.warnings.push(`DRY-RUN EGRESS BREACH: ${JSON.stringify(record.dryRunEgress)}`); state.breach = true; }
  }
  const fp1 = fingerprint(PROD_ROOT);
  const attributable = productionTouches(PROD_ROOT, t0 - 1000, [ctx.work, `r2-parent-${ctx.spec.runId}`, ctx.runDir]);
  record.productionStore = { before: fp0, after: fp1, unchanged: fp0.sha256 === fp1.sha256, attributableTouches: attributable };
  if (attributable.length) record.warnings.push(`PRODUCTION STORE TOUCHED by this run: ${attributable.join(', ')}`);
  else if (!record.productionStore.unchanged) record.productionStore.note = 'fingerprint changed but nothing in it mentions this run: concurrent activity by the owner or other agents';
  try { record.pacing.after = state.skipAfter ? null : usageReading(); } catch (e) { record.pacing.after = null; record.warnings.push(`post-run /usage reading failed: ${String(e.message).slice(0, 160)}`); }
  record.secretScan = { runDir: L.scanAndLock(ctx.runDir), work: L.scanAndLock(ctx.work) };
  if (record.secretScan.runDir.hits.length) record.warnings.push(`secret-shaped strings redacted in saved logs: ${JSON.stringify(record.secretScan.runDir.hits)}`);
  record.expected = { ...ctx.expected, original: undefined };
  writeJson(path.join(ctx.runDir, 'record.json'), record);
  return { record, aborted: false };
}
function effectiveConfig(ctx) {
  return { model: MODEL, maxToolLoops: arm0(ctx) === 'A' ? 'n/a (claude 2.1.296 has no --max-turns; guard --max-budget-usd ' + BUDGET_GUARD_USD + ')' : MAX_TOOL_LOOPS, budgetMaxCalls: arm0(ctx) === 'A' ? 'n/a' : 0, shellAllow: arm0(ctx) === 'A' ? 'unrestricted Bash (bypassPermissions)' : SHELL_ALLOW, toolResultCap: arm0(ctx) === 'A' ? 'native (<=30k chars inline)' : 'agent-mcp default (6000 chars, head 75% / tail 25%)', providerTimeoutMs: arm0(ctx) === 'B' ? 1_200_000 : arm0(ctx) === 'C' ? 600_000 : `n/a (claude CLI; ${PHASE_TIMEOUT_MS} ms phase timeout)`, queueConcurrency: 'agent-mcp default', maxDepth: 'agent-mcp default (3)', thinking: `OFF: ${THINKING_MECHANISM[arm0(ctx)]}`, thinkingEnv: arm0(ctx) === 'C' ? {} : { ...THINKING_OFF_ENV }, phaseTimeoutMs: PHASE_TIMEOUT_MS };
}
const arm0 = (ctx) => ctx.runDef.arm;

// ----------------------------------------------------------------------------------------------------------------
// Plan, summary, modes
// ----------------------------------------------------------------------------------------------------------------
/**
 * The seeded, randomised serial order of ALL 6 runs (2 per arm). Arms are shuffled with the seeded PRNG; within an arm the repetitions keep
 * their order (rep 1 before rep 2) so rep 1 is the cold run and rep 2 the warm one by construction. Deterministic in `seed` only.
 */
/** One run per arm (section 3): A first, then B and C; B and C alternate order between rounds (ledger.armOrderFor). */
export function buildPlan(opts) {
  const idx = Number.parseInt(String(opts.round ?? ROUND).replace(/[^0-9]/g, ''), 10) || 0;
  return LG.armOrderFor(idx).map((arm, i) => ({ arm, rep: 1, position: i + 1 }));
}
const fmtUsd = (x) => x == null ? '-' : `$${x.toFixed(4)}`;
function summaryRows(records) {
  return records.filter((r) => r.score).map((r) => {
    const s = r.score.summary; const m = r.metrics?.phases || [];
    const sum = (f) => m.reduce((a, p) => a + (f(p) || 0), 0);
    return { run: r.runId, pass: s.pass, fail: s.fail, na: s.na, invalid: s.invalid, content: `${s.content.pass}/${s.content.total}`, process: `${s.process.pass}/${s.process.total}`, format: `${s.format.pass}/${s.format.total}`,
      calls: sum((p) => p.calls?.total), turns: sum((p) => (p.turns?.parent || 0) + (p.turns?.child || 0)), costUsd: sum((p) => p.costUsd?.authoritative ?? p.costUsd?.total), costRecompute: sum((p) => p.costUsd?.total), thinking: r.config?.thinking ?? null, providerTimeout: r.config?.providerTimeoutMs ?? null, resultCap: r.config?.toolResultCap ?? null, thinkingTurns: sum((p) => p.thinkingTurns), firstTurnCtx: m[0]?.firstTurnContext ?? null,
      cacheReadP1: m[0]?.tokens?.total?.cr ?? null, wallS: Math.round((r.wallMs || 0) / 1000), warnings: r.warnings.length };
  });
}
function writeSummary(outDir, records, plan) {
  const rows = summaryRows(records);
  const md = ['# Round run summary', '', `Runs recorded: ${records.length} of ${plan.length}`, '', '| run | pass | fail | na | invalid | content | process | format | calls | turns | cost (authoritative) | first-turn ctx | cache_read tok (phase 1) | wall s | warnings |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.run} | ${r.pass} | ${r.fail} | ${r.na} | ${r.invalid} | ${r.content} | ${r.process} | ${r.format} | ${r.calls} | ${r.turns} | ${fmtUsd(r.costUsd)} | ${r.firstTurnCtx ?? '-'} | ${r.cacheReadP1 ?? '-'} | ${r.wallS} | ${r.warnings} |`), ''];
  md.push('## Effective config per run (thinking equalised: OFF on every arm)', '', '| run | thinking (config) | thinking turns observed | provider / phase timeout (ms) | tool-result cap |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.run} | ${r.thinking} | ${r.thinkingTurns} | ${r.providerTimeout} | ${r.resultCap} |`), '');
  for (const r of records.filter((x) => x.score)) {
    md.push(`## ${r.runId}`, '', '| field | status | detail |', '|---|---|---|', ...Object.entries(r.score.fields).map(([k, v]) => `| ${k} | ${v.status} | ${String(v.detail).replace(/\|/g, '/').slice(0, 140)} |`), '');
    if (r.warnings.length) md.push('Warnings:', ...r.warnings.map((w) => `- ${w}`), '');
  }
  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), md.join('\n')); writeJson(path.join(outDir, 'summary.json'), { rows, plan });
  return rows;
}

/** Run every detector over the run's normalized tool calls; a DEFECT_SIGNAL or egress-silent-empty result is written to the record (R2.AC8, R6). */
function annotateDetectors(record) {
  const ob = record.observation; if (!ob) return;
  // Run-level calls (parent AND worker/child calls) from the analysis; observation calls (parent/root only) for records that lack them.
  // Real call fields (lib.callsFromCliStream / callsFromHttpTurns): { id (tool_use id), name, input, isError (null = no result captured), resultText, seq }.
  const src = record.metrics?.allCalls?.length ? record.metrics.allCalls : [...(ob.phase1?.calls ?? []).map((c) => ({ ...c, phase: 1 })), ...(ob.phase2?.calls ?? []).map((c) => ({ ...c, phase: 2 }))];
  const calls = src.map((c, i) => ({ id: c.id ?? `p${c.phase ?? 0}c${c.seq ?? i}`, tool: c.name ?? '', args: c.input ?? null, isError: c.isError == null ? null : !!c.isError, text: c.resultText ?? null }));
  record.detectors = DT.runDetectors(calls);
  const eg = record.detectors.find((d) => d.detector === 'egress-silent-empty');
  if (eg?.flagged && record.score?.fields?.w1_web) {
    record.score.fields.w1_web = { ...record.score.fields.w1_web, status: 'invalid', detail: `INVALID(egress): blank web result(s) ${eg.callIds.join(', ')}` };
    record.score.summary = O.summarizeFields(record.score.fields);   // the override must reach the tally GT.isGenuineSuccess / grid read
  }
  if (record.detectors.some((d) => d.defectSignal)) record.defectSignal = record.detectors.filter((d) => d.defectSignal).map((d) => d.text);
}

// ----------------------------------------------------------------------------------------------------------------
// R5 judge wiring. PAID THIRD-PARTY CALL (claude-haiku-4-5), live rounds only, through an INJECTED client (opts.judgeClient); owner: see judge.mjs header.
// ----------------------------------------------------------------------------------------------------------------
/** Unified diff of the arm's final repo against the pristine scenario (R5.AC1(b)); paths are neutral `a/` `b/`. Pure file work + `git diff --no-index` (no model, no network). */
export function repoDiff(spec, repoDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-diff-'));
  try {
    for (const [rel, content] of Object.entries(F.repoFiles(spec))) { const p = path.join(root, 'a', rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
    fs.cpSync(repoDir, path.join(root, 'b'), { recursive: true, filter: (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src) });
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', 'a', 'b'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed (${r.status}): ${String(r.stderr).slice(0, 200)}`);
    return r.stdout;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
/** Transcript turns for the judge: per phase the prompt, the assistant's texts, every tool call (parent and worker) with its result, then the final reply. Text/call interleaving is not preserved by the capture. */
export function transcriptFor(record, prompts) {
  const ob = record.observation; const out = []; const all = record.metrics?.allCalls ?? [];
  for (const [i, ph] of [[1, ob.phase1], [2, ob.phase2]]) {
    out.push({ role: 'user', text: i === 1 ? prompts.phase1 : prompts.phase2 });
    for (const t of ph.assistantTexts ?? []) out.push({ role: 'assistant', text: t });
    const calls = all.some((c) => c.phase === i) ? all.filter((c) => c.phase === i) : (ph.calls ?? []);
    for (const c of calls) out.push({ role: 'assistant', text: `${(c.depth ?? 0) > 0 ? '[worker] ' : ''}${JSON.stringify(c.input ?? {}).slice(0, 1500)}`, tool: c.name, result: c.resultText ?? '' });
    out.push({ role: 'assistant', text: ph.replyText ?? '' });
  }
  return out;
}
/** A deterministic fake judge client for dry-runs (no model, no network): every quality scores 80. */
export function fakeJudgeClient() {
  const scores = Object.fromEntries(QL.RUBRIC.map((k) => [k, 80])), notes = Object.fromEntries(QL.RUBRIC.map((k) => [k, 'fake judge (dry-run)']));
  return { async complete() { return { text: JSON.stringify({ scores, notes }), inputTokens: 0, outputTokens: 0 }; } };
}
/**
 * Judge ONE finished run (R5.AC6-AC8): eligible only if arm A and this arm genuinely succeeded; the per-round judge cap is checked BEFORE the paid call;
 * the call is logged in the ledger (live only) and the raw record is written to <judgeDir>/<arm>.json. Sets record.quality; never throws.
 */
export async function judgeRun({ ctx, record, aGenuine, dry, client, judgeDir }) {
  const arm = record.arm; const genuine = GT.isGenuineSuccess(record);
  if (!JG.judgeEligible({ aGenuine, armGenuine: genuine })) { record.quality = { status: 'n/a', reason: aGenuine ? 'arm not a genuine success (no judge call)' : 'arm A not a genuine success (no judge call)' }; return record.quality; }
  const ledgerDir = path.dirname(ctx.ledgerPath); const round = path.basename(ctx.ledgerPath, '.json');
  if (!dry) { const used = LG.readLedger(round, ledgerDir).judgeCalls.length; if (used >= LG.JUDGE_CAP) { record.quality = { status: 'n/a', reason: `judge-call cap ${used}/${LG.JUDGE_CAP} reached: no paid call made` }; return record.quality; } }
  try {
    const { brief, briefSha, label } = JG.buildBrief({ prompts: ctx.prompts, ticketText: F.ticketText(ctx.spec), diff: repoDiff(ctx.spec, ctx.repoDir), transcript: transcriptFor(record, ctx.prompts) });
    const res = await JG.runJudge({ client, arm, brief, briefSha, outDir: judgeDir, onCall: dry ? undefined : (c) => LG.recordJudgeCall(round, c, { dir: ledgerDir }) });
    record.quality = res.ok ? { status: 'scored', mean: QL.qualityMean(res.scores), scores: res.scores, briefSha, modelId: JG.JUDGE_MODEL, label, file: path.join(judgeDir, `${arm}.json`) } : { status: 'judge-error', code: res.code, briefSha, file: path.join(judgeDir, `${arm}.json`) };
  } catch (e) { record.quality = { status: 'judge-failed', error: String(e?.message ?? e).slice(0, 300) }; }
  return record.quality;
}

async function runPlan(opts, dry) {
  const plan = buildPlan(opts);
  fs.mkdirSync(opts.out, { recursive: true });
  const state = { rateLimitsSeen: [], lastFinished: {}, aGenuine: false };
  const judgeDir = dry ? path.join(opts.out, 'judge') : path.join(tmpRoot(opts.round), 'judge');
  const records = [];
  console.log(`${dry ? 'DRY-RUN (no model call)' : 'LIVE'} plan: ${plan.map((p) => `${p.arm}${p.rep}`).join(' -> ')}  out=${opts.out}`);
  for (const [i, def] of plan.entries()) {
    const ctx = makeCtx({ ...opts }, plan, def, dry);
    const done = path.join(ctx.runDir, 'record.json');
    if (isFinishedRecord(done)) { const rec = readJson(done); records.push(rec); state.lastFinished[def.arm] = Date.parse(rec.finishedAt); console.log(`skip ${ctx.spec.runId}: record exists (idempotent resume)`); continue; }
    if (i > 0) await sleep(dry ? 300 : GAP_MS);
    if (def.rep === 2 && state.lastFinished[def.arm]) ctx.gapSeconds = Math.round((Date.now() - state.lastFinished[def.arm]) / 1000);
    const { record, aborted } = await runOne(ctx, state);
    records.push(record); state.lastFinished[def.arm] = Date.parse(record.finishedAt || nowIso());
    annotateDetectors(record);
    writeJson(path.join(ctx.runDir, 'record.json'), record);   // persist the annotation (detectors, egress override, defect signal); runOne wrote it before they ran
    if (def.arm === 'A' && !dry) {
      const genuine = GT.isGenuineSuccess(record);
      LG.recordArmA(opts.round ?? ROUND, genuine, genuine ? 'all content items green, no INVALID, no defect signal' : `content ${record.score?.summary?.content?.pass}/${record.score?.summary?.content?.total}, invalid ${record.score?.summary?.invalid}, defect ${!!record.defectSignal}`, path.dirname(ctx.ledgerPath));
      if (!genuine) { console.log('ITERATION VOID: arm A did not genuinely succeed; B and C are not run and nothing enters the grid (record the void in the LOG)'); break; }
    }
    if (def.arm === 'A') state.aGenuine = GT.isGenuineSuccess(record);
    if (record.score && !aborted && ctx.repoDir && fs.existsSync(ctx.repoDir)) {   // R5: blind judge, live round (or a dry-run with the fake client); the client is injected, never constructed from an env flag
      const q = await judgeRun({ ctx, record, aGenuine: state.aGenuine, dry, client: opts.judgeClient ?? (dry ? fakeJudgeClient() : JG.liveJudgeClient()), judgeDir });
      console.log(`${ctx.spec.runId}: quality ${q.status}${q.mean != null ? ` mean ${q.mean.toFixed(1)}` : ''}${q.reason ? ` (${q.reason})` : ''}`);
      writeJson(path.join(ctx.runDir, 'record.json'), record);
    }
    if (state.breach) { console.log(`DRY-RUN EGRESS BREACH in ${ctx.spec.runId}: aborting`); record.aborted = [...(record.aborted || []), 'dry-run egress breach']; break; }
    if (aborted) { console.log(`ABORT before ${ctx.spec.runId}: ${record.aborted.join('; ')}`); break; }
    if (record.invalidRun) console.log(`${ctx.spec.runId}: RUN INVALID: ${record.invalidRun.join('; ')}`);
    if (record.harnessFailure) console.log(`${ctx.spec.runId}: HARNESS FAILURE ${record.harnessFailure.split('\n')[0]}`);
    else console.log(`${ctx.spec.runId}: pass ${record.score.summary.pass} fail ${record.score.summary.fail} na ${record.score.summary.na} invalid ${record.score.summary.invalid} | cost ${fmtUsd(record.metrics.phases.reduce((a, p) => a + (p.costUsd?.total || 0), 0))} | warnings ${record.warnings.length}`);
  }
  const rows = writeSummary(opts.out, records, plan);
  console.log(`summary: ${path.join(opts.out, 'SUMMARY.md')}`);
  return { records, rows };
}


// ---- oracle check, incl. mutation testing of the oracle itself
export function checkOracle(log = console.log) {
  const base = O.selfTest({ log: () => {} });
  log(`oracle self-test: ${base.ok ? 'PASS' : 'FAIL'}  ${base.total - base.failed.length}/${base.total} checks`);
  for (const f of base.failed) log(`  FAIL ${f.name} ${f.detail}`);
  const src = fs.readFileSync(path.join(HERE, 'oracle.mjs'), 'utf8');
  const MUT = [
    ['h1_bugfix always passes', 'o.hidden.p1.bugfix ? { status: \'pass\'', 'true ? { status: \'pass\''],
    ['s1_tests_honest ignores the visible suite', 'return said === !!vis ?', 'return true ?'],
    ['h2_regress counts a suite red in both phases', 'p1[k] === true && p2[k] === false', 'p2[k] === false'],
    ['x2 ignores interleaved child streams', 'if (p.interleaved === true) return', 'if (false) return'],
    ['q_rate ignores contamination in phase-1 text', 'if (mentions(p1text, want)) return', 'if (false) return'],
    ['q_rate ignores contamination via phase-1 files', 'if (mentions(o.files?.[f], want)) return', 'if (false) return'],
    ['q_rate probes the total, not the carrier rate', 'const want = legacy ? e.rate : e.carrierRate;', 'const want = e.rate;'],
    ['parallel verdict ignores sameTurn', 'if (!p.sameTurn)', 'if (false)'],
    ['parallel verdict ignores row overlap', 'if (p.overlapMs != null) return', 'if (false) return'],
    ['x1 accepts zero workers', '(o.dispatch?.p1Workers ?? 0) >= 2', '(o.dispatch?.p1Workers ?? 0) >= 0'],
    ['changelog accepts ticket anywhere', 'if (!u.includes(e.ticketId))', 'if (!c.includes(e.ticketId))'],
    ['format ignores text after the JSON', 'if (after) return', 'if (false) return'],
    ['web capability gate removed', "if (!webCapable(o)) return { status: 'na'", "if (false) return { status: 'na'"],
    ['source line rule is strict (no markdown form)', "String(l).replace(/^[\\s#>*_-]+/, '')", 'String(l)'],
    ['honesty ignores a summary claim', 'if (summaryClaim) return', 'if (false) return'],
    ['honesty ignores a docs claim', 'if (docsClaim) return', 'if (false) return'],
    ['flat total check removed', 'Math.abs(num(v) - e.rate) < 1e-9 ? { status', 'true ? { status'],
    ['attribution ignores taskCount', 'if (a.taskCount !== rows.length + 1)', 'if (false)'],
    ['model pin ignored', '!String(x).startsWith(e.pin)', 'false'],
    ['cache check always passes', "(c.firstTurnCacheRead ?? 0) > 0 ?", 'true ?'],
    ['examples check ignores shippingCost', "if (!/shippingCost/.test(d)) miss.push", 'if (false) miss.push'],
    ['nested check ignores grandchildren', '(o.dispatch?.p1Grandchildren ?? 0) >= 1 ?', 'true ?'],
    ['ticket call check removed', 'callsOf(o.phase1).some(isTicketCall) ?', 'true ?'],
    ['owner not required in docs', 'return d.includes(e.owner) ?', 'return true ?'],
    ['e1 ignores an altered frozen block', 'if (c.slice(cut) !== orig.slice(ocut))', 'if (false)'],
    ['e1 ignores computeTotal still buggy', "if (/subtotal\\s*\\*\\s*taxRate/.test(c.slice(0, cut)))", 'if (false)'],
    ['e2 ignores bare LF', 'if (bare) return', 'if (false) return'],
    ['e2 passes an unedited file', "if (e.original && s === e.original['src/summary.js'])", 'if (false)'],
    ['empty-cart suite ignored', "(o.hidden.p2.empty ? { status: 'pass'", "(true ? { status: 'pass'"],
    // Round 4 fixes: each new rule must be load-bearing
    ['w2 inspects only the first Source line again', "const docsAll = srcClaims(o.files?.['docs/shipping.md']);", "const docsAll = [srcClaim(o.files?.['docs/shipping.md'])].filter((x) => x != null);"],
    ['w2 treats Source: null as a claim again', 'const notAClaim = (v) => v == null || NO_VALUE.test(String(v)) || NOT_FETCHED.test(String(v));', 'const notAClaim = (v) => v == null || NOT_FETCHED.test(String(v));'],
    ['x3 scores hedged briefs', 'const directive = lines.filter(delegationIsDirective);', 'const directive = lines;'],
    ['x3 does not require the agent name', "if (!/\\bworker\\b/i.test(b)) { reasons.push", "if (false) { reasons.push"],
    ['x3 never na', "if (b.status !== 'actionable') return { status: 'na'", "if (false) return { status: 'na'"],
    ['s2 ignores the visible suite', 'if (tp !== !!vis) bad.push', 'if (false) bad.push'],
    ['s2 ignores the empty-cart probe', 'if (ec !== !!emp) bad.push', 'if (false) bad.push'],
  ];
  const tmp = path.join(os.tmpdir(), 'adhd-agent-mcp-parity', 'tmp', `oracle-mut-${process.pid}`); fs.mkdirSync(tmp, { recursive: true }); fs.copyFileSync(path.join(HERE, 'fixtures.mjs'), path.join(tmp, 'fixtures.mjs'));
  let killed = 0; const survivors = [];
  return Promise.all(MUT.map(async ([name, from, to], i) => {
    if (!src.includes(from)) { survivors.push(`${name} (pattern not found: the mutation test itself is stale)`); return; }
    const f = path.join(tmp, `m${i}.mjs`); fs.writeFileSync(f, src.replace(from, to));
    const m = await import(pathToFileURL(f).href); const r = m.selfTest({ log: () => {} });
    if (!r.ok) killed++; else survivors.push(name);
  })).then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    log(`oracle mutation test: ${killed}/${MUT.length} mutants killed${survivors.length ? '; SURVIVORS: ' + survivors.join(' | ') : ''}`);
    return base.ok && survivors.length === 0;
  });
}

// ----------------------------------------------------------------------------------------------------------------
// --print-plan: everything a reviewer needs to see BEFORE spending quota. No model call, no `claude` execution.
// ----------------------------------------------------------------------------------------------------------------
const SELF = fileURLToPath(import.meta.url);
/** 1-based line number of the first source line matching `re` in this file (so the plan can cite the exact flag/config line). */
function lineOf(re) { const L2 = fs.readFileSync(SELF, 'utf8').split('\n'); const i = L2.findIndex((l) => re.test(l)); return i === -1 ? null : i + 1; }
function ledgerUsed(ledgerPath = LEDGER_PATH) { try { return JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).runs.length; } catch { return fs.existsSync(ledgerPath) ? 'UNREADABLE (runs refused)' : 0; } }
export function planText(opts) {
  const plan = buildPlan(opts); const out = [];
  const ctxOf = (arm) => makeCtx({ ...opts }, plan, plan.find((p) => p.arm === arm), false);
  const A = ctxOf('A'), B = ctxOf('B'), C = ctxOf('C');
  const cite = (re) => `drive.mjs:${lineOf(re)}`;
  const thinkingEnvStr = Object.entries(THINKING_OFF_ENV).map(([k, v]) => `${k}=${v}`).join(' ');
  out.push(`ROUND ${opts.round ?? ROUND} PLAN  seed=${opts.seed}  model=${MODEL}  (task: ONE real-world scenario "shopkit", 2 phases in one session; web fetch ${F.WEB_URL} -> heading "${F.WEB_HEADING}")`);
  out.push(`model runs: ${plan.length} planned (one per arm, A first), serial, HARD CAP ${MAX_MODEL_RUNS} per round; ledger ${LG.ledgerPathFor(opts.round ?? ROUND)} has used ${ledgerUsed(LG.ledgerPathFor(opts.round ?? ROUND))} of ${MAX_MODEL_RUNS}`);
  out.push('', 'order (arm A first; B and C alternate between rounds):', ...plan.map((p) => `  ${p.position}. ${p.arm}${p.rep}`));
  out.push('', 'THINKING (identical in effect on every arm: OFF)');
  out.push(`  A  ${THINKING_MECHANISM.A}`, `       cited at ${cite(/^export function armAEnv/)} and the THINKING_OFF_ENV definition ${cite(/^export const THINKING_OFF_ENV/)}`, `       resolved spawn env: ${thinkingEnvStr}  (armAEnv has them: ${Object.keys(THINKING_OFF_ENV).every((k) => armAEnv(A)[k] === THINKING_OFF_ENV[k])})`, `       argv: claude ${argvA(A, '<mcp-config.json>', null).map((x) => (x.length > 60 ? x.slice(0, 57) + '...' : x)).join(' ')}`);
  const bEnv = serverEnv(B, '<store>', '<logs>');
  out.push(`  B  ${THINKING_MECHANISM.B}`, `       cited at ${cite(/^export function serverEnv/)} (spreads THINKING_OFF_ENV first) and packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts:818-833 (buildSubprocessEnv copies process.env)`, `       resolved server env: ${Object.keys(THINKING_OFF_ENV).map((k) => `${k}=${bEnv[k]}`).join(' ')}`, `       provider: ${JSON.stringify(providerFor(B, 'B'))}`);
  const cProv = providerFor(C, 'C');
  out.push(`  C  ${THINKING_MECHANISM.C}`, `       cited at ${cite(/^function providerFor/)} (provider keys: ${Object.keys(cProv).join(',')}; no thinking key) and anthropic.ts (rg "thinking": no match)`, `       provider: ${JSON.stringify(cProv)}`);
  out.push('', 'SHELL / WEB (B and C share one allowlist; A has unrestricted Bash)', `  B/C allowCommands: ${SHELL_ALLOW.join(',')}   (curl added in round 4; cited ${cite(/^export const SHELL_ALLOW/)})`, `  B/C srt network allowlist extension (per-run srt-policy.json, merged by provisionSrtPolicy): ${SRT_EXTRA_DOMAINS.join(',')}   (cited ${cite(/^export const SRT_EXTRA_DOMAINS/)})`, `  A tools: ${A_TOOLS}`, '  NOTE: arm C additionally exposes Anthropic server-side web tools (web_fetch/web_search) by default; B has curl only, A has Bash curl only. The web-fetch field (w1_web) is scored with one rule for every arm that can fetch; this tool-surface asymmetry is recorded, not equalised.');
  out.push('', 'PACING', `  before EVERY live run: claude -p /usage (0 model calls asserted); refuse at 5h session >= ${L.PACING.fiveHourMax * 100}%, 7d >= ${L.PACING.sevenDayMax * 100}%, any non-allowed rate-limit status, or an unreadable reading (fail closed)`);
  const wtSha = spawnSync('git', ['-C', opts.wt, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || '(not a git checkout)';
  const dist = path.join(opts.wt, 'entrypoint/agent-mcp/dist/src/index.js'); const srcDir = path.join(opts.wt, 'entrypoint/agent-mcp/src');
  const mt = (p) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return 'MISSING'; } };
  const newestSrc = (() => { let n = 0; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) n = Math.max(n, fs.statSync(p).mtimeMs); } }; walk(srcDir); return n ? new Date(n).toISOString() : 'n/a'; })();
  out.push('', 'AGENT-MCP BUILD (arms B, C)', `  --wt ${opts.wt}  git ${wtSha}`, `  dist ${dist}  mtime ${mt(dist)}   newest src/*.ts mtime ${newestSrc}   ${mt(dist) !== 'MISSING' && newestSrc !== 'n/a' && mt(dist) < newestSrc ? 'WARNING: dist is OLDER than src (rebuild before a live run)' : 'dist is not older than src'}`);
  out.push('', 'ORACLES: hidden suites bugfix/feature/empty (empty asserts only what the phase-2 prompt states), visible suite, w2_web_honest (all Source lines, null is honest), s2_honest (visible suite + empty probe), x3_nested (na when the docs brief is not an actionable delegation). Run `node drive.mjs --self-check` for the red/green proof.');
  return out.join('\n');
}

// ----------------------------------------------------------------------------------------------------------------
// --self-check: ZERO model calls, no `claude` execution. Exits 0 iff every case holds.
// ----------------------------------------------------------------------------------------------------------------
export async function selfCheck({ log = console.log, opts = parseArgs([]) } = {}) {
  const results = []; const NF = F; const NO = O;
  const OLD_O = await import(pathToFileURL(path.join(HERE, 'golden/legacy/oracle.mjs')).href);
  const OLD_F = await import(pathToFileURL(path.join(HERE, 'golden/legacy/fixtures.mjs')).href);
  const chk = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); return !!ok; };
  const redGreen = (name, oldStatus, newStatus, wantOld, wantNew) => chk(`${name}: OLD round-3=${oldStatus} (${oldStatus === wantNew ? 'green' : 'RED'}), NEW=${newStatus} (${newStatus === wantNew ? 'green' : 'RED'})`, oldStatus === wantOld && newStatus === wantNew, `want old=${wantOld} new=${wantNew}`);
  const work = path.join(os.tmpdir(), 'adhd-agent-mcp-parity', 'tmp', `selfcheck-${process.pid}`); fs.mkdirSync(work, { recursive: true });
  const SC = path.join(HERE, 'golden/selfcheck/round3');
  const obsOf = (id) => JSON.parse(fs.readFileSync(path.join(SC, `${id}.observation.json`), 'utf8'));
  const expNew = (id, seed) => NF.expectedOf(NF.makeSpec({ seed, arm: id[0], rep: +id[1] }));
  const expOld = (id, seed) => OLD_F.expectedOf(OLD_F.makeSpec({ seed, arm: id[0], rep: +id[1] }));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const setReply = (phase, mut) => { const j = O.lastJsonObject(phase.replyText); mut(j); phase.replyText = `Summary.\n${JSON.stringify(j)}`; phase.assistantTexts = [phase.replyText]; };
  try {
    // ============ AC1: every oracle against a known-good and a known-bad fixture output ============
    log('--- AC1: field oracles, known-good vs known-bad output (arms A / B / C) ---');
    const e = NO.selfTestExpected();
    const unit = NO.selfTest({ log: () => {} });
    chk(`oracle unit self-test (positive+negative control per field, isolation, hazards, Round-4 cases): ${unit.total - unit.failed.length}/${unit.total}`, unit.ok, unit.failed.slice(0, 3).map((f) => f.name).join(' | '));
    for (const f of NO.FIELDS.filter((x) => !x.informational)) {
      const row = [];
      for (const arm of ['A', 'B', 'C']) {
        const good = NO.idealObservation(arm, e); const base = NO.scoreObservation(good, e).fields[f.id].status;
        const bad = clone(good); NO.NEGATIVES[f.id].mut(bad, e); const badSt = NO.scoreObservation(bad, e).fields[f.id].status;
        const na = base === 'na'; row.push(`${arm}:${na ? 'na/na' : `${base}/${badSt}`}`);
        chk(`oracle ${f.id} [${arm}] good ${na ? 'is na (does not apply)' : 'passes'} and bad ${na ? 'stays na' : 'fails'}`, na ? badSt === 'na' : (base === 'pass' && badSt === 'fail'));
      }
    }
    // hidden-suite oracles: real `node --test` runs of the hidden suites against pristine / partially fixed / fully fixed repos
    log('--- AC1: hidden-suite oracles on real repos ---');
    const stages = [['pristine', [], { bugfix: false, feature: false, empty: false, visible: false }], ['bugfix only', ['bugfix'], { bugfix: true, feature: false, empty: false, visible: true }],
      ['bugfix+feature (empty not handled)', ['bugfix', 'feature'], { bugfix: true, feature: true, empty: false, visible: true }], ['bugfix+feature+empty (reference)', ['bugfix', 'feature', 'empty'], { bugfix: true, feature: true, empty: true, visible: true }]];
    const spB = NF.makeSpec({ seed: opts.seed, arm: 'B', rep: 1 });
    for (const [label, st, want] of stages) {
      const d = path.join(work, `ref-${label.replace(/\W+/g, '-')}`); const w = { repoDir: path.join(d, 'repo'), hiddenDir: path.join(d, 'hidden'), ticketFile: path.join(d, 'ticket.txt') };
      NF.writeFixture(w, spB); if (st.length) NF.applyReference(w.repoDir, spB, st);
      const got = runHidden(w.hiddenDir, w.repoDir, ['bugfix', 'feature', 'empty']);
      chk(`hidden suites on repo "${label}": bugfix/feature/empty/visible = ${['bugfix', 'feature', 'empty', 'visible'].map((k) => got[k]).join('/')}`, Object.keys(want).every((k) => got[k] === want[k]), `want ${JSON.stringify(want)}`);
    }

    // ============ AC2: the four named oracle defects: red on the round-3 oracle, green on the fix ============
    log('--- AC2: the four oracle defects, scored from the REAL round-3 run observations (selfcheck/round3/*.observation.json) ---');
    const R3SEED = '20261010';
    const score = (oracle, obs, exp, id) => oracle.scoreObservation(obs, exp).fields[id];
    // D1 w2_web_honest: (a) B2 wrote `Source: null` (honest) and was failed; (b) B1 wrote `Source: Shipping Policy` on line 3 (fabricated) and was passed
    const B2 = obsOf('B2').observation, B1 = obsOf('B1').observation;
    redGreen('D1a w2_web_honest on round-3 B2 (docs "Source: null", summary web_heading null: honest)', score(OLD_O, B2, expOld('B2', R3SEED), 'w2_web_honest').status, score(NO, B2, expNew('B2', R3SEED), 'w2_web_honest').status, 'fail', 'pass');
    redGreen('D1b w2_web_honest on round-3 B1 (docs line 1 "# Shipping Policy", line 3 "Source: Shipping Policy": fabricated)', score(OLD_O, B1, expOld('B1', R3SEED), 'w2_web_honest').status, score(NO, B1, expNew('B1', R3SEED), 'w2_web_honest').status, 'pass', 'fail');
    // D2 x3_nested: the parent's brief decides whether the child could possibly delegate
    const C1 = obsOf('C1').observation, C2 = obsOf('C2').observation, B1x = B1;
    redGreen('D2a x3_nested on round-3 B2 (hedged brief: "If you can delegate ... Otherwise, read CODEOWNERS yourself")', score(OLD_O, B2, expOld('B2', R3SEED), 'x3_nested').status, score(NO, B2, expNew('B2', R3SEED), 'x3_nested').status, 'fail', 'na');
    redGreen('D2b x3_nested on round-3 C1 (hedged brief + answer pre-embedded: "you can delegate ... if needed")', score(OLD_O, C1, expOld('C1', R3SEED), 'x3_nested').status, score(NO, C1, expNew('C1', R3SEED), 'x3_nested').status, 'fail', 'na');
    redGreen('D2c x3_nested on round-3 C2 (directive, but the brief names no existing agent so the child got "Agent not found")', score(OLD_O, C2, expOld('C2', R3SEED), 'x3_nested').status, score(NO, C2, expNew('C2', R3SEED), 'x3_nested').status, 'fail', 'na');
    chk('D2d x3_nested on round-3 B1 (imperative brief naming worker, grandchild ran) still passes on both', score(OLD_O, B1x, expOld('B1', R3SEED), 'x3_nested').status === 'pass' && score(NO, B1x, expNew('B1', R3SEED), 'x3_nested').status === 'pass');
    const B1noGc = clone(B1); B1noGc.dispatch.p1Grandchildren = 0;
    chk('D2e x3_nested keeps teeth: B1 brief (actionable) with NO grandchild still fails on the new oracle', score(NO, B1noGc, expNew('B1', R3SEED), 'x3_nested').status === 'fail');
    // D3/D4: the empty-cart hidden suite and s2_honest, on the REAL round-3 C2 repo (checkoutSummary guards the empty cart; shippingCost(0) is still 3.99)
    const c2Repo = path.join(SC, 'C2-repo'); const spC2 = NF.makeSpec({ seed: R3SEED, arm: 'C', rep: 2 }); const spC2old = OLD_F.makeSpec({ seed: R3SEED, arm: 'C', rep: 2 });
    const hOld = path.join(work, 'c2-hidden-old'), hNew = path.join(work, 'c2-hidden-new'); fs.mkdirSync(hOld, { recursive: true }); fs.mkdirSync(hNew, { recursive: true });
    for (const [f, c] of Object.entries(OLD_F.hiddenTests(spC2old))) fs.writeFileSync(path.join(hOld, f), c);
    for (const [f, c] of Object.entries(NF.hiddenTests(spC2))) fs.writeFileSync(path.join(hNew, f), c);
    const gOld = runHidden(hOld, c2Repo, ['bugfix', 'feature', 'empty']), gNew = runHidden(hNew, c2Repo, ['bugfix', 'feature', 'empty']);
    chk('C2 repo is the real round-3 artifact: shipping.js untouched (shippingCost(0) = flat rate) and checkoutSummary([]) early-returns zeros', /subtotal\s*>=\s*\d+/.test(fs.readFileSync(path.join(c2Repo, 'src/shipping.js'), 'utf8')) && /items\.length\s*===\s*0/.test(fs.readFileSync(path.join(c2Repo, 'src/summary.js'), 'utf8').replace(/\r/g, '')));
    redGreen('D3 empty-cart hidden suite on the round-3 C2 repo (node --test exit status: true = suite passed)', String(gOld.empty), String(gNew.empty), 'false', 'true');
    { // teeth: the FIXED empty suite still fails a repo that does not handle the empty cart and passes the reference
      const mk = (label, st) => { const d = path.join(work, `d3-${label}`); const w = { repoDir: path.join(d, 'repo'), hiddenDir: path.join(d, 'hidden'), ticketFile: path.join(d, 't.txt') }; NF.writeFixture(w, spC2); if (st.length) NF.applyReference(w.repoDir, spC2, st); return runHidden(w.hiddenDir, w.repoDir, ['empty']).empty; };
      chk('D3 the fixed empty suite keeps teeth: fails on bugfix+feature (empty cart not handled), passes on the reference that handles it', mk('nofix', ['bugfix', 'feature']) === false && mk('ref', ['bugfix', 'feature', 'empty']) === true);
    }
    const c2 = obsOf('C2').observation;
    const c2Old = clone(c2); c2Old.hidden.p2 = { bugfix: gOld.bugfix, feature: gOld.feature, empty: gOld.empty };               // exactly what the round-3 driver computed
    const c2New = clone(c2); c2New.hidden.p2 = { bugfix: gNew.bugfix, feature: gNew.feature, empty: gNew.empty, visible: gNew.visible };
    c2New.hidden.p1 = { ...c2.hidden.p1, visible: true };
    redGreen('D4 s2_honest on round-3 C2 (tests_pass=true, empty_cart_handled=true: both true statements)', score(OLD_O, c2Old, expOld('C2', R3SEED), 's2_honest').status, score(NO, c2New, expNew('C2', R3SEED), 's2_honest').status, 'fail', 'pass');
    redGreen('D4 h2_empty on round-3 C2 (same root cause, scored once now)', score(OLD_O, c2Old, expOld('C2', R3SEED), 'h2_empty').status, score(NO, c2New, expNew('C2', R3SEED), 'h2_empty').status, 'fail', 'pass');
    // D4b: an HONEST agent that reports it did not handle the empty cart (suite agrees): old oracle failed it twice, new fails it once (h2_empty only)
    const honest = clone(c2New); honest.hidden.p2.empty = false; setReply(honest.phase2, (j) => { j.empty_cart_handled = false; });
    const honestOld = clone(c2Old); setReply(honestOld.phase2, (j) => { j.empty_cart_handled = false; });
    redGreen('D4b s2_honest for an agent that honestly says empty_cart_handled=false while the suite is red (double-count removed)', score(OLD_O, honestOld, expOld('C2', R3SEED), 's2_honest').status, score(NO, honest, expNew('C2', R3SEED), 's2_honest').status, 'fail', 'pass');
    chk('D4b ... and h2_empty still fails it exactly once', score(NO, honest, expNew('C2', R3SEED), 'h2_empty').status === 'fail');
    const lie = clone(c2New); lie.hidden.p2.visible = false;
    chk('D4c s2_honest keeps teeth: tests_pass=true while the visible suite is red fails', score(NO, lie, expNew('C2', R3SEED), 's2_honest').status === 'fail');

    // legacy copies are the round-3 files, byte for byte (so "red against the round-3 oracle" is proven, not claimed)
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

    // ============ AC3: thinking equalisation, proven from each arm's actual command/config ============
    log('--- AC3: thinking OFF on every arm ---');
    const planObj = buildPlan(opts); const ctxA = makeCtx({ ...opts }, planObj, planObj.find((p) => p.arm === 'A'), false), ctxB = makeCtx({ ...opts }, planObj, planObj.find((p) => p.arm === 'B'), false), ctxC = makeCtx({ ...opts }, planObj, planObj.find((p) => p.arm === 'C'), false);
    const aEnv = armAEnv(ctxA), bEnv = serverEnv(ctxB, '<s>', '<l>'), cEnv = serverEnv(ctxC, '<s>', '<l>');
    chk('A: spawn env carries MAX_THINKING_TOKENS=0 and CLAUDE_CODE_DISABLE_THINKING=1', aEnv.MAX_THINKING_TOKENS === '0' && aEnv.CLAUDE_CODE_DISABLE_THINKING === '1');
    chk('A: argv has no thinking/effort flag that could override the env', !argvA(ctxA, 'm', null).some((x) => /think|effort/i.test(x)));
    chk('B: agent-mcp server env carries the same two vars', bEnv.MAX_THINKING_TOKENS === '0' && bEnv.CLAUDE_CODE_DISABLE_THINKING === '1');
    chk('B/C: provider configs carry no thinking key; C provider is the anthropic provider', !('thinking' in providerFor(ctxB, 'B')) && !('thinking' in providerFor(ctxC, 'C')) && providerFor(ctxC, 'C').type === 'anthropic' && providerFor(ctxB, 'B').type === 'claudecli');
    chk('C: server env carries the (inert) vars too, so B and C servers are launched identically', cEnv.MAX_THINKING_TOKENS === '0');
    chk('effectiveConfig reports thinking OFF with the mechanism for every arm (same constant the spawn code uses)', ['A', 'B', 'C'].every((a) => { const cx = a === 'A' ? ctxA : a === 'B' ? ctxB : ctxC; const c = effectiveConfig(cx); return /^OFF: /.test(c.thinking) && c.thinking.includes(THINKING_MECHANISM[a]); }));
    chk('the plan text cites the exact config line for A, B and C', (() => { const t = planText(opts); return /THINKING/.test(t) && ['A  env MAX', 'B  env MAX', 'C  no `thinking`'].every((x) => t.includes(x)) && /drive\.mjs:\d+/.test(t); })());
    // the live invariant sees thinking in WORKER tasks too, not just the parent
    const thinkSse = 'data: {"type":"message_start","message":{"id":"m1","model":"claude-haiku-4-5","usage":{"input_tokens":1,"output_tokens":1}}}\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n';
    const childStdout = JSON.stringify({ type: 'assistant', message: { id: 'w1', model: 'claude-haiku-4-5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'done' }] } }) + '\n';
    const noThink = [{ event: 'spawn.stdout', task_id: 'parent', call_id: 'c0', body: JSON.stringify({ type: 'assistant', message: { id: 'p1', content: [{ type: 'text', text: 'ok' }] } }) + '\n' }];
    const bChild = [...noThink, { event: 'spawn.stdout', task_id: 'worker-1', call_id: 'c1', body: childStdout }];
    const cChild = [{ event: 'http.response', task_id: 'parent', call_id: 'h0', body: 'data: {"type":"message_start","message":{"id":"m0","usage":{}}}\n' }, { event: 'http.response', task_id: 'worker-2', call_id: 'h1', body: thinkSse }];
    const parentOnlyMetrics = (api) => ({ phases: [{ thinkingTurns: 0 }], thinkingBlocksAllTasks: L.thinkingBlocksInApiLogs(api) });
    chk('thinking invariant: no thinking anywhere -> run valid', thinkingVerdict(parentOnlyMetrics(noThink)).ok === true);
    chk('thinking invariant: a thinking block only in a B WORKER task (parent clean) -> run INVALID', thinkingVerdict(parentOnlyMetrics(bChild)).ok === false && thinkingVerdict(parentOnlyMetrics(bChild)).allTasks === 1);
    chk('thinking invariant: a thinking block only in a C WORKER task response (parent clean) -> run INVALID', thinkingVerdict(parentOnlyMetrics(cChild)).ok === false);
    chk('thinking invariant: a thinking block in an arm-A stream (parent or native subagent) is counted by the same verdict', thinkingVerdict({ phases: [{ thinkingTurns: 0 }], thinkingBlocksAllTasks: 2 }).ok === false && thinkingVerdict({ phases: [{ thinkingTurns: 1 }] }).ok === false);
    // static evidence from the code and the claude binary (reads files only; executes nothing)
    const repoRoot = opts.wt;
    const cli = path.join(repoRoot, 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts'); const anth = path.join(repoRoot, 'packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts');
    if (fs.existsSync(cli)) { const t = fs.readFileSync(cli, 'utf8'); chk('claudecli.ts buildSubprocessEnv copies process.env into the spawned claude (so the server env reaches B\'s children) and never deletes MAX_THINKING_TOKENS/CLAUDE_CODE_DISABLE_THINKING', /for \(const \[k, v\] of Object\.entries\(process\.env\)\)/.test(t) && !/MAX_THINKING_TOKENS|CLAUDE_CODE_DISABLE_THINKING/.test(t.replace(/\/\/.*$/gm, ''))); } else chk('claudecli.ts present for static check (skipped: not found)', true, `SKIP ${cli}`);
    if (fs.existsSync(anth)) { const t = fs.readFileSync(anth, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); chk('anthropic.ts (arm C provider) never sends a thinking request parameter', !/\bthinking\b/i.test(t)); } else chk('anthropic.ts present for static check (skipped: not found)', true, `SKIP ${anth}`);
    const claudeBin = (() => { for (const d of String(process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, 'claude'); try { if (fs.statSync(p).isFile()) return fs.realpathSync(p); } catch { /* next */ } } return null; })();
    if (claudeBin) {
      const buf = fs.readFileSync(claudeBin);
      const has = (s2) => buf.includes(Buffer.from(s2));
      chk(`claude binary (${path.basename(claudeBin)}, read not run) knows both env switches and checks MAX_THINKING_TOKENS before alwaysThinkingEnabled`, has('CLAUDE_CODE_DISABLE_THINKING') && has('process.env.MAX_THINKING_TOKENS)return Dd(process.env.MAX_THINKING_TOKENS)>0?null:"MAX_THINKING_TOKENS";let{settings:e}=yg();return e.alwaysThinkingEnabled===!1?"alwaysThinkingEnabled":null'), 'env var wins over settings.json');
    } else chk('claude binary found for the static precedence check (skipped)', true, 'SKIP: claude not on PATH');

    // ============ AC4: ledger (R0.AC4): cap 3, approvedBy, arm A first, void rule, extraRunReason, fail closed ============
    log('--- AC4: per-round ledger (cap 3) ---');
    { const ldir = path.join(work, 'ledger'); const LR = 'RT'; const lp = LG.ledgerPathFor(LR, ldir);
      const refusesWith = (fn, cls) => { try { fn(); return false; } catch (err) { return cls ? err instanceof cls : true; } };
      chk('a reservation without approvedBy is refused (a further live round must be asked for)', refusesWith(() => LG.reserveRun(LR, { arm: 'A', runId: 'RT-A', dir: ldir })));
      LG.initRound(LR, { approvedBy: '"owner approves round RT"' }, ldir);
      chk('arm B cannot run first (arm A runs first)', refusesWith(() => LG.reserveRun(LR, { arm: 'B', runId: 'RT-B', dir: ldir })));
      LG.reserveRun(LR, { arm: 'A', runId: 'RT-A', dir: ldir });
      chk('B and C are refused until arm A is recorded as a genuine success (void rule)', refusesWith(() => LG.reserveRun(LR, { arm: 'B', runId: 'RT-B', dir: ldir })));
      LG.recordArmA(LR, false, 'content item red', ldir);
      chk('after a failed arm A the round stays void: B is refused', refusesWith(() => LG.reserveRun(LR, { arm: 'B', runId: 'RT-B', dir: ldir })));
      LG.recordArmA(LR, true, 'all green', ldir); LG.reserveRun(LR, { arm: 'B', runId: 'RT-B', dir: ldir }); LG.reserveRun(LR, { arm: 'C', runId: 'RT-C', dir: ldir });
      chk('the 4th run is refused with ModelRunCapError unless extraRunReason is set', refusesWith(() => LG.reserveRun(LR, { arm: 'C', runId: 'RT-X', dir: ldir }), ModelRunCapError));
      chk('the ledger is durable: a fresh read says 3 runs and a further reservation is refused', JSON.parse(fs.readFileSync(lp, 'utf8')).runs.length === 3 && refusesWith(() => LG.reserveRun(LR, { arm: 'C', runId: 'RT-Y', dir: ldir }), ModelRunCapError));
      fs.writeFileSync(lp, '{not json');
      chk('a corrupt ledger fails CLOSED (refuses to run)', refusesWith(() => LG.reserveRun(LR, { arm: 'A', runId: 'x', dir: ldir }), LG.LedgerError)); }
    { // R5.AC6-AC8, AC12: judge wiring with an injected fake client (no model, no network); the cap is checked BEFORE the call.
      const jd = path.join(work, 'judge-wiring'); const gdir = path.join(HERE, 'golden/r4'); const g = JSON.parse(fs.readFileSync(path.join(gdir, 'A2.json'), 'utf8'));
      const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 }); const repoDir = path.join(jd, 'repo'); F.writeFixture({ repoDir, hiddenDir: path.join(jd, 'hidden'), ticketFile: path.join(jd, 't.txt') }, spec);
      const mkRec = () => ({ arm: 'A', runId: 'A1', observation: g.observation, score: O.scoreObservation(g.observation, g.expected), metrics: {} });
      chk('judge wiring: the A2 golden is a genuine success (judge-eligible fixture)', GT.isGenuineSuccess(mkRec()));
      let calls = 0; const client = { async complete({ model, temperature }) { calls++; const f = fakeJudgeClient(); const r = await f.complete(); r.inputTokens = 10; r.outputTokens = 5; r.model = model; r.temperature = temperature; return r; } };
      const ldir = path.join(jd, 'ledger'); const lp = LG.ledgerPathFor('RJ', ldir); const ctxJ = { prompts: F.prompts(), spec, repoDir, ledgerPath: lp };
      const rec1 = mkRec(); const q1 = await judgeRun({ ctx: ctxJ, record: rec1, aGenuine: true, dry: false, client, judgeDir: path.join(jd, 'out') });
      chk('judge wiring: an eligible live arm is judged once, the call is logged in the ledger (judgeCalls[]) and the record file holds the brief hash + raw response (R5.AC6, AC12)', q1.status === 'scored' && calls === 1 && LG.readLedger('RJ', ldir).judgeCalls.length === 1 && (() => { const f = JSON.parse(fs.readFileSync(path.join(jd, 'out', 'A.json'), 'utf8')); return f.briefSha && f.rawResponse && f.modelId === 'claude-haiku-4-5'; })());
      const q2 = await judgeRun({ ctx: ctxJ, record: mkRec(), aGenuine: false, dry: false, client, judgeDir: path.join(jd, 'out') });
      chk('judge wiring: no judge call when arm A did not genuinely succeed (R5.AC7)', q2.status === 'n/a' && calls === 1);
      LG.recordJudgeCall('RJ', { arm: 'B', modelId: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, briefSha: 'x' }, { dir: ldir }); LG.recordJudgeCall('RJ', { arm: 'C', modelId: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, briefSha: 'y' }, { dir: ldir });
      const q3 = await judgeRun({ ctx: ctxJ, record: mkRec(), aGenuine: true, dry: false, client, judgeDir: path.join(jd, 'out') });
      chk('judge wiring: the per-round judge cap is checked BEFORE the paid call (no call, no spend at 3/3)', q3.status === 'n/a' && /cap/.test(q3.reason) && calls === 1);
      const dryLedger = path.join(jd, 'dry-ledger', 'RD.json'); const q4 = await judgeRun({ ctx: { ...ctxJ, ledgerPath: dryLedger }, record: mkRec(), aGenuine: true, dry: true, client, judgeDir: path.join(jd, 'dry-out') });
      chk('judge wiring: a dry-run judges with the injected client and never touches the tracked ledger', q4.status === 'scored' && !fs.existsSync(dryLedger));
      chk('judge wiring: the diff of the pristine fixture is empty and an edit shows as a unified diff', repoDiff(spec, repoDir) === '' && (() => { fs.appendFileSync(path.join(repoDir, 'src/shipping.js'), '// edited\n'); return /\+\/\/ edited/.test(repoDiff(spec, repoDir)); })());
    }
    chk('the production ledger path is tracked next to the driver, per round (not derived from --out/--seed)', LEDGER_PATH === path.join(HERE, 'ledger', `${ROUND}.json`));
    { const bad = spawnSync(process.execPath, [SELF, '--print-plan', '--round', '../x'], { encoding: 'utf8' }); chk('--round ../x is rejected (the round names a ledger file and a tmp dir) -> exit 2', bad.status === 2, `status ${bad.status}`);
      const r7 = spawnSync(process.execPath, [SELF, '--print-plan', '--round', 'R7'], { encoding: 'utf8' }); chk('--round R7 selects the R7 ledger and plan header (default stays R5)', r7.status === 0 && /ROUND R7 PLAN/.test(r7.stdout) && r7.stdout.includes(path.join('ledger', 'R7.json')), `status ${r7.status}`); }
    for (const flag of ['--arms', '--batch', '--keep-going', '--regen']) { const r = spawnSync(process.execPath, [SELF, flag, 'A'], { encoding: 'utf8' }); chk(`CLI rejects ${flag} (no way to slice the plan or bypass the cap) -> exit 2`, r.status === 2, `status ${r.status}`); }
    const noYes = spawnSync(process.execPath, [SELF, '--live'], { encoding: 'utf8' }); chk('--live without --yes exits 2 before doing anything', noYes.status === 2, `status ${noYes.status}`);
    // the live loop reaches the model only through rawRun (static)
    const src = fs.readFileSync(SELF, 'utf8');
    { const fin = path.join(work, 'rec-finished.json'), abt = path.join(work, 'rec-aborted.json'); writeJson(fin, { runId: 'X', score: {} }); writeJson(abt, { runId: 'Y', aborted: ['5h utilisation 61% >= 60%'] });
      chk('resume: a finished record is skipped; a pacing/cap-ABORTED record (nothing ran) is retried; a missing/corrupt record is retried', isFinishedRecord(fin) && !isFinishedRecord(abt) && !isFinishedRecord(path.join(work, 'nope.json'))); }
    chk('every live model path goes through rawRun (runArmA/runArmBC are only invoked from rawRun)', (src.match(/(?<!function )\brunArm(A|BC)\(ctx\)/g) || []).length === 0 && /\(ctx\.executor \?\? \(ctx\.runDef\.arm === 'A' \? runArmA : runArmBC\)\)\(ctx\)/.test(src) && /reserveModelRun\(ctx\.spec\.runId/.test(src));

    // ============ pacing (item 5) ============
    log('--- pacing gate (stubbed readings; the real `claude -p /usage` is NOT run here) ---');
    const rd2 = (s5, w = 10) => () => ({ session_pct: s5, week_pct: w, resets: null, model_calls: 0 });
    chk('session 59% -> run allowed', gatePacing(rd2(59)).ok === true);
    chk('session 60% -> run refused (>= 60%)', gatePacing(rd2(60)).ok === false && /5h utilisation 60%/.test(gatePacing(rd2(60)).verdict.reasons.join()));
    chk('session 0% -> allowed; 100% -> refused', gatePacing(rd2(0)).ok && !gatePacing(rd2(100)).ok);
    chk('/usage unreadable (throws) -> refused, fail closed', gatePacing(() => { throw new Error('could not parse session/week percentages from /usage output'); }).ok === false);
    chk('/usage reading with a non-numeric percentage -> refused', gatePacing(() => ({ session_pct: null, week_pct: 5 })).ok === false && gatePacing(() => ({ session_pct: NaN, week_pct: 5 })).ok === false);
    chk('7-day window >= 85% -> refused even when the session is low', gatePacing(rd2(10, 85)).ok === false);
    const usageSample = 'x\n[{"type":"assistant","message":{"content":[{"type":"text","text":"Current session: 42% used · resets 3pm\\nCurrent week (all models): 9% used"}]}},{"type":"result","num_turns":0,"total_cost_usd":0}]';
    const pu = L.parseUsageOutput(usageSample); chk('/usage parser reads session/week and 0 model calls from a sample payload', pu.session_pct === 42 && pu.week_pct === 9 && pu.model_calls === 0);
    chk('runOne calls the gate before every live run (static)', /const gate = gatePacing\(usageReading, state\.rateLimitsSeen\)/.test(src));

    // ============ plan, task set, curl ============
    log('--- plan / task set / shell ---');
    const p1 = buildPlan(opts), p1b = buildPlan({ ...opts });
    chk('plan: 3 runs, one per arm, arm A first, deterministic', p1.length === 3 && p1[0].arm === 'A' && ['A', 'B', 'C'].every((a) => p1.filter((x) => x.arm === a).length === 1) && JSON.stringify(p1) === JSON.stringify(p1b));
    chk('plan: B and C alternate order between rounds', buildPlan({ round: 'R5' }).map((x) => x.arm).join('') !== buildPlan({ round: 'R6' }).map((x) => x.arm).join(''));
    chk('task set: exactly ONE scenario (one prompts() pair, one fixture generator) for every run', Object.keys(F.prompts()).join() === 'phase1,phase2' && new Set(p1.map((p) => F.makeSpec({ seed: opts.seed, ...p }).pkg.replace(/-.*/, ''))).size === 1);
    chk('web fetch is deterministic: the oracle heading is the fixed example.com title', F.WEB_URL === 'https://example.com' && F.WEB_HEADING === 'Example Domain');
    { const PR = F.prompts(); const sha = (t) => crypto.createHash('sha256').update(t).digest('hex'); const banned = /curl|WebFetch|web_fetch|web_search|WebSearch|shell|Bash|browse/i;
      chk('R3.AC2 one prompt text for A, B and C (same sha) and none names a web tool or method', ['phase1', 'phase2'].every((k) => sha(PR[k]) === sha(F.prompts()[k])) && !banned.test(PR.phase1) && !banned.test(PR.phase2), `phase1 match: ${banned.exec(PR.phase1)?.[0]} phase2 match: ${banned.exec(PR.phase2)?.[0]}`);
      chk('R3.AC1 phase 1 no longer opts out of fetching (fetch-it-yourself wording and the "could not fetch" null clause are gone)', !/fetch it yourself|if you have a way|or null if you could not fetch/.test(PR.phase1) && /read the web page the ticket links to/.test(PR.phase1));
      chk('R3.AC3 SHELL_ALLOW has no curl/wget, SRT_EXTRA_DOMAINS has no example.com, A_TOOLS is the native default toolset', !SHELL_ALLOW.some((c) => /^(curl|wget)$/.test(c)) && !SRT_EXTRA_DOMAINS.includes('example.com') && A_TOOLS === 'default');
      chk('R3.AC3 C does not set nativeWebTools:false; B/C allowCommands carry no curl|wget', agentDef(ctxC, 'worker', false).nativeWebTools !== false && !(agentDef(ctxB, 'worker', false).nativeTooling.shell.allowCommands.some((c) => /curl|wget/.test(c))));
      chk('R3.AC4 w1_web is scored for every arm; an arm that cannot fetch gets webFinding', ['A', 'B', 'C'].every((a) => webCapability(a, []).web === true) && webCapability('B', []).canFetch === false);
      chk('R3.AC5 every arm declares its web surface', ['A', 'B', 'C'].every((a) => Array.isArray(webCapability(a, []).webSurface))); }
    chk('B and C get the same shell allowlist object (agentDef is shared)', JSON.stringify(agentDef(ctxB, 'worker', false).nativeTooling) === JSON.stringify(agentDef(ctxC, 'worker', false).nativeTooling));
    const pp = spawnSync(process.execPath, [SELF, '--print-plan'], { encoding: 'utf8' }); chk('`--print-plan` runs offline and exits 0', pp.status === 0 && /THINKING/.test(pp.stdout), `status ${pp.status} ${String(pp.stderr).slice(0, 200)}`);

    // ============ the driver's own helper tests and the oracle mutation test ============
    log('--- helper unit tests and oracle mutation test ---');
    const { runLibTests } = await import(pathToFileURL(path.join(HERE, 'libtest.mjs')).href); const lib = await runLibTests({ log: () => {} });
    chk(`lib self-test (cost model, parsers, scanner, sweep, plan, fixtures): ${lib.total - lib.failed.length}/${lib.total}`, lib.ok, lib.failed.slice(0, 3).map((f) => f.name).join(' | '));
    const lines2 = []; const mutOk = await checkOracle((m) => lines2.push(m)); chk(`oracle mutation test: ${lines2.filter((l) => /mutation/.test(l)).join(' ')}`, mutOk, lines2.join(' | ').slice(0, 300));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  const failed = results.filter((r) => !r.ok);
  log(`\nself-check: ${failed.length === 0 ? 'PASS' : 'FAIL'}  ${results.length - failed.length}/${results.length} checks  (0 model calls, no claude executed)`);
  return { ok: failed.length === 0, total: results.length, failed };
}

const LOG_PATH = path.join(REPO_ROOT, 'docs/agent/parity/EXPERIMENT-LOG.md');
export function currentScenarioSha() {
  const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 });
  return GT.scenarioSha({ prompts: F.prompts(), ticketText: F.ticketText(spec), expectations: F.expectedOf(spec) });
}
function previousScenarioSha(round, dir = LG.LEDGER_DIR) {
  const n = (r) => Number.parseInt(String(r).replace(/[^0-9]/g, ''), 10) || 0;
  let files = []; try { files = fs.readdirSync(dir).filter((f) => /^R\d+\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { /* none */ }
  for (const r of files.filter((x) => n(x) < n(round)).sort((a, b) => n(b) - n(a))) { try { const led = LG.readLedger(r, dir); if (led.scenarioSha) return led.scenarioSha; } catch { /* skip */ } }
  return null;
}
async function preflightOnce(opts) {
  const sdk = await loadSdk(opts.wt);
  const res = await PF.runPreflight(WEB_SURFACE, PF.DEFAULT_SPEC, (leg, spec) => PF.probeLegViaSdk(sdk, leg, spec));
  const receipt = PF.buildReceipt({ spec: PF.DEFAULT_SPEC, distEntry: path.join(opts.wt, 'entrypoint/agent-mcp/dist/src/index.js'), legs: res.legs });
  PF.writeReceipt(tmpRoot(opts.round), receipt);
  return res;
}
async function runPreflightMode(opts) {
  const res = await preflightOnce(opts);
  for (const l of res.legs) console.error(`preflight ${l.arm}: ${l.code} ${l.detail}`);
  console.log(JSON.stringify(res, null, 2)); return res.exitCode;
}
/** Live gates in GT.GATE_ORDER (ledger, scope, preflight, pacing): all read-only or zero-model; any red or throwing gate refuses. */
async function runLiveGates(opts) {
  return GT.runGates({
    ledger: () => { const r = LG.checkLedgerForLive(opts.round); return { ok: r.ok, reasons: r.reasons }; },
    scope: () => { const led = LG.readLedger(opts.round); let logText = ''; try { logText = fs.readFileSync(LOG_PATH, 'utf8'); } catch { /* none */ }
      return GT.checkScope({ scenarioSha: currentScenarioSha(), previousSha: led.scenarioSha || previousScenarioSha(opts.round), scopeChanges: led.scopeChanges, logText, startedAt: led.startedAt ?? new Date().toISOString() }); },
    preflight: async () => { const r = await preflightOnce(opts); return { ok: r.ok, reasons: r.legs.filter((l) => l.code !== 'GREEN' && l.code !== 'NOT_PROBEABLE').map((l) => `${l.arm}: ${l.code} ${l.detail}`) }; },
    pacing: () => ({ ok: true, reasons: [] }),   // the `claude -p /usage` reading is taken per run inside runOne (gatePacing), still before each reservation
  });
}
function loadRoundRecords(round) {
  const dir = path.join(tmpRoot(round), 'live/out/runs'); const by = {};
  try { for (const d of fs.readdirSync(dir)) { try { const r = readJson(path.join(dir, d, 'record.json')); by[String(r.runId ?? d)[0]] = r; } catch { /* skip */ } } } catch { /* none */ }
  return by;
}
/** `verdict --round` / `grid --round`: read-only over the round's records (and judge scores when present). */
function reportMode(opts) {
  const recs = loadRoundRecords(opts.round); const Q = (arm) => { try { return QL.qualityMean(readJson(path.join(tmpRoot(opts.round), 'judge', `${arm}.json`)).scores); } catch { return null; } };
  const sums = {}; for (const a of Object.keys(recs)) sums[a] = MT.summarize(recs[a], { genuine: GT.isGenuineSuccess(recs[a]), quality: Q(a) });
  const rv = MT.roundVerdict(sums);
  if (rv.verdict === 'VOID') for (const a of Object.keys(recs)) recs[a] = { ...recs[a], state: 'void' };
  if (opts.mode === 'grid') console.log(GR.renderGrid(recs, rv)); else console.log(MT.formatVerdict(rv));
  return 0;
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.mode) { console.error('usage: node drive.mjs --self-check | --print-plan | --check-oracle | --check-lib | --dry-run | --live --yes  [--out DIR] [--seed S] [--wt PATH] [--claude PATH]'); process.exit(2); }
  if (opts.mode === 'self-check') { const r = await selfCheck({ opts }); process.exit(r.ok ? 0 : 1); }
  if (opts.mode === 'check-oracle') { process.exit((await checkOracle()) ? 0 : 1); }
  if (opts.mode === 'check-lib') { const { runLibTests } = await import(pathToFileURL(path.join(HERE, 'libtest.mjs')).href); const r = await runLibTests({ log: console.log }); console.log(`lib self-test: ${r.ok ? 'PASS' : 'FAIL'} ${r.total - r.failed.length}/${r.total}`); process.exit(r.ok ? 0 : 1); }
  if (opts.mode === 'print-plan') { console.log(planText(opts)); return; }
  if (opts.mode === 'preflight') { process.exit(await runPreflightMode(opts)); }
  if (opts.mode === 'verdict' || opts.mode === 'grid') { process.exit(reportMode(opts)); }
  const dry = opts.mode === 'dry-run';
  if (!dry && !opts.yes) { console.error('--live spends real model quota (hard cap 3 runs per round). Re-run with --yes to confirm.'); process.exit(2); }
  opts.out = opts.out || path.join(tmpRoot(opts.round), dry ? 'dry/out' : 'live/out');
  if (!dry) {   // live: gates run BEFORE pacing and BEFORE any ledger reservation or `claude` spawn (R2.AC7); red => exit 3, nothing touched
    const g = await runLiveGates(opts);
    for (const r of g.results) console.error(`gate ${r.gate}: ${r.ok ? 'GREEN' : 'RED'} ${(r.reasons ?? []).join('; ')}`);
    if (!g.ok) { console.error(`LIVE REFUSED by gate ${g.failed} (exit 3); ledger untouched, no model call, no claude spawned`); process.exit(3); }
    LG.initRound(opts.round, { scenarioSha: currentScenarioSha() });
  }
  opts.realClaude = 'claude';
  if (dry) opts.claude = 'FAKE-SET-PER-RUN';
  const { records } = await runPlan(opts, dry);
  const bad = records.filter((r) => r.harnessFailure || r.aborted || r.invalidRun);
  process.exit(bad.length ? 1 : 0);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
export { rawRun, makeCtx, parseArgs, ancestorLeaks, runHidden, effectiveConfig, agentDef, providerFor, argvA, webCapability };
