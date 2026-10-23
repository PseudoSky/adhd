/*
 * guards: arm C's agent_create (parent or worker) or the Anthropic request on the wire lacks thinking {type:'adaptive'} while arm A asks for it, thinkingFacts reports requested versus wire wrongly, PARITY_THINKING_C=none still sends thinking, or a driver whose worker definition forgets thinking is not flagged as a mismatch.
 * tier: P (spawns drive.mjs --dry-run against the built agent-mcp over stdio MCP; e2e lane, ADR-0009)
 * gap: This cannot be observed at tier S because agent_create's argument must travel through the real built server to the SDK request body that a fake Anthropic server receives over a socket.
 * cites: R10 LP AC2, AC3 (SCOPE-R10-thinking-parity, as titled in this file; no backlog uid appears in this file; filed under G9 bucket 003366c1-fef5-4b97-be06-bda8155d31a3).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from '../../helpers/parity-instrument/load';

/**
 * R10 launch prep, e2e lane (ADR-0009): the real `drive.mjs --dry-run --round R10` against the REAL built agent-mcp (arm C over stdio MCP) with the instrument's fake Anthropic upstream,
 * the capture proxy on (the R10 profile forces it) and the fake `claude` for arm A. No model call, no network, no `--live`.
 *   AC2 arm C's agent_create for BOTH the parent and the worker sends provider.thinking {type:'adaptive'}, and every main (tool-declaring) request the fake Anthropic server received carries
 *       thinking {type:'adaptive'} (workers included); arm A's request carries what the fake claude emits (compared with its own capture, never overwritten)
 *   AC3 record.thinkingFacts: requested versus wire. PARITY_THINKING_C=none => requested none, wire none, match, and agent_create carries no thinking. A MUTATED driver (the worker
 *       definition forgets it) => the same run reports a mismatch and the assertions go red on the unmutated expectations
 */
