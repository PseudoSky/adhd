import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * R8 (EXPERIMENT-LOG SCOPE-R8-model-alias, SCOPE-R8-B-only; owner 2026-10-12: "just b"): one arm-B run on the model alias `haiku`, effort high set
 * explicitly, wire capture ON, judge on the same alias. The round is re-pointed by `ledger.profile` WITHOUT touching the module pins, so R5/R7 keep theirs.
 * Acceptance ids: R8-profile AC1..AC3 (fail-closed profile, B-only reserve/cap, waiver on the record), R8-model AC1..AC4 (alias, pin match, resolved-id pricing,
 * judge model), R8-effort AC1..AC3 (mechanism, wire verification, driver record), R8-capture AC1 (a dry-run proxy can never reach a real upstream).
 * No model call, no network: pure functions plus a tmp ledger directory.
 */
const LG = await loadParity('ledger.mjs');
const D = await loadParity('drive.mjs');
const O = await loadParity('oracle.mjs');
const L = await loadParity('lib.mjs');
const J = await loadParity('judge.mjs');
const F = await loadParity('fixtures.mjs');
const WD = await loadParity('wire-diff.mjs');

const WAIVER = 'owner: "just b"';
let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r8-ledger-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const writeLedger = (round: string, patch: Record<string, unknown>) => {
  fs.writeFileSync(LG.ledgerPathFor(round, dir), JSON.stringify({ ...LG.emptyLedger(round), approvedBy: 'owner: "just b"', ...patch }));
};
const bProfile = (over: Record<string, unknown> = {}) => ({ arms: ['B'], armAWaiver: WAIVER, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true, ...over });

