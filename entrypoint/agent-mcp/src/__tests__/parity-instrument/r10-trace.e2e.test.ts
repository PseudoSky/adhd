import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PARITY_DIR } from './load';

/**
 * PARITY-R10-prep AC1 + AC3 + AC5/AC6 - e2e lane (ADR-0009). `drive.mjs --dry-run --round R10` end to end against the REAL built agent-mcp (arm C, over stdio MCP, with the tracing plugin
 * pinned to a file sink in the run dir), the instrument's fake `claude` (arm A) and the in-process fake Anthropic server (thinking returned as omitted: signature only). No model, no network,
 * nothing is signalled that the driver did not spawn. The dry run writes only under a tmp `--out`; the committed R10 ledger (not an approval) is checked to be untouched.
 *   AC1  the graded wall is the engine window sum for BOTH arms, the segments partition the run with residual 0, and arm C's accounting step is a condition wait (< the old 1.5 s sleep)
 *   AC3  evidence.json + evidence/threads.jsonl exist for both arms, thinking is recorded (omitted), delegation mode and trace counts are present, the leak scan is clean, no signature anywhere
 *   AC6  the live driver is referenced by no nx target, hook or CI workflow
 */
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
let out = '';
let ledgerBefore = '';
const ledgerFile = path.join(PARITY_DIR, 'ledger', 'R10.json');
beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-dry-')); ledgerBefore = fs.readFileSync(ledgerFile, 'utf8'); });
afterAll(() => { fs.rmSync(out, { recursive: true, force: true }); });

const rec = (id: string) => JSON.parse(fs.readFileSync(path.join(out, 'runs', id, 'record.json'), 'utf8'));

