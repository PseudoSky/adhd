/**
 * PARITY-R10-prep AC4 - e2e lane (ADR-0009). Real processes, no mocks.
 *
 * Owner direction: "if I find out your harness is killing my claude sessions I'll be mad".
 * The process tree built per scenario (all throwaway node sleepers, nothing of the user's is touched):
 *
 *     vitest worker (V) -> A  "ancestor": a detached node process (its own process group) that runs the probe D and then stays alive
 *                            \-> D  "the driver": imports parity/lib.mjs (the REAL file, or a mutated COPY) and calls sweepPids / killOwnedGroup the way drive.mjs does
 *     vitest worker (V) -> B  "bystander": a detached node sleeper that D never spawned (stands in for the user's other claude session)
 *
 * Control (the real lib.mjs): D is made to ATTACK A and B in five ways (unowned pid, forged registry entry for an ancestor, forged entry with a recycled start time, group-kill of an ancestor, group-kill
 * of a bystander). Every attack is refused with the expected guard code and both A and B stay alive, while D's own child X (owned) is terminated.
 * Mutants (in-test copies of lib.mjs with ONE guard removed; the real file is never modified): the matching attack now SUCCEEDS, i.e. the bystander/ancestor dies. That is what proves the control can see a kill.
 * Only processes created by this test are ever passed to the probe; pid 1 / the vitest worker / the shell are never targets.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const LIB = path.join(PACKAGE_ROOT, 'parity', 'lib.mjs');
const TMP = path.join(REPO_ROOT, 'tmp', 'agent-mcp', `parity-killsafety-${process.pid}`);
const SLEEPER = ['-e', 'setInterval(() => {}, 1000)'];

const PROBE = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [,, libUrl, scenario, bystander, vitestPid, outFile] = process.argv;
const L = await import(libUrl);
const A = process.ppid; const B = Number(bystander); const V = Number(vitestPid);
const table = L.psTable(); const row = (pid) => table.find((p) => p.pid === pid);
const forge = (reg, pid) => reg.m.set(pid, { pid, lstart: row(pid).lstart, pgid: row(pid).pgid });
const out = { scenario, probe: process.pid, ancestorPid: A, bystanderPid: B };
if (scenario === 'unowned') {
  const reg = new L.OwnedRegistry(process.pid);
  const x = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  out.registered = reg.add(x.pid); out.x = x.pid;
  const swept = await L.sweepPids([x.pid, B, A], 800, reg);
  out.swept = [...swept]; out.refused = swept.refused;
  await new Promise((r) => { if (x.exitCode !== null || x.signalCode !== null) r(); else { x.once('exit', r); setTimeout(r, 3000); } });
  out.xSignal = x.signalCode;
} else if (scenario === 'forged-ancestor') {
  const reg = new L.OwnedRegistry(V); forge(reg, A);   // registry that believes the ancestor is its own child: only the ancestor guard stands in the way
  const swept = await L.sweepPids([A], 500, reg); out.swept = [...swept]; out.refused = swept.refused;
} else if (scenario === 'forged-recycled') {
  const reg = new L.OwnedRegistry(V); reg.m.set(B, { pid: B, lstart: 'Mon Jan 1 00:00:00 1999', pgid: B });   // a registered pid whose start time no longer matches: "recycled"
  const swept = await L.sweepPids([B], 500, reg); out.swept = [...swept]; out.refused = swept.refused;
} else if (scenario === 'group-ancestor') {
  const reg = new L.OwnedRegistry(V); forge(reg, A);   // A leads its own process group, the probe is a member of it
  out.group = L.killOwnedGroup(A, 'SIGTERM', reg);
} else if (scenario === 'group-bystander') {
  const reg = new L.OwnedRegistry(process.pid);
  out.group = L.killOwnedGroup(B, 'SIGTERM', reg);
}
fs.writeFileSync(outFile, JSON.stringify(out));
`;
const ANCESTOR = `
const { spawn } = require('node:child_process');
const [libUrl, scenario, bystander, vitestPid, outFile, probeFile] = process.argv.slice(2);
const d = spawn(process.execPath, [probeFile, libUrl, scenario, bystander, vitestPid, outFile], { stdio: ['ignore', 'inherit', 'inherit'] });
d.on('exit', (code) => { console.log('PROBE-DONE ' + code); setInterval(() => {}, 1000); });
`;

type Run = { out: Record<string, any> | null; a: ChildProcess; b: ChildProcess; probeCode: string };
const live: ChildProcess[] = [];
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
/** resolves true when `c` exits within `ms`, false on the deadline (a bounded, event-driven wait: no polling sleep). */
const waitExit = (c: ChildProcess, ms: number) => new Promise<boolean>((res) => { if (exited(c)) return res(true); const t = setTimeout(() => res(false), ms); c.once('exit', () => { clearTimeout(t); res(true); }); });

