import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * R8-judge (BLOCKING BUG found by the R8 B1 live run): the judge call was rejected with HTTP 400 "`temperature` is deprecated for this model" because
 * judge.mjs sent `temperature: 0`, and the failure left NO trace in the ledger (judgeCalls[] stayed empty) while the driver exited 0.
 *   AC1  the judge request body carries no `temperature` (runJudge args and the live client's wire body), and the judge record states the sampling honestly
 *   AC2  a judge failure is recorded in the ledger (status/error/paidCallAttempted), counted against the cap only when a request went out, surfaced in the
 *        summary line, and turns the process exit code non-zero
 *   AC3  `rejudgeRecord` re-judges a saved judge-failed run from its own final repo state, refuses every case that could double-spend or judge the wrong state
 * No model call, no network: injected clients, a stub fetch, tmp ledger directories.
 */
const LG = await loadParity('ledger.mjs');
const D = await loadParity('drive.mjs');
const J = await loadParity('judge.mjs');
const O = await loadParity('oracle.mjs');
const F = await loadParity('fixtures.mjs');

const WAIVER = 'owner: "just b"';
const HTTP_400 = 'judge: HTTP 400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."},"request_id":"req_TEST"}';
let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r8-judge-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const g = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden', 'r4', 'A2.json'), 'utf8'));
const mkRec = (over: Record<string, unknown> = {}) => ({ arm: 'A', runId: 'A1', observation: g.observation, score: O.scoreObservation(g.observation, g.expected), metrics: {}, model: { resolved: ['claude-haiku-5-5'] }, ...over });
const mkCtx = (ledgerPath: string, work: string) => {
  const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 });
  const repoDir = path.join(work, 'repo');
  F.writeFixture({ repoDir, hiddenDir: path.join(work, 'hidden'), ticketFile: path.join(work, 't.txt') }, spec);
  return { prompts: F.prompts(), spec, repoDir, ledgerPath, profile: { judgeModel: 'haiku', arms: ['B'], armAWaiver: WAIVER } };
};
const okClient = (sent: Array<Record<string, unknown>> = []) => ({
  async complete(a: Record<string, unknown>) {
    sent.push(a);
    const r = await D.fakeJudgeClient().complete();
    return { ...r, inputTokens: 1000, outputTokens: 500, model: 'claude-haiku-5-5' };
  },
});
const rejectingClient = (sent: Array<Record<string, unknown>> = [], message = HTTP_400) => ({ async complete(a: Record<string, unknown>) { sent.push(a); throw new Error(message); } });

describe('R8-judge AC1: no temperature on the judge request', () => {
  const stubFetch = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 4 }, model: 'claude-haiku-5-5' }) };
    };
    return { bodies, fetchImpl };
  };

  it('the live client never puts temperature on the wire, even when a caller still passes one (negative control: the stale caller)', async () => {
    const { bodies, fetchImpl } = stubFetch();
    const client = J.liveJudgeClient({ apiKey: 'sk-ant-api03-SYNTHETIC', fetchImpl }); // pragma: allowlist secret gitleaks:allow
    await client.complete({ model: 'claude-haiku-5-5', temperature: 0, maxTokens: 5, prompt: 'p' });
    await client.complete({ model: 'claude-haiku-5-5', maxTokens: 5, prompt: 'p' });
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(Object.keys(b)).not.toContain('temperature');
      expect(b).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'p' }] });
    }
  });

  it('runJudge hands the client model, maxTokens and prompt only, and the saved record states the sampling honestly', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const out = path.join(dir, 'out');
    const r = await J.runJudge({ client: okClient(sent), arm: 'B', brief: 'BRIEF', briefSha: 'sha', outDir: out, model: 'claude-haiku-5-5', modelRequested: 'haiku' });
    expect(r.ok).toBe(true);
    expect(Object.keys(sent[0]).sort()).toEqual(['maxTokens', 'model', 'prompt']);
    const rec = JSON.parse(fs.readFileSync(path.join(out, 'B.json'), 'utf8'));
    expect(rec.sampling).toMatch(/model default/i);
    expect(rec.sampling).toMatch(/temperature not sent/i);
  });
});