describe('R8-profile', () => {
  it('AC1: profileOf returns null without a profile, parses a valid B-only profile, and fails CLOSED on every malformed variant (negative controls)', () => {
    expect(LG.profileOf({})).toBeNull();
    expect(LG.profileOf({ profile: bProfile() })).toEqual({ arms: ['B'], armAWaiver: WAIVER, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
    const bad: Array<[string, Record<string, unknown>]> = [
      ['not an object', 'x' as never],
      ['empty arms', bProfile({ arms: [] })],
      ['unknown arm', bProfile({ arms: ['D'] })],
      ['duplicate arm', bProfile({ arms: ['B', 'B'] })],
      ['A omitted without a waiver', bProfile({ armAWaiver: '  ' })],
      ['unknown effort', bProfile({ effort: 'ultra' })],
      ['non-boolean capture', bProfile({ capture: 'yes' })],
      ['empty model', bProfile({ model: ' ' })],
      ['alias model on a round that includes arm C', bProfile({ arms: ['B', 'C'] })],
    ];
    for (const [why, profile] of bad) expect(() => LG.profileOf({ profile }), why).toThrow(LG.LedgerError);
    // A in the arms needs no waiver, and a concrete id is allowed with C.
    expect(LG.profileOf({ profile: { arms: ['A', 'C'], model: 'claude-haiku-5-5' } }).armAWaiver).toBeNull();
  });

  it('AC2: a B-only profile caps the round at ONE run, lets B reserve first (no A-first gate), refuses A and C, and the second B is over the cap (negative controls)', () => {
    writeLedger('R8', { profile: bProfile() });
    expect(LG.capOf(LG.readLedger('R8', dir))).toBe(1);
    expect(() => LG.reserveRun('R8', { arm: 'A', runId: 'A1', dir })).toThrow(/not in ledger.profile.arms/);
    expect(() => LG.reserveRun('R8', { arm: 'C', runId: 'C1', dir })).toThrow(/not in ledger.profile.arms/);
    expect(LG.reserveRun('R8', { arm: 'B', runId: 'B1', dir })).toEqual({ used: 1, cap: 1 });
    expect(() => LG.reserveRun('R8', { arm: 'B', runId: 'B2', dir })).toThrow(LG.ModelRunCapError);
    expect(LG.readLedger('R8', dir).armA).toBeNull();   // nothing is faked: the waiver is recorded, armA is not set
  });

  it('AC2: WITHOUT a profile the A-first gate still applies to B (the waiver exists only through the profile)', () => {
    writeLedger('R9', {});
    expect(() => LG.reserveRun('R9', { arm: 'B', runId: 'B1', dir })).toThrow(/arm A runs first/);
    writeLedger('R9', { profile: { arms: ['A', 'B'] } });
    expect(() => LG.reserveRun('R9', { arm: 'B', runId: 'B1', dir })).toThrow(/arm A runs first/);
  });

  it('AC2: checkLedgerForLive reports a malformed profile as a refusal reason and an unapproved ledger as another', () => {
    writeLedger('R8', { profile: bProfile({ effort: 'ultra' }) });
    const r = LG.checkLedgerForLive('R8', dir);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/ledger\.profile.*effort/);
    writeLedger('R8', { profile: bProfile(), approvedBy: '' });
    expect(LG.checkLedgerForLive('R8', dir).reasons.join(' ')).toMatch(/approvedBy/);
    writeLedger('R8', { profile: bProfile() });
    expect(LG.checkLedgerForLive('R8', dir)).toMatchObject({ ok: true, reasons: [] });
  });

  it('AC3: the tracked R8 ledger is a B-only haiku/high/capture profile whose approval quotes the owner and whose scope changes name the LOG headings', () => {
    const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R8.json'), 'utf8'));
    const p = LG.profileOf(led);
    expect(p).toMatchObject({ arms: ['B'], model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
    expect(p.armAWaiver).toContain('just b');
    expect(led.approvedBy).toContain('just b');
    expect(led.scopeChanges).toEqual(expect.arrayContaining(['SCOPE-R8-model-alias', 'SCOPE-R8-B-only']));
    expect(led.runs).toEqual([]);   // no live run is recorded by the instrument change
  });

  it('AC3: roundProfile re-points R8 only; every other round keeps the module pins and the full A,B,C plan', () => {
    expect(D.roundProfile({ round: 'R8' })).toMatchObject({ arms: ['B'], model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
    for (const r of ['R5', 'R7']) {
      const p = D.roundProfile({ round: r });
      expect(p, r).toMatchObject({ arms: null, model: F.PIN_MODEL, judgeModel: J.JUDGE_MODEL, effort: null, capture: false });
    }
    expect(D.buildPlan({ round: 'R8' }).map((e: { arm: string }) => e.arm)).toEqual(['B']);
    expect(D.buildPlan({ round: 'R7' }).map((e: { arm: string }) => e.arm).sort()).toEqual(['A', 'B', 'C']);   // negative control: the default plan is untouched
  });
});

describe('R8-model', () => {
  it('AC1: isModelAlias separates the claude CLI shorthand from a concrete first-party id', () => {
    for (const a of ['haiku', 'sonnet', 'opus', 'fast']) expect(LG.isModelAlias(a), a).toBe(true);
    for (const c of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'Claude-Haiku-4-5']) expect(LG.isModelAlias(c), c).toBe(false);
    for (const n of ['', '  ', null, undefined]) expect(LG.isModelAlias(n as never)).toBe(false);
  });

  it('AC2: an alias pin matches only its own family (claude-<alias>-*); a concrete pin keeps prefix matching; neighbours and look-alikes fail (negative controls)', () => {
    expect(O.pinMatches('claude-haiku-5-5', 'haiku')).toBe(true);
    expect(O.pinMatches('claude-haiku-4-5', 'haiku')).toBe(true);
    for (const wrong of ['claude-sonnet-5-5', 'haikuish', 'claude-haikuish-1', 'haiku', 'gpt-haiku-1']) expect(O.pinMatches(wrong, 'haiku'), wrong).toBe(false);
    expect(O.pinMatches('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true);
    expect(O.pinMatches('claude-sonnet-5-5-20261001', 'claude-sonnet-5-5')).toBe(true);
    expect(O.pinMatches('claude-haiku-5-5', 'claude-sonnet-5-5')).toBe(false);
  });

  it('AC2: r1_model scores an arm served by a haiku-family id against an alias pin and fails a sonnet-served arm', () => {
    const e = { ...O.selfTestExpected(), pin: 'haiku' };
    const status = (models: string[]) => { const o = O.idealObservation('B', e); o.models = models; return O.scoreObservation(o, e).fields.r1_model.status; };
    expect(status(['claude-haiku-5-5'])).toBe('pass');
    expect(status(['claude-sonnet-5-5'])).toBe('fail');
  });

  it('AC3: modelFacts records requested -> resolved and prices by the RESOLVED id; an unknown resolved id is unmeasured with a warning, never another model price', () => {
    const ok = D.modelFacts({ requested: 'haiku', resolved: ['claude-haiku-5-5'] });
    expect(ok).toMatchObject({ requested: 'haiku', alias: true, resolved: ['claude-haiku-5-5'], warnings: [] });
    expect(ok.pricing[0]).toMatchObject({ model: 'claude-haiku-5-5', card: 'claude-haiku-5-5' });
    expect(ok.pricing[0].source).toContain('pricing.json');
    const unknown = D.modelFacts({ requested: 'haiku', resolved: ['claude-haiku-9-9'] });
    expect(unknown.pricing[0].card).toBeNull();
    expect(unknown.warnings.join(' ')).toMatch(/no rate card for resolved model claude-haiku-9-9/);
    expect(D.modelFacts({ requested: 'haiku', resolved: [] }).warnings.join(' ')).toMatch(/no response model id was observed/);
    expect(D.modelFacts({ requested: 'haiku', resolved: ['claude-sonnet-5-5'] }).warnings.join(' ')).toMatch(/outside the family of the alias/);
    expect(D.modelFacts({ requested: 'haiku', resolved: ['claude-haiku-5-5'], wire: { mainModels: ['claude-haiku-4-5'], sideModels: [] } }).warnings.join(' ')).toMatch(/wire request model/);
  });

  it('AC3: the haiku-5-5 rate card prices a usage by its own rates (and differs from the sonnet pin card)', () => {
    const h = L.rateCardFor('claude-haiku-5-5'); const s = L.rateCardFor(F.PIN_MODEL);
    expect(h.rates).not.toEqual(s.rates);
    expect(h.rates.input).toBeLessThan(s.rates.input);
    expect(L.rateCardFor('claude-haiku-9-9')).toBeNull();
  });

  it('AC4: resolveJudgeModel passes a concrete id through, resolves an alias from the ids the arm reported, and THROWS with none (no paid call is made)', () => {
    expect(J.resolveJudgeModel('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(J.resolveJudgeModel('haiku', ['claude-sonnet-5-5', 'claude-haiku-5-5'])).toBe('claude-haiku-5-5');
    expect(() => J.resolveJudgeModel('haiku', [])).toThrow(/no arm of this round reported/);
    expect(() => J.resolveJudgeModel('haiku', ['claude-sonnet-5-5'])).toThrow(/no call made/);
  });

  it('AC4: judgeCostUsd prices by the reported model card; without a model it keeps the pinned list price; an unknown model is null', () => {
    expect(J.judgeCostUsd(1e6, 1e6)).toBe(J.JUDGE_PRICE_PER_MTOK.input + J.JUDGE_PRICE_PER_MTOK.output);
    const r = L.rateCardFor('claude-haiku-5-5').rates;
    expect(J.judgeCostUsd(1e6, 1e6, 'claude-haiku-5-5')).toBeCloseTo(r.input + r.output, 9);
    expect(J.judgeCostUsd(1000, 1000, 'claude-haiku-9-9')).toBeNull();
  });
});

describe('R8-effort', () => {
  const wire = (over: Record<string, unknown> = {}) => ({ requests: 7, mainRequests: 6, mainModels: ['claude-haiku-5-5'], mainEfforts: ['high'], sideEfforts: ['medium'], sideModels: ['claude-haiku-5-5'], ...over });

  it('AC1: effortEnv sets CLAUDE_CODE_EFFORT_LEVEL for arm B only, and only when the profile names an effort (negative controls)', () => {
    const ctx = (arm: string, effort: string | null) => ({ runDef: { arm }, profile: { effort } });
    expect(D.effortEnv(ctx('B', 'high'))).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    expect(D.effortEnv(ctx('A', 'high'))).toEqual({});
    expect(D.effortEnv(ctx('C', 'high'))).toEqual({});
    expect(D.effortEnv(ctx('B', null))).toEqual({});
  });

  it('AC2: effortFacts is verified only when EVERY tool-declaring request carried the level; side calls are listed apart; every other case has its own status', () => {
    expect(D.effortFacts({ requested: 'high', arm: 'B', wire: wire() })).toMatchObject({ status: 'verified', observed: ['high'], sideObserved: ['medium'] });
    expect(D.effortFacts({ requested: 'high', arm: 'B', wire: wire({ mainEfforts: ['high', 'medium'] }) }).status).toBe('mismatch');
    expect(D.effortFacts({ requested: 'high', arm: 'B', wire: wire({ mainEfforts: [] }) }).status).toBe('mismatch');
    expect(D.effortFacts({ requested: 'high', arm: 'B', wire: wire({ mainRequests: 0, mainEfforts: [] }) }).status).toBe('unobserved');
    expect(D.effortFacts({ requested: 'high', arm: 'B', wire: null }).status).toBe('unverified');
    expect(D.effortFacts({ requested: null, arm: 'B', wire: wire() }).status).toBe('not-requested');
    expect(D.effortFacts({ requested: 'high', arm: 'C', wire: wire({ mainEfforts: [null] }) }).status).toBe('not-settable');
    expect(D.effortFacts({ requested: 'high', arm: 'A', wire: wire({ mainEfforts: [null] }) }).status).toBe('mismatch');
  });

  it('AC2: wireFactsFor derives main/side requests, models and efforts from an analysis (main = declares tools)', () => {
    const req = (tools: string[], effort: string | null) => ({ tools, model: 'claude-haiku-5-5', effort });
    const a = { arms: { B: { requests: [req(['x'], 'high'), req(['x'], 'high'), req([], 'medium')] } } };
    expect(WD.wireFactsFor(a, 'B')).toEqual({ requests: 3, mainRequests: 2, mainModels: ['claude-haiku-5-5'], mainEfforts: ['high'], sideEfforts: ['medium'], sideModels: ['claude-haiku-5-5'] });
    expect(WD.wireFactsFor(a, 'A')).toMatchObject({ requests: 0, mainRequests: 0 });
  });

  it('AC3: the R8 plan text shows only arm B, the explicit effort mechanism, the alias model and capture ON, and cites the waiver', () => {
    const text: string = D.planText({ round: 'R8', seed: '20261011', wt: D.DEFAULT_WT, claude: 'claude', rep: 1, capture: false });
    expect(text).toContain('arms [B]');
    expect(text).toContain('model=haiku (ALIAS');
    expect(text).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
    expect(text).toContain('wire capture ON (forced by the profile)');
    expect(text).toContain('ARM-A GATE NOT APPLIED');
    expect(text).not.toMatch(/\n\s+[AC]1\b/);   // negative control: no A1 / C1 in the order
  });
});

describe('R8-capture', () => {
  it('AC1: a dry-run capture proxy NEVER gets a real upstream (fake Anthropic when running, a discard sink otherwise); a live one gets the real endpoints (negative control)', () => {
    const dry = D.captureUpstreams({ dry: true, fakeAnthropicUrl: 'http://127.0.0.1:4242' }, {});
    expect(dry.anthropic).toBe('http://127.0.0.1:4242');
    const dryNoFake = D.captureUpstreams({ dry: true }, { PARITY_UPSTREAM_ANTHROPIC: 'https://api.anthropic.com', PARITY_UPSTREAM_OPENAI: 'https://api.openai.com' });   // even an operator override cannot leak a dry run
    for (const u of Object.values(dryNoFake) as string[]) expect(new URL(u).hostname, u).toBe('127.0.0.1');
    expect(dryNoFake.anthropic).toBe(D.DRY_SINK);
    const live = D.captureUpstreams({ dry: false }, {});
    expect(new URL(live.anthropic).hostname).toBe('api.anthropic.com');
  });
});

describe('R8-model judge path (the only paid call, driven through the real judgeRun with an injected client)', () => {
  const g = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden', 'r4', 'A2.json'), 'utf8'));
  const mkRec = (model: unknown, models?: string[]) => ({ arm: 'A', runId: 'A1', observation: models ? { ...g.observation, models } : g.observation, score: O.scoreObservation(g.observation, g.expected), metrics: {}, model });
  const mkCtx = (ledgerPath: string, work: string) => {
    const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 });
    const repoDir = path.join(work, 'repo');
    F.writeFixture({ repoDir, hiddenDir: path.join(work, 'hidden'), ticketFile: path.join(work, 't.txt') }, spec);
    return { prompts: F.prompts(), spec, repoDir, ledgerPath, profile: { judgeModel: 'haiku', arms: ['B'], armAWaiver: WAIVER } };
  };
  const client = (sent: string[]) => ({
    async complete({ model }: { model: string }) {
      sent.push(model);
      const r = await D.fakeJudgeClient().complete();
      return { ...r, inputTokens: 1000, outputTokens: 500, model: 'claude-haiku-5-5' };
    },
  });

  it('AC4: the alias is resolved from the arm-reported id before the call, the A waiver is on the record, and the ledger call is priced by the haiku-5-5 card', async () => {
    const sent: string[] = [];
    const lp = LG.ledgerPathFor('RJ8', dir);
    const q = await D.judgeRun({ ctx: mkCtx(lp, dir), record: mkRec({ resolved: ['claude-haiku-5-5'] }), aGenuine: true, aWaived: true, dry: false, client: client(sent), judgeDir: path.join(dir, 'out') });
    expect(q).toMatchObject({ status: 'scored', modelRequested: 'haiku', modelId: 'claude-haiku-5-5', armAWaived: WAIVER });
    expect(sent).toEqual(['claude-haiku-5-5']);   // the API never sees the alias
    const r = L.rateCardFor('claude-haiku-5-5').rates;
    expect(LG.readLedger('RJ8', dir).judgeCalls[0].costUsd).toBeCloseTo((1000 * r.input + 500 * r.output) / 1e6, 12);
  });

  it('AC4 negative controls: no reported id -> judge-failed and NO call; a non-genuine arm is not made judgeable by the waiver', async () => {
    const sent: string[] = [];
    const none = await D.judgeRun({ ctx: mkCtx(LG.ledgerPathFor('RJ9', dir), dir), record: mkRec({ resolved: [] }, []), aGenuine: true, aWaived: true, dry: false, client: client(sent), judgeDir: path.join(dir, 'out9') });
    expect(none.status).toBe('judge-failed');
    expect(none.error).toMatch(/no call made/);
    const notGenuine = await D.judgeRun({ ctx: mkCtx(LG.ledgerPathFor('RJ10', dir), dir), record: mkRec({ resolved: ['claude-haiku-5-5'] }), aGenuine: false, aWaived: true, dry: false, client: client(sent), judgeDir: path.join(dir, 'out10') });
    expect(notGenuine.status).toBe('n/a');
    expect(sent).toEqual([]);
  });
});
