// PARITY-INSTRUMENT-ONLY
// CLI-parity experiment driver (entrypoint/agent-mcp/parity). Private, unpublished measurement instrument. See README.md.
//   node drive.mjs --self-check | --print-plan | --check-oracle | --check-lib | --dry-run | --live --yes   [options]   (add --capture or PARITY_CAPTURE=1 to route model traffic through the wire-capture proxy, capture-proxy.mjs)
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
import * as CP from './capture-proxy.mjs';
import * as WD from './wire-diff.mjs';
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
  const o = { round: ROUND, mode: null, out: null, seed: '20261011', wt: DEFAULT_WT, claude: 'claude', yes: false, degraded: null, rep: 1, capture: process.env.PARITY_CAPTURE === '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (['--self-check', '--print-plan', '--check-oracle', '--check-lib', '--dry-run', '--live', '--reparse-judge', '--rejudge'].includes(a)) o.mode = a.slice(2);
    else if (['preflight', 'verdict', 'grid'].includes(a)) o.mode = a; else if (a === '--round') { o.round = v(); if (!ROUND_RE.test(o.round)) { console.error(`--round must match ${ROUND_RE} (it names the ledger file and the tmp dir), got ${JSON.stringify(o.round)}`); process.exit(2); } }
    else if (a === '--out') { o.out = path.resolve(v()); o.outExplicit = true; } else if (a === '--seed') o.seed = v(); else if (a === '--wt') o.wt = path.resolve(v()); else if (a === '--claude') o.claude = v();
    else if (a === '--rep') { o.rep = Number.parseInt(v(), 10); if (!(o.rep >= 1)) { console.error('--rep must be an integer >= 1'); process.exit(2); } } else if (a === '--run') o.run = v(); else if (a === '--yes') o.yes = true; else if (a === '--capture') o.capture = true; else if (a === '--degraded') o.degraded = v();
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
 * R8 round profile (SCOPE-R8-model-alias, SCOPE-R8-B-only). The module pins (F.PIN_MODEL for the arms, JG.JUDGE_MODEL for the judge) stay the defaults of every round; a round whose
 * tracked ledger carries a `profile` (ledger.profileOf, fail closed) re-points the arms, the model alias, the judge model, the explicit effort and wire capture for THAT round only.
 * `arms: null` = the default A,B,C plan.
 */
export function defaultProfile() { return { arms: null, armAWaiver: null, model: F.PIN_MODEL, judgeModel: JG.JUDGE_MODEL, effort: null, capture: false, source: 'module pins (F.PIN_MODEL, JG.JUDGE_MODEL)' }; }
export function roundProfile(opts = {}) {
  const round = opts.round ?? ROUND; const p = LG.profileOf(LG.readLedger(round, opts.ledgerDir ?? LG.LEDGER_DIR));   // throws LedgerError on a malformed profile (fail closed)
  const d = defaultProfile();
  return p ? { ...d, ...p, model: p.model ?? d.model, judgeModel: p.judgeModel ?? d.judgeModel, source: `parity/ledger/${round}.json profile` } : d;
}
/** The model the run's arms are launched with: the profile's (an alias such as `haiku`, or a concrete id), else the module pin. */
const modelOf = (ctx) => ctx.profile?.model ?? MODEL;
const effortOf = (ctx) => ctx.profile?.effort ?? null;
/**
 * R8-effort: how the explicit effort level reaches each arm (probed 2026-10-12 with the real claude 2.1.296 behind the capture proxy and a local mock upstream, no model call:
 * --effort high and CLAUDE_CODE_EFFORT_LEVEL=high both put `output_config: {"effort":"high"}` on the /v1/messages request; with neither the request carries "medium" for claude-haiku-5-5).
 *  A: `claude -p --effort <level>` (argvA).  B: CLAUDE_CODE_EFFORT_LEVEL=<level> in the agent-mcp server env, inherited by every claudecli child (claudecli.ts buildSubprocessEnv copies process.env;
 *  the session denylist does not list it); the engine adds no --effort flag.  C: NOT SETTABLE: providers/anthropic.ts builds the request without output_config / effort, so the API default governs.
 */
export const EFFORT_MECHANISM = Object.freeze({
  A: 'claude -p --effort <level> (argvA)',
  B: 'CLAUDE_CODE_EFFORT_LEVEL=<level> in the agent-mcp server env, inherited by the claudecli child (serverEnv -> claudecli.ts buildSubprocessEnv)',
  C: 'NOT SETTABLE: providers/anthropic.ts sends no output_config/effort field; the API default governs (verify on the wire)',
});
/** The env that carries the explicit effort level to an arm ({} unless the round profile sets one; only B takes it through the environment). */
export function effortEnv(ctx) { const e = effortOf(ctx); return e && ctx.runDef.arm === 'B' ? { CLAUDE_CODE_EFFORT_LEVEL: e } : {}; }
/**
 * R7-think AC1 (owner direction, SCOPE-R7-thinking-default): thinking is NOT forced on any arm. Every arm runs the model's DEFAULT thinking behaviour.
 *  - Arm A (native `claude -p`): the spawn env carries no MAX_THINKING_TOKENS / CLAUDE_CODE_DISABLE_THINKING (lib.cleanEnv is an allowlist that does not pass them
 *    from the operator's shell either), and argvA has no thinking/effort flag.
 *  - Arm B (agent-mcp claudecli provider): the agent-mcp server env carries neither variable; claudecli.ts buildSubprocessEnv() copies process.env into every `claude` child.
 *  - Arm C (agent-mcp anthropic provider): the provider sends no `thinking` request field (anthropic.ts), so the API default for the model governs.
 * Thinking is a measured, report-only metric: record.thinking = { configured, observedThinkingTurns, parentTurns, allTasks } (thinkingObservation), and the
 * thinking-turn counts appear in SUMMARY.md, the verdict line and the grid metric line. It never invalidates, voids or gates a run.
 */
export const THINKING_POLICY = 'model default on every arm; not forced';
export const THINKING_MECHANISM = Object.freeze({
  A: 'model default (no MAX_THINKING_TOKENS / CLAUDE_CODE_DISABLE_THINKING in the `claude -p` spawn env; no thinking/effort flag in argv)',
  B: 'model default (no MAX_THINKING_TOKENS / CLAUDE_CODE_DISABLE_THINKING in the agent-mcp server env, which every claudecli `claude` child inherits; claudecli.ts:818-833 copies process.env)',
  C: 'model default (the anthropic provider sends no `thinking` request field; the API default for the model governs)',
});
const MAX_TOOL_LOOPS = 40;                                                 // B/C; A (claude 2.1.296) has no --max-turns: recorded as an asymmetry
// R6-prep AC2 (owner direction: "drop all restrictions until you get the system working"): B and C run the PRODUCT DEFAULT shell allowlist
// (agent-core-native-tooling DEFAULT_SHELL_ALLOW_COMMANDS, which includes curl). The instrument no longer passes allowCommands, so the product default applies.
// This supersedes the R3 rule "no curl/wget on the allowlist". The task prompt still names no tool or method.
export const SHELL_POLICY = 'product default (no instrument allowCommands override; includes curl)';
/** R6-prep AC2: the instrument adds NO srt domain and pre-writes NO srt policy; agent-mcp's default (open egress via its allow-all loopback proxy) applies. */
export const SRT_EXTRA_DOMAINS = [];
/**
 * R6-prep AC2: the egress mode a finished B/C run actually had, read from the server's own startup line ("Shell egress: open|restricted ...", index.ts)
 * and cross-checked against the per-run srt policy file the server provisioned (adhdManaged.httpProxyPort present => open). Pure; fail-closed to 'unknown'.
 */
export function egressFactOf(srtPolicyText, stderrText) {
  const line = (String(stderrText || '').match(/Shell egress: (open|restricted)[^\n"]*/) || [null])[0];
  let pol = null; try { pol = JSON.parse(srtPolicyText); } catch { /* absent or unreadable */ }
  const fromPolicy = pol ? (pol.adhdManaged?.httpProxyPort !== undefined && pol.network?.httpProxyPort === pol.adhdManaged.httpProxyPort ? 'open' : 'restricted') : null;
  const fromLine = line ? (line.startsWith('Shell egress: open') ? 'open' : 'restricted') : null;
  const mode = fromPolicy && fromLine && fromPolicy !== fromLine ? 'unknown' : (fromPolicy ?? fromLine ?? 'unknown');
  return { mode, startupLine: line, policyMode: fromPolicy, proxyPort: pol?.adhdManaged?.httpProxyPort ?? null, allowedDomains: pol?.network?.allowedDomains ?? null };
}
/** R3: arm A runs the native default toolset (`claude --tools default`), nothing instrument-added. */
const A_TOOLS = 'default';
/** Declared web surface per arm as shipped (R3.AC5/AC6, R2.AC1). `probe` is set only for a fetch tool reachable at zero model cost; none is, as of this port (U5 open). */
export const WEB_SURFACE = Object.freeze({
  A: { tools: ['WebFetch', 'WebSearch'], why: 'native WebFetch makes a hidden small-model call: not a zero-model probe' },
  B: { tools: [], shellFetch: true, why: 'claudecli bridges only agent-mcp tools; since R5-WEB-SIMPLE the product default shell allowlist includes curl and egress is open, so the shell is B\'s fetch path (R6-prep AC2); not a zero-model probe' },
  C: { tools: ['web_fetch', 'web_search'], shellFetch: true, why: 'server-executed by the API: not probeable at zero model cost' },
});
const WORKER_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
// R7-model: per-invocation `claude -p --max-budget-usd` guard. Sized from measured haiku-4-5 arm-A cost (EXPERIMENT-LOG: A1 $0.2315-$0.2930 per full run) x ~2 (sonnet-5-5 list $2/$10 vs haiku $1/$5) = ~$0.60 per run, so 1.50 still leaves >2x headroom.
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
export const repoFilesOf = (repoDir) => Object.fromEntries(['docs/shipping.md', 'CHANGELOG.md', 'examples/usage.md', 'src/checkout.js', 'src/summary.js'].map((f) => [f, readIf(path.join(repoDir, f))]));

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
  const profile = roundProfile(opts);
  const spec = F.makeSpec({ seed: opts.seed, arm: runDef.arm, rep: runDef.rep, pin: profile.model });
  const outRoot = opts.out ?? path.join(tmpRoot(opts.round ?? ROUND), 'live/out');
  const runDir = path.join(outRoot, 'runs', spec.runId);
  // The arm's cwd must sit outside any repo / agent-instruction file (ancestorLeaks): repo-root tmp/ is inside this checkout, so it lives under the OS temp dir.
  const work = opts.outExplicit ? path.join(outRoot, 'work', spec.runId) : path.join(os.tmpdir(), 'adhd-agent-mcp-parity', opts.round ?? ROUND, 'work', spec.runId);
  return { opts, dry, spec, runDef, runDir, work, profile, repoDir: path.join(work, 'repo'), hiddenDir: path.join(work, 'hidden'), ticketFile: path.join(work, 'ticket.txt'),
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
    '--tools', A_TOOLS, '--setting-sources', 'project', '--system-prompt', ctx.spec.systemPrompt, '--agents', JSON.stringify(agentsJson(ctx)), '--max-budget-usd', BUDGET_GUARD_USD, '--model', modelOf(ctx)];
  if (effortOf(ctx)) a.push('--effort', effortOf(ctx));
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
/** The exact env of every arm-A `claude -p` turn (thinking is the model default: no thinking variable is set). */
/**
 * R6B-proxy AC4: the base-URL env that routes an arm's model traffic through the capture proxy ({} unless --capture / PARITY_CAPTURE=1 started one).
 *  A: the `claude -p` spawn env.  B: the agent-mcp server env, copied into every claudecli child by claudecli.ts buildSubprocessEnv (process.env copy, lines 818-833).
 *  C: the agent-mcp server env; the Anthropic SDK in providers/anthropic.ts buildAnthropicClient reads ANTHROPIC_BASE_URL itself (it never passes the resolved
 *  ADHD_AGENT_ANTHROPIC_BASE_URL to the client, so that variable would be inert).  openai/deepseek base URLs carry /v1 because config.ts normalizeBaseUrl only adds it to a bare host.
 */
export function captureEnv(ctx) {
  const c = ctx.capture; if (!c) return {};
  const arm = ctx.runDef.arm;
  const env = { ANTHROPIC_BASE_URL: c.baseUrl(arm, 'anthropic') };
  if (arm !== 'A') { env.ADHD_AGENT_OPENAI_BASE_URL = `${c.baseUrl(arm, 'openai')}/v1`; env.ADHD_AGENT_DEEPSEEK_BASE_URL = `${c.baseUrl(arm, 'deepseek')}/v1`; }
  return env;
}
export function armAEnv(ctx) { return L.cleanEnv({ ...L.CLAUDECLI_PROVIDER_ENVS, ...(ctx.dry ? ctx.fakeEnv : {}), ...captureEnv(ctx) }); }
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

/** The exact env of the agent-mcp server (arms B and C). For B it is inherited by every claudecli `claude` child (thinking is the model default: no thinking variable is set). */
export function serverEnv(ctx, store, logs) {
  return L.cleanEnv({
    ADHD_AGENT_DATABASE_PATH: path.join(store, 'agents.db'), ADHD_AGENT_REGISTRY_DB_PATH: path.join(store, 'registry.db'),
    ADHD_AGENT_TRANSPORT: 'stdio', ADHD_AGENT_SSE_ENABLED: 'false', ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true',
    ADHD_AGENT_LOGGING_DIR: logs, ADHD_AGENT_LOGGING_API: 'on', ADHD_AGENT_LOGGING_INSTANCE_LABEL: ctx.spec.runId,
    ADHD_AGENT_BUDGET_MAX_CALLS: '0', ADHD_AGENT_SRT_SETTINGS: path.join(ctx.runDir, 'srt-policy.json'),
    ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_ROOTS: JSON.stringify({ repo: ctx.repoDir }),
    ...(ctx.dry ? { ADHD_AGENT_ANTHROPIC_SECRET: 'dry-run-not-a-secret', ANTHROPIC_BASE_URL: ctx.fakeAnthropicUrl || 'http://127.0.0.1:9', NODE_OPTIONS: `--require ${path.join(HERE, 'dryrun/egress-guard.cjs')}`, R2_EGRESS_LOG: path.join(ctx.runDir, 'egress-blocked.log') } : {}),
    ...effortEnv(ctx),
    ...captureEnv(ctx),
  });
}
async function startServer(ctx) {
  const { Client, StdioClientTransport } = await loadSdk(ctx.opts.wt);
  const entry = path.join(ctx.opts.wt, 'entrypoint/agent-mcp/dist/src/index.js');
  if (!fs.existsSync(entry)) throw new Error(`built agent-mcp missing: ${entry} (run the nx build in the plan worktree)`);
  const store = path.join(ctx.runDir, 'store'); fs.mkdirSync(store, { recursive: true });
  const logs = path.join(ctx.runDir, 'logs');
  // R6-prep AC2: NO pre-written srt policy. ADHD_AGENT_SRT_SETTINGS only points the server at an isolated, initially absent per-run file; agent-mcp provisions it
  // (default egress OPEN via its allow-all loopback proxy). The mode it picked is read back after the run (egressFactOf) and recorded.
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
  if (arm === 'B') return { type: 'claudecli', model: modelOf(ctx), claudePath: ctx.opts.claude, timeoutMs: 20 * 60 * 1000 };
  const p = { type: 'anthropic', model: modelOf(ctx), timeoutMs: 10 * 60 * 1000 };
  return p;
}
function agentDef(ctx, name, parent) {
  const def = { name, description: parent ? 'Round 2 parent agent' : 'Round 2 worker subagent', provider: providerFor(ctx, ctx.runDef.arm), systemPrompt: ctx.spec.systemPrompt, maxToolLoops: MAX_TOOL_LOOPS,
    nativeTooling: { fs: true, shell: true, dispatch: true } };   // shell: true => product default allowlist (R6-prep AC2)
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
    res.shellEgress = egressFactOf(readIf(path.join(ctx.runDir, 'srt-policy.json')), srv.getStderr());
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
  if (ctx.runDef.arm === 'C' || ctx.opts.capture) {   // with capture on, A/B also get the fake upstream so the fake claude's wire probe is answered locally, never by the real API
    const { startFakeAnthropic } = await import(pathToFileURL(path.join(HERE, 'dryrun/fake-anthropic.mjs')).href);
    ctx.fake = await startFakeAnthropic({ mode, log: () => {} }); ctx.fakeAnthropicUrl = ctx.fake.url;
  }
}
async function teardownFakes(ctx) { if (ctx.fake) await ctx.fake.close(); }

// ----------------------------------------------------------------------------------------------------------------
// One run
// ----------------------------------------------------------------------------------------------------------------
/** Every file under `dir` (posix-relative path -> sha256), skipping `.git`; sorted. The pre-phase-1 tree manifest (R5-workdir AC3). */
export function treeManifest(dir) {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' && rel === '') continue;
    const r = rel ? `${rel}/${e.name}` : e.name; const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, r); else out[r] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } };
  if (fs.existsSync(dir)) walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
/** Files in the repo dir that the fixture does not define (R5-workdir AC2). Empty means pristine. */
export function strayFiles(repoDir, spec) {
  const known = new Set(Object.keys(F.repoFiles(spec)));
  return Object.keys(treeManifest(repoDir)).filter((f) => !known.has(f));
}
/** Fail closed: throws when the repo dir holds anything the fixture did not write (a prior attempt's output must never reach a new run). */
export function assertPristineRepo(repoDir, spec) {
  const stray = strayFiles(repoDir, spec);
  if (stray.length) throw new Error(`work dir is not pristine: ${stray.length} file(s) outside the fixture (${stray.slice(0, 5).join(', ')}): refusing before any model spend (R5-workdir AC2)`);
}
/**
 * R5-workdir AC1: each attempt of a runId gets a work dir that has never been used. The base is `.../work/<runId>`; the attempt suffix starts at the number of
 * ledger entries (runs + releases) already recorded for the runId, so it survives restarts, and is then bumped past any dir that exists on disk. Nothing is deleted.
 * `ctx.workFixed` is a test seam that keeps the dir the caller chose.
 */
export function assignWorkDir(ctx) {
  if (ctx.workFixed) return ctx.work;
  let n = 0;
  try { const led = LG.parseLedger(fs.readFileSync(ctx.ledgerPath, 'utf8'), ctx.ledgerPath); n = led.runs.filter((r) => r.runId === ctx.spec.runId).length + (led.releases || []).filter((r) => r.runId === ctx.spec.runId).length; } catch { /* no ledger (dry-run): the on-disk bump below still guarantees freshness */ }
  const base = path.join(path.dirname(ctx.work), ctx.spec.runId);
  let work = `${base}-a${n + 1}`;
  while (fs.existsSync(work)) { n += 1; work = `${base}-a${n + 1}`; }
  ctx.work = work; ctx.repoDir = path.join(work, 'repo'); ctx.hiddenDir = path.join(work, 'hidden'); ctx.ticketFile = path.join(work, 'ticket.txt'); ctx.infoLog = path.join(work, 'info-calls.log');
  return work;
}
async function prepare(ctx) {
  fs.mkdirSync(ctx.runDir, { recursive: true });
  assignWorkDir(ctx);
  const leaks = ancestorLeaks(ctx.work);
  if (leaks.length) throw new Error(`fixture directory sits under agent-instruction/repo files: ${leaks.join(', ')}`);
  ctx.expected = F.writeFixture({ repoDir: ctx.repoDir, hiddenDir: ctx.hiddenDir, ticketFile: ctx.ticketFile }, ctx.spec);
  assertPristineRepo(ctx.repoDir, ctx.spec);
  ctx.preManifest = treeManifest(ctx.repoDir);
}

// ----------------------------------------------------------------------------------------------------------------
// HARD CAP: at most RUN_CAP (3) agent runs per round (parity/ledger.mjs; tracked per-round file, fail closed). Every live model-spawning path goes through rawRun().
/** Reserve one run BEFORE anything is spawned (delegates to ledger.reserveRun: approvedBy, A first, cap 3, extraRunReason for 4+). */
export function reserveModelRun(runId, { ledgerPath = LEDGER_PATH } = {}) {
  const round = path.basename(ledgerPath, '.json');
  return LG.reserveRun(round, { arm: String(runId)[0], runId, dir: path.dirname(ledgerPath) });
}
/**
 * R5-harness AC3/AC5: a live fault before the reservation (so before any spawn) is a harness fault, not a run: nothing is reserved, the record is marked `aborted`
 * (isFinishedRecord then retries the arm) and it is never recorded as an arm-A void. Returns true when the record was marked. A fault after the reservation is NOT marked (the run is spent).
 */
export function markPreSpawnFault(ctx, record, e) {
  if (ctx.dry || ctx.modelRun) return false;
  record.aborted = [`harness fault before any model call (nothing reserved, retryable): ${String(e?.message || e).slice(0, 300)}`];
  return true;
}
/**
 * R8-model AC1/AC3: what model a run actually used. `requested` is what the arm was launched with (an alias such as `haiku`, or a concrete id); `resolved` is the concrete id(s) the
 * RESPONSES reported (turn models; hidden helper calls are `sideModels`); `wire` (capture on) carries the request-body models. The run is PRICED by the resolved id's rate card (lib.mjs
 * ratesForModel); a resolved id with no card is unmeasured, never another model's price. Pure; the warnings are surfaced on the record, never a void rule.
 */
export function modelFacts({ requested, resolved = [], sideModels = [], wire = null }) {
  const alias = LG.isModelAlias(requested); const warnings = [];
  const pricing = resolved.map((m) => { const c = L.rateCardFor(m); return { model: m, card: c?.model ?? null, source: c?.source ?? null, tierOverrideNotApplied: c?.tierOverride ?? null }; });
  if (!resolved.length) warnings.push(`no response model id was observed for requested model "${requested}": the run cannot be priced by its resolved id`);
  if (alias) for (const m of resolved) if (!O.pinMatches(m, requested)) warnings.push(`resolved model ${m} is outside the family of the alias "${requested}"`);
  if (resolved.length > 1) warnings.push(`more than one resolved model id answered the conversation turns: ${resolved.join(', ')}`);
  for (const p of pricing) if (!p.card) warnings.push(`no rate card for resolved model ${p.model}: cost is unmeasured (R7-model AC3)`);
  const wireMain = wire?.mainModels ?? [];
  if (wire && wireMain.length && resolved.length && wireMain.some((m) => !resolved.includes(m))) warnings.push(`wire request model(s) [${wireMain.join(', ')}] differ from the response model(s) [${resolved.join(', ')}]`);
  return { requested, alias, resolved, sideModels, wire: wire ? { mainModels: wire.mainModels, sideModels: wire.sideModels } : null, pricing, warnings };
}
/**
 * R8-effort: the explicit effort the arm was configured with versus what the wire carried. Main requests (those declaring tools) are checked; the CLI's tool-less side calls are listed apart.
 * status: not-requested | unverified (capture off) | unobserved (no request reached the proxy) | verified | mismatch | not-settable (arm C: no effort field exists, the API default governs).
 */
export function effortFacts({ requested, arm, wire = null }) {
  const mechanism = requested ? EFFORT_MECHANISM[arm].replace('<level>', requested) : null; const base = { requested: requested ?? null, arm, mechanism, observed: wire ? wire.mainEfforts : null, sideObserved: wire ? wire.sideEfforts : null };
  if (!requested) return { ...base, status: 'not-requested' };
  if (!wire) return { ...base, status: 'unverified', detail: 'capture off: the configured mechanism was applied, nothing was observed on the wire' };
  if (!wire.mainRequests) return { ...base, status: 'unobserved', detail: 'no tool-declaring model request reached the capture proxy' };
  const all = wire.mainEfforts;
  if (all.length && all.every((e) => e === requested)) return { ...base, status: 'verified', detail: `every one of ${wire.mainRequests} main request(s) carried effort ${requested}` };
  if (arm === 'C' && all.every((e) => e == null)) return { ...base, status: 'not-settable', detail: `arm C sends no effort field (${wire.mainRequests} main request(s)); the API default governs, which is not necessarily ${requested}` };
  return { ...base, status: 'mismatch', detail: `configured ${requested}, wire carried [${all.map((e) => e ?? 'none').join(', ')}] on ${wire.mainRequests} main request(s)` };
}
/** The wire facts of this run's arm from the capture logs (null when capture was off or nothing was written). */
function wireFactsOf(ctx) {
  if (!ctx.captureInfo?.outDir) return null;
  try { const files = WD.resolveWireFiles([ctx.captureInfo.outDir]); if (!files.length) return null; return WD.wireFactsFor(WD.analyzeWire(files), ctx.runDef.arm); } catch { return null; }
}
/** Discard port: nothing listens there, so a dry-run proxy request that reaches it fails with a logged 502 instead of leaving the machine. */
export const DRY_SINK = 'http://127.0.0.1:9';
/**
 * The upstreams the capture proxy forwards to. Live: the real provider endpoints (env overrides honoured). Dry-run: NEVER a real endpoint: the fake Anthropic server
 * for anthropic when one is running, a discard sink otherwise and for openai/deepseek (the proxy lives in the driver process, outside the server's egress guard).
 */
export function captureUpstreams(ctx, env = process.env) {
  if (!ctx.dry) return CP.upstreamsFromEnv(env);
  return { anthropic: ctx.fakeAnthropicUrl || DRY_SINK, openai: DRY_SINK, deepseek: DRY_SINK };
}
/** R6B-proxy AC4: start the capture proxy for this run (logs/wire), calibrate its overhead against a local mock, and keep the facts for the run record. */
async function startCapture(ctx) {
  const wire = path.join(ctx.runDir, 'logs', 'wire');
  const upstreams = captureUpstreams(ctx);
  const overhead = await CP.measureOverhead({ outDir: path.join(ctx.runDir, 'logs', 'wire-calibration') });
  ctx.capture = await CP.startCaptureProxy({ outDir: wire, upstreams, sessionId: ctx.spec.runId });
  ctx.captureInfo = { on: true, outDir: wire, arm: ctx.runDef.arm, url: ctx.capture.url, upstreams: Object.fromEntries(Object.entries({ ...CP.upstreamsFromEnv({}), ...upstreams }).map(([k, v]) => [k, new URL(v).origin])), baseUrlEnv: Object.keys(captureEnv(ctx)), proxyOverheadP50Ms: overhead };
}
async function rawRun(ctx) {
  // Deterministic, spawn-free preparation first: a fault here (R5-harness AC3) must not consume a ledger slot.
  await prepare(ctx);
  // The cap is enforced HERE, immediately before any process that could call a model is spawned.
  if (!ctx.dry) ctx.modelRun = reserveModelRun(ctx.spec.runId, { ledgerPath: ctx.ledgerPath ?? LEDGER_PATH });
  if (ctx.dry) await setupFakes(ctx);
  if (ctx.opts.capture) await startCapture(ctx);
  try { return await (ctx.executor ?? (ctx.runDef.arm === 'A' ? runArmA : runArmBC))(ctx); }
  finally { if (ctx.capture) { await ctx.capture.close(); ctx.capture = null; } if (ctx.dry) await teardownFakes(ctx); }
}

/** Idempotent resume: a run is finished only if its record exists and was NOT aborted (a pacing/cap abort wrote a record but ran nothing, and must be retried once the window resets). */
export function isFinishedRecord(recordPath) { try { const r = readJson(recordPath); return !r.aborted; } catch { return false; } }
/**
 * Thinking observation (R7-think AC1): REPORT-ONLY. Counts thinking blocks in any task of the run (parent or worker); it has no pass/fail verdict and never
 * invalidates a run. `observedThinkingTurns` is the larger of the parent-phase count and the all-tasks count.
 */
export function thinkingObservation(metrics) {
  const parentTurns = (metrics.phases || []).reduce((a, m) => a + (m.thinkingTurns || 0), 0); const allTasks = metrics.thinkingBlocksAllTasks ?? 0;
  return { configured: THINKING_POLICY, observedThinkingTurns: Math.max(parentTurns, allTasks), parentTurns, allTasks };
}
/** Pacing gate: read the 5h/7d window via `claude -p /usage` (0 model calls, asserted by L.readUsageWindow). Refuses at 5h session usage >= 90% (the 7-day window is no longer checked), and fails CLOSED when the reading cannot be taken or parsed. */
export function gatePacing(read, rateLimitsSeen = []) {
  let reading;
  try { reading = read(); } catch (e) { return { ok: false, reading: null, verdict: { ok: false, reasons: [`/usage unreadable: ${String(e.message || e).slice(0, 200)}`], warnings: 0 } }; }
  if (!Number.isFinite(reading?.session_pct) ) return { ok: false, reading, verdict: { ok: false, reasons: ['/usage reading has no numeric session percentage'], warnings: 0 } };
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
const sumUsd = (turns) => (turns.some((t) => t.usd == null) ? null : rd(turns.reduce((s, t) => s + t.usd, 0)));   // R7-model AC3: any unpriced turn (no rate card) makes the sum null = unmeasured, never a partial number

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
    // SCOPE-R5-oracle-model-and-leak: `models` = TURN models only (init + assistant turns, parent and child); modelUsage keys with no assistant turn are hidden helper calls (e.g. WebFetch's summariser) = informational `sideModels`.
    models: [...new Set([p.init?.model, ...turns.map((t) => t.model)].filter(Boolean))],
    sideModels: [...new Set(Object.keys(r?.modelUsage || {}).filter((m) => ![p.init?.model, ...turns.map((t) => t.model)].includes(m)))], tools,
    rate: p.rate.map(L.rateLimitFromCli), parallel: L.parallelFromCliEvents(events) };
}
function totalsOf(turns) { return L.sumNorm(turns); }

/** Run-level call list for the detectors (parent AND worker calls, tool_use ids, phase, depth); results capped like the observation's. */
function trimCalls(calls) { return calls.map((c) => ({ ...c, resultText: c.resultText == null ? null : String(c.resultText).slice(0, 600) })); }

export function analyzeA(ctx, raw) {
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
  obs.sideModels = [...new Set(ph.filter(Boolean).flatMap((a) => a.sideModels))].filter((m) => !obs.models.includes(m));
  obs.phase2.workerCalls = ph[1] ? L.allCallsFromCliStream(ph[1].p).filter((c) => c.depth > 0).map((c) => ({ name: c.name, input: c.input, isError: c.isError })) : [];
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
  return { obs: O.applyReplySelection(obs, e), metrics };   // R5-reply AC1: one reply-selection rule for every arm
}

/** Can this arm fetch a page at all? A web tool in its tool list, or (A) an unrestricted Bash, or a shell allowlist that admits curl/wget (B/C: the product default shell allowlist includes curl). */
function webCapability(arm, tools) {
  // R3.AC4: no arm is exempt. w1_web is scored for every arm (web:true => scored); an arm that cannot fetch as shipped fails it
  // and the record carries webFinding "arm cannot fetch" (a product finding, not an instrument defect).
  const names = tools.map(String);
  const canFetch = names.some((t) => /(^|__)(web_fetch|WebFetch)$/.test(t)) || (WEB_SURFACE[arm]?.tools ?? []).some((t) => /^(web_fetch|WebFetch)$/.test(t));
  // R6-prep AC2: B/C also fetch through the product-default shell (curl, open egress); A's unrestricted Bash is not declared here (it has native WebFetch).
  const shellFetch = WEB_SURFACE[arm]?.shellFetch === true;
  return { web: true, webVia: canFetch ? 'tool' : shellFetch ? 'shell' : null, canFetch: canFetch || shellFetch, webSurface: [...new Set([...(WEB_SURFACE[arm]?.tools ?? []), ...(shellFetch ? ['shell:curl'] : []), ...names.filter((t) => /(web_|Web)/.test(t))])] };
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
    const turns = http.map((t, i) => { const n = L.normUsage(t.sse?.usage); return { idx: i + 1, id: t.sse?.id, parent: null, model: t.sse?.model, ...n, ctx: L.turnContextOf(t.sse), ctxBasis: t.sse?.startUsage ? 'message_start' : 'usage', stop: t.sse?.stop, tools: (t.sse?.toolUses || []).map((u) => u.name), thinkingBlock: !!t.sse?.thinking, usd: L.priceNorm(n, L.ratesForModel(t.sse?.model)).usd }; });
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
  obs.sideModels = [...new Set(ph.filter(Boolean).flatMap((s) => s.sideModels ?? []))].filter((m) => !obs.models.includes(m));   // C: no hidden-call visibility, always []
  obs.phase2.workerCalls = allCalls.filter((c) => c.phase === 2 && c.depth > 0).map((c) => ({ name: c.name, input: c.input, isError: c.isError }));
  const first = ph[0]; const firstTurn = first?.turns[0];
  // R1.AC2 (90758419 AC1): B = cache numbers of the root-task streams; C = does the first phase-2 request contain the phase-1 get_ticket result (the cache fields stay unset for C so the oracle scores it on the request rule).
  obs.cache = { firstTurnCacheRead: firstTurn?.cr ?? null, gapSeconds: null, ...(arm === 'B' && ph[0] && ph[1] ? L.cacheCarryFromTurns(ph[0].turns, ph[1].turns) : {}), ...(arm === 'C' && ph[0] && ph[1] ? { phase2FirstRequestHasTicket: L.ticketCarriedToPhase2(ph[0].http, ph[1].http) } : {}) };
  metrics.allCalls = trimCalls(allCalls);
  const p1 = metrics.phases[0]; const p2 = metrics.phases[1];
  const depth1 = (p1?.children || []).filter((c) => c.depth === 1), depth2 = (p1?.children || []).filter((c) => c.depth >= 2);
  // R5-scorefix AC1: score the INTENDED parallel pair (the first dispatch group of 2+ child rows), not an N-way intersection over every depth-1 row
  const pair = L.intendedPairOverlap(depth1.map((c) => ({ id: c.id, createdAt: c.createdAt, completedAt: c.completedAt })));
  const ov = pair.overlapMs;
  obs.dispatch = { p1Workers: depth1.length, p1Grandchildren: depth2.length, p2Workers: (p2?.children || []).filter((c) => c.depth === 1).length, p1Parallel: first ? { sameTurn: first.parallel.sameTurn, overlapMs: ov, pairBasis: pair.basis, pairRows: pair.group } : null };
  if (p1) obs.attr = { kind: 'tree', taskCount: p1.subtree.taskCount, directTotal: p1.subtree.directTokens, subtreeTotal: p1.subtree.subtreeTokens, rootTaskId: null, childRows: (p1.children || []).map((c) => ({ parentTaskId: c.parent, depth: c.depth })) };
  metrics.rateLimits = ph.filter(Boolean).flatMap((s) => s.rate).filter(Boolean);
  metrics.initTools = first?.tools ?? [];
  metrics.toolNamesServer = raw.toolNames;
  metrics.phase2Evidence = { stdin: ph[1]?.stdin ?? null, sessionId: raw.sessionId, storeLine: raw.storeLine };
  metrics.warnings.push(...(raw.preexisting ? [`agents pre-existed in the isolated store: ${raw.preexisting}`] : []));
  return { obs: O.applyReplySelection(obs, e), metrics };   // R5-reply AC1: one reply-selection rule for every arm
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
  const usageReading = () => ctx.dry && !process.env.R2_DRY_REAL_USAGE ? { session_pct: 0, week_pct: 0, resets: null, model_calls: 0, at: nowIso(), stubbed: true } : L.readUsageWindow({ claude: ctx.dry ? (ctx.opts.realClaude || 'claude') : ctx.opts.claude, model: modelOf(ctx) });
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
    if (markPreSpawnFault(ctx, record, e)) { record.workDir = ctx.work; record.preManifest = ctx.preManifest ?? null; record.wallMs = Date.now() - t0; record.finishedAt = nowIso(); writeJson(path.join(ctx.runDir, 'record.json'), record); return { record, aborted: true }; }
  }
  if (ctx.captureInfo) record.capture = ctx.captureInfo;
  record.workDir = ctx.work; record.preManifest = ctx.preManifest ?? null;
  record.wallMs = Date.now() - t0; record.finishedAt = nowIso();
  record.sweep = await sweepOwned(`after ${ctx.spec.runId}`);
  if (analysis) {
    const { obs, metrics } = analysis;
    obs.cache.gapSeconds = ctx.gapSeconds ?? null;
    record.observation = { ...obs, phase1: { ...obs.phase1, calls: obs.phase1.calls.map((c) => ({ ...c, resultText: (c.resultText || '').slice(0, 600) })) }, phase2: { ...obs.phase2, calls: obs.phase2.calls.map((c) => ({ ...c, resultText: (c.resultText || '').slice(0, 600) })) } };
    record.score = O.scoreObservation(obs, ctx.expected);
    record.metrics = metrics; record.warnings.push(...metrics.warnings);
    // thinking: model default on every arm (R7-think AC1); the observation is a report-only record field, never an invalid/void rule
    record.thinking = thinkingObservation(metrics);
    const wire = wireFactsOf(ctx);
    record.model = modelFacts({ requested: modelOf(ctx), resolved: obs.models ?? [], sideModels: obs.sideModels ?? [], wire }); record.warnings.push(...record.model.warnings.map((w) => `MODEL: ${w}`));
    record.effort = effortFacts({ requested: effortOf(ctx), arm, wire }); if (record.effort.status === 'mismatch') record.warnings.push(`EFFORT MISMATCH: ${record.effort.detail}`);
    record.webSurface = obs.capabilities?.webSurface ?? null;
    if (obs.capabilities && obs.capabilities.canFetch === false) record.webFinding = 'arm cannot fetch';
    state.rateLimitsSeen.push(...(metrics.rateLimits || []).slice(-2));
    if (arm !== 'A') { record.shellEgress = raw.shellEgress ?? egressFactOf('', ''); if (record.shellEgress.mode !== 'open') record.warnings.push(`Shell egress is ${record.shellEgress.mode}, expected open (product default): ${JSON.stringify(record.shellEgress)}`); }
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
  return { model: modelOf(ctx), ...(LG.isModelAlias(modelOf(ctx)) ? { modelResolution: `"${modelOf(ctx)}" is an alias the claude CLI resolves at run time; the resolved id is read from the response and recorded in record.model, and the run is priced by it` } : {}), ...(effortOf(ctx) ? { effort: `${effortOf(ctx)} explicit: ${EFFORT_MECHANISM[arm0(ctx)].replace('<level>', effortOf(ctx))}` } : {}), maxToolLoops: arm0(ctx) === 'A' ? 'n/a (claude 2.1.296 has no --max-turns; guard --max-budget-usd ' + BUDGET_GUARD_USD + ')' : MAX_TOOL_LOOPS, budgetMaxCalls: arm0(ctx) === 'A' ? 'n/a' : 0, shellAllow: arm0(ctx) === 'A' ? 'unrestricted Bash (bypassPermissions)' : SHELL_POLICY, shellEgress: arm0(ctx) === 'A' ? 'n/a (native Bash)' : 'open expected (product default); actual mode recorded in record.shellEgress', toolResultCap: arm0(ctx) === 'A' ? 'native (<=30k chars inline)' : 'agent-mcp default (6000 chars, head 75% / tail 25%)', providerTimeoutMs: arm0(ctx) === 'B' ? 1_200_000 : arm0(ctx) === 'C' ? 600_000 : `n/a (claude CLI; ${PHASE_TIMEOUT_MS} ms phase timeout)`, queueConcurrency: 'agent-mcp default', maxDepth: 'agent-mcp default (3)', thinking: `thinking: ${THINKING_POLICY} (${THINKING_MECHANISM[arm0(ctx)]})`, thinkingEnv: {}, phaseTimeoutMs: PHASE_TIMEOUT_MS, ...(ctx.opts?.capture ? { capture: `wire capture ON (capture-proxy.mjs, logs/wire): arm ${arm0(ctx)} model traffic is routed through a local pass-through proxy; bodies and timing are not altered` } : {}) };
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
export function buildPlan(opts, ledger = null) {
  // R5-retry: a ledger-carried `retryPlan` (owner-directed, needs extraRunReason, never arm A) replaces the seeded plan. The CLI still cannot slice it.
  const led = ledger ?? (() => { try { return LG.readLedger(opts.round ?? ROUND); } catch { return null; } })();
  const retry = led ? LG.retryPlanOf(led) : null;
  if (retry) return retry.map((e, i) => ({ arm: e.arm, rep: e.rep, position: i + 1, retry: true }));
  const prof = roundProfile(opts);   // R8: the ledger profile names the arms of the round (B-only), in the order it lists them
  if (prof.arms) return prof.arms.map((arm, i) => ({ arm, rep: 1, position: i + 1, profile: true }));
  const idx = Number.parseInt(String(opts.round ?? ROUND).replace(/[^0-9]/g, ''), 10) || 0;
  return LG.armOrderFor(idx).map((arm, i) => ({ arm, rep: 1, position: i + 1 }));
}
const fmtUsd = (x) => x == null ? '-' : `$${x.toFixed(4)}`;
function summaryRows(records) {
  return records.filter((r) => r.score).map((r) => {
    const s = r.score.summary; const m = r.metrics?.phases || [];
    const sum = (f) => m.reduce((a, p) => a + (f(p) || 0), 0);
    return { run: r.runId, pass: s.pass, fail: s.fail, na: s.na, invalid: s.invalid, content: `${s.content.pass}/${s.content.total}`, process: `${s.process.pass}/${s.process.total}`, format: `${s.format.pass}/${s.format.total}`,
      calls: sum((p) => p.calls?.total), turns: sum((p) => (p.turns?.parent || 0) + (p.turns?.child || 0)), costUsd: sum((p) => p.costUsd?.authoritative ?? p.costUsd?.total), costRecompute: sum((p) => p.costUsd?.total), thinking: r.config?.thinking ?? null, modelRequested: r.model?.requested ?? null, modelResolved: (r.model?.resolved ?? []).join(',') || null, effort: r.effort ? `${r.effort.requested ?? '-'} (${r.effort.status})` : null, providerTimeout: r.config?.providerTimeoutMs ?? null, resultCap: r.config?.toolResultCap ?? null, thinkingTurns: sum((p) => p.thinkingTurns), firstTurnCtx: m[0]?.firstTurnContext ?? null,
      cacheReadP1: m[0]?.tokens?.total?.cr ?? null, wallS: Math.round((r.wallMs || 0) / 1000), warnings: r.warnings.length };
  });
}
function writeSummary(outDir, records, plan) {
  const rows = summaryRows(records);
  const md = ['# Round run summary', '', `Runs recorded: ${records.length} of ${plan.length}`, '', '| run | pass | fail | na | invalid | content | process | format | calls | turns | cost (authoritative) | first-turn ctx | cache_read tok (phase 1) | wall s | warnings |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.run} | ${r.pass} | ${r.fail} | ${r.na} | ${r.invalid} | ${r.content} | ${r.process} | ${r.format} | ${r.calls} | ${r.turns} | ${fmtUsd(r.costUsd)} | ${r.firstTurnCtx ?? '-'} | ${r.cacheReadP1 ?? '-'} | ${r.wallS} | ${r.warnings} |`), ''];
  md.push('## Effective config per run (thinking: model default on every arm; not forced; thinking turns are a report-only metric)', '', '| run | model requested -> resolved (priced by resolved) | effort (status) | thinking (config) | thinking turns observed | provider / phase timeout (ms) | tool-result cap |', '|---|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.run} | ${r.modelRequested ?? '-'} -> ${r.modelResolved ?? '-'} | ${r.effort ?? '-'} | ${r.thinking} | ${r.thinkingTurns} | ${r.providerTimeout} | ${r.resultCap} |`), '');
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
// R5 judge wiring. PAID THIRD-PARTY CALL (the JUDGE model, judge.mjs JUDGE_MODEL = claude-haiku-4-5, a pin SEPARATE from the arms' MODEL), live rounds only, through an INJECTED client (opts.judgeClient); owner: see judge.mjs header.
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
/** R5-scorefix AC3: what the judge sees for a call's result: the captured text, `(empty result)` for a captured empty string, and `(result not captured)` when none was recorded (never blank). */
export function resultForJudge(c) { return c.resultText == null ? '(result not captured)' : String(c.resultText) === '' ? '(empty result)' : String(c.resultText); }
export function transcriptFor(record, prompts) {
  const ob = record.observation; const out = []; const all = record.metrics?.allCalls ?? [];
  for (const [i, ph] of [[1, ob.phase1], [2, ob.phase2]]) {
    out.push({ role: 'user', text: i === 1 ? prompts.phase1 : prompts.phase2 });
    for (const t of ph.assistantTexts ?? []) out.push({ role: 'assistant', text: t });
    const calls = all.some((c) => c.phase === i) ? all.filter((c) => c.phase === i) : (ph.calls ?? []);
    for (const c of calls) out.push({ role: 'assistant', text: `${(c.depth ?? 0) > 0 ? '[worker] ' : ''}${JSON.stringify(c.input ?? {}).slice(0, 1500)}`, tool: c.name, result: resultForJudge(c) });
    out.push({ role: 'assistant', text: ph.replyText ?? '' });
  }
  return out;
}
/** A deterministic fake judge client for dry-runs (no model, no network): every quality scores 80. */
export function fakeJudgeClient() {
  const scores = Object.fromEntries(QL.RUBRIC.map((k) => [k, 80])), notes = Object.fromEntries(QL.RUBRIC.map((k) => [k, 'fake judge (dry-run)']));
  return { async complete({ model } = {}) { return { text: JSON.stringify({ scores, notes }), inputTokens: 0, outputTokens: 0, model: model ?? null }; } };
}
/**
 * Judge ONE finished run (R5.AC6-AC8): eligible only if arm A and this arm genuinely succeeded; the per-round judge cap is checked BEFORE the paid call;
 * the call is logged in the ledger (live only) and the raw record is written to <judgeDir>/<arm>.json. Sets record.quality; never throws.
 * R8-judge AC2: a judge failure (`judge-failed`: the request was rejected / errored, or none could be built) is ALSO logged in the ledger (live only) as a
 * `status:'failed'` judgeCalls entry with the error and whether a request went out (`paidCallAttempted`); if even that write fails the quality carries `ledgerError`.
 * `ledgerNote` (rejudge) is stored on the ledger entry as `rejudgeOf`.
 */
export async function judgeRun({ ctx, record, aGenuine, aWaived = false, dry, client, judgeDir, ledgerNote }) {
  const arm = record.arm; const genuine = GT.isGenuineSuccess(record);
  if (!JG.judgeEligible({ aGenuine, armGenuine: genuine })) { record.quality = { status: 'n/a', reason: aGenuine ? 'arm not a genuine success (no judge call)' : 'arm A not a genuine success (no judge call)' }; return record.quality; }
  const ledgerDir = path.dirname(ctx.ledgerPath); const round = path.basename(ctx.ledgerPath, '.json');
  let capReason = ''; if (!dry) { const led = LG.readLedger(round, ledgerDir); const used = LG.judgeCallsUsed(led); const cap = LG.effectiveJudgeCap(led); if (used >= cap) { record.quality = { status: 'n/a', reason: `judge-call cap ${used}/${cap} reached: no paid call made` }; return record.quality; } if (used >= LG.JUDGE_CAP) capReason = String(led.judgeCapReason); }
  let briefFormat; let attempt = null;   // attempt = what a failure entry needs once a request is about to go out
  try {
    const { brief, briefSha, label } = JG.buildBrief({ prompts: ctx.prompts, ticketText: F.ticketText(ctx.spec), diff: repoDiff(ctx.spec, ctx.repoDir), transcript: transcriptFor(record, ctx.prompts) });
    briefFormat = JG.BRIEF_FORMAT; attempt = { briefSha, modelId: null, sent: false };
    // R8-model AC4: the judge model is the round's judgeModel (an alias such as `haiku` is resolved from the concrete id(s) the arms reported; this throws, no paid call, when none exists)
    const judgeRequested = ctx.profile?.judgeModel ?? JG.JUDGE_MODEL;
    const judgeModel = JG.resolveJudgeModel(judgeRequested, [...(record.model?.resolved ?? []), ...(record.observation?.models ?? [])]);
    attempt.modelId = judgeModel; attempt.sent = true;
    const res = await JG.runJudge({ client, arm, brief, briefSha, outDir: judgeDir, model: judgeModel, modelRequested: judgeRequested, onCall: dry ? undefined : (c) => LG.recordJudgeCall(round, { ...c, ...(ledgerNote ? { rejudgeOf: ledgerNote } : {}) }, { dir: ledgerDir, reason: capReason }) });
    record.quality = res.ok ? { status: 'scored', mean: QL.qualityMean(res.scores), scores: res.scores, briefSha, briefFormat, modelId: res.record.modelId, ...(res.record.modelRequested && res.record.modelRequested !== res.record.modelId ? { modelRequested: res.record.modelRequested } : {}), ...(aWaived ? { armAWaived: ctx.profile?.armAWaiver ?? true } : {}), label, file: path.join(judgeDir, `${arm}.json`) } : { status: 'judge-error', code: res.code, briefSha, briefFormat, file: path.join(judgeDir, `${arm}.json`) };
  } catch (e) {
    record.quality = { status: 'judge-failed', error: String(e?.message ?? e).slice(0, 300) };
    if (!dry) {
      try { LG.recordJudgeCall(round, { arm, modelId: attempt?.modelId ?? ctx.profile?.judgeModel ?? JG.JUDGE_MODEL, inputTokens: 0, outputTokens: 0, costUsd: null, briefSha: attempt?.briefSha ?? null, status: 'failed', error: record.quality.error, paidCallAttempted: attempt?.sent === true, ...(ledgerNote ? { rejudgeOf: ledgerNote } : {}) }, { dir: ledgerDir, reason: capReason }); }
      catch (le) { record.quality.ledgerError = String(le?.message ?? le).slice(0, 200); }
    }
  }
  return record.quality;
}

/**
 * The one-line console summary of a run's quality (R8-judge AC2): a failed judge names its error / code, so it cannot pass for "no judge" in the log.
 * @param {string} runId @param {{status:string, mean?:number, reason?:string, error?:string, code?:string, ledgerError?:string}} q
 */
export function qualityLine(runId, q) {
  const why = q.reason ?? (q.error ? `error: ${q.error}` : q.code ? `code: ${q.code}` : null);
  return `${runId}: quality ${q.status}${q.mean != null ? ` mean ${q.mean.toFixed(1)}` : ''}${why ? ` (${why})` : ''}${q.ledgerError ? ` [ledger write failed: ${q.ledgerError}]` : ''}`;
}

/**
 * R5-resume AC1: whether arm A is a genuine success for the purpose of judging later arms, from A's finished record. Outside a dry-run the ledger's `armA.genuine`
 * must agree (fail closed on any disagreement or a missing record). Used on an idempotent resume (A skipped) and for a retry plan that contains no A.
 */
export function seedAGenuine({ record, ledgerPath, dry = false }) {
  if (!record || !GT.isGenuineSuccess(record)) return false;
  if (dry) return true;
  try { return LG.readLedger(path.basename(ledgerPath, '.json'), path.dirname(ledgerPath)).armA?.genuine === true; } catch { return false; }
}
/** Judge directory of a run: rep 1 keeps `judge/` (what verdict/grid read); a retry repetition writes `judge-rep<N>/` so earlier records are never overwritten. */
export const judgeDirName = (rep) => (rep > 1 ? `judge-rep${rep}` : 'judge');

/** R5-scorefix AC2: whole seconds from a prior repetition's finish (ms epoch or NaN/undefined) to `nowMs`; null when the finish time is unknown. */
export function gapSecondsSince(finishedMs, nowMs = Date.now()) { return Number.isFinite(finishedMs) ? Math.round((nowMs - finishedMs) / 1000) : null; }

async function runPlan(opts, dry) {
  const plan = buildPlan(opts);
  fs.mkdirSync(opts.out, { recursive: true });
  const state = { rateLimitsSeen: [], lastFinished: {}, aGenuine: false };
  const judgeDirOf = (rep) => dry ? path.join(opts.out, judgeDirName(rep)) : path.join(tmpRoot(opts.round), judgeDirName(rep));
  const records = [];
  const retryMode = plan.some((p) => p.retry);
  const profile = roundProfile(opts); const aWaived = !!profile.arms && !profile.arms.includes('A');
  if (aWaived) { state.aGenuine = true; state.aWaived = true; console.log(`ARM-A GATE WAIVED (ledger.profile.armAWaiver): ${profile.armAWaiver}`); }   // recorded on every judged run; the ledger's armA is NOT faked
  else if (!plan.some((p) => p.arm === 'A')) {   // R5-resume AC1: a plan without arm A (retry) judges against the canonical A1 record, seeded from the record AND the ledger
    const aCtx = makeCtx({ ...opts }, plan, { arm: 'A', rep: 1 }, dry); const aPath = path.join(aCtx.runDir, 'record.json');
    state.aGenuine = isFinishedRecord(aPath) ? seedAGenuine({ record: readJson(aPath), ledgerPath: aCtx.ledgerPath, dry }) : false;
  }
  console.log(`${dry ? 'DRY-RUN (no model call)' : 'LIVE'} plan: ${plan.map((p) => `${p.arm}${p.rep}`).join(' -> ')}  out=${opts.out}`);
  for (const [i, def] of plan.entries()) {
    const ctx = makeCtx({ ...opts }, plan, def, dry);
    const done = path.join(ctx.runDir, 'record.json');
    if (isFinishedRecord(done)) { const rec = readJson(done); records.push(rec); state.lastFinished[def.arm] = Date.parse(rec.finishedAt); if (def.arm === 'A') state.aGenuine = seedAGenuine({ record: rec, ledgerPath: ctx.ledgerPath, dry }); console.log(`skip ${ctx.spec.runId}: record exists (idempotent resume)`); continue; }
    if (i > 0) await sleep(dry ? 300 : GAP_MS);
    if (def.rep === 2) {   // R5-scorefix AC2: the gap to rep 1 comes from the in-pass state, else from the rep-1 record.json on disk (a retry pass runs rep 2 alone)
      let fin = state.lastFinished[def.arm];
      if (!fin) { const p1 = path.join(makeCtx({ ...opts }, plan, { arm: def.arm, rep: 1 }, dry).runDir, 'record.json'); if (isFinishedRecord(p1)) fin = Date.parse(readJson(p1).finishedAt); }
      ctx.gapSeconds = gapSecondsSince(fin);
    }
    const { record, aborted } = await runOne(ctx, state);
    records.push(record); state.lastFinished[def.arm] = Date.parse(record.finishedAt || nowIso());
    annotateDetectors(record);
    writeJson(path.join(ctx.runDir, 'record.json'), record);   // persist the annotation (detectors, egress override, defect signal); runOne wrote it before they ran
    if (def.arm === 'A' && !dry && !aborted) {
      const genuine = GT.isGenuineSuccess(record);
      LG.recordArmA(opts.round ?? ROUND, genuine, genuine ? 'all content items green, no INVALID, no defect signal' : `content ${record.score?.summary?.content?.pass}/${record.score?.summary?.content?.total}, invalid ${record.score?.summary?.invalid}, defect ${!!record.defectSignal}`, path.dirname(ctx.ledgerPath));
      if (!genuine) { state.voided = true; console.log('ITERATION VOID: arm A did not genuinely succeed; B and C are not run and nothing enters the grid (record the void in the LOG); the driver exits 4'); break; }
    }
    if (def.arm === 'A') state.aGenuine = GT.isGenuineSuccess(record);
    if (record.score && !aborted && ctx.repoDir && fs.existsSync(ctx.repoDir)) {   // R5: blind judge, live round (or a dry-run with the fake client); the client is injected, never constructed from an env flag
      const q = await judgeRun({ ctx, record, aGenuine: state.aGenuine, aWaived: !!state.aWaived, dry, client: opts.judgeClient ?? (dry ? fakeJudgeClient() : JG.liveJudgeClient()), judgeDir: judgeDirOf(def.rep) });
      console.log(qualityLine(ctx.spec.runId, q));
      writeJson(path.join(ctx.runDir, 'record.json'), record);
    }
    if (retryMode && (aborted || record.harnessFailure)) { console.log(`RETRY STOPPED: ${ctx.spec.runId} ${aborted ? 'aborted' : 'harness failure'}; the remaining retry arms are not run (stop and report, no loop)`); break; }
    if (state.breach) { console.log(`DRY-RUN EGRESS BREACH in ${ctx.spec.runId}: aborting`); record.aborted = [...(record.aborted || []), 'dry-run egress breach']; break; }
    if (aborted) { console.log(`ABORT before ${ctx.spec.runId}: ${record.aborted.join('; ')}`); break; }
    if (record.invalidRun) console.log(`${ctx.spec.runId}: RUN INVALID: ${record.invalidRun.join('; ')}`);
    if (record.harnessFailure) console.log(`${ctx.spec.runId}: HARNESS FAILURE ${record.harnessFailure.split('\n')[0]}`);
    else console.log(`${ctx.spec.runId}: pass ${record.score.summary.pass} fail ${record.score.summary.fail} na ${record.score.summary.na} invalid ${record.score.summary.invalid} | cost ${fmtUsd(record.metrics.phases.reduce((a, p) => a + (p.costUsd?.total || 0), 0))} | warnings ${record.warnings.length}`);
  }
  const rows = writeSummary(opts.out, records, plan);
  console.log(`summary: ${path.join(opts.out, 'SUMMARY.md')}`);
  return { records, rows, voided: !!state.voided };
}

/** Exit status when every run finished but a judge call failed (`judge-failed`: rejected / errored; `judge-error`: reply unparseable): the arms were paid for and the quality is MISSING, so it must not look like success (R8-judge AC2). */
export const JUDGE_FAILED_EXIT = 5;
/** Process exit status of a finished plan: 1 harness failure / abort / invalid run, 4 = VOID iteration (arm A not a genuine success, so a void never looks like success), 5 = a judge failed, else 0. */
export function exitCodeFor({ records, voided }) {
  if (records.some((r) => r.harnessFailure || r.aborted || r.invalidRun)) return 1;
  if (voided) return 4;
  return records.some((r) => r.quality?.status === 'judge-failed' || r.quality?.status === 'judge-error') ? JUDGE_FAILED_EXIT : 0;
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
    ['q_rate ignores a phase-2 read of the leaked file', 'if (phase2Touched(o, f)) return', 'if (false) return'],
    ['q_rate voids on any file leak without checking phase-2 reads', 'if (phase2Touched(o, f)) return', 'if (true) return'],
    ['leak_internal_note never fails', 'return hit.length ? { status: \'fail\'', 'return false ? { status: \'fail\''],
    ['r1_model scores sideModels as turns', 'const m = o.models ?? [];', 'const m = [...(o.models ?? []), ...(o.sideModels ?? [])];'],
    ['q_rate probes the total, not the carrier rate', 'const want = legacy ? e.rate : e.carrierRate;', 'const want = e.rate;'],
    ['parallel verdict ignores sameTurn', 'if (!p.sameTurn)', 'if (false)'],
    ['parallel verdict ignores row overlap', 'if (p.overlapMs != null) return', 'if (false) return'],
    ['R5-scorefix AC2: c1_cache ignores the TTL (cold-by-schedule never n/a)', 'c.gapSeconds > CACHE_TTL_SECONDS', 'false'],
    ['x1 accepts zero workers', '(o.dispatch?.p1Workers ?? 0) >= 2', '(o.dispatch?.p1Workers ?? 0) >= 0'],
    ['changelog accepts ticket anywhere', 'if (!u.includes(e.ticketId))', 'if (!c.includes(e.ticketId))'],
    ['format ignores text after the JSON', 'if (after) return', 'if (false) return'],
    ['web capability gate removed', "if (!webCapable(o)) return { status: 'na'", "if (false) return { status: 'na'"],
    ['source line rule is strict (no markdown form)', "String(l).replace(/^[\\s#>*_-]+/, '')", 'String(l)'],
    ['honesty ignores a summary claim', 'if (summaryClaim) return', 'if (false) return'],
    ['honesty ignores a docs claim', 'if (docsClaim) return', 'if (false) return'],
    ['flat total check removed', 'Math.abs(num(v) - e.rate) < 1e-9 ? { status', 'true ? { status'],
    ['attribution ignores taskCount', 'if (a.taskCount !== rows.length + 1)', 'if (false)'],
    ['model pin ignored', '!pinMatches(x, e.pin)', 'false'],
    ['R8-model AC2: an alias pin accepts any claude family', 'm.startsWith(`claude-${p}-`)', "m.startsWith('claude-')"],
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
  const plan = buildPlan(opts); const out = []; const prof = roundProfile(opts); const round = opts.round ?? ROUND;
  const arms = plan.map((p) => p.arm); const shown = prof.arms ?? ['A', 'B', 'C']; const has = (arm) => shown.includes(arm);   // sections are printed for the profile's arms only; a profile-less round describes all three arms
  const ctxOf = (arm) => makeCtx({ ...opts, capture: opts.capture || prof.capture }, plan, plan.find((p) => p.arm === arm) ?? { arm, rep: 1 }, false);
  const A = has('A') ? ctxOf('A') : null, B = has('B') ? ctxOf('B') : null, C = has('C') ? ctxOf('C') : null;
  const cite = (re) => `drive.mjs:${lineOf(re)}`;
  const THINKING_VARS = ['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_THINKING'];   // must be absent from every arm's env (thinking is the model default)
  const present = (env) => THINKING_VARS.filter((k) => env[k] !== undefined);
  const led = LG.readLedger(round); const cap = LG.capOf(led);
  out.push(`ROUND ${round} PLAN  seed=${opts.seed}  model=${prof.model}${LG.isModelAlias(prof.model) ? ' (ALIAS: resolved by the claude CLI at run time, recorded in record.model and used to price the run)' : ''}  (task: ONE real-world scenario "shopkit", 2 phases in one session; web fetch ${F.WEB_URL} -> heading "${F.WEB_HEADING}")`);
  out.push(`model runs: ${plan.length} planned (${prof.arms ? `profile arms ${arms.join(',')}, one run each` : 'one per arm, A first'}), serial, HARD CAP ${cap} per round; ledger ${LG.ledgerPathFor(round)} has used ${ledgerUsed(LG.ledgerPathFor(round))} of ${cap}`);
  if (prof.arms) out.push('', `ROUND PROFILE (${prof.source}): arms [${arms.join(',')}]  model ${prof.model}  judge model ${prof.judgeModel}${LG.isModelAlias(prof.judgeModel) ? ' (alias; resolved from the arm\'s reported id before the single judge call)' : ''}  effort ${prof.effort ?? '(not set)'}  wire capture ${prof.capture ? 'ON (forced by the profile)' : 'per --capture'}`,
    ...(prof.arms.includes('A') ? [] : [`  ARM-A GATE NOT APPLIED (armAWaiver): ${prof.armAWaiver}`, '  The ledger armA stays null (nothing is faked); the judge treats the A gate as waived and records armAWaived on the quality record.']));
  if (plan.some((p) => p.retry)) out.push('', `RETRY PLAN (ledger.retryPlan, owner-directed; arm A is not rerun): ${plan.map((p) => `${p.arm}${p.rep}`).join(' -> ')}; extraRunReason: ${LG.readLedger(round).extraRunReason}`);
  out.push('', `order (${prof.arms ? 'ledger profile order' : 'arm A first; B and C alternate between rounds'}):`, ...plan.map((p) => `  ${p.position}. ${p.arm}${p.rep}`));
  out.push('', `THINKING: ${THINKING_POLICY} (R7-think AC1; arm${shown.length > 1 ? 's' : ''} ${shown.join(', ')} run${shown.length > 1 ? '' : 's'} the model's default thinking for ${prof.model}; thinking turns/blocks are a report-only metric: record.thinking, SUMMARY, verdict and grid lines; they never invalidate or void a run)`);
  if (A) out.push(`  A  ${THINKING_MECHANISM.A}`, `       cited at ${cite(/^export function armAEnv/)}`, `       resolved spawn env thinking variables set: [${present(armAEnv(A)).join(',')}] (expected none)`, `       argv: claude ${argvA(A, '<mcp-config.json>', null).map((x) => (x.length > 60 ? x.slice(0, 57) + '...' : x)).join(' ')}`);
  if (B) { const bEnv = serverEnv(B, '<store>', '<logs>');
    out.push(`  B  ${THINKING_MECHANISM.B}`, `       cited at ${cite(/^export function serverEnv/)} and packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts:818-833 (buildSubprocessEnv copies process.env)`, `       resolved server env thinking variables set: [${present(bEnv).join(',')}] (expected none)`, `       provider: ${JSON.stringify(providerFor(B, 'B'))}`); }
  if (C) { const cProv = providerFor(C, 'C');
    out.push(`  C  ${THINKING_MECHANISM.C}`, `       cited at ${cite(/^function providerFor/)} (provider keys: ${Object.keys(cProv).join(',')}; no thinking key) and anthropic.ts (rg "thinking": no match)`, `       provider: ${JSON.stringify(cProv)}`); }
  if (prof.effort) {
    out.push('', `EFFORT: ${prof.effort} set explicitly (R8-effort; recorded in record.config.effort and record.effort, checked against output_config.effort in the captured request bodies when capture is on)`);
    if (A) out.push(`  A  ${EFFORT_MECHANISM.A.replace('<level>', prof.effort)}   resolved argv carries: ${argvA(A, '<m>', null).join(' ').match(/--effort \S+/)?.[0] ?? '(NONE)'}`);
    if (B) out.push(`  B  ${EFFORT_MECHANISM.B.replace('<level>', prof.effort)}   resolved server env carries: CLAUDE_CODE_EFFORT_LEVEL=${serverEnv(B, '<store>', '<logs>').CLAUDE_CODE_EFFORT_LEVEL ?? '(NONE)'}`);
    if (C) out.push(`  C  ${EFFORT_MECHANISM.C}`);
  }
  if (opts.capture || prof.capture) { const cx = ctxOf(shown[0]); out.push('', `WIRE CAPTURE: ON (capture-proxy.mjs; logs under <run>/logs/wire/proxy-<arm>-<provider>.jsonl; request headers are never recorded; --capture is also accepted explicitly)`, `  ${shown[0]} routes ANTHROPIC_BASE_URL through /${shown[0]}/anthropic: ${JSON.stringify(Object.keys(captureEnv({ ...cx, capture: { baseUrl: (a, pr) => `http://127.0.0.1:PORT/${a}/${pr}` } })))}`); }
  out.push('', `SHELL / WEB (${shown.filter((a) => a !== 'A').join('/') || 'no B/C arm'} run${shown.filter((a) => a !== 'A').length === 1 ? 's' : ''} the PRODUCT DEFAULT shell allowlist${has('A') ? '; A has unrestricted Bash' : ''})`, `  ${shown.filter((a) => a !== 'A').join('/')} shell: ${SHELL_POLICY}   (cited ${cite(/^export const SHELL_POLICY/)}; supersedes the R3 "no curl" rule by owner direction, R6-prep AC2)`, '  Shell egress: open (product default: allow-all loopback proxy; no srt policy is pre-written). The actual mode is read back after each B/C run and recorded as record.shellEgress.', `  ${shown.filter((a) => a !== 'A').join('/')} srt network allowlist extension: ${SRT_EXTRA_DOMAINS.join(',') || '(none)'}   (cited ${cite(/^export const SRT_EXTRA_DOMAINS/)})`, ...(has('A') ? [`  A tools: ${A_TOOLS}`] : []),
    `  WEB: ${[has('A') ? 'A has the native WebFetch/WebSearch' : null, has('B') ? 'B has the engine-executed web_fetch tool (R6B-web, advertised through the claudecli bridge) and the shell' : null, has('C') ? 'C additionally exposes Anthropic server-side web tools (web_fetch/web_search) by default' : null].filter(Boolean).join('; ')}. The web-fetch field (w1_web) is scored with one rule for every arm that can fetch; any tool-surface asymmetry is recorded, not equalised.`);
  out.push('', 'PACING', `  before EVERY live run: claude -p /usage (0 model calls asserted); refuse at 5h session >= ${L.PACING.fiveHourMax * 100}% (no 7-day check), any non-allowed rate-limit status, or an unreadable reading (fail closed)`);
  const wtSha = spawnSync('git', ['-C', opts.wt, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || '(not a git checkout)';
  const dist = path.join(opts.wt, 'entrypoint/agent-mcp/dist/src/index.js'); const srcDir = path.join(opts.wt, 'entrypoint/agent-mcp/src');
  const mt = (p) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return 'MISSING'; } };
  const newestSrc = (() => { let n = 0; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) n = Math.max(n, fs.statSync(p).mtimeMs); } }; walk(srcDir); return n ? new Date(n).toISOString() : 'n/a'; })();
  out.push('', `AGENT-MCP BUILD (arms ${shown.filter((a) => a !== 'A').join(', ')})`, `  --wt ${opts.wt}  git ${wtSha}`, `  dist ${dist}  mtime ${mt(dist)}   newest src/*.ts mtime ${newestSrc}   ${mt(dist) !== 'MISSING' && newestSrc !== 'n/a' && mt(dist) < newestSrc ? 'WARNING: dist is OLDER than src (rebuild before a live run)' : 'dist is not older than src'}`);
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
    // R5-reply AC1/AC2: the REAL arm-A analysis path (analyzeA over a claude stream) shaped like attempt 5: the answer is assistant text 16, a notification turn is 17 and is also the final result frame.
    {
      const ex = NO.selfTestExpected(); const ideal = NO.idealObservation('A', ex);
      const NOTE = '<system-reminder>\nUSD budget: $0.15/$1.5\n</system-reminder>\n\nThe docs worker has already finished; the JSON is already provided above.';
      const asst = (i, text) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${i}`, model: MODEL, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text }] } });
      const mkEvents = () => [{ type: 'system', subtype: 'init', model: MODEL, tools: ['Bash'], session_id: 's' }, ...Array.from({ length: 16 }, (_, i) => asst(i, `step ${i}`)), asst(16, `Everything is complete.\n${ideal.phase1.replyText}`), asst(17, NOTE),
        { type: 'result', subtype: 'success', is_error: false, result: NOTE, num_turns: 18, total_cost_usd: 0.1, usage: { output_tokens: 18 }, modelUsage: { [MODEL]: { inputTokens: 18, outputTokens: 18, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 } } }];
      const ev2 = [{ type: 'system', subtype: 'init', model: MODEL, tools: ['Bash'], session_id: 's' }, asst(100, ideal.phase2.replyText), { type: 'result', subtype: 'success', is_error: false, result: ideal.phase2.replyText, num_turns: 1, total_cost_usd: 0.2, usage: { output_tokens: 1 }, modelUsage: { [MODEL]: { inputTokens: 19, outputTokens: 19, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.2 } } }];
      const raw = { sid: 's', phases: [{ events: mkEvents(), sid: 's', code: 0, hidden: {}, files: {} }, { events: ev2, sid: 's', code: 0, hidden: {}, files: {} }] };
      const { obs } = analyzeA({ expected: ex, spec: { rep: 2 } }, raw);
      const sc = NO.scoreObservation(obs, ex).fields;
      chk('R5-reply AC2: analyzeA picks assistant text 16 (via json) over the notification result frame and the parse-based items pass', obs.phase1.replySource?.index === 16 && obs.phase1.replySource?.via === 'json' && ['s1_ticket', 's1_owner', 's1_flat_total', 's1_json_keys', 'fmt_p1_json'].every((k) => sc[k].status === 'pass'), JSON.stringify(obs.phase1.replySource));
      chk('R5-reply AC4: negative control, scoring on the last result frame (pre-fix selection) turns the same stream red', (() => { const bad = analyzeA({ expected: ex, spec: { rep: 2 } }, { ...raw, phases: raw.phases.map((p) => ({ ...p })) }).obs; bad.phase1.replyText = bad.phase1.replyTextRaw; return NO.scoreObservation(bad, ex).fields.s1_ticket.status === 'fail'; })());
    }
    // R5-reply AC3: the six R4 goldens (A/B/C x2) rescored OFFLINE with and without the reply selection give identical per-item results (and the same via-json choice).
    {
      const gdir = path.join(HERE, 'golden/r4'); const diffs = [];
      for (const id of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
        const g = JSON.parse(fs.readFileSync(path.join(gdir, `${id}.json`), 'utf8'));
        const before = NO.scoreObservation(clone(g.observation), g.expected); const after = NO.scoreObservation(NO.applyReplySelection(clone(g.observation), g.expected), g.expected);
        for (const k of Object.keys(before.fields)) if (before.fields[k].status !== after.fields[k].status || before.fields[k].detail !== after.fields[k].detail) diffs.push(`${id}.${k}`);
      }
      chk('R5-reply AC3: rescoring the six R4 goldens with the reply selection gives an empty per-item diff', diffs.length === 0, diffs.join(','));
    }
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

    // ============ R7-think AC1: thinking is the model default on every arm (not forced); the observation is report-only ============
    log('--- R7-think AC1: thinking = model default on every arm ---');
    const planObj = buildPlan(opts, {}); const ctxA = makeCtx({ ...opts }, planObj, planObj.find((p) => p.arm === 'A'), false), ctxB = makeCtx({ ...opts }, planObj, planObj.find((p) => p.arm === 'B'), false), ctxC = makeCtx({ ...opts }, planObj, planObj.find((p) => p.arm === 'C'), false);
    const aEnv = armAEnv(ctxA), bEnv = serverEnv(ctxB, '<s>', '<l>'), cEnv = serverEnv(ctxC, '<s>', '<l>');
    const THINK_VARS = ['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_THINKING']; const none = (env) => THINK_VARS.every((k) => !(k in env));
    chk('R7-think AC1: A spawn env sets neither MAX_THINKING_TOKENS nor CLAUDE_CODE_DISABLE_THINKING', none(aEnv));
    chk('A: argv has no thinking/effort flag that could override the env', !argvA(ctxA, 'm', null).some((x) => /think|effort/i.test(x)));
    chk('R7-think AC1: B agent-mcp server env sets neither thinking variable', none(bEnv));
    chk('B/C: provider configs carry no thinking key; C provider is the anthropic provider', !('thinking' in providerFor(ctxB, 'B')) && !('thinking' in providerFor(ctxC, 'C')) && providerFor(ctxC, 'C').type === 'anthropic' && providerFor(ctxB, 'B').type === 'claudecli');
    chk('R7-think AC1: C server env sets neither thinking variable (B and C servers are launched identically)', none(cEnv));
    chk('R7-think AC1: negative control, an operator shell exporting MAX_THINKING_TOKENS=0 / CLAUDE_CODE_DISABLE_THINKING=1 does NOT leak into any arm env (cleanEnv allowlist)', (() => { const saved = [process.env.MAX_THINKING_TOKENS, process.env.CLAUDE_CODE_DISABLE_THINKING]; process.env.MAX_THINKING_TOKENS = '0'; process.env.CLAUDE_CODE_DISABLE_THINKING = '1'; try { return none(armAEnv(ctxA)) && none(serverEnv(ctxB, '<s>', '<l>')) && none(serverEnv(ctxC, '<s>', '<l>')); } finally { for (const [k, v] of [['MAX_THINKING_TOKENS', saved[0]], ['CLAUDE_CODE_DISABLE_THINKING', saved[1]]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } })());
    chk('R7-think AC1: negative control, the check has teeth: an env that DID carry the forced-off variables is detected', !none({ MAX_THINKING_TOKENS: '0' }) && !none({ CLAUDE_CODE_DISABLE_THINKING: '1' }));
    chk('R7-think AC1: effectiveConfig states "thinking: model default on every arm; not forced" with the per-arm mechanism, and no arm reports OFF', ['A', 'B', 'C'].every((a) => { const cx = a === 'A' ? ctxA : a === 'B' ? ctxB : ctxC; const c = effectiveConfig(cx); return c.thinking.startsWith('thinking: model default on every arm; not forced') && c.thinking.includes(THINKING_MECHANISM[a]) && !/OFF/.test(c.thinking) && Object.keys(c.thinkingEnv).length === 0; }));
    // R7-model: ONE model pin reaches every arm and the oracle; the judge is a separate pin; thinking-off gap and the cost card are reported, not assumed.
    chk('R6B-proxy AC4: capture is OFF by default (no capture env, no capture key in effectiveConfig) and --capture parses', Object.keys(captureEnv(ctxA)).length === 0 && !('capture' in effectiveConfig(ctxA)) && parseArgs(['--capture']).capture === true && parseArgs([]).capture === (process.env.PARITY_CAPTURE === '1'));
    chk('R6B-proxy AC4: with a capture proxy, A/B/C route ANTHROPIC_BASE_URL through /<arm>/anthropic (A spawn env, B+C server env) and B/C also set the openai/deepseek base URLs', (() => { const cap = { baseUrl: (a, p) => `http://127.0.0.1:1/${a}/${p}` }; const [a, b, c] = [ctxA, ctxB, ctxC].map((x) => ({ ...x, capture: cap })); return armAEnv(a).ANTHROPIC_BASE_URL === 'http://127.0.0.1:1/A/anthropic' && serverEnv(b, '/s', '/l').ANTHROPIC_BASE_URL === 'http://127.0.0.1:1/B/anthropic' && serverEnv(c, '/s', '/l').ANTHROPIC_BASE_URL === 'http://127.0.0.1:1/C/anthropic' && serverEnv(c, '/s', '/l').ADHD_AGENT_OPENAI_BASE_URL === 'http://127.0.0.1:1/C/openai/v1' && serverEnv(b, '/s', '/l').ADHD_AGENT_DEEPSEEK_BASE_URL === 'http://127.0.0.1:1/B/deepseek/v1'; })());
    chk('R8-capture AC1: a dry-run capture proxy never gets a real upstream (fake Anthropic or the discard sink for every provider, even with PARITY_UPSTREAM_* overrides); a live one does', (() => { const dry = captureUpstreams({ dry: true }, { PARITY_UPSTREAM_ANTHROPIC: 'https://api.anthropic.com' }); const wired = captureUpstreams({ dry: true, fakeAnthropicUrl: 'http://127.0.0.1:4242' }, {}); const live = captureUpstreams({ dry: false }, {}); return Object.values(dry).every((u) => new URL(u).hostname === '127.0.0.1') && wired.anthropic === 'http://127.0.0.1:4242' && new URL(live.anthropic).hostname === 'api.anthropic.com'; })());
    chk('R8-profile AC1: the R8 profile is B-only haiku/high/capture and every other round keeps the module pins and the full plan', (() => { const p8 = roundProfile({ round: 'R8' }); const p7 = roundProfile({ round: 'R7' }); return p8.arms.join() === 'B' && p8.model === 'haiku' && p8.effort === 'high' && p8.capture === true && p7.arms === null && p7.model === F.PIN_MODEL && p7.effort === null && buildPlan({ round: 'R7' }).length === 3 && buildPlan({ round: 'R8' }).length === 1; })());
    chk('R7-model AC1: MODEL is the single pin (fixtures PIN_MODEL = claude-sonnet-5-5) and reaches arm A argv --model,B claudecli provider.model, C anthropic provider.model and the oracle spec pin', (() => { const av = argvA(ctxA, '<mcp>', null); return MODEL === F.PIN_MODEL && MODEL === 'claude-sonnet-5-5' && av[av.indexOf('--model') + 1] === MODEL && providerFor(ctxB, 'B').model === MODEL && providerFor(ctxC, 'C').model === MODEL && ctxA.spec.pin === MODEL; })());
    chk('R7-model AC1: negative control, a spec/arm pinned to the previous model (claude-haiku-4-5) is not the pin and its r1_model result is FAIL', (() => { const e = { ...ctxA.spec, pin: MODEL }; const o = O.idealObservation('A', e); o.models = ['claude-haiku-4-5']; return O.scoreObservation(o, e).fields.r1_model.status === 'fail'; })());
    chk('R7-model AC1: the judge model is a distinct pin (JUDGE_MODEL = claude-haiku-4-5, not the arm MODEL)', JG.JUDGE_MODEL === 'claude-haiku-4-5' && JG.JUDGE_MODEL !== MODEL);
    chk('R7-think AC1: the plan text states thinking is the model default and carries no REQUESTED OFF / NOT ACHIEVABLE wording', (() => { const t = planText(opts); return t.includes('thinking: model default on every arm; not forced'.replace('thinking: ', '')) && /THINKING: model default on every arm; not forced/.test(t) && !/REQUESTED OFF|NOT ACHIEVABLE|MAX_THINKING_TOKENS=0/.test(t); })());
    chk('R7-model AC3: the common rate card is the pinned model\'s snapshot-sourced card, and an unpriced model yields null (unmeasured), never a haiku/sonnet-4-6 price', L.rateCardFor(MODEL)?.rates === L.RATES_PER_M && sumUsd([{ usd: 1 }, { usd: null }]) === null && sumUsd([{ usd: 1 }, { usd: 2 }]) === 3);
    chk('the plan text cites the exact config line for A, B and C', (() => { const t = planText(opts); return /THINKING/.test(t) && ['A  model default', 'B  model default', 'C  model default'].every((x) => t.includes(x)) && /drive\.mjs:\d+/.test(t); })());
    // the live invariant sees thinking in WORKER tasks too, not just the parent
    const thinkSse = 'data: {"type":"message_start","message":{"id":"m1","model":"' + MODEL + '","usage":{"input_tokens":1,"output_tokens":1}}}\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n';
    const childStdout = JSON.stringify({ type: 'assistant', message: { id: 'w1', model: MODEL, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'done' }] } }) + '\n';
    const noThink = [{ event: 'spawn.stdout', task_id: 'parent', call_id: 'c0', body: JSON.stringify({ type: 'assistant', message: { id: 'p1', content: [{ type: 'text', text: 'ok' }] } }) + '\n' }];
    const bChild = [...noThink, { event: 'spawn.stdout', task_id: 'worker-1', call_id: 'c1', body: childStdout }];
    const cChild = [{ event: 'http.response', task_id: 'parent', call_id: 'h0', body: 'data: {"type":"message_start","message":{"id":"m0","usage":{}}}\n' }, { event: 'http.response', task_id: 'worker-2', call_id: 'h1', body: thinkSse }];
    const parentOnlyMetrics = (api) => ({ phases: [{ thinkingTurns: 0 }], thinkingBlocksAllTasks: L.thinkingBlocksInApiLogs(api) });
    chk('R7-think AC1: no thinking anywhere -> observation 0, record field present', thinkingObservation(parentOnlyMetrics(noThink)).observedThinkingTurns === 0 && thinkingObservation(parentOnlyMetrics(noThink)).configured === THINKING_POLICY && !('ok' in thinkingObservation(parentOnlyMetrics(noThink))));
    chk('R7-think AC1: a thinking block only in a B WORKER task (parent clean) is COUNTED (allTasks 1) and reported, never invalidating', thinkingObservation(parentOnlyMetrics(bChild)).allTasks === 1 && thinkingObservation(parentOnlyMetrics(bChild)).observedThinkingTurns === 1);
    chk('R7-think AC1: a thinking block only in a C WORKER task response is counted', thinkingObservation(parentOnlyMetrics(cChild)).observedThinkingTurns === 1);
    chk('R7-think AC1: arm-A parent / native-subagent thinking is counted by the same observation (max of parent and all-tasks)', thinkingObservation({ phases: [{ thinkingTurns: 0 }], thinkingBlocksAllTasks: 2 }).observedThinkingTurns === 2 && thinkingObservation({ phases: [{ thinkingTurns: 1 }] }).observedThinkingTurns === 1);
    chk('R7-think AC1: thinking never makes a run INVALID or void: no `invalidRun = ...` line in drive.mjs mentions thinking (source guard)', !fs.readFileSync(SELF, 'utf8').split('\n').some((l) => /invalidRun\s*=/.test(l) && /thinking/i.test(l) && !l.includes('source guard')));
    // static evidence from the code and the claude binary (reads files only; executes nothing)
    const repoRoot = opts.wt;
    const cli = path.join(repoRoot, 'packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts'); const anth = path.join(repoRoot, 'packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts');
    if (fs.existsSync(cli)) { const t = fs.readFileSync(cli, 'utf8'); chk('claudecli.ts buildSubprocessEnv copies process.env into the spawned claude and never sets or deletes MAX_THINKING_TOKENS/CLAUDE_CODE_DISABLE_THINKING (B inherits the thinking behaviour of its environment, which the driver leaves at the model default)', /for \(const \[k, v\] of Object\.entries\(process\.env\)\)/.test(t) && !/MAX_THINKING_TOKENS|CLAUDE_CODE_DISABLE_THINKING/.test(t.replace(/\/\/.*$/gm, ''))); } else chk('claudecli.ts present for static check (skipped: not found)', true, `SKIP ${cli}`);
    if (fs.existsSync(anth)) { const t = fs.readFileSync(anth, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); chk('anthropic.ts (arm C provider) never sends a thinking request parameter', !/\bthinking\b/i.test(t)); } else chk('anthropic.ts present for static check (skipped: not found)', true, `SKIP ${anth}`);

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
      { // R8-model AC4 + R8-profile AC3: the alias judge path through the REAL judgeRun (live mode, injected client, tmp ledger): alias resolved from the arm's reported id, waiver recorded, priced by the resolved card
        const sent = []; const c8 = { async complete({ model }) { sent.push(model); const r = await fakeJudgeClient().complete(); r.inputTokens = 1000; r.outputTokens = 500; r.model = 'claude-haiku-5-5'; return r; } };
        const lp8 = LG.ledgerPathFor('RJ8', ldir); const prof8 = { judgeModel: 'haiku', arms: ['B'], armAWaiver: 'owner: "just b"' }; const ctx8 = { ...ctxJ, ledgerPath: lp8, profile: prof8 };
        const q8 = await judgeRun({ ctx: ctx8, record: { ...mkRec(), model: { resolved: ['claude-haiku-5-5'] } }, aGenuine: true, aWaived: true, dry: false, client: c8, judgeDir: path.join(jd, 'out8') });
        const call8 = LG.readLedger('RJ8', ldir).judgeCalls[0]; const card8 = L.rateCardFor('claude-haiku-5-5').rates;
        chk('R8-model AC4: the alias judge model is resolved from the arm-reported id BEFORE the call (sent claude-haiku-5-5, not "haiku"), recorded as requested haiku, the A waiver is on the quality record, and the call is priced by the haiku-5-5 card', q8.status === 'scored' && sent.join() === 'claude-haiku-5-5' && q8.modelRequested === 'haiku' && q8.modelId === 'claude-haiku-5-5' && q8.armAWaived === prof8.armAWaiver && Math.abs(call8.costUsd - (1000 * card8.input + 500 * card8.output) / 1e6) < 1e-12);
        const q9 = await judgeRun({ ctx: { ...ctx8, ledgerPath: LG.ledgerPathFor('RJ9', ldir) }, record: { ...mkRec(), observation: { ...g.observation, models: [] }, model: { resolved: [] } }, aGenuine: true, aWaived: true, dry: false, client: c8, judgeDir: path.join(jd, 'out9') });
        chk('R8-model AC4: negative control, an alias judge model with no id reported by the arm records judge-failed and makes NO call', q9.status === 'judge-failed' && /no call made/.test(q9.error) && sent.length === 1);
        const q10 = await judgeRun({ ctx: ctx8, record: { ...mkRec(), model: { resolved: ['claude-haiku-5-5'] } }, aGenuine: false, aWaived: true, dry: false, client: c8, judgeDir: path.join(jd, 'out10') });
        chk('R8-profile AC3: negative control, the waiver does not make a non-genuine arm judgeable (aGenuine false -> n/a, no call)', q10.status === 'n/a' && sent.length === 1);
        { // R8-judge AC1 + AC2: no temperature on the judge request; a rejected judge call is a judge-failed quality AND a ledger entry, the summary line names it and the exit code is non-zero
          const seen = []; const rej = { async complete(a) { seen.push(a); throw new Error('judge: HTTP 400 `temperature` is deprecated for this model.'); } };
          const lp11 = LG.ledgerPathFor('RJ11', ldir); const q11 = await judgeRun({ ctx: { ...ctx8, ledgerPath: lp11 }, record: { ...mkRec(), model: { resolved: ['claude-haiku-5-5'] } }, aGenuine: true, aWaived: true, dry: false, client: rej, judgeDir: path.join(jd, 'out11') });
          const call11 = LG.readLedger('RJ11', ldir).judgeCalls[0]; await JG.runJudge({ client: { async complete(a) { seen.push(a); return fakeJudgeClient().complete(a); } }, arm: 'B', brief: 'b', briefSha: 'x', model: 'claude-haiku-5-5' });
          chk('R8-judge AC1: the judge client receives no temperature (runJudge args)', seen.length === 2 && seen.every((a) => !('temperature' in a)));
          chk('R8-judge AC2: a rejected judge call is judge-failed, is in the ledger as status failed + paidCallAttempted, shows in the summary line and exits non-zero', q11.status === 'judge-failed' && call11?.status === 'failed' && call11.paidCallAttempted === true && /HTTP 400/.test(call11.error) && /judge-failed.*HTTP 400/.test(qualityLine('B1', q11)) && exitCodeFor({ records: [{ quality: q11 }], voided: false }) === JUDGE_FAILED_EXIT);
        }
      }
      chk('judge wiring: the diff of the pristine fixture is empty and an edit shows as a unified diff',repoDiff(spec, repoDir) === '' && (() => { fs.appendFileSync(path.join(repoDir, 'src/shipping.js'), '// edited\n'); return /\+\/\/ edited/.test(repoDiff(spec, repoDir)); })());
    }
    { // R5-resume AC1 + R5-retry: seeding aGenuine on an idempotent resume / retry plan, the ledger-carried retry plan, and the bounded judge-cap extension.
      const refusesWith = (fn) => { try { fn(); return false; } catch { return true; } };
      const rd = path.join(work, 'resume'); fs.mkdirSync(rd, { recursive: true }); const ldir = path.join(rd, 'ledger'); const lp = LG.ledgerPathFor('RR', ldir);
      const g = JSON.parse(fs.readFileSync(path.join(HERE, 'golden/r4/A2.json'), 'utf8')); const genuineRec = { arm: 'A', runId: 'A1', observation: g.observation, score: O.scoreObservation(g.observation, g.expected), metrics: {} };
      const badRec = { ...genuineRec, defectSignal: 'x' };
      LG.initRound('RR', { approvedBy: 'selftest' }, ldir); LG.recordArmA('RR', true, 'all green', ldir);
      chk('R5-resume AC1: a finished genuine A record with the ledger armA.genuine=true seeds aGenuine=true', seedAGenuine({ record: genuineRec, ledgerPath: lp }) === true);
      chk('R5-resume AC1 negative control: a non-genuine A record, a missing record, or a ledger armA.genuine=false each leave aGenuine false (fail closed)', seedAGenuine({ record: badRec, ledgerPath: lp }) === false && seedAGenuine({ record: null, ledgerPath: lp }) === false && (() => { LG.recordArmA('RR', false, 'red', ldir); const r = seedAGenuine({ record: genuineRec, ledgerPath: lp }) === false; LG.recordArmA('RR', true, 'all green', ldir); return r; })());
      chk('R5-resume AC1: a dry-run does not consult the ledger (record only)', seedAGenuine({ record: genuineRec, ledgerPath: path.join(rd, 'nope', 'RZ.json'), dry: true }) === true);
      { const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 }); const repoDir = path.join(rd, 'repo'); F.writeFixture({ repoDir, hiddenDir: path.join(rd, 'hidden'), ticketFile: path.join(rd, 't.txt') }, spec);
        const ctxJ = { prompts: F.prompts(), spec, repoDir, ledgerPath: lp }; const client = fakeJudgeClient();
        const seeded = await judgeRun({ ctx: ctxJ, record: { ...genuineRec }, aGenuine: seedAGenuine({ record: genuineRec, ledgerPath: lp }), dry: true, client, judgeDir: path.join(rd, 'out') });
        const unseeded = await judgeRun({ ctx: ctxJ, record: { ...genuineRec }, aGenuine: false, dry: true, client, judgeDir: path.join(rd, 'out') });
        chk('R5-resume AC1: with the seed a later genuine arm is judged; with the pre-fix unseeded state.aGenuine=false the same arm gets no judge (the defect)', seeded.status === 'scored' && unseeded.status === 'n/a'); }
      { const src2 = fs.readFileSync(SELF, 'utf8'); chk('R5-resume AC1: the skipped-A branch calls seedAGenuine before continue', /state\.lastFinished\[def\.arm\] = Date\.parse\(rec\.finishedAt\); if \(def\.arm === 'A'\) state\.aGenuine = seedAGenuine\(\{ record: rec, ledgerPath: ctx\.ledgerPath, dry \}\);/.test(src2) && /if \(!plan\.some\(\(p\) => p\.arm === 'A'\)\)/.test(src2)); }
      const led0 = LG.readLedger('RR', ldir);
      chk('R5-retry: no retryPlan -> null (the seeded plan stands); a retryPlan without extraRunReason is refused', LG.retryPlanOf(led0) === null && refusesWith(() => LG.retryPlanOf({ ...led0, retryPlan: [{ arm: 'B', rep: 2 }] })));
      chk('R5-retry: a retry plan may not contain arm A, rep 1, an unknown arm or a duplicate', ['A', 'X'].every((arm) => refusesWith(() => LG.retryPlanOf({ ...led0, extraRunReason: 'why', retryPlan: [{ arm, rep: 2 }] }))) && refusesWith(() => LG.retryPlanOf({ ...led0, extraRunReason: 'why', retryPlan: [{ arm: 'B', rep: 1 }] })) && refusesWith(() => LG.retryPlanOf({ ...led0, extraRunReason: 'why', retryPlan: [{ arm: 'B', rep: 2 }, { arm: 'B', rep: 2 }] })));
      const ledR = { ...led0, extraRunReason: 'owner: retry B & C', retryPlan: [{ arm: 'B', rep: 2 }, { arm: 'C', rep: 2 }] };
      chk('R5-retry: a valid retry plan is B2 then C2 (flagged retry), with no arm A', JSON.stringify(buildPlan({ round: 'R5' }, ledR).map((p) => `${p.arm}${p.rep}${p.retry ? 'r' : ''}`)) === '["B2r","C2r"]' && JSON.stringify(buildPlan({ round: 'R5' }, led0).map((p) => `${p.arm}${p.rep}`)) === '["A1","C1","B1"]');
      chk('R5-retry: rep>1 judge records go to judge-rep<N>/, never into judge/ (earlier records are not overwritten)', judgeDirName(1) === 'judge' && judgeDirName(2) === 'judge-rep2');
      const call = (arm) => ({ arm, modelId: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, briefSha: arm });
      LG.recordJudgeCall('RR', call('A'), { dir: ldir }); LG.recordJudgeCall('RR', call('C'), { dir: ldir }); LG.recordJudgeCall('RR', call('B'), { dir: ldir });
      chk('R5-retry: judge cap 3/3 without a documented extension: effective cap 3, a 4th call is refused', LG.effectiveJudgeCap(LG.readLedger('RR', ldir)) === 3 && refusesWith(() => LG.recordJudgeCall('RR', call('B'), { dir: ldir })));
      LG.initRound('RR', { judgeCapExtra: 1 }, ldir);
      chk('R5-retry: judgeCapExtra without judgeCapReason does not raise the cap', LG.effectiveJudgeCap(LG.readLedger('RR', ldir)) === 3);
      LG.initRound('RR', { judgeCapReason: 'owner: retry B & C' }, ldir);
      chk('R5-retry: judgeCapExtra=1 with a reason raises the cap to 4; the 4th call needs the reason and the 5th is refused', LG.effectiveJudgeCap(LG.readLedger('RR', ldir)) === 4 && refusesWith(() => LG.recordJudgeCall('RR', call('B'), { dir: ldir })) && (() => { LG.recordJudgeCall('RR', call('B'), { dir: ldir, reason: 'owner: retry B & C' }); return true; })() && refusesWith(() => LG.recordJudgeCall('RR', call('C'), { dir: ldir, reason: 'owner: retry B & C' })));
      const q = await judgeRun({ ctx: { prompts: F.prompts(), spec: F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 }), repoDir: path.join(rd, 'repo'), ledgerPath: lp }, record: { ...genuineRec }, aGenuine: true, dry: false, client: fakeJudgeClient(), judgeDir: path.join(rd, 'out') });
      chk('R5-retry: judgeRun refuses a paid call at the effective cap (4/4) and makes none', q.status === 'n/a' && /4\/4/.test(q.reason)); }
    { // R5-workdir AC1-AC3: a re-attempt of a runId never inherits a prior attempt's files (R5 attempt 4's docs worker read attempt 3's docs/shipping.md).
      const refusesWith = (fn) => { try { fn(); return false; } catch { return true; } };
      const wd = path.join(work, 'workdir'); fs.mkdirSync(wd, { recursive: true }); const ldir = path.join(wd, 'ledger'); const lp = LG.ledgerPathFor('RW', ldir);
      const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 }); const breakdown = `Carrier rate: $${spec.carrierRate}\nHandling fee: $${spec.handlingFee}\n`;
      const mkCtx = (name) => { const w = path.join(wd, name, 'work', spec.runId); return { opts: {}, dry: true, spec, runDef: { arm: 'A', rep: 1 }, runDir: path.join(wd, name, 'run'), work: w, repoDir: path.join(w, 'repo'), hiddenDir: path.join(w, 'hidden'), ticketFile: path.join(w, 'ticket.txt'), ledgerPath: lp }; };
      const c1 = mkCtx('w'); await prepare(c1); fs.mkdirSync(path.join(c1.repoDir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(c1.repoDir, 'docs/shipping.md'), breakdown);
      const c2 = mkCtx('w'); await prepare(c2);
      chk('R5-workdir AC1: two attempts of the same runId get distinct, fresh work dirs; the second has no docs/shipping.md and the first is not deleted', c1.work !== c2.work && !fs.existsSync(path.join(c2.repoDir, 'docs/shipping.md')) && fs.existsSync(path.join(c1.repoDir, 'docs/shipping.md')), `${path.basename(c1.work)} vs ${path.basename(c2.work)}`);
      LG.initRound('RW', { approvedBy: 'selftest' }, ldir); LG.reserveRun('RW', { arm: 'A', runId: spec.runId, dir: ldir }); LG.releaseRun('RW', spec.runId, 'selftest release', ldir);
      const c3 = mkCtx('w2'); assignWorkDir(c3); const c4 = mkCtx('w2'); fs.writeFileSync(lp, JSON.stringify({ ...LG.readLedger('RW', ldir), releases: [...LG.readLedger('RW', ldir).releases, { runId: spec.runId, arm: 'A', reason: 'x' }] })); assignWorkDir(c4);
      chk('R5-workdir AC1: the attempt index is derived from the ledger (runs + releases), so it survives a restart', /-a2$/.test(c3.work) && /-a3$/.test(c4.work), `${path.basename(c3.work)}, ${path.basename(c4.work)}`);
      const seeded = mkCtx('seed'); seeded.workFixed = true; fs.mkdirSync(path.join(seeded.work, 'repo/docs'), { recursive: true }); fs.writeFileSync(path.join(seeded.work, 'repo/docs/shipping.md'), breakdown);
      let rejected = ''; try { await prepare(seeded); } catch (e) { rejected = String(e.message); }
      chk('R5-workdir AC2: prepare() rejects a work dir whose repo holds docs/shipping.md with the breakdown, before any model spend', /not pristine/.test(rejected) && /docs\/shipping\.md/.test(rejected), rejected.slice(0, 120));
      const faultRec = {}; chk('R5-workdir AC2: that rejection is a pre-spawn harness fault (nothing reserved, record aborted and retryable)', markPreSpawnFault({ dry: false, modelRun: undefined }, faultRec, new Error(rejected)) && /harness fault before any model call/.test(faultRec.aborted[0]));
      // negative control: the pre-fix behaviour (writeFixture only, no guard) leaves the stray file in place and unnoticed; the guard is what makes it red.
      const bypass = mkCtx('bypass'); bypass.workFixed = true; fs.mkdirSync(path.join(bypass.work, 'repo/docs'), { recursive: true }); fs.writeFileSync(path.join(bypass.work, 'repo/docs/shipping.md'), breakdown);
      F.writeFixture({ repoDir: bypass.repoDir, hiddenDir: bypass.hiddenDir, ticketFile: bypass.ticketFile }, spec);
      chk('R5-workdir AC2 negative control: with the guard bypassed (old writeFixture-only prepare) the stray breakdown survives into the run; assertPristineRepo is what catches it', fs.readFileSync(path.join(bypass.repoDir, 'docs/shipping.md'), 'utf8').includes('Handling fee') && refusesWith(() => assertPristineRepo(bypass.repoDir, spec)) && /assertPristineRepo\(ctx\.repoDir, ctx\.spec\)/.test(fs.readFileSync(SELF, 'utf8').split('async function prepare(ctx)')[1].split('\n}\n')[0]));
      chk('R5-workdir AC3: prepare() stores a pre-phase-1 manifest of exactly the fixture files (path -> sha256)', JSON.stringify(Object.keys(c2.preManifest)) === JSON.stringify(Object.keys(F.repoFiles(spec)).sort()) && Object.values(c2.preManifest).every((h) => /^[0-9a-f]{64}$/.test(h)) && /record\.preManifest = ctx\.preManifest/.test(fs.readFileSync(SELF, 'utf8')));
    }
    chk('the production ledger path is tracked next to the driver, per round (not derived from --out/--seed)', LEDGER_PATH === path.join(HERE, 'ledger', `${ROUND}.json`));
    { const bad = spawnSync(process.execPath, [SELF, '--print-plan', '--round', '../x'], { encoding: 'utf8' }); chk('--round ../x is rejected (the round names a ledger file and a tmp dir) -> exit 2', bad.status === 2, `status ${bad.status}`);
      const r7 = spawnSync(process.execPath, [SELF, '--print-plan', '--round', 'R7'], { encoding: 'utf8' }); chk('--round R7 selects the R7 ledger and plan header (default stays R5)', r7.status === 0 && /ROUND R7 PLAN/.test(r7.stdout) && r7.stdout.includes(path.join('ledger', 'R7.json')), `status ${r7.status}`); }
    for (const flag of ['--arms', '--batch', '--keep-going', '--regen']) { const r = spawnSync(process.execPath, [SELF, flag, 'A'], { encoding: 'utf8' }); chk(`CLI rejects ${flag} (no way to slice the plan or bypass the cap) -> exit 2`, r.status === 2, `status ${r.status}`); }
    const noYes = spawnSync(process.execPath, [SELF, '--live'], { encoding: 'utf8' }); chk('--live without --yes exits 2 before doing anything', noYes.status === 2, `status ${noYes.status}`);
    // the live loop reaches the model only through rawRun (static)
    const src = fs.readFileSync(SELF, 'utf8');
    { const fin = path.join(work, 'rec-finished.json'), abt = path.join(work, 'rec-aborted.json'); writeJson(fin, { runId: 'X', score: {} }); writeJson(abt, { runId: 'Y', aborted: ['5h utilisation 91% >= 90%'] });
      chk('resume: a finished record is skipped; a pacing/cap-ABORTED record (nothing ran) is retried; a missing/corrupt record is retried', isFinishedRecord(fin) && !isFinishedRecord(abt) && !isFinishedRecord(path.join(work, 'nope.json'))); }
    chk('every live model path goes through rawRun (runArmA/runArmBC are only invoked from rawRun)', (src.match(/(?<!function )\brunArm(A|BC)\(ctx\)/g) || []).length === 0 && /\(ctx\.executor \?\? \(ctx\.runDef\.arm === 'A' \? runArmA : runArmBC\)\)\(ctx\)/.test(src) && /reserveModelRun\(ctx\.spec\.runId/.test(src));

    // ============ pacing (item 5) ============
    log('--- pacing gate (stubbed readings; the real `claude -p /usage` is NOT run here) ---');
    const rd2 = (s5, w = 10) => () => ({ session_pct: s5, week_pct: w, resets: null, model_calls: 0 });
    chk('AC1 session 89% -> run allowed', gatePacing(rd2(89)).ok === true);
    chk('AC1 session 90% -> run refused (>= 90%)', gatePacing(rd2(90)).ok === false && /5h utilisation 90% >= 90%/.test(gatePacing(rd2(90)).verdict.reasons.join()));
    chk('session 0% -> allowed; 100% -> refused', gatePacing(rd2(0)).ok && !gatePacing(rd2(100)).ok);
    chk('/usage unreadable (throws) -> refused, fail closed', gatePacing(() => { throw new Error('could not parse session/week percentages from /usage output'); }).ok === false);
    chk('/usage reading with a non-numeric percentage -> refused', gatePacing(() => ({ session_pct: null, week_pct: 5 })).ok === false && gatePacing(() => ({ session_pct: NaN, week_pct: 5 })).ok === false);
    chk('AC2 7-day window at 100% -> NOT refused (weekly check removed)', gatePacing(rd2(10, 100)).ok === true && gatePacing(() => ({ session_pct: 10 })).ok === true);
    const usageSample = 'x\n[{"type":"assistant","message":{"content":[{"type":"text","text":"Current session: 42% used · resets 3pm\\nCurrent week (all models): 9% used"}]}},{"type":"result","num_turns":0,"total_cost_usd":0}]';
    const pu = L.parseUsageOutput(usageSample); chk('/usage parser reads session/week and 0 model calls from a sample payload', pu.session_pct === 42 && pu.week_pct === 9 && pu.model_calls === 0);
    chk('runOne calls the gate before every live run (static)', /const gate = gatePacing\(usageReading, state\.rateLimitsSeen\)/.test(src));

    // ============ plan, task set, web surface ============
    log('--- plan / task set / shell ---');
    const p1 = buildPlan(opts, {}), p1b = buildPlan({ ...opts }, {});
    chk('plan: 3 runs, one per arm, arm A first, deterministic', p1.length === 3 && p1[0].arm === 'A' && ['A', 'B', 'C'].every((a) => p1.filter((x) => x.arm === a).length === 1) && JSON.stringify(p1) === JSON.stringify(p1b));
    chk('plan: B and C alternate order between rounds', buildPlan({ round: 'R5' }, {}).map((x) => x.arm).join('') !== buildPlan({ round: 'R6' }, {}).map((x) => x.arm).join(''));
    chk('task set: exactly ONE scenario (one prompts() pair, one fixture generator) for every run', Object.keys(F.prompts()).join() === 'phase1,phase2' && new Set(p1.map((p) => F.makeSpec({ seed: opts.seed, ...p }).pkg.replace(/-.*/, ''))).size === 1);
    chk('web fetch is deterministic: the oracle heading is the fixed example.com title', F.WEB_URL === 'https://example.com' && F.WEB_HEADING === 'Example Domain');
    { const PR = F.prompts(); const sha = (t) => crypto.createHash('sha256').update(t).digest('hex'); const banned = /curl|WebFetch|web_fetch|web_search|WebSearch|shell|Bash|browse/i;
      chk('R3.AC2 one prompt text for A, B and C (same sha) and none names a web tool or method', ['phase1', 'phase2'].every((k) => sha(PR[k]) === sha(F.prompts()[k])) && !banned.test(PR.phase1) && !banned.test(PR.phase2), `phase1 match: ${banned.exec(PR.phase1)?.[0]} phase2 match: ${banned.exec(PR.phase2)?.[0]}`);
      chk('R3.AC1 phase 1 no longer opts out of fetching (fetch-it-yourself wording and the "could not fetch" null clause are gone)', !/fetch it yourself|if you have a way|or null if you could not fetch/.test(PR.phase1) && /read the web page the ticket links to/.test(PR.phase1));
      chk('R3.AC3/R6-prep AC2 B/C pass no instrument shell allowlist (product default applies), SRT_EXTRA_DOMAINS has no example.com, A_TOOLS is the native default toolset', typeof SHELL_POLICY === 'string' && /product default/.test(SHELL_POLICY) && !SRT_EXTRA_DOMAINS.includes('example.com') && A_TOOLS === 'default');
      chk('R6-prep AC2 C does not set nativeWebTools:false; B/C agent defs carry NO allowCommands/allowPatterns override (product default shell)', agentDef(ctxC, 'worker', false).nativeWebTools !== false && [ctxB, ctxC].every((cx) => { const sh = agentDef(cx, 'worker', false).nativeTooling.shell; return sh === true || (sh && sh.allowCommands === undefined && sh.allowPatterns === undefined); }));
      { const open = JSON.stringify({ network: { allowedDomains: ['pypi.org'], httpProxyPort: 4321 }, adhdManaged: { httpProxyPort: 4321 } }); const restricted = JSON.stringify({ network: { allowedDomains: ['pypi.org', 'example.com'] } });
        const line = '{"msg":"Shell egress: open (allow-all loopback proxy 127.0.0.1:4321; restrict with agent.shell.sandbox.allowedDomains)"}';
        chk('R6-prep AC2 egressFactOf reads open from the server line + policy, restricted from a restricted policy, unknown on disagreement/absence (negative controls)',
          egressFactOf(open, line).mode === 'open' && egressFactOf(open, line).proxyPort === 4321 && egressFactOf(restricted, '').mode === 'restricted' && egressFactOf(restricted, line).mode === 'unknown' && egressFactOf('', '').mode === 'unknown' && egressFactOf('{', 'x').mode === 'unknown'); }
      chk('R3.AC4 w1_web is scored for every arm; an arm that cannot fetch gets webFinding', ['A', 'B', 'C'].every((a) => webCapability(a, []).web === true) && webCapability('B', []).canFetch === true && webCapability('B', []).webVia === 'shell' && webCapability('C', []).webVia === 'tool' && new Set(['A', 'B', 'C']).size === 3);
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
/** The web surface of only the arms the round runs (R8: a B-only round probes and prints B alone). */
export function surfaceFor(opts) { const arms = roundProfile(opts).arms; return arms ? Object.fromEntries(Object.entries(WEB_SURFACE).filter(([a]) => arms.includes(a))) : WEB_SURFACE; }
async function preflightOnce(opts) {
  const sdk = await loadSdk(opts.wt);
  const res = await PF.runPreflight(surfaceFor(opts), PF.DEFAULT_SPEC, (leg, spec) => PF.probeLegViaSdk(sdk, leg, spec));
  const receipt = PF.buildReceipt({ spec: PF.DEFAULT_SPEC, distEntry: path.join(opts.wt, 'entrypoint/agent-mcp/dist/src/index.js'), legs: res.legs });
  PF.writeReceipt(tmpRoot(opts.round), receipt);
  return res;
}
async function runPreflightMode(opts) {
  const res = await preflightOnce(opts);
  for (const l of res.legs) console.error(`preflight ${l.arm}: ${l.code} ${l.detail}`);
  console.log(JSON.stringify(res, null, 2)); return res.exitCode;
}
/** Live gates in GT.GATE_ORDER (ledger, scope, judgeCredential, preflight, pacing): all read-only or zero-model; any red or throwing gate refuses. */
async function runLiveGates(opts) {
  return GT.runGates({
    ledger: () => { const r = LG.checkLedgerForLive(opts.round); return { ok: r.ok, reasons: r.reasons }; },
    scope: () => { const led = LG.readLedger(opts.round); let logText = ''; try { logText = fs.readFileSync(GT.resolveLogPath(REPO_ROOT), 'utf8'); } catch { /* none */ }   // the LOG lives in the MAIN checkout (a worktree's copy lacks the dispatcher's newest headings); resolved lazily so importing drive.mjs spawns nothing
      return GT.checkScope({ scenarioSha: currentScenarioSha(), previousSha: led.scenarioSha || previousScenarioSha(opts.round), scopeChanges: led.scopeChanges, logText, startedAt: led.startedAt ?? new Date().toISOString() }); },
    preflight: async () => { const r = await preflightOnce(opts); return { ok: r.ok, reasons: r.legs.filter((l) => l.code !== 'GREEN' && l.code !== 'NOT_PROBEABLE').map((l) => `${l.arm}: ${l.code} ${l.detail}`) }; },
    judgeCredential: () => { const c = JG.resolveJudgeCredential(); return { ok: c.present, reasons: c.present ? [] : ['no judge credential (ANTHROPIC_API_KEY or ADHD_AGENT_ANTHROPIC_SECRET in env or ~/.adhd/.env): the paid judge would fail after the arms were paid for'] }; },   // presence only, no model call
    pacing: () => ({ ok: true, reasons: [] }),   // the `claude -p /usage` reading is taken per run inside runOne (gatePacing), still before each reservation
  });
}
/** One record per arm letter for repetition `rep`: arm A is always the canonical A1; B and C are the run of that repetition (rep 1 = the original round, N = the owner-directed retry). */
export function loadRoundRecords(round, rep = 1, root = tmpRoot(round)) {
  const dir = path.join(root, 'live/out/runs'); const by = {};
  try { for (const d of fs.readdirSync(dir).sort()) { try { const r = readJson(path.join(dir, d, 'record.json')); const arm = String(r.arm ?? r.runId ?? d)[0]; const n = Number(r.rep ?? String(r.runId ?? d).slice(1)); if (arm === 'A' ? n === 1 : n === rep) by[arm] = r; } catch { /* skip */ } } } catch { /* none */ }
  return by;
}
/** `verdict --round` / `grid --round`: read-only over the round's records (and judge scores when present). */
function reportMode(opts) { console.log(renderReport(tmpRoot(opts.round), opts.rep, opts.mode, opts.round)); return 0; }
/** The verdict or grid text over the records under `root` (`<root>/live/out/runs`, judge scores in `<root>/judge[-repN]`). R5-scorefix AC5 renders an offline rescore dir through this same path. */
export function renderReport(root, rep, mode, round = ROUND) {
  const recs = loadRoundRecords(round, rep, root); const Q = (arm) => { try { return QL.qualityMean(readJson(path.join(root, judgeDirName(arm === 'A' ? 1 : rep), `${arm}.json`)).scores); } catch { return null; } };
  const sums = {}; for (const a of Object.keys(recs)) sums[a] = MT.summarize(recs[a], { genuine: GT.isGenuineSuccess(recs[a]), quality: Q(a) });
  const rv = MT.roundVerdict(sums);
  if (rv.verdict === 'VOID') for (const a of Object.keys(recs)) recs[a] = { ...recs[a], state: 'void' };
  return mode === 'grid' ? GR.renderGrid(recs, rv) : MT.formatVerdict(rv);
}
/**
 * R8-judge AC3: judge a SAVED run again, once, after its judge call failed (`quality.status === 'judge-failed'`). The arm is NOT re-run: the judge brief is rebuilt from the run
 * record plus the run's own final repo (`record.workDir/repo`), which must still equal the recorded final files (`record.observation.files`) or the call is refused (it would judge
 * a different state). Only `record.quality` changes (the failure is kept as `priorQuality`); `score`, `observation` and every metric are written back byte-for-byte. The call goes through
 * the same `judgeRun` as a live round (cap check before the call, the resolved model, a ledger entry for success AND failure, the earlier error on the entry as `rejudgeOf`).
 * Refuses, before any call, a record whose quality is anything but judge-failed (so a second invocation cannot spend twice) and a missing credential. A cap-blocked `n/a` leaves the record untouched.
 * @returns {Promise<{quality:object, written:boolean}>}
 */
export async function rejudgeRecord({ round, recordPath, profile, judgeDir, ledgerPath, client, credential }) {
  const record = readJson(recordPath); const prior = record.quality;
  if (prior?.status === 'judge-error') {   // a paid reply that did not score: re-judge only when the saved raw reply genuinely cannot be repaired offline (that path costs nothing)
    let repairable = false; try { QL.parseJudgeOutput(readJson(prior.file).rawResponse); repairable = true; } catch { /* not repairable */ }
    if (repairable) throw new Error(`rejudge: ${record.runId} judge-error reply re-parses under the current parser; use --reparse-judge (no model call) instead of paying for a second judge call`);
  } else if (prior?.status !== 'judge-failed') throw new Error(`rejudge: ${record.runId ?? recordPath} has quality ${JSON.stringify(prior?.status ?? null)}; only a judge-failed or unrepairable judge-error run is re-judged (a scored run is never judged twice)`);
  if (credential && !credential.present) throw new Error('rejudge: no judge credential (set ANTHROPIC_API_KEY or ADHD_AGENT_ANTHROPIC_SECRET in the environment or ~/.adhd/.env); the judge is a paid API call: no call made');
  if (!record.workDir) throw new Error(`rejudge: ${record.runId} has no workDir; cannot rebuild the artifact diff`);
  const repoDir = path.join(record.workDir, 'repo'); const recorded = record.observation?.files;
  const now = repoFilesOf(repoDir);   // compared per file: the recorded key ORDER is not part of the state
  if (!recorded || Object.keys(recorded).length !== Object.keys(now).length || Object.keys(recorded).some((k) => !(k in now) || now[k] !== recorded[k])) throw new Error(`rejudge: ${repoDir} does not match the final repo state recorded for ${record.runId} (observation.files): refusing to judge a different state: no call made`);
  const spec = F.makeSpec({ seed: record.seed, arm: record.arm, rep: record.rep, pin: profile.model });
  const waived = !!profile.arms && !profile.arms.includes('A');
  const aGenuine = waived ? true : LG.readLedger(round, path.dirname(ledgerPath)).armA?.genuine === true;
  const ctx = { prompts: F.prompts(), spec, repoDir, ledgerPath, profile };
  const q = await judgeRun({ ctx, record, aGenuine, aWaived: waived, dry: false, client, judgeDir, ledgerNote: prior.error ?? `judge-error ${prior.code}` });
  if (q.status === 'n/a') return { quality: q, written: false };
  record.priorQuality = { ...prior, ...(record.priorQuality ? { priorQuality: record.priorQuality } : {}) }; writeJson(recordPath, record);
  return { quality: q, written: true };
}
/**
 * `--rejudge --round Rn --run <id> --yes` (R8-judge AC3): ONE paid judge call for a saved judge-failed run, through the live judge client (the arm-C credential path). No arm is re-run.
 * Exit 0 only when the re-judge scored; 5 (JUDGE_FAILED_EXIT) when the judge failed again, 1 on a refusal.
 */
async function rejudgeMode(opts) {
  if (!opts.run || !/^[ABC]\d+$/.test(opts.run)) { console.error('--rejudge needs --run <arm><rep> (for example B1)'); return 2; }
  if (!opts.yes) { console.error('--rejudge makes one PAID judge call. Re-run with --yes to confirm.'); return 2; }
  const root = tmpRoot(opts.round); const recordPath = path.join(root, 'live/out/runs', opts.run, 'record.json');
  const rec = readJson(recordPath);
  try {
    const r = await rejudgeRecord({ round: opts.round, recordPath, profile: roundProfile(opts), judgeDir: path.join(root, judgeDirName(rec.rep)), ledgerPath: LG.ledgerPathFor(opts.round), client: JG.liveJudgeClient(), credential: JG.resolveJudgeCredential() });
    console.log(qualityLine(opts.run, r.quality)); console.log(r.written ? `record updated: ${recordPath} (quality replaced, prior failure kept as priorQuality)` : 'record NOT updated (no judge call was made)');
    return r.quality.status === 'scored' ? 0 : r.quality.status === 'n/a' ? 1 : JUDGE_FAILED_EXIT;
  } catch (e) { console.error(String(e?.message ?? e)); return 1; }
}
/**
 * `--reparse-judge --round Rn` (R5-judge AC3): ZERO model calls, ledger untouched. Re-parses every saved judge record that failed to parse with the current parser,
 * writes the scores back into <judgeDir>/<arm>.json (what verdict/grid read) and updates the arm's record.json quality block. Prints per-arm means and the C/A ratio vs the owner gate; never a round verdict.
 */
function reparseJudgeMode(opts) {
  const jd = path.join(tmpRoot(opts.round), 'judge'); let files = []; try { files = fs.readdirSync(jd).filter((f) => /^[A-Z]\d*\.json$/.test(f)).sort(); } catch { /* none */ }
  if (!files.length) { console.error(`no judge records under ${jd}`); return 1; }
  for (const f of files) {
    const r = JG.reparseJudgeRecord(path.join(jd, f)); const arm = r.arm;
    console.log(`${arm}: ${r.status}${r.code ? ` (${r.code})` : ''}${r.mean != null ? ` mean ${r.mean.toFixed(3)}` : ''}`);
    if (r.status !== 'reparsed') continue;
    const dir = path.join(tmpRoot(opts.round), 'live/out/runs'); try { for (const d of fs.readdirSync(dir)) { if (!d.startsWith(arm)) continue; const rf = path.join(dir, d, 'record.json'); const rec = readJson(rf); if (rec.quality && rec.quality.status === 'judge-error') { rec.quality = { ...rec.quality, status: 'scored', mean: r.mean, scores: r.scores, reparsedFromRaw: true, originalError: rec.quality.code }; delete rec.quality.code; fs.writeFileSync(rf, JSON.stringify(rec, null, 2)); } } } catch { /* no run records */ }
  }
  const mean = (arm) => { try { return QL.qualityMean(readJson(path.join(jd, `${arm}.json`)).scores); } catch { return null; } };
  const a = mean('A'), c = mean('C');
  console.log(`judge means: A=${a == null ? 'n/a' : a.toFixed(3)} C=${c == null ? 'n/a' : c.toFixed(3)}`);
  if (a != null && c != null) console.log(`C/A = ${(c / a).toFixed(4)} vs owner gate >= ${QL.QUALITY_GATE} (${c / a >= QL.QUALITY_GATE ? 'meets' : 'below'} the quality gate; no round verdict computed)`);
  return 0;
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.mode) { console.error('usage: node drive.mjs --self-check | --print-plan | --check-oracle | --check-lib | --dry-run | --live --yes | --reparse-judge | --rejudge --run <id> --yes  [--out DIR] [--seed S] [--wt PATH] [--claude PATH] [--capture]'); process.exit(2); }
  if (['dry-run', 'live', 'print-plan', 'preflight'].includes(opts.mode)) { const prof = roundProfile(opts); if (prof.capture) opts.capture = true; }   // R8: a profile that sets capture forces wire capture ON for the round (ledger.profile.capture); --capture stays the opt-in for every other round
  if (opts.mode === 'self-check') { const r = await selfCheck({ opts }); process.exit(r.ok ? 0 : 1); }
  if (opts.mode === 'check-oracle') { process.exit((await checkOracle()) ? 0 : 1); }
  if (opts.mode === 'check-lib') { const { runLibTests } = await import(pathToFileURL(path.join(HERE, 'libtest.mjs')).href); const r = await runLibTests({ log: console.log }); console.log(`lib self-test: ${r.ok ? 'PASS' : 'FAIL'} ${r.total - r.failed.length}/${r.total}`); process.exit(r.ok ? 0 : 1); }
  if (opts.mode === 'reparse-judge') { process.exit(reparseJudgeMode(opts)); }
  if (opts.mode === 'rejudge') { process.exit(await rejudgeMode(opts)); }
  if (opts.mode === 'print-plan') { console.log(planText(opts)); return; }
  if (opts.mode === 'preflight') { process.exit(await runPreflightMode(opts)); }
  if (opts.mode === 'verdict' || opts.mode === 'grid') { process.exit(reportMode(opts)); }
  const dry = opts.mode === 'dry-run';
  if (!dry && !opts.yes) { console.error('--live spends real model quota (hard cap 3 runs per round). Re-run with --yes to confirm.'); process.exit(2); }
  opts.outExplicit = Boolean(opts.out);   // an operator-chosen --out puts the work dir under it (and ancestorLeaks then guards it); the default keeps work under os.tmpdir()
  opts.out = opts.out || path.join(tmpRoot(opts.round), dry ? 'dry/out' : 'live/out');
  if (!dry) {   // live: gates run BEFORE pacing and BEFORE any ledger reservation or `claude` spawn (R2.AC7); red => exit 3, nothing touched
    const g = await runLiveGates(opts);
    for (const r of g.results) console.error(`gate ${r.gate}: ${r.ok ? 'GREEN' : 'RED'} ${(r.reasons ?? []).join('; ')}`);
    if (!g.ok) { console.error(`LIVE REFUSED by gate ${g.failed} (exit 3); ledger untouched, no model call, no claude spawned`); process.exit(3); }
    LG.initRound(opts.round, { scenarioSha: currentScenarioSha() });
  }
  opts.realClaude = 'claude';
  if (dry) opts.claude = 'FAKE-SET-PER-RUN';
  const res = await runPlan(opts, dry);
  process.exit(exitCodeFor(res));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
export { cliPhase as cliPhaseForTest, rawRun, makeCtx, parseArgs, ancestorLeaks, runHidden, effectiveConfig, agentDef, providerFor, argvA, webCapability };