describe('R8-judge AC2: a judge failure is recorded, surfaced and not a success', () => {
  it('an upstream rejection is a judge-failed quality AND a ledger judgeCalls entry carrying status, error and paidCallAttempted (negative control: the pre-fix ledger stayed empty)', async () => {
    const lp = LG.ledgerPathFor('RJF', dir);
    const sent: Array<Record<string, unknown>> = [];
    const q = await D.judgeRun({ ctx: mkCtx(lp, dir), record: mkRec(), aGenuine: true, aWaived: true, dry: false, client: rejectingClient(sent), judgeDir: path.join(dir, 'out') });
    expect(q.status).toBe('judge-failed');
    expect(q.error).toMatch(/HTTP 400/);
    expect(sent).toHaveLength(1);
    const calls = LG.readLedger('RJF', dir).judgeCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ arm: 'A', status: 'failed', paidCallAttempted: true, modelId: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0, costUsd: null });
    expect(calls[0].error).toMatch(/temperature.*deprecated/);
    expect(calls[0].briefSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a request that went out counts toward the judge cap (fail closed); a failure before any request does not, and records paidCallAttempted:false', async () => {
    const lp = LG.ledgerPathFor('RJC', dir);
    for (let i = 0; i < 3; i++) await D.judgeRun({ ctx: mkCtx(lp, dir), record: mkRec(), aGenuine: true, aWaived: true, dry: false, client: rejectingClient(), judgeDir: path.join(dir, 'out') });
    expect(LG.readLedger('RJC', dir).judgeCalls).toHaveLength(3);
    expect(LG.judgeCallsUsed(LG.readLedger('RJC', dir))).toBe(3);
    const sent: Array<Record<string, unknown>> = [];
    const capped = await D.judgeRun({ ctx: mkCtx(lp, dir), record: mkRec(), aGenuine: true, aWaived: true, dry: false, client: okClient(sent), judgeDir: path.join(dir, 'out') });
    expect(capped.status).toBe('n/a');
    expect(capped.reason).toMatch(/cap 3\/3/);
    expect(sent).toEqual([]);

    const lp2 = LG.ledgerPathFor('RJN', dir);
    const noId = await D.judgeRun({ ctx: mkCtx(lp2, dir), record: mkRec({ model: { resolved: [] }, observation: { ...g.observation, models: [] } }), aGenuine: true, aWaived: true, dry: false, client: okClient(sent), judgeDir: path.join(dir, 'out2') });
    expect(noId.status).toBe('judge-failed');
    expect(sent).toEqual([]);
    const led2 = LG.readLedger('RJN', dir);
    expect(led2.judgeCalls).toHaveLength(1);
    expect(led2.judgeCalls[0]).toMatchObject({ status: 'failed', paidCallAttempted: false });
    expect(LG.judgeCallsUsed(led2)).toBe(0);
  });

  it('a dry-run judge failure never touches the ledger', async () => {
    const lp = LG.ledgerPathFor('RJD', dir);
    const q = await D.judgeRun({ ctx: mkCtx(lp, dir), record: mkRec(), aGenuine: true, aWaived: true, dry: true, client: rejectingClient(), judgeDir: path.join(dir, 'out') });
    expect(q.status).toBe('judge-failed');
    expect(fs.existsSync(lp)).toBe(false);
  });

  it('judgeRun still never throws when the failure itself cannot be written to the ledger (the quality carries ledgerError)', async () => {
    const lp = LG.ledgerPathFor('RJL', dir);
    fs.writeFileSync(lp, JSON.stringify({ ...LG.emptyLedger('RJL'), judgeCalls: [] }));
    const ctx = mkCtx(lp, dir);
    let n = 0;
    const client = { async complete() { n++; fs.writeFileSync(lp, '{not json'); throw new Error(HTTP_400); } };
    const q = await D.judgeRun({ ctx, record: mkRec(), aGenuine: true, aWaived: true, dry: false, client, judgeDir: path.join(dir, 'out') });
    expect(n).toBe(1);
    expect(q.status).toBe('judge-failed');
    expect(q.ledgerError).toBeTruthy();
  });

  it('the summary line names the failure (error or code), and a scored run keeps its mean', () => {
    const failed = D.qualityLine('B1', { status: 'judge-failed', error: HTTP_400 });
    expect(failed).toMatch(/^B1: quality judge-failed/);
    expect(failed).toMatch(/HTTP 400/);
    expect(D.qualityLine('B1', { status: 'judge-error', code: 'NOT_JSON' })).toMatch(/judge-error.*NOT_JSON/);
    expect(D.qualityLine('B1', { status: 'scored', mean: 71.5 })).toBe('B1: quality scored mean 71.5');
    expect(D.qualityLine('B1', { status: 'n/a', reason: 'cap' })).toBe('B1: quality n/a (cap)');
  });

  it('exitCodeFor: a judge-failed or judge-error run is non-zero (JUDGE_FAILED_EXIT), n/a and scored stay 0, harness failure keeps its precedence', () => {
    const rec = (quality: unknown, extra: Record<string, unknown> = {}) => ({ quality, ...extra });
    expect(D.exitCodeFor({ records: [rec({ status: 'scored' })], voided: false })).toBe(0);
    expect(D.exitCodeFor({ records: [rec({ status: 'n/a' })], voided: false })).toBe(0);
    expect(D.exitCodeFor({ records: [rec(undefined)], voided: false })).toBe(0);
    expect(D.exitCodeFor({ records: [rec({ status: 'judge-failed' })], voided: false })).toBe(D.JUDGE_FAILED_EXIT);
    expect(D.exitCodeFor({ records: [rec({ status: 'judge-error' })], voided: false })).toBe(D.JUDGE_FAILED_EXIT);
    expect(D.JUDGE_FAILED_EXIT).not.toBe(0);
    expect(D.exitCodeFor({ records: [rec({ status: 'judge-failed' }, { harnessFailure: 'x' })], voided: false })).toBe(1);
  });
});

