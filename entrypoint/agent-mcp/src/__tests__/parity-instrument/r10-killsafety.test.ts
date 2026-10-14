/*
 * guards: a signal guard in OwnedRegistry, refusalFor or killOwnedGroup stops returning its refusal code (pid-range, self, ancestor, not-owned, recycled, not-child, protected group, foreign member, fail-closed without a registry), or a pkill, killall or stray process.kill appears outside lib.mjs.
 * tier: S (synthetic process tables, no real signal; static source audit)
 * cites: PARITY-R10-prep AC4 (SCOPE-R10-prep, as titled in this file; no backlog uid appears in this file; filed under G9 bucket 003366c1-fef5-4b97-be06-bda8155d31a3).
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * PARITY-R10-prep AC4 (SCOPE-R10-prep, owner: "if I find out your harness is killing my claude sessions I'll be mad"): the signal guards of the live driver, decided over SYNTHETIC process tables so no
 * real process is ever signalled here. Each guard is pinned by the refusal code it returns, so removing one changes the code and turns a test red. The real-process proof (a bystander and an ancestor
 * that stay alive, with the guards mutated away to show the test can see a kill) is r10-killsafety.e2e.test.ts.
 */
const L = await loadParity('lib.mjs');

type Row = { pid: number; ppid: number; pgid: number; lstart: string; command: string };
const row = (pid: number, ppid: number, pgid: number, lstart = 'Mon Jan 1 00:00:00 2026', command = `cmd${pid}`): Row => ({ pid, ppid, pgid, lstart, command });
const SELF = 100;
/** launchd(1) > terminal(10) > the user's interactive claude session (50) > bash tool > the driver (100) > owned child (200) > grandchild (201); plus a bystander claude (300) and a sibling of the driver (400). */
const table = (): Row[] => [
  row(1, 0, 1), row(10, 1, 10), row(50, 10, 50, 'Mon Jan 1 00:00:01 2026', 'claude'), row(60, 50, 60, 'Mon Jan 1 00:00:02 2026', 'bash'), row(SELF, 60, 60, 'Mon Jan 1 00:00:03 2026', 'node drive.mjs'),
  row(200, SELF, 200, 'Mon Jan 1 00:00:10 2026', 'claude -p'), row(201, 200, 200, 'Mon Jan 1 00:00:11 2026', 'node mcp'), row(202, 201, 202, 'Mon Jan 1 00:00:12 2026', 'sh child of mcp'),
  row(300, 1, 300, 'Mon Jan 1 00:00:05 2026', 'claude (bystander)'), row(400, 60, 60, 'Mon Jan 1 00:00:06 2026', 'sibling of the driver'),
];
const registry = (t = table(), pids = [200]) => { const r = new L.OwnedRegistry(SELF); for (const p of pids) expect(r.add(p, t)).toBe(true); return r; };

describe('PARITY-R10-prep AC4: OwnedRegistry', () => {
  it('AC4: only a DIRECT child of the driver can be registered; everything else is rejected with a reason and can never be signalled', () => {
    const t = table(); const r = new L.OwnedRegistry(SELF);
    for (const pid of [300, 50, 1, 0, -5, 201, SELF, 9999]) expect(r.add(pid, t)).toBe(false);
    expect(r.size).toBe(0);
    expect(r.rejected.map((x: { pid: number }) => x.pid)).toEqual([300, 50, 1, 0, -5, 201, SELF, 9999]);
    expect(r.add(200, t)).toBe(true);
    expect(r.validRoots(t)).toEqual([200]);
  });
  it('AC4: a registered root whose start time changed (pid recycled by the OS) is no longer valid', () => {
    const t = table(); const r = registry(t);
    const t2 = t.map((p) => (p.pid === 200 ? { ...p, lstart: 'Tue Feb 2 00:00:00 2026' } : p));
    expect(r.validRoots(t2)).toEqual([]);
  });
});

