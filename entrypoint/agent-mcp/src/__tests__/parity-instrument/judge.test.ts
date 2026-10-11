import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { PARITY_DIR, loadParity } from './load';

/**
 * Judge unit tests (spec R5.AC9, AC10, AC11). No model call: the judge client is a fake and the live client is never constructed.
 *   R5.AC9  known-mean fixtures: the quality mean/gate arithmetic on hand-computed score sets.
 *   R5.AC10 blindness across arm orders: the brief a judge sees is a pure function of spec + diff + normalized transcript, independent of
 *           which arm it is, the order arms are judged in, and every identifying token.
 *   R5.AC11 mutated-parser teeth: each parser rule is deleted in a copy of quality.mjs and a fixture must then be accepted that the real parser rejects.
 */
const Q = await loadParity('quality.mjs');
const J = await loadParity('judge.mjs');
const M = await loadParity('metrics.mjs');

const RUBRIC: string[] = Q.RUBRIC;
const scoresOf = (f: (k: string, i: number) => number) => Object.fromEntries(RUBRIC.map((k, i) => [k, f(k, i)]));
const notesOf = () => Object.fromEntries(RUBRIC.map((k) => [k, `note ${k}`]));
const reply = (scores: object, notes: object = notesOf(), extra: object = {}) => JSON.stringify({ scores, notes, ...extra });

describe('R5.AC9 known-mean fixtures', () => {
  it('R5.AC9: the rubric is exactly the 8 named qualities, unweighted', () => {
    expect(RUBRIC).toHaveLength(8);
    expect(new Set(RUBRIC).size).toBe(8);
    expect(Q.QUALITY_GATE).toBe(0.98);
  });

  it.each([
    ['all 80', scoresOf(() => 80), 80],
    ['1..8 scaled by 10 (10,20,...,80)', scoresOf((_k, i) => (i + 1) * 10), 45],
    ['half 100 half 50', scoresOf((_k, i) => (i < 4 ? 100 : 50)), 75],
    ['extremes 1 and 100', scoresOf((_k, i) => (i === 0 ? 100 : 1)), (100 + 7) / 8],
  ])('R5.AC9: qualityMean(%s) = %d', (_name, scores, mean) => {
    expect(Q.qualityMean(scores)).toBeCloseTo(mean as number, 12);
  });

  it('R5.AC9: parse then mean round-trips a reply with a known mean, scores and notes preserved in rubric order', () => {
    const p = Q.parseJudgeOutput(reply(scoresOf((_k, i) => 60 + i)));
    expect(Object.keys(p.scores)).toEqual(RUBRIC);
    expect(Q.qualityMean(p.scores)).toBeCloseTo(63.5, 12);
    expect(p.notes.code_clarity).toBe('note code_clarity');
  });

  it('R5.AC9: the 0.98 gate is applied to the arm mean vs A mean through the verdict (boundary and just below)', () => {
    const a = Q.qualityMean(scoresOf(() => 100));
    const edge = Q.qualityMean(scoresOf((_k, i) => (i < 2 ? 100 - 5 : 100 - 1))); // 100 - (10+6)/8 = 98
    expect(edge / a).toBeCloseTo(0.98, 12);
    const sm = (q: number, arm: string) => ({ runId: arm, arm, genuine: true, extra: false, extraRunReason: '', costBilled: 1, costCommon: 1, wallMs: 1, quality: q, turns: 0, toolCalls: 0, peakContext: null });
    expect(M.variantVerdict(sm(a, 'A'), sm(edge, 'B')).goals.quality.result).toBe('PASS');
    expect(M.variantVerdict(sm(a, 'A'), sm(edge - 0.5, 'B')).goals.quality.result).toBe('FAIL');
  });

  it('R5.AC9: judge cost is the pinned-model price arithmetic and the model id is pinned', () => {
    expect(J.JUDGE_MODEL).toBe('claude-haiku-4-5');
    expect(J.judgeCostUsd(1_000_000, 0)).toBeCloseTo(1, 12);
    expect(J.judgeCostUsd(0, 1_000_000)).toBeCloseTo(5, 12);
    expect(J.judgeCostUsd(2000, 500)).toBeCloseTo(2000e-6 + 500 * 5e-6, 12);
  });

  it('R5.AC7: judging is eligible only when A and the judged arm both genuinely succeeded', () => {
    expect(J.judgeEligible({ aGenuine: true, armGenuine: true })).toBe(true);
    expect(J.judgeEligible({ aGenuine: true, armGenuine: false })).toBe(false);
    expect(J.judgeEligible({ aGenuine: false, armGenuine: true })).toBe(false);
    expect(J.judgeEligible({ aGenuine: 'yes', armGenuine: true })).toBe(false);
  });
});

