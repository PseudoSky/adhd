/*
 * guards: the analyze commands stop reproducing the R9 triage numbers from the committed golden bundles (wall gap 17.780 s with residual 0, thread table, parent blocking, worker surplus, tools offered), RT1-RT6 miss a replayed or dangling thinking block, the probe matcher is not boundary-exact, a golden bundle holds signatures, keys or page text, or the CLI is non-deterministic or accepts a bad section.
 * tier: S (pure functions and in-process CLI over committed redacted bundles)
 * cites: PARITY-R10-prep AC2 (SCOPE-R10-prep, as titled in this file; no backlog uid appears in this file; filed under G9 bucket 003366c1-fef5-4b97-be06-bda8155d31a3).
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from '../../helpers/parity-instrument/load';

/**
 * PARITY-R10-prep AC2 (SCOPE-R10-prep, owner: "Please do not tell me 'I cant tell why' again ..."): the analysis commands that replace the R9 triage throwaway scripts, driven by the committed,
 * redacted golden bundles of the saved R9 A1 / C1 runs (parity/golden/r10/*.bundle.json, made with `drive.mjs analyze --emit-bundle <runDir> --redact-spans`). No test reads gitignored data.
 */
const AN = await loadParity('analyze.mjs');
const EV = await loadParity('evidence.mjs');
const golden = (n: string) => JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden', 'r10', n), 'utf8'));
const A = golden('r9-A1.bundle.json');
const C = golden('r9-C1.bundle.json');

describe('PARITY-R10-prep AC2: wall-gap reconciliation reproduces the R9 triage-2 numbers', () => {
  it('AC2: the 17.780 s wall gap = +9.246 (phase 1) +3.549 (phase 2) +2.208 (poll lag) +2.777 (harness overhead), residual 0 ms', () => {
    const r = AN.reconcile(A, C);
    expect(r.gapMs).toBe(17780);
    expect(r.deltas.phases).toEqual([9246, 3549]);
    expect(r.deltas.pollLagMs).toBe(2208);
    expect(r.deltas.overheadMs).toBe(2777);
    expect(r.residualMs).toBe(0);
    expect(r.measurementMs).toBe(4985);
    expect(r.c.phases.map((p: { ms: number }) => p.ms)).toEqual([58125, 34795]);
    expect(r.a.phases.map((p: { ms: number }) => p.ms)).toEqual([48879, 31246]);
    expect(r.c.identityMs).toBe(0);
    expect(r.a.identityMs).toBe(0);
  });

  it('AC2: the printed table carries the same numbers and the C overhead split (1.5 s fixed sleep, 1.283 s setup); A stays unattributed (not back-filled)', () => {
    const t = AN.formatReconcile(AN.reconcile(A, C));
    expect(t).toContain('gap +17.780 = +9.246 +3.549 +2.208 +2.777 (residual 0 ms)');
    expect(t).toContain('fixed sleep 1.500');
    expect(t).toContain('setup 1.283');
    expect(t).toContain('A1 overhead split: unattributed 0.620 (no marks; not split)');
    expect(t).toContain('4.985 s (28.0% of the gap)');
  });

  it('AC2 negative control: dropping the poll-lag term from the reconciliation leaves a non-zero residual (the identity has teeth)', () => {
    const C2 = JSON.parse(JSON.stringify(C));
    C2.record.duration.pollLagMs = 0;
    expect(AN.reconcile(A, C2).residualMs).toBe(2208);
  });
});