describe('PARITY-R10-prep AC4: refusalFor, one guard per refusal code', () => {
  const t = table(); const r = registry(t);
  it('AC4: allowed: the owned child, and its descendants at any depth', () => {
    for (const pid of [200, 201, 202]) expect(L.refusalFor(pid, r, t, SELF)).toBeNull();
  });
  it('AC4: pid-range: <= 1, non-integers, NaN, negative (a process GROUP id) are refused', () => {
    for (const pid of [1, 0, -1, -200, 2.5, NaN, '200' as unknown as number]) expect(L.refusalFor(pid, r, t, SELF)).toBe('pid-range');
  });
  it('AC4: self: the driver is never a target', () => { expect(L.refusalFor(SELF, r, t, SELF)).toBe('self'); });
  it('AC4: ancestor: the interactive claude session (50), its shell (60) and the terminal (10) are refused even when somebody registered them', () => {
    for (const pid of [50, 60, 10]) expect(L.refusalFor(pid, r, t, SELF)).toBe('ancestor');
    const forged = new L.OwnedRegistry(SELF); forged.m.set(50, { pid: 50, lstart: t.find((p) => p.pid === 50)!.lstart, pgid: 50 });
    expect(L.refusalFor(50, forged, t, SELF)).toBe('ancestor');
  });
  it('AC4: not-owned: a bystander claude, a sibling of the driver and a process that does not exist are refused', () => {
    for (const pid of [300, 400, 9999]) expect(L.refusalFor(pid, r, t, SELF)).toBe('not-owned');
  });
  it('AC4: recycled: a registered pid whose start time changed is refused (and so are its former descendants, which are no longer derived from a valid root)', () => {
    const t2 = t.map((p) => (p.pid === 200 ? { ...p, lstart: 'Tue Feb 2 00:00:00 2026' } : p));
    expect(L.refusalFor(200, r, t2, SELF)).toBe('recycled');
    expect(L.refusalFor(201, r, t2, SELF)).toBe('not-owned');
  });
  it('AC4: not-child: a registered root that is no longer a child of the driver is refused', () => {
    const t2 = t.map((p) => (p.pid === 200 ? { ...p, ppid: 400 } : p));
    expect(L.refusalFor(200, r, t2, SELF)).toBe('not-child');
  });
  it('AC4: a descendant is re-derived from the live table: re-parented away from the owned tree it is not owned any more', () => {
    const t2 = t.map((p) => (p.pid === 202 ? { ...p, ppid: 1 } : p));
    expect(L.refusalFor(202, r, t2, SELF)).toBe('not-owned');
  });
  it('AC4: signalAllowance is exactly the owned subtree and never contains the protected set', () => {
    const a = L.signalAllowance(r, t, SELF);
    expect([...a.allowed].sort()).toEqual([200, 201, 202]);
    for (const p of [SELF, 60, 50, 10, 1, 300, 400]) expect(a.allowed.has(p)).toBe(false);
    expect([...a.protectedPids].sort((x: number, y: number) => x - y)).toEqual([10, 50, 60, 100].concat([1]).sort((x, y) => x - y));
  });
});