const WD = await loadParity('wire-diff.mjs');
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const env = (extra: Record<string, string> = {}) => { const e: Record<string, string> = {}; for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PARITY_')) e[k] = v; return { ...e, ...extra }; };
function dry(extraEnv: Record<string, string>, drive = DRIVE) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-lp-dry-')); cleanup.push(out);
  const r = spawnSync(process.execPath, [drive, '--dry-run', '--round', 'R10', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 420_000, env: env(extraEnv) });
  return { out, r, stdout: r.stdout, rec: (id: string) => JSON.parse(fs.readFileSync(path.join(out, 'runs', id, 'record.json'), 'utf8')) };
}
const wireBodies = (out: string, id: string, file: string) => fs.readFileSync(path.join(out, 'runs', id, 'logs', 'wire', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'raw_request').map((e) => e.body);
const hasTools = (b: { tools?: unknown[] }) => (b.tools?.length ?? 0) > 0;
const agentCreates = (out: string) => (JSON.parse(fs.readFileSync(path.join(out, 'runs', 'C1', 'mcp-calls.json'), 'utf8')) as { name: string; args: { name: string; provider: Record<string, unknown> } }[]).filter((c) => c.name === 'agent_create');

describe('R10 LP: arm C asks the model what arm A asks (offline dry run, real built server)', () => {
  const state: { default?: ReturnType<typeof dry> } = {};

  it('R10 LP AC2: default config - agent_create sends provider.thinking {type:adaptive} for BOTH the parent and the worker definition, and every main request on the wire carries it', () => {
    const d = dry({}); state.default = d;
    expect(d.r.status, d.stdout + d.r.stderr).toBe(0);
    const creates = agentCreates(d.out);
    expect(creates.map((c) => c.args.name).sort()).toEqual(['r2-parent-C1', 'worker']);
    for (const c of creates) expect(c.args.provider, c.args.name).toMatchObject({ type: 'anthropic', effort: 'high', thinking: { type: 'adaptive' } });
    const bodies = wireBodies(d.out, 'C1', 'proxy-C-anthropic.jsonl'); const main = bodies.filter(hasTools);
    expect(main.length).toBeGreaterThan(10);
    for (const b of main) expect(b.thinking).toEqual({ type: 'adaptive' });
    // the worker's requests are among them: the parent is the only definition with the r2info MCP tools, so a request without them is a worker turn
    const workerTurns = main.filter((b) => !(b.tools as { name: string }[]).some((t) => /r2info/.test(t.name)));
    expect(workerTurns.length).toBeGreaterThan(0);
    // effort rides next to it unchanged
    for (const b of main) expect(b.output_config).toEqual({ effort: 'high' });
  }, 480_000);

  it('R10 LP AC2/AC3: the record says verified for C (requested vs wire, main requests) and observed-only for A, whose own capture is what the fake claude emitted (unchanged)', () => {
    const d = state.default; if (!d) throw new Error('the default dry run (previous test) did not complete'); const c = d.rec('C1').thinkingFacts; const a = d.rec('A1').thinkingFacts;
    expect(c).toMatchObject({ arm: 'C', requested: '{"type":"adaptive"}', status: 'verified', match: true, observed: ['{"type":"adaptive"}'], controlled: true });
    expect(c.mainRequests).toBe(wireBodies(d.out, 'C1', 'proxy-C-anthropic.jsonl').filter(hasTools).length);
    expect(d.rec('C1').warnings.join('\n')).not.toMatch(/THINKING MISMATCH/);
    expect(a).toMatchObject({ arm: 'A', requested: null, status: 'not-controlled', match: null, controlled: false });
    const aWire = wireBodies(d.out, 'A1', 'proxy-A-anthropic.jsonl').filter(hasTools).map((b) => WD.canonThinking(b.thinking));   // independent of thinkingFacts
    expect(aWire.length).toBeGreaterThan(0);
    expect(a.observed).toEqual([...new Set(aWire.map((t) => t ?? 'none'))]);
    expect(d.stdout).toMatch(/thinking arm C: requested \{"type":"adaptive"\}, wire \[\{"type":"adaptive"\}\] on \d+ main request\(s\): MATCH/);
    expect(d.stdout).toMatch(/thinking arm A: requested \(not set by the harness\)/);
    console.log(`R10 LP example facts C1: ${JSON.stringify(c)}\nR10 LP example facts A1: ${JSON.stringify(a)}`);
  });

  it('R10 LP AC3 negative control: PARITY_THINKING_C=none => agent_create carries no thinking, the wire carries none, the fact says requested none, wire none, match', () => {
    const d = dry({ PARITY_THINKING_C: 'none' });
    expect(d.r.status, d.stdout + d.r.stderr).toBe(0);
    for (const c of agentCreates(d.out)) expect(c.args.provider, c.args.name).not.toHaveProperty('thinking');
    for (const b of wireBodies(d.out, 'C1', 'proxy-C-anthropic.jsonl').filter(hasTools)) expect(b).not.toHaveProperty('thinking');
    expect(d.rec('C1').thinkingFacts).toMatchObject({ requested: 'none', observed: ['none'], status: 'verified', match: true });
    expect(d.stdout).toMatch(/thinking arm C: requested none, wire \[none\] on \d+ main request\(s\): MATCH/);
  }, 480_000);

  it('R10 LP AC3 mutant: a driver whose worker definition forgets the thinking is caught - the facts report a MISMATCH (and the default-run expectations are red against it)', () => {
    const src = fs.readFileSync(DRIVE, 'utf8');
    const fn = src.indexOf('function agentDef(ctx, name, parent) {'); const ret = src.indexOf('  return def;', fn);
    expect(fn).toBeGreaterThan(0); expect(ret).toBeGreaterThan(fn); expect(ret - fn).toBeLessThan(1200);   // the first `return def;` after agentDef begins is agentDef's own
    const mutated = `${src.slice(0, ret)}  if (!parent) delete def.provider.thinking;   // MUTANT: the worker definition forgets thinking\n${src.slice(ret)}`;
    const file = path.join(PARITY_DIR, `drive.r10-launch-mutant-${process.pid}.mjs`);
    fs.writeFileSync(file, mutated);
    let d: ReturnType<typeof dry>;
    try { d = dry({}, file); } finally { fs.rmSync(file, { force: true }); }
    expect(d.r.status, d.stdout + d.r.stderr).toBe(0);
    const creates = agentCreates(d.out);
    const providerOfDef = (n: string) => creates.find((c) => c.args.name === n)?.args.provider ?? {};
    expect(providerOfDef('worker')).not.toHaveProperty('thinking');
    expect(providerOfDef('r2-parent-C1')).toMatchObject({ thinking: { type: 'adaptive' } });
    const f = d.rec('C1').thinkingFacts;
    expect(f).toMatchObject({ status: 'mismatch', match: false, requested: '{"type":"adaptive"}' });
    expect(f.observed).toEqual(expect.arrayContaining(['{"type":"adaptive"}', 'none']));
    expect(d.rec('C1').warnings.join('\n')).toMatch(/THINKING MISMATCH: requested thinking \{"type":"adaptive"\}, wire carried/);
    expect(d.stdout).toMatch(/: MISMATCH/);
    // the unmutated expectation (every main request carries adaptive) is false on the mutant's wire: the AC2 test would be red
    expect(wireBodies(d.out, 'C1', 'proxy-C-anthropic.jsonl').filter(hasTools).every((b) => b.thinking?.type === 'adaptive')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  }, 480_000);
});