describe('PARITY-R10-prep AC2: threads, parent blocking, worker surplus, tools offered', () => {
  it('AC2: per-thread table: C has 16 parent + 6 + 6 + 2 (nested) + 4 worker requests, A has 16 parent + 4 + 3 + 3 workers and the WebFetch side thread', () => {
    const rc = AN.threadRows(C);
    expect(rc.map((r: { role: string; requests: number }) => `${r.role}:${r.requests}`)).toEqual(['parent:16', 'worker:6', 'worker:6', 'worker-nested:2', 'worker:4']);
    const ra = AN.threadRows(A);
    expect(ra.map((r: { role: string; requests: number }) => `${r.role}:${r.requests}`)).toEqual(['parent:16', 'side:1', 'worker:4', 'worker:3', 'worker:3']);
    expect(rc.reduce((a: number, r: { toolErrors: number }) => a + r.toolErrors, 0)).toBe(3);
    expect(rc.find((r: { role: string }) => r.role === 'parent').retryRounds).toBe(2);
  });

  it('AC2: parent blocking: C blocked 19.167 s + 13.537 s on SYNC delegation (tasks_batch, task); the tracing plugin spans say 19.128 s and 13.524 s; A launched its workers in the background (0.064 s)', () => {
    const rows = AN.blockingRows(C).filter((r: { calls: { delegation: string | null }[] }) => r.calls.some((c) => c.delegation));
    expect(rows.map((r: { gapMs: number }) => r.gapMs)).toEqual([19167, 13537]);
    expect(rows.map((r: { calls: { name: string; delegation: string }[] }) => `${r.calls[0].name}:${r.calls[0].delegation}`)).toEqual(['agent-mcp__tasks_batch:sync', 'agent-mcp__task:sync']);
    expect(rows.map((r: { calls: { traceMs: number }[] }) => r.calls[0].traceMs)).toEqual([19128, 13524]);
    const ta = AN.blockingRows(A).filter((r: { calls: { delegation: string | null }[] }) => r.calls.some((c) => c.delegation));
    expect(ta.map((r: { calls: { delegation: string }[] }) => r.calls.map((c) => c.delegation).join(','))).toEqual(['background,background', 'sync']);
    expect(ta[0].gapMs).toBe(64);
    const text = AN.formatBlocking(C);
    expect(text).toContain('parent blocked on SYNC delegation: 32.704 s over 2 turn(s) [19.167, 13.537]');
  });

  it('AC2: same-turn concurrency is visible: C parent turns with two traced calls whose spans overlap are flagged', () => {
    const rows = AN.blockingRows(C);
    expect(rows.filter((r: { spansOverlap: boolean }) => r.spansOverlap).length).toBeGreaterThanOrEqual(5);
    expect(rows.find((r: { seq: number }) => r.seq === 1).sameTurnConcurrent).toBe(true);
  });

  it('AC2: worker-request surplus: C 18 vs A 10 (surplus 8), by worker and by purpose, with a retry-after-error round on the critical-path worker', () => {
    const s = AN.surplus(A, C);
    expect(s.totalC).toBe(18);
    expect(s.totalA).toBe(10);
    const retry = s.purposes.find((p: { purpose: string }) => p.purpose === 'retry-after-error:shell');
    expect(retry).toMatchObject({ c: 1, a: 0 });
    expect(AN.formatSurplus(A, C)).toContain('total worker requests | C 18 | A 10 | surplus 8');
  });

  it('AC2: tools offered: parent 34 (C) vs 25 (A), worker 33 (C) vs 4 (A); the diff lists names only in C', () => {
    const t = AN.toolsOffered(C);
    expect(t.parent[0].n).toBe(34);
    expect(t.worker[0].n).toBe(33);
    expect(AN.toolsOffered(A).worker[0].n).toBe(4);
    const text = AN.formatTools(A, C);
    expect(text).toMatch(/worker \| 4 x 33 \| 3 x 4 \| 33:/);
    expect(text).toContain('agent-mcp__tasks_batch');
  });
});