describe('R10 dry run (fair timing + evidence)', () => {
  it('AC1/AC3: a dry R10 round runs A1 and C1 to completion with no harness failure and leaves the R10 ledger untouched (it is not an approval)', () => {
    const r = spawnSync(process.execPath, [DRIVE, '--dry-run', '--round', 'R10', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 420_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(out, 'runs')).sort()).toEqual(['A1', 'C1']);
    for (const id of ['A1', 'C1']) expect(rec(id).harnessFailure, id).toBeUndefined();
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);
    expect(JSON.parse(ledgerBefore).approvedBy).toBeFalsy();
  }, 480_000);

  it('AC1: the graded wall is the sum of the engine windows (not the run wall) for both arms; every segment is named and the partition has residual 0', () => {
    for (const id of ['A1', 'C1']) {
      const r = rec(id); const d = r.duration;
      expect(r.fairTiming.version, id).toBe(1);
      expect(d, id).toMatchObject({ graded: 'fairWallMs', fairTiming: true, overhead: { attributed: true, fair: true, residualMs: 0 } });
      expect(r.wallMs, id).toBe(d.windowsMs.reduce((a: number, b: number) => a + b, 0));
      expect(r.runWallMs, id).toBeGreaterThan(r.wallMs);
      const o = d.overhead;
      expect(o.setupMs + o.lagMs + o.verificationMs + o.handoffMs + o.accountingMs + o.teardownMs + r.wallMs, id).toBe(r.runWallMs);
      for (const k of ['setupMs', 'lagMs', 'verificationMs', 'handoffMs', 'accountingMs', 'teardownMs']) expect(o[k], `${id} ${k}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('AC1: arm C accounting is a bounded condition wait: far below the legacy 1.5 s fixed sleep, with the settle outcome recorded; arm A has no accounting step; boot is reported beside the split', () => {
    const c = rec('C1'); const a = rec('A1');
    expect(c.duration.overhead.accountingMs).toBeLessThan(1000);
    expect(c.fairTiming.settle).toMatchObject({ settled: true, deadlineHit: false });
    expect(c.fairTiming.settle.polls).toBeGreaterThanOrEqual(2);
    expect(c.fairTiming.boot.serverConnectMs).toBeGreaterThan(0);
    expect(a.duration.overhead.accountingMs).toBeLessThan(50);
    expect(Object.keys(a.fairTiming.boot)).toEqual(expect.arrayContaining(['p1.initMs', 'p2.initMs']));
    // the old attribution does not exist on a fair record
    expect(JSON.stringify(c.duration)).not.toContain('fixedSleepMs');
  });

  it('AC3: evidence exists for both arms: C joins wire + API log + tracing plugin + MCP calls; A joins the wire; the bundle is text-free and signature-free', () => {
    const ec = rec('C1').evidence; const ea = rec('A1').evidence;
    expect(ec.sources).toEqual({ wire: true, api: true, trace: true, calls: true });
    expect(ea.sources.wire).toBe(true);
    expect(ec.requests).toBeGreaterThan(10);
    expect(ec.thinking.blocks).toBe(ec.requests);
    expect(ec.thinking.omitted).toBe(ec.thinking.blocks);   // the fake API returns signature-only thinking: recorded as OMITTED, not as "no thinking"
    expect(ec.thinking.note).toContain('omitted by the API');
    expect(ec.delegation.sync).toBeGreaterThan(0);
    expect(ec.trace.toolCalls).toBeGreaterThan(0);
    expect(ec.trace.modelCalls).toBeGreaterThan(0);
    for (const e of [ec, ea]) expect(e.leakScan).toEqual({ ok: true, kinds: {} });
    for (const id of ['A1', 'C1']) {
      const dir = path.join(out, 'runs', id);
      const bundle = fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8');
      const threads = fs.readFileSync(path.join(dir, 'evidence', 'threads.jsonl'), 'utf8');
      for (const t of [bundle, threads]) { expect(t, id).not.toContain('FAKESIGNATURE'); expect(t, id).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}/); }
      expect(JSON.parse(bundle).schema).toBe('parity-evidence/1');
    }
  });

  it('AC3: the tracing plugin output of arm C lands in the run directory (file sink pinned by the instrument), not in the user home', () => {
    const traceDir = path.join(out, 'runs', 'C1', 'logs', 'trace');
    const files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const lines = fs.readFileSync(path.join(traceDir, files[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((l) => l.event === 'agent.tool_call.finish')).toBe(true);
    expect(lines.some((l) => l.event === 'agent.model_call.finish')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('FAKESIGNATURE');
  });

  it('AC2: the analyze command runs on the dry-run evidence bundles, exits 0 and prints every section', () => {
    const r = spawnSync(process.execPath, [DRIVE, 'analyze', 'R10', path.join(out, 'runs', 'A1', 'evidence.json'), path.join(out, 'runs', 'C1', 'evidence.json')], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const h of ['WALL-GAP RECONCILIATION', 'THREADS', 'PARENT BLOCKING', 'WORKER-REQUEST SURPLUS', 'TOOLS OFFERED', 'RT1-RT6 WIRE CHECKS']) expect(r.stdout).toContain(`== ${h}`);
  }, 150_000);
});

describe('R10 wiring (AC6): the live driver is reachable from no automated entrypoint', () => {
  it('AC6: no project.json / nx.json / package.json script / hook / workflow names drive.mjs or the R10 live flags', () => {
    const roots = ['project.json', 'nx.json', 'package.json', '.githooks', '.github', 'tools'].map((p) => path.join(REPO, p)).filter((p) => fs.existsSync(p));
    const r = spawnSync('rg', ['-n', '-l', '--glob', '!node_modules', '--glob', '!**/dist/**', 'parity/drive\\.mjs|drive\\.mjs --live', ...roots, path.join(REPO, 'entrypoint', 'agent-mcp', 'project.json'), path.join(REPO, 'entrypoint', 'agent-mcp', 'package.json')], { encoding: 'utf8' });
    expect(r.status, `matches: ${r.stdout}`).toBe(1);   // rg exit 1 = no match
  });
});
