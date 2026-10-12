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
 * R8-AC (ticket R8-AC, SCOPE-R8-A-C-complete; owner 2026-10-12): after B1 the round is completed with arms A (native claude -p) then C (agent-mcp anthropic provider), ONE run each, the same
 * scenario sha, alias `haiku` (C calls the Messages API directly and needs the concrete id B1 resolved to), effort high on every arm, capture ON, the A-first gate APPLIED again.
 * Acceptance ids: R8-AC-profile AC1..AC5 (completedArms / armModels, cap counts B1, A-first enforced by armA.genuine, the tracked ledger), R8-AC-model AC1..AC2 (C concrete id,
 * same scenario sha, A/C model guard), R8-AC-effort AC1..AC3 (C carries effort on the wire; A and C route through the capture proxy by arm), R8-AC-plan AC1 (plan/preflight surface).
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
    expect(LG.profileOf({ profile: bProfile() })).toEqual({ arms: ['B'], completedArms: [], armModels: {}, armAWaiver: WAIVER, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
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

  it('AC3: roundProfile re-points R8 only; every other round keeps the module pins and the full A,B,C plan', () => {
    expect(D.roundProfile({ round: 'R8' })).toMatchObject({ arms: ['A', 'C'], completedArms: ['B'], model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
    for (const r of ['R5', 'R7']) {
      const p = D.roundProfile({ round: r });
      expect(p, r).toMatchObject({ arms: null, completedArms: [], model: F.PIN_MODEL, judgeModel: J.JUDGE_MODEL, effort: null, capture: false });
    }
    expect(D.buildPlan({ round: 'R8' }).map((e: { arm: string }) => e.arm)).toEqual(['A', 'C']);
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
    expect(D.effortFacts({ requested: 'high', arm: 'C', wire: wire({ mainEfforts: ['high'] }) }).status).toBe('verified');   // R8-AC-effort AC1: C is settable now (provider.effort -> output_config.effort)
    expect(D.effortFacts({ requested: 'high', arm: 'C', wire: wire({ mainEfforts: [null] }) }).status).toBe('mismatch');   // negative control: a C request with no effort field is a mismatch, not "not settable"

    expect(D.effortFacts({ requested: 'high', arm: 'A', wire: wire({ mainEfforts: [null] }) }).status).toBe('mismatch');
  });

  it('AC2: wireFactsFor derives main/side requests, models and efforts from an analysis (main = declares tools)', () => {
    const req = (tools: string[], effort: string | null) => ({ tools, model: 'claude-haiku-5-5', effort });
    const a = { arms: { B: { requests: [req(['x'], 'high'), req(['x'], 'high'), req([], 'medium')] } } };
    expect(WD.wireFactsFor(a, 'B')).toEqual({ requests: 3, mainRequests: 2, mainModels: ['claude-haiku-5-5'], mainEfforts: ['high'], sideEfforts: ['medium'], sideModels: ['claude-haiku-5-5'] });
    expect(WD.wireFactsFor(a, 'A')).toMatchObject({ requests: 0, mainRequests: 0 });
  });

  it('AC3: the R8 plan text shows arms A then C, the explicit effort mechanism for each, the alias model and capture ON; B1 is listed as already run, not planned', () => {
    const text: string = D.planText({ round: 'R8', seed: '20261011', wt: D.DEFAULT_WT, claude: 'claude', rep: 1, capture: false });
    expect(text).toContain('arms [A,C]');
    expect(text).toContain('model=haiku (ALIAS');
    expect(text).toContain('--effort high');
    expect(text).toContain('output_config.effort');
    expect(text).toContain('wire capture ON (forced by the profile)');
    expect(text).toContain('ARM-A GATE APPLIED');
    expect(text).toMatch(/\n\s+1\. A1\n\s+2\. C1\n/);
    expect(text).not.toMatch(/\n\s+\d\. B1\n/);   // negative control: B1 is not in the order
    expect(text).toContain('already run');
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// R8-AC: the A and C remainder of R8 after B1 (ticket R8-AC, SCOPE-R8-A-C-complete)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const HAIKU_ID = 'claude-haiku-5-5';
/** The ledger profile of the A,C remainder: B1 is kept as run (completedArms), A and C are planned, C is sent the concrete id B1 resolved to. */
const acProfile = (over: Record<string, unknown> = {}) => ({ arms: ['A', 'C'], completedArms: ['B'], armModels: { C: HAIKU_ID }, armAWaiver: WAIVER, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true, ...over });
const b1Run = { runId: 'B1', arm: 'B', at: '2026-10-12T08:13:21.613Z', pid: 1 };

describe('R8-AC-profile', () => {
  it('AC1: profileOf parses the A,C remainder (completedArms, armModels) and fails CLOSED on every malformed variant (negative controls)', () => {
    const led = (profile: Record<string, unknown>, runs: unknown[] = [b1Run]) => ({ profile, runs });
    expect(LG.profileOf(led(acProfile()))).toEqual({ arms: ['A', 'C'], completedArms: ['B'], armModels: { C: HAIKU_ID }, armAWaiver: WAIVER, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
    const bad: Array<[string, Record<string, unknown>, unknown[]?]> = [
      ['completed arm also planned', acProfile({ completedArms: ['A'] })],
      ['completed arm not a letter', acProfile({ completedArms: ['D'] })],
      ['completed arm listed twice', acProfile({ completedArms: ['B', 'B'] })],
      ['completed arm has NO recorded run in the ledger', acProfile(), []],
      ['armModels is not an object', acProfile({ armModels: 'x' })],
      ['armModels names an arm that is not planned', acProfile({ armModels: { C: HAIKU_ID, B: HAIKU_ID } })],
      ['armModels value empty', acProfile({ armModels: { C: ' ' } })],
      ['armModels.C is itself an alias (the Messages API does not resolve it)', acProfile({ armModels: { C: 'haiku' } })],
      ['alias model with arm C and no armModels.C', acProfile({ armModels: undefined })],
    ];
    for (const [why, profile, runs] of bad) expect(() => LG.profileOf(led(profile, runs)), why).toThrow(LG.LedgerError);
    expect(LG.profileOf({ profile: { arms: ['A', 'C'], model: 'claude-haiku-5-5' } }).completedArms).toEqual([]);   // optional fields default
  });

  it('AC2: the cap counts B1 (3 runs), B is refused as already run, C is refused until A is recorded genuine, a non-genuine A keeps C refused, an arm never runs twice', () => {
    fs.writeFileSync(LG.ledgerPathFor('R8', dir), JSON.stringify({ ...LG.emptyLedger('R8'), approvedBy: 'owner', profile: acProfile(), runs: [b1Run], armOrder: ['B'] }));
    expect(LG.capOf(LG.readLedger('R8', dir))).toBe(3);
    expect(() => LG.reserveRun('R8', { arm: 'B', runId: 'B2', dir })).toThrow(/already ran|not in ledger.profile.arms/);
    expect(() => LG.reserveRun('R8', { arm: 'C', runId: 'C1', dir })).toThrow(/arm A did not genuinely succeed/);   // A-first is enforced by armA, B1 being in runs
    expect(LG.reserveRun('R8', { arm: 'A', runId: 'A1', dir })).toEqual({ used: 2, cap: 3 });
    expect(() => LG.reserveRun('R8', { arm: 'A', runId: 'A2', dir })).toThrow(/already (ran|reserved)/);   // never an arm twice
    LG.recordArmA('R8', false, 'content 3/5', dir);
    expect(() => LG.reserveRun('R8', { arm: 'C', runId: 'C1', dir })).toThrow(/arm A did not genuinely succeed/);   // negative control: a failed A voids the rest
    LG.recordArmA('R8', true, 'all green', dir);
    expect(LG.reserveRun('R8', { arm: 'C', runId: 'C1', dir })).toEqual({ used: 3, cap: 3 });
    expect(() => LG.reserveRun('R8', { arm: 'C', runId: 'C2', dir })).toThrow(/already (ran|reserved)|cap/);
    expect(LG.readLedger('R8', dir).runs.map((r: { arm: string }) => r.arm)).toEqual(['B', 'A', 'C']);
  });

  it('AC2: the A-first gate is NOT waived by the A,C profile: the waiver text is history for the completed arm, planText/judge treat A as applied', () => {
    const prof = D.roundProfile({ round: 'R8' });
    expect(prof.arms).toContain('A');
    expect(!!prof.arms && !prof.arms.includes('A')).toBe(false);   // the expression runPlan and rejudge use for "waived"
  });

  it('AC3: the judge cap leaves room for the A and the C judge call on top of the two B1 calls (negative control: bare JUDGE_CAP does not)', () => {
    const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R8.json'), 'utf8'));
    const b1Calls = led.judgeCalls.filter((c: { arm: string }) => c.arm === 'B').length;
    expect(b1Calls + 2).toBeGreaterThan(LG.JUDGE_CAP);   // without an extra the C judge call would be refused AFTER its arm was paid for
    expect(LG.effectiveJudgeCap(led)).toBeGreaterThanOrEqual(b1Calls + 2);
    expect(String(led.judgeCapReason)).toMatch(/A and C/);
  });

  it('AC4: the tracked R8 ledger is the A,C remainder: B1 kept as the first and completed run, arms A then C, approval quotes the owner, scope changes name the LOG headings', () => {
    const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R8.json'), 'utf8'));
    const p = LG.profileOf(led);
    expect(p).toMatchObject({ arms: ['A', 'C'], completedArms: ['B'], armModels: { C: HAIKU_ID }, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
    expect(led.approvedBy).toContain('just b');   // B1's original approval stays on the record
    expect(led.approvedBy).toMatch(/arms A \(native claude -p\) then C/);   // and the A,C direction is recorded next to it
    expect(led.scopeChanges).toEqual(expect.arrayContaining(['SCOPE-R8-model-alias', 'SCOPE-R8-B-only', 'SCOPE-R8-A-C-complete']));
    expect(led.runs[0]).toMatchObject({ runId: 'B1', arm: 'B' });
    expect(led.runs.length).toBeLessThanOrEqual(LG.capOf(led));
    expect(led.runs.slice(1).map((r: { arm: string }) => r.arm).every((a: string, i: number) => a === ['A', 'C'][i])).toBe(true);   // anything run after B1 ran A first, then C
  });

  it('AC5: the B1 record, its judge calls and the scenario sha are untouched by the amendment', () => {
    const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R8.json'), 'utf8'));
    expect(led.runs[0]).toEqual({ runId: 'B1', arm: 'B', at: '2026-10-12T08:13:21.613Z', pid: 81983 });
    expect(led.judgeCalls.slice(0, 2).map((c: { arm: string; modelId: string; briefSha: string }) => [c.arm, c.modelId, c.briefSha.slice(0, 8)])).toEqual([['B', HAIKU_ID, '3b685bcf'], ['B', HAIKU_ID, '0339bce1']]);
    expect(led.scenarioSha).toBe('56956efb90fc213aaaca7dff6d94f731e94a7b69ad4295e66ddb5fd6e06e4a18');
  });
});

describe('R8-AC-model', () => {
  const ctxFor = (arm: string) => D.makeCtx({ round: 'R8', seed: '20261011', wt: D.DEFAULT_WT, claude: 'claude', rep: 1, out: path.join(dir, 'out') }, D.buildPlan({ round: 'R8' }), { arm, rep: 1 }, true);

  it('AC1: A is launched with the alias, C with the concrete id (the Messages API does not resolve `haiku`), B would keep the alias; the spec pin stays the alias for every arm', () => {
    expect(D.argvA(ctxFor('A'), '<m>', null)).toEqual(expect.arrayContaining(['--model', 'haiku']));
    expect(D.providerFor(ctxFor('C'), 'C')).toMatchObject({ type: 'anthropic', model: HAIKU_ID });
    expect(D.providerFor(ctxFor('B'), 'B')).toMatchObject({ type: 'claudecli', model: 'haiku' });   // an arm without its own model keeps the round alias
    for (const arm of ['A', 'C']) expect(ctxFor(arm).spec.pin, arm).toBe('haiku');
  });

  it('AC1: the C run is recorded as requested claude-haiku-5-5 (a concrete id, no alias warning) and its config does not claim an alias resolution', () => {
    const f = D.modelFacts({ requested: HAIKU_ID, resolved: [HAIKU_ID], wire: { mainModels: [HAIKU_ID], sideModels: [] } });
    expect(f).toMatchObject({ requested: HAIKU_ID, alias: false, resolved: [HAIKU_ID], warnings: [] });
    expect(D.effectiveConfig(ctxFor('C'))).toMatchObject({ model: HAIKU_ID });
    expect(D.effectiveConfig(ctxFor('C')).modelResolution).toBeUndefined();
    expect(D.effectiveConfig(ctxFor('A')).modelResolution).toMatch(/alias/);
  });

  it('AC1: the scenario sha of the A and C arms is the B1 run\'s sha (the model pin does not enter it)', () => {
    const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R8.json'), 'utf8'));
    expect(D.currentScenarioSha()).toBe(led.scenarioSha);
    for (const arm of ['A', 'C']) expect(F.expectedOf(ctxFor(arm).spec).pin, arm).toBe('haiku');   // every planned arm is scored against the alias pin (r1_model accepts the claude-haiku-* family)
  });

  it('AC2: armModelGuard lets C start only when A answered with exactly the id C is sent; a different, a second or no id stops with no spawn (negative controls)', () => {
    const prof = { arms: ['A', 'C'], armModels: { C: HAIKU_ID } };
    const aRec = (resolved: string[]) => ({ model: { resolved } });
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: aRec([HAIKU_ID]) })).toEqual({ ok: true, reasons: [] });
    expect(D.armModelGuard({ profile: prof, arm: 'A', aRecord: null }).ok).toBe(true);   // the guard is about arms that name a concrete model
    for (const resolved of [['claude-haiku-4-5'], [HAIKU_ID, 'claude-haiku-4-5'], []]) {
      const g = D.armModelGuard({ profile: prof, arm: 'C', aRecord: aRec(resolved) });
      expect(g.ok, resolved.join()).toBe(false);
      expect(g.reasons.join(' ')).toMatch(/no spawn|not started/);
    }
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: null }).ok).toBe(false);
  });
});

describe('R8-AC-effort', () => {
  const ctxFor = (arm: string, effort: string | null = 'high') => ({ ...D.makeCtx({ round: 'R8', seed: '20261011', wt: D.DEFAULT_WT, claude: 'claude', rep: 1, out: path.join(dir, 'out') }, D.buildPlan({ round: 'R8' }), { arm, rep: 1 }, true), profile: { ...D.roundProfile({ round: 'R8' }), effort } });

  it('AC1: arm C carries the effort as provider.effort (-> output_config.effort), on the agent definition of the parent AND the worker; none when no effort is configured (negative control)', () => {
    expect(D.providerFor(ctxFor('C'), 'C')).toMatchObject({ type: 'anthropic', model: HAIKU_ID, effort: 'high' });
    expect(D.agentDef(ctxFor('C'), 'worker', false).provider).toMatchObject({ effort: 'high' });
    expect(D.agentDef(ctxFor('C'), 'parent', true).provider).toMatchObject({ effort: 'high' });
    expect(Object.keys(D.providerFor(ctxFor('C', null), 'C'))).not.toContain('effort');
    expect(Object.keys(D.providerFor(ctxFor('B'), 'B'))).not.toContain('effort');   // B uses the env mechanism, not a provider field
  });

  it('AC2: the C mechanism names the request field, A keeps --effort, B keeps the env', () => {
    expect(D.EFFORT_MECHANISM.C).toMatch(/output_config\.effort/);
    expect(D.EFFORT_MECHANISM.C).not.toMatch(/NOT SETTABLE/);
    expect(D.argvA(ctxFor('A'), '<m>', null).join(' ')).toMatch(/--effort high/);
    expect(D.effortEnv(ctxFor('B'))).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    expect(D.effortEnv(ctxFor('C'))).toEqual({});
  });

  it('AC3: A and C reach the capture proxy through their own path <arm>/<provider>', () => {
    const capture = { baseUrl: (a: string, p: string) => `http://127.0.0.1:1/${a}/${p}` };
    expect(D.captureEnv({ runDef: { arm: 'A' }, capture }).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1/A/anthropic');
    expect(D.captureEnv({ runDef: { arm: 'C' }, capture }).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1/C/anthropic');
    expect(D.captureEnv({ runDef: { arm: 'C' }, capture: null })).toEqual({});
  });
});