function writeLib(name: string, mutate: ((s: string) => string) | null): string {
  if (!mutate) return pathToFileURL(LIB).href;
  const src = fs.readFileSync(LIB, 'utf8');
  const stubbed = src.replace("import { PIN_MODEL } from './fixtures.mjs';", "const PIN_MODEL = 'x';");
  if (stubbed === src) throw new Error('lib.mjs fixtures import line not found: update the mutant harness');
  const mutated = mutate(stubbed);
  if (mutated === stubbed) throw new Error(`mutant ${name} did not apply: the guard text changed, update the mutant`);
  const f = path.join(TMP, `lib.${name}.mjs`); fs.writeFileSync(f, mutated); return pathToFileURL(f).href;
}

async function run(libUrl: string, scenario: string, tag: string): Promise<Run> {
  fs.mkdirSync(TMP, { recursive: true });
  const probe = path.join(TMP, 'probe.mjs'); const anc = path.join(TMP, 'ancestor.cjs'); const outFile = path.join(TMP, `${tag}.json`);
  fs.writeFileSync(probe, PROBE); fs.writeFileSync(anc, ANCESTOR);
  const b = spawn(process.execPath, SLEEPER, { detached: true, stdio: 'ignore' }); live.push(b);
  const a = spawn(process.execPath, [anc, libUrl, scenario, String(b.pid), String(process.pid), outFile, probe], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }); live.push(a);
  let stdout = ''; a.stdout!.on('data', (d) => { stdout += d; });
  const done = new Promise<void>((res) => { const t = setTimeout(res, 30_000); a.stdout!.on('data', () => { if (stdout.includes('PROBE-DONE')) { clearTimeout(t); res(); } }); a.once('exit', () => { clearTimeout(t); res(); }); });
  await done;
  const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  return { out, a, b, probeCode: stdout.match(/PROBE-DONE (\S+)/)?.[1] ?? 'none' };
}
afterEach(() => { for (const c of live.splice(0)) { if (!exited(c)) { try { c.kill('SIGKILL'); } catch { /* gone */ } } } });   // only the throwaway processes THIS test spawned
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const MUT = {
  'allow-all': (s: string) => s.replace('export function refusalFor(pid, registry, table = psTable(), self = process.pid) {', 'export function refusalFor(pid, registry, table = psTable(), self = process.pid) { return null;'),
  'no-not-owned': (s: string) => s.replace('  return REFUSAL.NOT_OWNED;\n}', '  return null;\n}'),
  'no-ancestor': (s: string) => s.replace('  if (ancestorsOf(self, table).has(pid)) return REFUSAL.ANCESTOR;\n', ''),
  'no-recycled': (s: string) => s.replace('if (!row || row.lstart !== e.lstart) return REFUSAL.RECYCLED;', 'if (!row) return REFUSAL.RECYCLED;'),
  'no-ancestor-no-protected-group': (s: string) => MUT['no-ancestor'](s).replace("  if (protPgids.has(pid)) return refuse('protected-group');\n", ''),
} as const;

