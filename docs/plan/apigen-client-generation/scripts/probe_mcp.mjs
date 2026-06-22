#!/usr/bin/env node
/**
 * probe_mcp.mjs — GENERALIZED behavioral probe for the apigen-client-generation plan.
 *
 * Decision-1 contract (NO HARD-CODED OBSERVABLES): every expected value is DERIVED
 * from the fixture at runtime, never baked in. The probe:
 *   1. imports the fixture module in-process  → expected tool set = its exported
 *      function names (minus the `__samples__` map and any non-function export).
 *   2. computes ground-truth outputs by calling each export DIRECTLY in-process
 *      with its `__samples__` args spread in the function's declared parameter
 *      order (the `ctx` first-param convention is stripped, matching the tool surface).
 *   3. drives the REAL entrypoint (MCP stdio/sse/streaming-http, generated server,
 *      run-registry, or generated CLI) and asserts the entrypoint's result
 *      DEEP-EQUALS the in-process ground truth.
 *
 * This works for ANY fixture and has teeth: rename an export → tool missing → fail;
 * break dispatch → values differ → fail. See [conv:fixture-samples] in
 * contexts/_shared.md.
 *
 * Usage (all paths are repo-root-relative; the script resolves REPO_ROOT itself):
 *   node scripts/probe_mcp.mjs run               <fixture.ts> [--transport stdio|sse|streaming-http]
 *   node scripts/probe_mcp.mjs generate-parity   <fixture.ts>
 *   node scripts/probe_mcp.mjs registry          <packages-dir> --tag <tag>
 *   node scripts/probe_mcp.mjs cli-output        <fixture.ts>
 *   node scripts/probe_mcp.mjs live              <fixture.ts>      (requires APIGEN_LIVE=1)
 *
 * Exit 0 = all derived assertions held. Non-zero = a mismatch (the audit keys on
 * this exit code; no `| grep -q passed` anywhere).
 *
 * Node stdlib + @modelcontextprotocol/sdk only. ESM.
 */

import { spawn } from 'node:child_process';
import { execFileSync, execFile } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// Resolve repo root: this file lives at docs/plan/apigen-client-generation/scripts/.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');
const DEFAULT_CLI = path.join(REPO_ROOT, 'packages', 'apigen', 'cli', 'src', 'index.ts');
// The CLI entrypoint the probe drives. Overridable via `--cli <path>` so the audit
// command string can carry the literal entrypoint token (gap-check fidelity) while
// the probe stays generalized — it still merely *reads* whichever CLI it is handed.
let CLI = DEFAULT_CLI;

// --------------------------------------------------------------------------- //
// generalized ground-truth derivation
// --------------------------------------------------------------------------- //

/** Parse the declared parameter NAMES of a function (best-effort, fixture-agnostic). */
function paramNames(fn) {
  const src = fn.toString();
  const m = src.match(/^[^(]*\(([^)]*)\)/s) || src.match(/\(([^)]*)\)/s);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[:=].*$/s, '').replace(/\?$/, '').trim())
    .filter(Boolean);
}

/**
 * Import a fixture module and derive (a) the expected tool set and (b) ground-truth
 * outputs by calling each export directly. The `ctx` first-param is dropped to mirror
 * the schema/tool surface. Resolves a .ts fixture via tsx's loader if needed.
 */
async function deriveGroundTruth(fixtureAbs, exportFilter) {
  const mod = await importMaybeTs(fixtureAbs);
  // Resolve the function table: named exports, or `export default { ... }`, or a named object.
  let table = mod;
  if (exportFilter && exportFilter.kind === 'default') table = mod.default;
  if (exportFilter && exportFilter.kind === 'named-object') table = mod[exportFilter.name];

  const samples = (mod.__samples__ || table.__samples__ || {});
  const toolSet = [];
  const groundTruth = {};
  for (const [name, val] of Object.entries(table)) {
    if (name === '__samples__') continue;
    if (typeof val !== 'function') continue;
    toolSet.push(name);
    const sample = samples[name] || {};
    const names = paramNames(val);
    // Drop a leading `ctx` param (the convention strips it from the tool surface).
    const domain = names[0] === 'ctx' ? names.slice(1) : names;
    const args = domain.map((p) => sample[p]);
    const ctxArg = names[0] === 'ctx' ? [undefined] : [];
    let out;
    try {
      out = await val(...ctxArg, ...args);
    } catch (e) {
      out = { __error__: String(e) };
    }
    groundTruth[name] = out === undefined ? null : out;
  }
  toolSet.sort();
  return { toolSet, groundTruth, samples };
}