describe('PARITY-R10-prep AC2: contamination (q_rate style) and RT1-RT6', () => {
  it('AC2: the carrier rate enters C through the ticket tool result and reaches parent phase-1 assistant text at request 25; in A it travels through the worker brief (asymmetric channel)', () => {
    const c = C.contamination.matches;
    expect(c.find((m: { channel: string }) => m.channel === 'request.toolResult')).toMatchObject({ seq: 2, phase: 1 });
    expect(c.filter((m: { channel: string; phase: number }) => m.channel === 'response.text' && m.phase === 1).map((m: { seq: number }) => m.seq)).toEqual([25]);
    expect(AN.formatContamination(C)).toContain('in PARENT assistant text of phase 1 (the q_rate invalid rule, oracle.mjs q_rate) 1 at request seq 25');
    const a = A.contamination.matches;
    expect(a.find((m: { channel: string }) => m.channel === 'request.brief')).toMatchObject({ seq: 9 });
    expect(a.find((m: { tool?: string }) => m.tool === 'Agent')).toMatchObject({ channel: 'response.toolInput', seq: 6 });
    expect(a.every((m: { span: string }) => /^\[\d+ chars\]$/.test(m.span))).toBe(true);   // golden spans are redacted
  });

  it('AC2: RT1-RT6 on C1: RT1-RT5 PASS; RT6 passes under the adopted definition (29/29) and the literal reading is printed (0/29, deficits 2,4 = the previous uncached input_tokens)', () => {
    const rt = AN.rtChecks(C);
    expect(rt.map((r: { id: string; verdict: string }) => `${r.id}:${r.verdict}`)).toEqual(['RT1:PASS', 'RT2:PASS', 'RT3:PASS', 'RT4:PASS', 'RT5:PASS', 'RT6:PASS']);
    expect(rt[0].text).toContain('27 emitted, 22 replayable');
    expect(rt[5].text).toContain('29/29 pairs');
    expect(rt[5].text).toContain('LITERAL reading');
    expect(rt[5].text).toContain('0/29 pairs');
    expect(rt[5].text).toContain('deficits of the failing pairs: 2,4 tokens');
    expect(AN.rtChecks(A)[3].verdict).toBe('n/a');
  });

  it('AC2 negative control: a replayed thinking block that was never emitted, or a dangling server_tool_use, turns RT1 / RT2 red', () => {
    const B = JSON.parse(JSON.stringify(C));
    const th = Object.keys(B.rt.thinking)[0];
    B.rt.thinking[th].replayedUnknown = 1;
    B.rt.dangling[th] = 1;
    const rt = AN.rtChecks(B);
    expect(rt[0].verdict).toBe('FAIL');
    expect(rt[1].verdict).toBe('FAIL');
  });

  it('AC2: the evidence summary says the thinking text is OMITTED by the API (signature only) in both arms, so nobody concludes from absence', () => {
    for (const b of [A, C]) {
      const t = AN.formatEvidence(b);
      expect(t).toContain('text omitted by the API (signature only)');
      expect(t).toContain('do not infer anything from its absence');
    }
  });

  it('AC2: the probe matcher is boundary-exact and minimal-span (synthetic text)', () => {
    expect(EV.findProbe('a rate of 19.50 and 9.505 and 9.50.', 9.5).map((h: { at: number }) => h.at)).toEqual([30]);
    expect(EV.findProbe('rate 9.50 now', 9.5, { redactSpan: true })[0].span).toBe('[4 chars]');
    expect(EV.findProbe('see TCK-ab12cd34 here', 'TCK-ab12cd34')).toHaveLength(1);
    expect(EV.findProbe('none', 9.5)).toEqual([]);
  });
});

describe('PARITY-R10-prep AC2: the CLI', () => {
  it('AC2: `analyze` over the two golden bundles is deterministic and exits 0; --section filters; a bad section exits 2', () => {
    const io = { tmpRoot: () => PARITY_DIR };
    const a = path.join(PARITY_DIR, 'golden', 'r10', 'r9-A1.bundle.json');
    const c = path.join(PARITY_DIR, 'golden', 'r10', 'r9-C1.bundle.json');
    const r1 = AN.analyzeCli(['R9', a, c], io);
    const r2 = AN.analyzeCli(['R9', a, c], io);
    expect(r1.code).toBe(0);
    expect(r1.out).toBe(r2.out);
    for (const h of ['WALL-GAP RECONCILIATION', 'THREADS', 'PARENT BLOCKING', 'WORKER-REQUEST SURPLUS', 'TOOLS OFFERED', 'CONTAMINATION', 'RT1-RT6 WIRE CHECKS', 'EVIDENCE']) expect(r1.out).toContain(`== ${h}`);
    const g = AN.analyzeCli(['R9', a, c, '--section', 'gap'], io);
    expect(g.out.startsWith('== WALL-GAP RECONCILIATION')).toBe(true);
    expect(g.out).not.toContain('== THREADS');
    expect(AN.analyzeCli(['R9', a, c, '--section', 'nope'], io).code).toBe(2);
    expect(AN.analyzeCli(['R9', a], io).code).toBe(2);
  });

  it('AC2: the golden bundles are redacted: no signatures, no key shapes, no page text, no prompt text', () => {
    for (const n of ['r9-A1.bundle.json', 'r9-C1.bundle.json']) {
      const text = fs.readFileSync(path.join(PARITY_DIR, 'golden', 'r10', n), 'utf8');
      expect(EV.leakScan(text, { forbidden: ['Example Domain', 'shopkit', 'security policy'] })).toEqual({ ok: true, kinds: {} });
    }
  });
});