describe('PARITY-R10-prep AC4: killOwnedGroup refusals (decided before any signal is sent)', () => {
  const sig = 'SIGTERM';
  it('AC4: no registry -> nothing is signalled (fail closed)', () => {
    expect(L.killOwnedGroup(200, sig, null, { table: table(), self: SELF })).toEqual({ ok: false, code: 'no-registry' });
    expect(L.killOwnedGroup(200, sig, { m: new Map() }, { table: table(), self: SELF }).code).toBe('no-registry');
  });
  it('AC4: bystander, ancestor, self, pid <= 1 and a negative pid (group id) are refused with the guard code', () => {
    const t = table(); const r = registry(t);
    const code = (pid: number) => L.killOwnedGroup(pid, sig, r, { table: t, self: SELF }).code;
    expect(code(300)).toBe('not-owned'); expect(code(50)).toBe('ancestor'); expect(code(SELF)).toBe('self'); expect(code(1)).toBe('pid-range'); expect(code(-200)).toBe('pid-range');
  });
  it('AC4: a descendant is not a group root: the group is only ever signalled through a registered child', () => {
    const t = table(); expect(L.killOwnedGroup(201, sig, registry(t), { table: t, self: SELF }).code).toBe('not-owned');
  });
  it('AC4: a child that did NOT create its own group (it shares the driver group) is refused: a kill(-pgid) would hit the driver and its ancestors', () => {
    const t = table().map((p) => (p.pid === 200 ? { ...p, pgid: 60 } : p)); const r = registry(t);
    expect(L.killOwnedGroup(200, sig, r, { table: t, self: SELF }).code).toBe('not-group-leader');
  });
  it('AC4: a child whose pgid equals the driver pgid / an ancestor pgid is refused as a protected group', () => {
    const t = table().map((p) => (p.pid === SELF ? { ...p, pgid: 200 } : p)); const r = registry(t, [200]);
    expect(L.killOwnedGroup(200, sig, r, { table: t, self: SELF }).code).toBe('protected-group');
  });
  it('AC4: a group that contains a process which is not a descendant of the child (a foreign member) is refused', () => {
    const t = [...table(), row(500, 1, 200, 'Mon Jan 1 00:00:20 2026', 'foreign member')]; const r = registry(t);
    expect(L.killOwnedGroup(200, sig, r, { table: t, self: SELF }).code).toBe('foreign-group-member');
  });
  it('AC4: a recycled child pid is refused', () => {
    const t = table(); const r = registry(t); const t2 = t.map((p) => (p.pid === 200 ? { ...p, lstart: 'Tue Feb 2 00:00:00 2026' } : p));
    expect(L.killOwnedGroup(200, sig, r, { table: t2, self: SELF }).code).toBe('recycled');
  });
});

describe('PARITY-R10-prep AC4: static audit of the signal sites', () => {
  const sources = fs.readdirSync(PARITY_DIR).filter((f) => f.endsWith('.mjs')).map((f) => ({ f, text: fs.readFileSync(path.join(PARITY_DIR, f), 'utf8') }));
  const hits = (re: RegExp) => sources.flatMap(({ f, text }) => text.split('\n').flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}`] : [])));
  it('AC4: no signal by name or pattern anywhere in the harness (pkill, killall, kill -, taskkill, pgrep-then-kill)', () => {
    expect(hits(/\bpkill\b|\bkillall\b|\btaskkill\b|['"`]kill['"`]|kill\s+-\d|killpg/)).toEqual([]);
  });
  it('AC4: process.kill appears only in lib.mjs: signal 0 in `alive`, and the guarded sweepPids / killOwnedGroup (libtest.mjs signals only the bystander it spawned itself)', () => {
    const h = hits(/process\.kill\(/).map((x) => x.split(':')[0]);
    expect([...new Set(h)]).toEqual(['lib.mjs']);
    const lib = sources.find((s) => s.f === 'lib.mjs')!.text.split('\n');
    const where = lib.flatMap((line, i) => (/process\.kill\(/.test(line) ? [i] : []));
    const fnOf = (i: number) => { for (let k = i; k >= 0; k--) { const m = lib[k].match(/^(?:export )?(?:async )?function (\w+)|^export const (\w+) =/); if (m) return m[1] ?? m[2]; } return null; };
    expect(where.map(fnOf).sort()).toEqual(['alive', 'killOwnedGroup', 'sweepPids', 'sweepPids']);
  });
  it('AC4: every ChildProcess.kill() / subprocess kill in drive.mjs goes through the owned-group helper (none exist)', () => {
    expect(hits(/(?<!process)\.kill\(/).filter((x) => !x.startsWith('libtest.mjs'))).toEqual([]);
    const drive = sources.find((s) => s.f === 'drive.mjs')!.text;
    expect(drive).toMatch(/L\.killOwnedGroup\(child\.pid, 'SIGTERM', owned\)/);
    expect(drive).toMatch(/L\.sweepPids\(\[\.\.\.L\.signalAllowance\(owned\)\.allowed\], 1500, owned\)/);
  });
});