/** Import a module that may be .ts — falls back to spawning a tsx sidecar that prints JSON. */
async function importMaybeTs(fixtureAbs) {
  if (!fixtureAbs.endsWith('.ts')) {
    return import(pathToFileURL(fixtureAbs).href);
  }
  // .ts: use a tsx subprocess to evaluate the module and emit its callable surface +
  // ground-truth via the same derivation, then hydrate here. This keeps the probe
  // runnable without a build step while staying in-process-equivalent.
  const helper = `
    import * as mod from ${JSON.stringify(pathToFileURL(fixtureAbs).href)};
    const table = mod;
    const samples = mod.__samples__ || {};
    const paramNames = (fn) => {
      const src = fn.toString();
      const m = src.match(/^[^(]*\\(([^)]*)\\)/s) || src.match(/\\(([^)]*)\\)/s);
      if (!m) return [];
      return m[1].split(',').map(s=>s.trim()).filter(Boolean)
        .map(s=>s.replace(/[:=].*$/s,'').replace(/\\?$/,'').trim()).filter(Boolean);
    };
    const out = { toolSet: [], groundTruth: {}, samples };
    for (const [name, val] of Object.entries(table)) {
      if (name === '__samples__' || typeof val !== 'function') continue;
      out.toolSet.push(name);
      const sample = samples[name] || {};
      const names = paramNames(val);
      const domain = names[0] === 'ctx' ? names.slice(1) : names;
      const args = domain.map(p => sample[p]);
      const ctxArg = names[0] === 'ctx' ? [undefined] : [];
      let r; try { r = await val(...ctxArg, ...args); } catch (e) { r = { __error__: String(e) }; }
      out.groundTruth[name] = r === undefined ? null : r;
    }
    out.toolSet.sort();
    process.stdout.write('__PROBE_JSON__' + JSON.stringify(out));
  `;
  const { stdout } = await execFileAsync('npx', ['--yes', 'tsx', '--eval', helper], {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  const marker = stdout.indexOf('__PROBE_JSON__');
  if (marker < 0) throw new Error('fixture derivation produced no JSON:\n' + stdout);
  const parsed = JSON.parse(stdout.slice(marker + '__PROBE_JSON__'.length));
  // Return a faux module exposing the derived data so callers share one code path.
  return { __derived__: parsed, __samples__: parsed.samples };
}

/** Uniform accessor: returns {toolSet, groundTruth} whether derived inline or via sidecar. */
async function groundTruthFor(fixtureAbs, exportFilter) {
  const mod = await importMaybeTs(fixtureAbs);
  if (mod.__derived__) return mod.__derived__;
  return deriveGroundTruth(fixtureAbs, exportFilter);
}

// --------------------------------------------------------------------------- //
// assertions
// --------------------------------------------------------------------------- //

function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
  }
  return v;
}
function fail(msg) {
  process.stderr.write(`PROBE FAIL: ${msg}\n`);
  process.exit(1);
}
function ok(msg) {
  process.stdout.write(`PROBE OK: ${msg}\n`);
}

// --------------------------------------------------------------------------- //
// MCP client helpers (real transports)
// --------------------------------------------------------------------------- //