describe('PARITY-R10-prep AC4: the real lib.mjs never signals a bystander or an ancestor (control)', () => {
  it('AC4: sweepPids kills only the owned child; the unowned bystander and the ancestor are refused (not-owned / ancestor) and stay alive', async () => {
    const r = await run(pathToFileURL(LIB).href, 'unowned', 'control-unowned');
    expect(r.out).not.toBeNull();
    expect(r.out!.registered).toBe(true);
    expect(r.out!.swept).toEqual([r.out!.x]);
    expect(r.out!.xSignal).toBe('SIGTERM');   // the owned child was really terminated: the guards do not just refuse everything
    expect(r.out!.refused).toEqual(expect.arrayContaining([{ pid: r.b.pid, code: 'not-owned' }, { pid: r.a.pid, code: 'ancestor' }]));
    expect(await waitExit(r.b, 500)).toBe(false);
    expect(await waitExit(r.a, 100)).toBe(false);
    expect(() => process.kill(r.b.pid!, 0)).not.toThrow();
    expect(() => process.kill(r.a.pid!, 0)).not.toThrow();
  }, 60_000);

  it('AC4: a registry that was forged to claim the ANCESTOR as its child still cannot signal it (ancestor)', async () => {
    const r = await run(pathToFileURL(LIB).href, 'forged-ancestor', 'control-forged-ancestor');
    expect(r.out!.refused).toEqual([{ pid: r.a.pid, code: 'ancestor' }]);
    expect(r.out!.swept).toEqual([]);
    expect(await waitExit(r.a, 500)).toBe(false);
  }, 60_000);

  it('AC4: a registered pid whose start time changed (recycled by the OS) is refused (recycled) and stays alive', async () => {
    const r = await run(pathToFileURL(LIB).href, 'forged-recycled', 'control-recycled');
    expect(r.out!.refused).toEqual([{ pid: r.b.pid, code: 'recycled' }]);
    expect(await waitExit(r.b, 500)).toBe(false);
  }, 60_000);

  it('AC4: a process-group kill aimed at the ancestor (which leads its own group and contains the probe) is refused; aimed at the unowned bystander it is refused', async () => {
    const g = await run(pathToFileURL(LIB).href, 'group-ancestor', 'control-group-ancestor');
    expect(g.out!.group).toEqual({ ok: false, code: 'ancestor' });
    expect(await waitExit(g.a, 500)).toBe(false);
    const h = await run(pathToFileURL(LIB).href, 'group-bystander', 'control-group-bystander');
    expect(h.out!.group).toEqual({ ok: false, code: 'not-owned' });
    expect(await waitExit(h.b, 500)).toBe(false);
  }, 60_000);
});

describe('PARITY-R10-prep AC4 negative controls: with ONE guard removed the same attack kills the bystander / ancestor (the test can see a kill)', () => {
  it('AC4 mutant allow-all: the unowned bystander AND the ancestor are killed', async () => {
    const r = await run(writeLib('allow-all', MUT['allow-all']), 'unowned', 'mut-allow-all');
    expect(await waitExit(r.b, 5000)).toBe(true);
    expect(await waitExit(r.a, 5000)).toBe(true);
  }, 60_000);
  it('AC4 mutant no-not-owned: the unowned bystander is killed (the ancestor guard still holds)', async () => {
    const r = await run(writeLib('no-not-owned', MUT['no-not-owned']), 'unowned', 'mut-no-not-owned');
    expect(await waitExit(r.b, 5000)).toBe(true);
    expect(await waitExit(r.a, 500)).toBe(false);
  }, 60_000);
  it('AC4 mutant no-ancestor: the forged-owned ancestor is killed', async () => {
    const r = await run(writeLib('no-ancestor', MUT['no-ancestor']), 'forged-ancestor', 'mut-no-ancestor');
    expect(await waitExit(r.a, 5000)).toBe(true);
  }, 60_000);
  it('AC4 mutant no-recycled: the recycled-pid bystander is killed', async () => {
    const r = await run(writeLib('no-recycled', MUT['no-recycled']), 'forged-recycled', 'mut-no-recycled');
    expect(await waitExit(r.b, 5000)).toBe(true);
  }, 60_000);
  it('AC4 mutant no-ancestor-no-protected-group: the group kill takes down the ancestor and its group', async () => {
    const r = await run(writeLib('no-ancestor-no-protected-group', MUT['no-ancestor-no-protected-group']), 'group-ancestor', 'mut-group');
    expect(await waitExit(r.a, 5000)).toBe(true);
  }, 60_000);
});