describe('R5.AC10 blindness across arm orders', () => {
  const prompts = { phase1: 'Fix the checkout bug in /Users/nix/dev/repo (ticket 0a1b2c3d-1111-4222-8333-444455556666).', phase2: 'Now document it.' };
  const ticketText = 'Ticket text mentioning claude and agent-mcp and anthropic.';
  const diff = 'diff --git a/src/a.js b/src/a.js\n+// edited by claude-haiku-4-5 via mcp__agent-mcp__task in /private/tmp/run42/x';
  // The SAME work as seen through three arms: only tool spellings and identity tokens differ.
  const transcripts: Record<string, Array<Record<string, unknown>>> = {
    A: [
      { role: 'assistant', text: 'I will use Bash and claude -p style tools.', tool: 'Bash', result: 'ok sess_AbCdEf123456 /Users/nix/secret/path' },
      { role: 'assistant', text: 'delegating', tool: 'Task', result: 'done' },
    ],
    B: [
      { role: 'assistant', text: 'I will use shell via agent-mcp on claudecli.', tool: 'mcp__shell__shell_execute', result: 'ok sess_AbCdEf123456 /Users/nix/secret/path' },
      { role: 'assistant', text: 'delegating', tool: 'mcp__agent-mcp__task', result: 'done' },
    ],
    C: [
      { role: 'assistant', text: 'I will use the haiku model on anthropic.', tool: 'shell_execute', result: 'ok sess_AbCdEf123456 /Users/nix/secret/path' },
      { role: 'assistant', text: 'delegating', tool: 'tasks_batch', result: 'done' },
    ],
  };
  const brief = (arm: string, label = 'Candidate-aaaaaa') => J.buildBrief({ prompts, ticketText, diff, transcript: transcripts[arm], label });

  it('R5.AC10: no identifying token reaches the brief, for any arm', () => {
    for (const arm of ['A', 'B', 'C']) {
      const { brief: b } = brief(arm);
      expect(b, arm).not.toMatch(/mcp__|claude|agent-mcp|anthropic|haiku|sonnet|opus|shell_execute|claudecli/i);
      expect(b, arm).not.toMatch(/\/Users\/|\/private\/tmp\/|sess_AbCdEf123456|0a1b2c3d-1111-4222-8333-444455556666/);
    }
  });

  it('R5.AC10: arm spellings normalize to the same categories, so equivalent work yields an identical brief body', () => {
    const body = (arm: string) => brief(arm).brief.split('## Transcript')[1].replace(/"text": "[^"]*"/g, '"text": "_"');
    expect(body('A')).toBe(body('B'));
    expect(body('B')).toBe(body('C'));
    expect(J.toolCategory('Task')).toBe('delegate');
    expect(J.toolCategory('mcp__agent-mcp__tasks_batch')).toBe('delegate');
    expect(J.toolCategory('mcp__shell__shell_execute')).toBe('shell');
    expect(J.toolCategory('WebFetch')).toBe('web');
  });

  it('R5.AC10: the brief of an arm does not depend on the order arms are judged in (fixed label => identical sha in every permutation)', () => {
    const perms = [['A', 'B', 'C'], ['C', 'B', 'A'], ['B', 'A', 'C'], ['B', 'C', 'A']];
    const sha: Record<string, Set<string>> = { A: new Set(), B: new Set(), C: new Set() };
    for (const order of perms) for (const arm of order) sha[arm].add(brief(arm).briefSha);
    for (const arm of ['A', 'B', 'C']) expect(sha[arm]!.size, arm).toBe(1);
  });

  it('R5.AC10: the label is random per judging and never the arm id; an injected rng makes it deterministic', () => {
    const l1 = J.randomLabel(() => 0.5);
    expect(l1).toMatch(/^Candidate-[0-9a-f]{6}$/);
    expect(l1).toBe(J.randomLabel(() => 0.5));
    expect(J.randomLabel(() => 0.1)).not.toBe(l1);
    for (const arm of ['A', 'B', 'C']) expect(J.buildBrief({ prompts, ticketText, diff, transcript: transcripts[arm] }).label).not.toMatch(new RegExp(`\\b${arm}\\b`));
  });

  it('R5.AC10: oracle results, cost, duration and thresholds are not part of the brief (it is built from spec, diff and transcript only)', () => {
    const { brief: b } = brief('A');
    expect(b).not.toMatch(/oracle|costUsd|wallMs|threshold|1\.02|0\.98/i);
  });

  it('R5.AC5: runJudge writes one record per call, logs the call to the ledger callback and rejects bad replies without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
    const calls: unknown[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const client = { complete: async (a: Record<string, unknown>) => (seen.push(a), { text: reply(scoresOf(() => 70)), inputTokens: 1000, outputTokens: 200 }) };
    const { brief: b, briefSha } = brief('A');
    const r = await J.runJudge({ client, arm: 'A', brief: b, briefSha, outDir: dir, onCall: (c: unknown) => calls.push(c) });
    expect(r.ok).toBe(true);
    expect(seen[0]).toMatchObject({ model: 'claude-haiku-4-5', temperature: 0, maxTokens: J.JUDGE_MAX_TOKENS, prompt: b });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'A.json'), 'utf8')).briefSha).toBe(briefSha);
    const bad = await J.runJudge({ client: { complete: async () => ({ text: 'sorry, cannot', inputTokens: 1, outputTokens: 1 }) }, arm: 'B', brief: b, briefSha });
    expect([bad.ok, bad.code]).toEqual([false, 'NOT_JSON']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('R5.AC11 mutated-parser teeth', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-mutants-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const good = (): Record<string, number> => scoresOf(() => 50);

  /** Fixtures the real parser must reject, keyed by the error code the rule produces. */
  const rejects: Array<[string, string]> = [
    ['NOT_JSON', 'no json here at all'],
    ['TEXT_OUTSIDE_JSON', `Here you go: ${reply(good())}`],
    ['BAD_SHAPE', JSON.stringify({ scores: [], notes: {} })],
    ['MISSING_KEY', reply(Object.fromEntries(Object.entries(good()).slice(1)))],
    ['EXTRA_KEY', reply({ ...good(), bonus: 5 }, { ...notesOf(), bonus: 'x' })],
    ['EXTRA_KEY', reply(good(), notesOf(), { verdict: 'great' })],
    ['DUPLICATE_KEY', reply(good()).replace('"code_clarity":50', '"code_clarity":50,"code_clarity":99')],
    ['NON_INTEGER', reply({ ...good(), code_clarity: 50.5 })],
    ['NON_INTEGER', reply({ ...good(), code_clarity: '50' })],
    ['OUT_OF_RANGE', reply({ ...good(), code_clarity: 0 })],
    ['OUT_OF_RANGE', reply({ ...good(), code_clarity: 101 })],
    ['BAD_SHAPE', reply(good(), { ...notesOf(), code_clarity: 7 })],
  ];

  it('R5.AC11: the real parser rejects every fixture with exactly the expected code (the table is the unmutated baseline)', () => {
    for (const [code, raw] of rejects) expect(() => Q.parseJudgeOutput(raw), `${code}: ${raw.slice(0, 40)}`).toThrowError(new RegExp(`^${code}:`));
    expect(() => Q.parseJudgeOutput(reply(good()))).not.toThrow();
  });

  const src = fs.readFileSync(path.join(PARITY_DIR, 'quality.mjs'), 'utf8');
  const mutants: Array<[string, string, string]> = [
    ['drop the integer check', "if (typeof v !== 'number' || !Number.isInteger(v))", 'if (false)'],
    ['drop the lower bound', 'if (v < 1 || v > 100)', 'if (v > 100)'],
    ['drop the upper bound', 'if (v < 1 || v > 100)', 'if (v < 1)'],
    ['drop the duplicate-key rule', 'if (dup) throw', 'if (false) throw'],
    ['drop the missing-key rule', 'if (missing.length) throw', 'if (false) throw'],
    ['drop the extra-key rule', 'if (extra.length) throw', 'if (false) throw'],
    ['drop the top-level extra-key rule', "if (Object.keys(obj).some((k) => k !== 'scores' && k !== 'notes')) throw", 'if (false) throw'],
    ['drop the text-outside-json rule', "if (!t.startsWith('{') || !t.endsWith('}')) {", 'if (false) {'],
    ['drop the notes-must-be-string rule', "if (typeof obj.notes[k] !== 'string') throw", 'if (false) throw'],
  ];

  it.each(mutants)('R5.AC11: mutant "%s" is killed (some fixture is accepted or mis-coded)', async (name, from, to) => {
    expect(src.includes(from), `mutation anchor missing in quality.mjs: ${from}`).toBe(true);
    const file = path.join(tmp, `mutant-${name.replace(/\W+/g, '-')}.mjs`);
    fs.writeFileSync(file, src.replace(from, to));
    const mut = await import(/* @vite-ignore */ `${file}?v=${Date.now()}`);
    const survived = rejects.every(([code, raw]) => {
      try {
        mut.parseJudgeOutput(raw);
        return false; // accepted a fixture that must be rejected: mutant detected
      } catch (e) {
        return (e as { code?: string }).code === code;
      }
    });
    expect(survived, `mutant "${name}" survived: every fixture still rejected with the right code`).toBe(false);
  });
});