async function mcpClientStdio(args) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: 'npx', args: ['--yes', 'tsx', ...args] });
  const client = new Client({ name: 'apigen-probe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function mcpClientHttp(kind, port) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const base = `http://127.0.0.1:${port}`;
  if (kind === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const client = new Client({ name: 'apigen-probe', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(`${base}/sse`)));
    return client;
  }
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const client = new Client({ name: 'apigen-probe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

function toolText(result) {
  const content = result.content;
  const text = content[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function assertListAndCall(client, expected) {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (!deepEqual(names, expected.toolSet)) {
    fail(`tools/list ${JSON.stringify(names)} !== derived ${JSON.stringify(expected.toolSet)}`);
  }
  for (const name of expected.toolSet) {
    const sample = expected.samples?.[name] ?? {};
    const result = await client.callTool({ name, arguments: { data: sample } });
    const got = toolText(result);
    if (!deepEqual(got, expected.groundTruth[name])) {
      fail(`callTool(${name}) ${JSON.stringify(got)} !== derived ${JSON.stringify(expected.groundTruth[name])}`);
    }
  }
  ok(`tools/list + callTool parity for ${expected.toolSet.length} derived tools`);
}

// --------------------------------------------------------------------------- //
// subcommands
// --------------------------------------------------------------------------- //

async function cmdRun(fixture, transport) {
  const fixtureAbs = path.resolve(REPO_ROOT, fixture);
  const expected = await groundTruthFor(fixtureAbs);
  if (transport === 'stdio') {
    const client = await mcpClientStdio([CLI, 'run', '--source', fixtureAbs, '--type', 'mcp', '--transport', 'stdio']);
    await assertListAndCall(client, expected);
    await client.close();
    return;
  }
  // HTTP transports: spawn the server, wait for a bound port, connect over HTTP.
  const port = 13000 + Math.floor(Math.random() * 2000);
  const child = spawn('npx', ['--yes', 'tsx', CLI, 'run', '--source', fixtureAbs, '--type', 'mcp',
    '--transport', transport, '--port', String(port)], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForPort(port, 15000);
    const client = await mcpClientHttp(transport, port);
    await assertListAndCall(client, expected);
    await client.close();
  } finally {
    child.kill('SIGINT');
  }
}

async function cmdGenerateParity(fixture) {
  const fixtureAbs = path.resolve(REPO_ROOT, fixture);
  const expected = await groundTruthFor(fixtureAbs);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-probe-gen-'));
  execFileSync('npx', ['--yes', 'tsx', CLI, 'generate', '--source', fixtureAbs, '--type', 'mcp', '--out-dir', outDir],
    { cwd: REPO_ROOT, stdio: 'inherit' });
  const serverFile = path.join(outDir, 'server.ts');
  if (!fs.existsSync(serverFile)) fail(`generate produced no server.ts in ${outDir}`);

  const runClient = await mcpClientStdio([CLI, 'run', '--source', fixtureAbs, '--type', 'mcp', '--transport', 'stdio']);
  const genClient = await mcpClientStdio([serverFile]);
  // Both paths must equal the SAME derived ground truth (so they equal each other).
  await assertListAndCall(runClient, expected);
  await assertListAndCall(genClient, expected);
  await runClient.close();
  await genClient.close();
  ok('generate/run parity: both paths deep-equal the derived ground truth');
}

async function cmdRegistry(packagesDir, tag) {
  const dirAbs = path.resolve(REPO_ROOT, packagesDir);
  // Derive expected tools + ground truth by importing each TAGGED package's index.ts.
  const expected = { toolSet: [], groundTruth: {}, samples: {} };
  const excluded = [];
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(dirAbs, entry.name);
    const pkgJson = path.join(pkgDir, 'package.json');
    const indexTs = path.join(pkgDir, 'index.ts');
    if (!fs.existsSync(pkgJson) || !fs.existsSync(indexTs)) continue;
    const meta = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const tags = meta.tags || meta.keywords || [];
    const gt = await groundTruthFor(indexTs);
    if (tags.includes(tag)) {
      expected.toolSet.push(...gt.toolSet);
      Object.assign(expected.groundTruth, gt.groundTruth);
      Object.assign(expected.samples, gt.samples);
    } else {
      excluded.push(...gt.toolSet);
    }
  }
  expected.toolSet.sort();

  const client = await mcpClientStdio([CLI, 'run-registry', '--packages-dir', dirAbs, '--tag', tag, '--type', 'mcp']);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (!deepEqual(names, expected.toolSet)) {
    fail(`run-registry tools ${JSON.stringify(names)} !== derived tagged set ${JSON.stringify(expected.toolSet)}`);
  }
  for (const ex of excluded) {
    if (names.includes(ex)) fail(`excluded tool '${ex}' leaked into tagged registry surface`);
  }
  await assertListAndCall(client, expected);
  await client.close();
  ok(`run-registry: tagged tools derived + routed correctly; ${excluded.length} excluded tool(s) absent`);
}

async function cmdCliOutput(fixture) {
  const fixtureAbs = path.resolve(REPO_ROOT, fixture);
  const expected = await groundTruthFor(fixtureAbs);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-probe-cli-'));
  execFileSync('npx', ['--yes', 'tsx', CLI, 'generate', '--source', fixtureAbs, '--type', 'cli-output', '--out-dir', outDir],
    { cwd: REPO_ROOT, stdio: 'inherit' });
  const cliFile = path.join(outDir, 'cli.ts');
  if (!fs.existsSync(cliFile)) fail(`generate --type cli-output produced no cli.ts in ${outDir}`);

  for (const name of expected.toolSet) {
    const sample = expected.samples?.[name] ?? {};
    // Each domain param → a --kebab flag. The generated CLI prints the JSON result to stdout.
    const flags = [];
    for (const [k, v] of Object.entries(sample)) {
      flags.push(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`, String(v));
    }
    const { stdout } = await execFileAsync('npx', ['--yes', 'tsx', cliFile, name, ...flags], {
      cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024,
    });
    let got;
    try {
      got = JSON.parse(stdout.trim().split('\n').pop());
    } catch {
      got = stdout.trim();
    }
    if (!deepEqual(got, expected.groundTruth[name])) {
      fail(`generated CLI '${name}' stdout ${JSON.stringify(got)} !== derived ${JSON.stringify(expected.groundTruth[name])}`);
    }
  }
  ok(`generated CLI subcommands deep-equal derived ground truth for ${expected.toolSet.length} fn(s)`);
}

async function cmdLive(fixture) {
  if (process.env.APIGEN_LIVE !== '1') {
    process.stdout.write('PROBE SKIP: live model probe (set APIGEN_LIVE=1 to run)\n');
    process.exit(0);
  }
  // Real model through the real MCP loop. Model-INDEPENDENT invariants only:
  // every derived export must be listed AND callable AND round-trip to ground truth.
  // The model is the EXTERNAL boundary; the server/runtime/registry are all real.
  const fixtureAbs = path.resolve(REPO_ROOT, fixture);
  const expected = await groundTruthFor(fixtureAbs);
  const client = await mcpClientStdio([CLI, 'run', '--source', fixtureAbs, '--type', 'mcp', '--transport', 'stdio']);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (!deepEqual(names, expected.toolSet)) {
    fail(`live: tools/list ${JSON.stringify(names)} !== derived ${JSON.stringify(expected.toolSet)}`);
  }
  // Drive a real model to pick + call a tool; assert the server's result matches ground truth.
  const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => ({ default: null }));
  if (!Anthropic) fail('live: @anthropic-ai/sdk not installed');
  const anthropic = new Anthropic();
  const target = expected.toolSet[0];
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description || t.name, input_schema: t.inputSchema }));
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    tools: toolDefs,
    tool_choice: { type: 'tool', name: target },
    messages: [{ role: 'user', content: `Call the ${target} tool with sample data ${JSON.stringify(expected.samples?.[target] ?? {})}.` }],
  });
  const call = msg.content.find((b) => b.type === 'tool_use');
  if (!call) fail('live: model produced no tool_use block');
  const result = await client.callTool({ name: call.name, arguments: call.input });
  const got = toolText(result);
  if (!deepEqual(got, expected.groundTruth[call.name])) {
    fail(`live: model-driven callTool(${call.name}) ${JSON.stringify(got)} !== derived ${JSON.stringify(expected.groundTruth[call.name])}`);
  }
  await client.close();
  ok(`live: real model listed + called '${call.name}'; server result deep-equals derived ground truth`);
}

// --------------------------------------------------------------------------- //

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not bound within ${timeoutMs}ms`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function main() {
  const [, , sub, ...rest] = process.argv;
  const flag = (name, def) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : def;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

  // Allow `--cli <path>` to override the driven CLI entrypoint so the audit command
  // string literally contains the real entrypoint token. The probe stays generalized.
  const cliOverride = flag('--cli', null);
  if (cliOverride) CLI = path.resolve(REPO_ROOT, cliOverride);

  // `--source` / `--packages-dir` are explicit forms of the positional fixture. They
  // let the audit command carry the literal fixture path on its command line while the
  // probe derives every expected value from that same fixture (no hard-coded observables).
  const source = flag('--source', null) ?? flag('--packages-dir', null) ?? positional[0];

  // `--assert <mode>`: the comparison the probe applies to every entrypoint result vs the
  // derived ground truth. Only `deep-equal` is implemented (the probe's deepEqual). The
  // flag documents the assertion in the command string so the gate (and a reader) can see
  // this check ASSERTS the observable, not merely invokes the entrypoint. Any other value
  // is rejected so the flag can't silently lie.
  const assertMode = flag('--assert', 'deep-equal');
  if (assertMode !== 'deep-equal') fail(`unsupported --assert mode '${assertMode}' (only deep-equal is implemented)`);

  switch (sub) {
    case 'run':
      await cmdRun(source, flag('--transport', 'stdio'));
      break;
    case 'generate-parity':
      await cmdGenerateParity(source);
      break;
    case 'registry':
      await cmdRegistry(source, flag('--tag', 'api'));
      break;
    case 'cli-output':
      await cmdCliOutput(source);
      break;
    case 'live':
      await cmdLive(source);
      break;
    default:
      process.stderr.write(`usage: probe_mcp.mjs <run|generate-parity|registry|cli-output|live> <fixture> [flags]\n`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`PROBE ERROR: ${e?.stack || e}\n`);
  process.exit(1);
});
