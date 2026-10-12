import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * R5-harness: the three instrument faults that stopped live round R5 attempt 2 before any model call.
 *   AC1 the default work dir is not under the repo (no ancestorLeaks)
 *   AC2 an explicit in-repo --out work dir is still rejected
 *   AC3 a harness fault before the reservation does not consume a run and does not record arm A as a void
 *   AC4 ledger.releaseRun is audited (reason required, unknown run refused, armA reset, startedAt kept)
 *   AC5 a retry after a harness fault re-runs the arm (the record is not "finished")
 *   AC6 the judge credential falls back to ADHD_AGENT_ANTHROPIC_SECRET (env, then the .env cascade) with the auth shape chosen by prefix, and a presence gate exists
 * No model is called: executors are stubs, fetch is a stub, `claude` is never spawned. Secrets used here are synthetic.
 */
const D = await loadParity('drive.mjs');
const LG = await loadParity('ledger.mjs');
const JG = await loadParity('judge.mjs');
const GT = await loadParity('gate.mjs');

const cleanup: string[] = [];
const mk = (p = 'r5h-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanup.push(d); return d; };
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const approvedLedger = (dir: string, extra: object = {}) => {
  fs.writeFileSync(path.join(dir, 'RT.json'), JSON.stringify({ ...LG.emptyLedger('RT'), approvedBy: 'owner', startedAt: '2026-10-11T00:00:00.000Z', ...extra }, null, 2));
  return path.join(dir, 'RT.json');
};
// Every ctx gets a unique round so its os.tmpdir() work dir never collides; the dir is removed afterwards.
let n = 0;
const ctxFor = (opts: object, arm = 'A') => {
  const round = `R${900 + n++ + (process.pid % 90) * 10}`;
  const ctx = D.makeCtx({ ...D.parseArgs([]), round, ...opts }, [], { arm, rep: 1 }, false);
  cleanup.push(path.join(os.tmpdir(), 'adhd-agent-mcp-parity', round));
  return ctx;
};

describe('R5-harness AC1/AC2 work dir placement', () => {
  it('AC1: a default run (main defaults opts.out inside the repo, no --out) puts the work dir under os.tmpdir() with zero ancestorLeaks', () => {
    const opts = D.parseArgs([]);
    expect(opts.outExplicit).toBeFalsy();
    // exactly what main() does before building any ctx
    opts.outExplicit = Boolean(opts.out);
    opts.out = path.join(D.tmpRoot(opts.round), 'live/out');
    const ctx = ctxFor(opts);
    expect(ctx.work.startsWith(os.tmpdir())).toBe(true);
    expect(ctx.work.startsWith(D.REPO_ROOT)).toBe(false);
    expect(D.ancestorLeaks(ctx.work)).toEqual([]);
    expect(ctx.runDir.startsWith(D.tmpRoot(opts.round))).toBe(true); // output still lands in the in-repo tmp/ tree
  });

  it('AC2: an explicit --out inside the repo keeps the work dir there and prepare/rawRun rejects it with the leak error', async () => {
    const opts = D.parseArgs(['--out', path.join(D.REPO_ROOT, 'tmp', 'agent-mcp', 'parity', 'R-unit-ac2')]);
    expect(opts.outExplicit).toBe(true);
    const ctx = ctxFor(opts);
    expect(ctx.work.startsWith(D.REPO_ROOT)).toBe(true);
    expect(D.ancestorLeaks(ctx.work).length).toBeGreaterThan(0);
    ctx.ledgerPath = approvedLedger(mk());
    ctx.executor = async () => { throw new Error('executor must not run'); };
    await expect(D.rawRun(ctx)).rejects.toThrow(/fixture directory sits under agent-instruction\/repo files/);
    fs.rmSync(path.join(D.REPO_ROOT, 'tmp', 'agent-mcp', 'parity', 'R-unit-ac2'), { recursive: true, force: true });
  });
});

describe('R5-harness AC3/AC5 a harness fault is not a run', () => {
  it('AC3: prepare() failing leaves the ledger runs empty and armA null; AC5: the marked record is retryable', async () => {
    const dir = mk();
    const ledgerPath = approvedLedger(dir);
    const before = fs.readFileSync(ledgerPath, 'utf8');
    const ctx = ctxFor(D.parseArgs(['--out', path.join(D.REPO_ROOT, 'tmp', 'agent-mcp', 'parity', 'R-unit-ac3')]));
    ctx.ledgerPath = ledgerPath;
    let err: unknown;
    try { await D.rawRun(ctx); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(ctx.modelRun).toBeUndefined();
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(before); // byte-identical: no reservation, no armA write
    const led = LG.readLedger('RT', dir);
    expect(led.runs).toEqual([]);
    expect(led.armA).toBeNull();

    const record: Record<string, unknown> = { harnessFailure: String((err as Error).stack) };
    expect(D.markPreSpawnFault(ctx, record, err)).toBe(true);
    expect(String((record.aborted as string[])[0])).toMatch(/harness fault before any model call/);
    const rec = path.join(mk(), 'record.json');
    fs.writeFileSync(rec, JSON.stringify(record));
    expect(D.isFinishedRecord(rec)).toBe(false); // AC5: resume re-runs the arm instead of skipping it
    fs.rmSync(path.join(D.REPO_ROOT, 'tmp', 'agent-mcp', 'parity', 'R-unit-ac3'), { recursive: true, force: true });
  });

  it('AC3 teeth: a run that does reach the spawn boundary IS reserved, and a fault after the reservation is NOT marked retryable', async () => {
    const dir = mk();
    const ledgerPath = approvedLedger(dir);
    const ctx = ctxFor(D.parseArgs([]));
    ctx.ledgerPath = ledgerPath;
    ctx.executor = async () => { throw new Error('boom after reservation'); };
    await expect(D.rawRun(ctx)).rejects.toThrow(/boom after reservation/);
    expect(LG.readLedger('RT', dir).runs.map((r: { runId: string }) => r.runId)).toEqual([ctx.spec.runId]);
    expect(D.markPreSpawnFault(ctx, {}, new Error('x'))).toBe(false);
    expect(D.isFinishedRecord(path.join(mk(), 'missing.json'))).toBe(false);
  });
});

describe('R5-harness AC4 ledger.releaseRun is audited', () => {
  const reserved = () => {
    const dir = mk();
    approvedLedger(dir);
    LG.reserveRun('RT', { arm: 'A', runId: 'A1', dir });
    LG.recordArmA('RT', false, 'content undefined/undefined', dir);
    return dir;
  };
  it('AC4: releases the run, resets armA, keeps startedAt, appends an audit entry with reason and timestamp', () => {
    const dir = reserved();
    const out = LG.releaseRun('RT', 'A1', 'harness fault before any model call', dir);
    expect(out.used).toBe(0);
    const led = LG.readLedger('RT', dir);
    expect(led.runs).toEqual([]);
    expect(led.armA).toBeNull();
    expect(led.armOrder).toEqual([]);
    expect(led.startedAt).toBe('2026-10-11T00:00:00.000Z');
    expect(led.releases).toHaveLength(1);
    expect(led.releases[0]).toMatchObject({ runId: 'A1', arm: 'A', reason: 'harness fault before any model call' });
    expect(Number.isFinite(Date.parse(led.releases[0].releasedAt))).toBe(true);
    // a released slot is reservable again (arm A first)
    expect(LG.reserveRun('RT', { arm: 'A', runId: 'A1', dir }).used).toBe(1);
  });
  it('AC4: no reason / unknown run are refused and leave the file untouched', () => {
    const dir = reserved();
    const f = path.join(dir, 'RT.json');
    const before = fs.readFileSync(f, 'utf8');
    expect(() => LG.releaseRun('RT', 'A1', '  ', dir)).toThrow(/reason is required/);
    expect(() => LG.releaseRun('RT', 'B1', 'x', dir)).toThrow(/not reserved/);
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
  });
  it('AC4: the cap still holds after a release (release is not a way to exceed 3)', () => {
    const dir = mk();
    approvedLedger(dir);
    LG.reserveRun('RT', { arm: 'A', runId: 'A1', dir });
    LG.recordArmA('RT', true, 'ok', dir);
    LG.reserveRun('RT', { arm: 'B', runId: 'B1', dir });
    LG.reserveRun('RT', { arm: 'C', runId: 'C1', dir });
    expect(() => LG.reserveRun('RT', { arm: 'C', runId: 'C2', dir })).toThrow(/cap/);
  });
  it('AC4: the committed R5 ledger records the owner-authorized repair', () => {
    const led = LG.readLedger('R5');
    expect(led.runs).toEqual([]);
    expect(led.armA).toBeNull();
    expect(led.startedAt).toBeTruthy();
    expect(led.releases?.[0]).toMatchObject({ runId: 'A1' });
    expect(led.releases?.[0].reason).toMatch(/harness fault before any model call, 0 model calls, attempt 2/);
  });
});

describe('R5-harness AC6 judge credential', () => {
  const API = 'sk-ant-api03-SYNTHETIC';
  const OAT = 'sk-ant-oat01-SYNTHETIC';
  const stubFetch = () => {
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 4 } }) };
    };
    return { calls, fetchImpl };
  };
  const call = (c: { complete: (a: object) => Promise<unknown> }) => c.complete({ model: 'm', temperature: 0, maxTokens: 5, prompt: 'p' });

  it('AC6: ANTHROPIC_API_KEY keeps working (x-api-key)', async () => {
    const { calls, fetchImpl } = stubFetch();
    await call(JG.liveJudgeClient({ env: { ANTHROPIC_API_KEY: API }, home: mk(), cwd: mk(), fetchImpl }));
    expect(calls[0].init.headers['x-api-key']).toBe(API);
    expect(calls[0].init.headers.authorization).toBeUndefined();
  });
  it('AC6: only ADHD_AGENT_ANTHROPIC_SECRET=sk-ant-api* in process env -> x-api-key', async () => { // pragma: allowlist secret
    const { calls, fetchImpl } = stubFetch();
    await call(JG.liveJudgeClient({ env: { ADHD_AGENT_ANTHROPIC_SECRET: API }, home: mk(), cwd: mk(), fetchImpl }));
    expect(calls[0].init.headers['x-api-key']).toBe(API);
  });
  it('AC6: an sk-ant-oat* secret from ~/.adhd/.env -> Bearer + oauth beta header + Claude Code identity system block', async () => {
    const home = mk();
    fs.mkdirSync(path.join(home, '.adhd'));
    fs.writeFileSync(path.join(home, '.adhd', '.env'), `OTHER=1\nADHD_AGENT_ANTHROPIC_SECRET="${OAT}"\n`);
    const { calls, fetchImpl } = stubFetch();
    await call(JG.liveJudgeClient({ env: {}, home, cwd: mk(), fetchImpl }));
    const h = calls[0].init.headers;
    expect(h.authorization).toBe(`Bearer ${OAT}`);
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(JSON.parse(calls[0].init.body).system[0].text).toMatch(/^You are Claude Code/);
  });
  it('AC6: a non-oauth, non-api token -> Bearer without the beta header or identity block', () => {
    const s = JG.judgeAuthShape('plain-token');
    expect(s.headers.authorization).toBe('Bearer plain-token');
    expect(s.headers['anthropic-beta']).toBeUndefined();
    expect(s.system).toBeUndefined();
  });
  it('AC6: process env beats the cascade; cwd .env beats ~/.adhd/.env; an empty value counts as unset', () => {
    const home = mk(), cwd = mk();
    fs.mkdirSync(path.join(home, '.adhd'));
    fs.writeFileSync(path.join(home, '.adhd', '.env'), 'ADHD_AGENT_ANTHROPIC_SECRET=from-home\n'); // pragma: allowlist secret
    expect(JG.resolveJudgeCredential({ env: {}, home, cwd }).secret).toBe('from-home');
    fs.writeFileSync(path.join(cwd, '.env'), 'ADHD_AGENT_ANTHROPIC_SECRET=from-cwd\n'); // pragma: allowlist secret
    expect(JG.resolveJudgeCredential({ env: {}, home, cwd }).secret).toBe('from-cwd');
    expect(JG.resolveJudgeCredential({ env: { ADHD_AGENT_ANTHROPIC_SECRET: 'from-env' }, home, cwd }).secret).toBe('from-env'); // pragma: allowlist secret
    expect(JG.resolveJudgeCredential({ env: { ADHD_AGENT_ANTHROPIC_SECRET: '' }, home, cwd }).secret).toBe('from-cwd');
  });
  it('AC6: nothing set -> throws BEFORE fetch; the resolved credential never serialises its secret', async () => {
    const { calls, fetchImpl } = stubFetch();
    await expect(call(JG.liveJudgeClient({ env: {}, home: mk(), cwd: mk(), fetchImpl }))).rejects.toThrow(/no credential/);
    expect(calls).toHaveLength(0);
    const r = JG.resolveJudgeCredential({ env: { ADHD_AGENT_ANTHROPIC_SECRET: OAT }, home: mk(), cwd: mk() });
    expect(r.present).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC');
    expect(JSON.stringify(Object.entries(r))).not.toContain('SYNTHETIC');
  });
  it('AC6: the presence gate is part of the live gate order, between scope and preflight, and red without a credential', async () => {
    expect(GT.GATE_ORDER).toEqual(['ledger', 'scope', 'judgeCredential', 'preflight', 'pacing']);
    let spawned = 0;
    const green = () => ({ ok: true, reasons: [] });
    const res = await GT.runGates({ ledger: green, scope: green, judgeCredential: () => ({ ok: JG.resolveJudgeCredential({ env: {}, home: mk(), cwd: mk() }).present, reasons: ['no judge credential'] }), preflight: () => { spawned++; return green(); }, pacing: () => { spawned++; return green(); } });
    expect(res).toMatchObject({ ok: false, exitCode: 3, failed: 'judgeCredential' });
    expect(spawned).toBe(0);
  });
});
