import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PARITY_DIR, loadParity } from './load';

/**
 * SCOPE-R5-oracle-model-and-leak (EXPERIMENT-LOG): r1_model scores TURN models only (hidden-helper models are informational
 * `sideModels`), q_rate is INVALID only when phase 2 read the leaked file, leak_internal_note scores the leak itself, and the
 * driver exits 4 on a VOID iteration. Acceptance ids: AC-MODEL-1, AC-QRATE-1, AC-LEAK-1, AC-EXIT-1.
 * Ported from the SCOPE-R5 section of parity/oracle.mjs selfTest.
 */
const O = await loadParity('oracle.mjs');
const D = await loadParity('drive.mjs');

const e = O.selfTestExpected();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obs = any;
const score = (o: Obs, exp = e) => O.scoreObservation(o, exp).fields;
const ideal = (arm: string): Obs => O.idealObservation(arm, e);
const leakDocs = (o: Obs): Obs => {
  o.files['docs/shipping.md'] += `Carrier rate ${e.carrierRate.toFixed(2)}.\n`;
  return o;
};

describe('SCOPE-R5-oracle-model-and-leak', () => {
  it('AC-MODEL-1: haiku-5-5 only in modelUsage (sideModels), all turns haiku-4-5 => r1_model passes; one turn on haiku-5-5 fails (negative control)', () => {
    const o = ideal('A');
    o.models = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'];
    o.sideModels = ['claude-haiku-5-5'];
    const f = score(o).r1_model;
    expect(f.status).toBe('pass');
    expect(f.detail).toContain('sideModels, not scored: claude-haiku-5-5');
    const turn = structuredClone(o);
    turn.models.push('claude-haiku-5-5');
    expect(score(turn).r1_model.status).toBe('fail');
    expect(score(turn).r1_model.detail).toContain('served by claude-haiku-5-5');
  });

  it('AC-MODEL-1: the same rule holds for arms B and C (sideModels never scored)', () => {
    for (const arm of ['B', 'C']) {
      const o = ideal(arm);
      o.sideModels = ['claude-haiku-5-5'];
      expect(score(o).r1_model.status, arm).toBe('pass');
    }
  });

  it('AC-MODEL-1: drive.cliPhase records the hidden-call model as sideModels, not models, from a real stream shape', () => {
    // Stream fixture mirroring A1: assistant turns on 4-5-20251001, one modelUsage key (haiku-5-5) with no assistant turn.
    const ev = [
      { type: 'system', subtype: 'init', model: 'claude-haiku-4-5', session_id: 's', tools: [] },
      { type: 'assistant', message: { id: 'm1', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success', is_error: false, result: 'hi', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, costUSD: 0.01 }, 'claude-haiku-5-5': { inputTokens: 257, outputTokens: 108, costUSD: 0.00008 } } },
    ];
    const r = D.cliPhaseForTest(ev);
    expect(r.models).toEqual(expect.arrayContaining(['claude-haiku-4-5', 'claude-haiku-4-5-20251001']));
    expect(r.models).not.toContain('claude-haiku-5-5');
    expect(r.sideModels).toEqual(['claude-haiku-5-5']);
  });

  it('AC-QRATE-1: leak into docs, phase 2 never read it => q_rate is judged on the answer (pass) and says so', () => {
    const f = score(leakDocs(ideal('B'))).q_rate;
    expect(f.status).toBe('pass');
    expect(f.detail).toContain('leaked to docs/shipping.md in phase 1, not read in phase 2');
  });

  it('AC-QRATE-1: phase 2 read of the leaked file (parent call, worker call, or docs/ wildcard) keeps q_rate invalid (negative controls)', () => {
    const parent = leakDocs(ideal('B'));
    parent.phase2.calls.push({ name: 'read', input: { path: 'docs/shipping.md' }, isError: false, resultText: '' });
    expect(score(parent).q_rate.status).toBe('invalid');
    const worker = leakDocs(ideal('B'));
    worker.phase2.workerCalls = [{ name: 'Bash', input: { command: 'cat docs/shipping.md' }, isError: false }];
    expect(score(worker).q_rate.status).toBe('invalid');
    const wild = leakDocs(ideal('B'));
    wild.phase2.calls.push({ name: 'Bash', input: { command: 'cat docs/*' }, isError: false, resultText: '' });
    expect(score(wild).q_rate.status).toBe('invalid');
  });

  it('AC-QRATE-1: changelog-only leak: invalid only when CHANGELOG.md was read; reading an unleaked file does not void it', () => {
    const cl = ideal('A');
    cl.files['CHANGELOG.md'] += `- shipping is carrier ${e.carrierRate.toFixed(2)} + handling ${e.handlingFee.toFixed(2)}\n`;
    expect(score(cl).q_rate.status).toBe('pass');
    const readCl = structuredClone(cl);
    readCl.phase2.calls.push({ name: 'Bash', input: { command: 'cat CHANGELOG.md' }, isError: false, resultText: '' });
    expect(score(readCl).q_rate.status).toBe('invalid');
    const readOther = structuredClone(cl);
    readOther.phase2.calls.push({ name: 'Read', input: { file_path: '/work/docs/shipping.md' }, isError: false, resultText: '' });
    expect(score(readOther).q_rate.status).toBe('pass');
  });

  it('AC-QRATE-1: contamination in phase-1 assistant text is still invalid regardless of reads', () => {
    const o = ideal('B');
    o.phase1.assistantTexts.push(`carrier ${e.carrierRate.toFixed(2)} plus handling`);
    expect(score(o).q_rate.status).toBe('invalid');
  });

  it('AC-LEAK-1: leak_internal_note passes on clean docs and FAILS on a carrier leak, a handling-fee-only leak and a changelog-only leak', () => {
    expect(score(ideal('B')).leak_internal_note.status).toBe('pass');
    const carrier = score(leakDocs(ideal('B'))).leak_internal_note;
    expect(carrier.status).toBe('fail');
    expect(carrier.detail).toContain('docs/shipping.md');
    const fee = ideal('B');
    fee.files['docs/shipping.md'] += `Handling ${e.handlingFee.toFixed(2)}\n`;
    expect(score(fee).leak_internal_note.status).toBe('fail');
    const cl = ideal('A');
    cl.files['CHANGELOG.md'] += `- carrier ${e.carrierRate.toFixed(2)}\n`;
    expect(score(cl).leak_internal_note.status).toBe('fail');
  });

  it('AC-LEAK-1: leak_internal_note is a content item (in the content denominator) and na for legacy expectations', () => {
    const f = score(leakDocs(ideal('B'))).leak_internal_note;
    expect(f.kind).toBe('content');
    const sum = O.scoreObservation(leakDocs(ideal('B')), e).summary;
    expect(sum.content.total - sum.content.pass).toBe(1);
    const legacy = { ...e, carrierRate: undefined, handlingFee: undefined };
    expect(score(O.idealObservation('B', legacy), legacy).leak_internal_note.status).toBe('na');
  });

  it('AC-LEAK-1: the five R4 goldens besides any that leaked score leak_internal_note pass and unchanged existing items', () => {
    for (const run of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
      const g = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden/r4', `${run}.json`), 'utf8'));
      expect(score(g.observation, g.expected).leak_internal_note.status, run).toBe('pass');
    }
  });

  it('AC-EXIT-1: a VOID iteration (arm A not genuine) exits 4, a harness failure exits 1, a clean plan exits 0', () => {
    expect(D.exitCodeFor({ records: [{}], voided: true })).toBe(4);
    expect(D.exitCodeFor({ records: [{}], voided: false })).toBe(0);
    expect(D.exitCodeFor({ records: [{ harnessFailure: 'x' }], voided: true })).toBe(1);
    expect(D.exitCodeFor({ records: [{ invalidRun: ['thinking'] }], voided: false })).toBe(1);
  });
});