describe('R8-judge AC3: rejudgeRecord (the saved run, judged again once)', () => {
  /** A saved judge-failed run whose work dir holds the run's final repo state (the golden observation's files are written into it). */
  const savedRun = (over: { quality?: unknown; mutateRepo?: boolean } = {}) => {
    const work = path.join(dir, 'work');
    const ctx = mkCtx(LG.ledgerPathFor('RJR', dir), work);
    const files = D.repoFilesOf(ctx.repoDir);
    const record = mkRec({ arm: 'B', runId: 'B1', rep: 1, seed: '20261011', workDir: work, observation: { ...g.observation, files }, quality: 'quality' in over ? over.quality : { status: 'judge-failed', error: HTTP_400 } });
    const runDir = path.join(dir, 'runs', 'B1'); fs.mkdirSync(runDir, { recursive: true });
    const recordPath = path.join(runDir, 'record.json'); fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    if (over.mutateRepo) fs.appendFileSync(path.join(ctx.repoDir, 'src/checkout.js'), '// changed after the run\n');
    return { recordPath, record, work, profile: ctx.profile, judgeDir: path.join(dir, 'judge'), ledgerPath: ctx.ledgerPath };
  };

  it('re-judges once from the run record, writes a scored quality with the prior failure kept, logs ONE ledger call carrying the prior failure, and leaves the score untouched', async () => {
    const s = savedRun();
    const sent: Array<Record<string, unknown>> = [];
    const before = JSON.parse(fs.readFileSync(s.recordPath, 'utf8'));
    const out = await D.rejudgeRecord({ ...s, round: 'RJR', client: okClient(sent) });
    expect(out.quality).toMatchObject({ status: 'scored', mean: 80, modelRequested: 'haiku', modelId: 'claude-haiku-5-5' });
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe('claude-haiku-5-5');
    expect(Object.keys(sent[0])).not.toContain('temperature');
    const after = JSON.parse(fs.readFileSync(s.recordPath, 'utf8'));
    expect(after.score).toEqual(before.score);
    expect(after.observation).toEqual(before.observation);
    expect(after.quality.status).toBe('scored');
    expect(after.priorQuality).toEqual(before.quality);
    const calls = LG.readLedger('RJR', dir).judgeCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0].rejudgeOf).toMatch(/HTTP 400/);
    expect(JSON.parse(fs.readFileSync(path.join(s.judgeDir, 'B.json'), 'utf8')).scores).toBeTruthy();
  });

  it('a second invocation on the now-scored record is refused BEFORE any call (no double spend)', async () => {
    const s = savedRun();
    await D.rejudgeRecord({ ...s, round: 'RJR', client: okClient() });
    const sent: Array<Record<string, unknown>> = [];
    await expect(D.rejudgeRecord({ ...s, round: 'RJR', client: okClient(sent) })).rejects.toThrow(/only a judge-failed/);
    expect(sent).toEqual([]);
    expect(LG.readLedger('RJR', dir).judgeCalls).toHaveLength(1);
  });

  it('refuses a run that was not judge-failed (scored / n/a / judge-error use their own paths), and a repo that no longer matches the recorded final state (negative controls)', async () => {
    for (const quality of [{ status: 'scored', mean: 1 }, { status: 'n/a', reason: 'x' }, { status: 'judge-error', code: 'NOT_JSON' }, undefined]) {
      const s = savedRun({ quality });
      const sent: Array<Record<string, unknown>> = [];
      await expect(D.rejudgeRecord({ ...s, round: 'RJR', client: okClient(sent) })).rejects.toThrow(/only a judge-failed/);
      expect(sent).toEqual([]);
      fs.rmSync(path.join(dir, 'work'), { recursive: true, force: true });
    }
    const drift = savedRun({ mutateRepo: true });
    const sent: Array<Record<string, unknown>> = [];
    await expect(D.rejudgeRecord({ ...drift, round: 'RJR', client: okClient(sent) })).rejects.toThrow(/final repo state/);
    expect(sent).toEqual([]);
  });

  it('a re-judge that fails again keeps the prior failure, records a second failed ledger entry and still never throws away the record', async () => {
    const s = savedRun();
    const out = await D.rejudgeRecord({ ...s, round: 'RJR', client: rejectingClient([], 'judge: HTTP 529 overloaded') });
    expect(out.quality.status).toBe('judge-failed');
    const after = JSON.parse(fs.readFileSync(s.recordPath, 'utf8'));
    expect(after.quality.error).toMatch(/529/);
    expect(after.priorQuality.error).toMatch(/HTTP 400/);
    expect(LG.readLedger('RJR', dir).judgeCalls[0]).toMatchObject({ status: 'failed', paidCallAttempted: true });
  });

  it('refuses before any call when the credential is missing (presence check only)', async () => {
    const s = savedRun();
    const sent: Array<Record<string, unknown>> = [];
    await expect(D.rejudgeRecord({ ...s, round: 'RJR', client: okClient(sent), credential: { present: false } })).rejects.toThrow(/no judge credential/);
    expect(sent).toEqual([]);
  });
});
