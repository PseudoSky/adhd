import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * PARITY-R9-cfg: the pacing gate is removed (owner: "disable the pacing gate entirely") and the models under test are CONFIGURATION, not code
 * (owner: "Make the model being run a separate configuration from the code ... environment variables with a json default ... all the anthropic ones use the same full value").
 * Pure instrument tests: no model call, no live run, no subprocess (the subprocess proofs are in r9-cfg.e2e.test.ts), `claude` is never executed (the spy proves it), process.env is only touched (PATH) around one injected-gate call.
 *   AC1 no usage-window read anywhere: sources, self-check subprocess, and the real live gate sequence all run with a spy `claude` that fails on /usage (and is never invoked)
 *   AC2 default config: A, B, C and the judge resolve to claude-haiku-5-5 with source json; R9 reaches the arms through the model flag / provider.model
 *   AC3 env precedence: per-group env > PARITY_MODEL > JSON; PARITY_EXPERIMENT_FILE and an explicit file work; sources are reported; rounds without the opt-in ignore env
 *   AC4 strict validation: unknown key, empty / non-string id, alias-only id, opus id, bad env => fail fast naming the key, zero spend (CLI exit 2, ledger byte-identical)
 *   AC5 equal-model guard aborts a mismatch before any spend; ledger run entries, judge calls and records carry the resolved ids
 *   AC6 R5-R8 ledgers keep their original model fields and print / derive identically, whatever the PARITY_* environment says
 *   AC7 `--print-plan --round R9` shows the resolved model per arm and the judge with its source, and the native flag / provider model
 */
const EX = await loadParity('experiment.mjs');
const D = await loadParity('drive.mjs');
const LG = await loadParity('ledger.mjs');
const GT = await loadParity('gate.mjs');
const L = await loadParity('lib.mjs');
const F = await loadParity('fixtures.mjs');
const O = await loadParity('oracle.mjs');

const cleanup: string[] = [];
const mk = (p = 'r9cfg-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanup.push(d); return d; };
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const HAIKU = 'claude-haiku-5-5';
const OLD = 'claude-haiku-4-5';
const md5 = (f: string) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

/** A `claude` stand-in on disk: logs its argv to SPY_LOG and exits 99 on /usage. Any invocation at all is a failure in these tests. */
function spyClaude() {
  const dir = mk('r9cfg-spy-');
  const bin = path.join(dir, 'claude');
  const log = path.join(dir, 'spy.log');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nfor a in "$@"; do [ "$a" = "/usage" ] && exit 99; done\nexit 1\n`, { mode: 0o755 });
  return { dir, bin, log, invoked: () => fs.existsSync(log) };
}

/** The R9 plan text with the environment injected (no process.env, no subprocess). */
const plan = (env: Record<string, string>, extra: object = {}) => D.planText({ ...D.parseArgs([]), round: 'R9', env, ...extra }) as string;

/** A temp ledger dir with one round whose profile opts into the experiment configuration. */
function configuredLedger(round: string, profile: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const dir = mk('r9cfg-led-');
  const led = { ...LG.emptyLedger(round), approvedBy: 'owner (test)', startedAt: '2026-10-12T20:37:09.841Z', scenarioSha: D.currentScenarioSha(), ...extra,
    profile: { arms: ['A', 'C'], effort: 'high', capture: true, pairedFixtures: true, modelConfig: 'experiment', ...profile } };
  fs.writeFileSync(LG.ledgerPathFor(round, dir), JSON.stringify(led, null, 2) + '\n');
  return { dir, file: LG.ledgerPathFor(round, dir) };
}
const optsFor = (round: string, dir: string, env: Record<string, string>, extra: object = {}) => ({ ...D.parseArgs([]), round, ledgerDir: dir, env, ...extra });

const writeExperiment = (obj: unknown, name = 'exp.json') => { const f = path.join(mk('r9cfg-exp-'), name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const goodGroups = (model = HAIKU) => ({ A: { provider: 'claude-cli', model }, B: { provider: 'claudecli', model }, C: { provider: 'anthropic', model }, judge: { provider: 'anthropic', model } });
const goodFile = (over: Record<string, unknown> = {}) => ({ schema: 'parity-experiment/1', groups: goodGroups(), ...over });

describe('PARITY-R9-cfg AC1: no usage-window read anywhere', () => {
  // needles are built by concatenation so this file never matches its own scan
  const NEEDLES = [new RegExp('(?<![\\w.])/' + 'usage(?![\\w.])'), new RegExp('read' + 'UsageWindow'), new RegExp('parse' + 'UsageOutput'), new RegExp('gate' + 'Pacing'), new RegExp('pacing' + 'Verdict'), new RegExp('rateLimits' + 'Seen'), new RegExp('R2_DRY_REAL_' + 'USAGE')];
  const instrumentSources = () => fs.readdirSync(PARITY_DIR).filter((f) => /\.(mjs|cjs|js|json|md)$/.test(f)).map((f) => [f, fs.readFileSync(path.join(PARITY_DIR, f), 'utf8')] as const)
    .concat(fs.readdirSync(path.join(PARITY_DIR, 'dryrun')).map((f) => [`dryrun/${f}`, fs.readFileSync(path.join(PARITY_DIR, 'dryrun', f), 'utf8')] as const));

  it('PARITY-R9-cfg AC1: no source, fake or doc in the instrument reads the usage window, names a pacing gate or keeps its helpers (golden fixtures excluded)', () => {
    const hits: string[] = [];
    for (const [f, text] of instrumentSources()) {
      for (const n of NEEDLES) if (n.test(text)) hits.push(`${f}: ${n}`);
      if (new RegExp('(?<![\\w-])[Pp]ac' + 'ing gate').test(text) || /Pacing gate \(SCOPE/.test(text)) hits.push(`${f}: pacing gate text`);
    }
    expect(hits).toEqual([]);
  });

  it('PARITY-R9-cfg AC1: the library and the gate order export no pacing helper and no pacing gate', () => {
    for (const k of ['read' + 'UsageWindow', 'parse' + 'UsageOutput', 'PAC' + 'ING', 'pacing' + 'Verdict']) expect(k in L).toBe(false);
    expect('gate' + 'Pacing' in D).toBe(false);
    expect(GT.GATE_ORDER).toEqual(['ledger', 'scope', 'models', 'judgeCredential', 'preflight']);
    expect(GT.GATE_ORDER).not.toContain('pac' + 'ing');
  });

  it('PARITY-R9-cfg AC1: the real live gate sequence runs every gate green with a spy `claude` on PATH and never invokes it (no /usage call)', async () => {
    const spy = spyClaude();
    const { dir } = configuredLedger('R9', {});
    const seen: string[] = [];
    const prevPath = process.env.PATH;
    process.env.PATH = `${spy.dir}${path.delimiter}${prevPath ?? ''}`;
    try {
      const res = await D.runLiveGates(optsFor('R9', dir, {}, { claude: spy.bin }), { preflight: async () => { seen.push('preflight'); return { ok: true, legs: [] }; }, judgeCredential: () => ({ present: true }) });
      expect(res.ok).toBe(true);
      expect(res.results.map((r: { gate: string }) => r.gate)).toEqual([...GT.GATE_ORDER]);
      expect(seen).toEqual(['preflight']);
    } finally { process.env.PATH = prevPath; }
    expect(spy.invoked()).toBe(false);
  });

});

describe('PARITY-R9-cfg AC2: default configuration', () => {
  it('PARITY-R9-cfg AC2: the shipped experiment.json gives A, B, C and the judge the same full id claude-haiku-5-5, source json, with each arm\'s fixed provider', () => {
    const ex = EX.resolveExperiment({ env: {} });
    for (const g of ['A', 'B', 'C', 'judge']) expect(ex.groups[g]).toMatchObject({ model: HAIKU, source: 'json', envVar: null });
    expect(Object.fromEntries(Object.entries(ex.groups).map(([g, v]) => [g, (v as { provider: string }).provider]))).toEqual({ A: 'claude-cli', B: 'claudecli', C: 'anthropic', judge: 'anthropic' });
    expect(ex.models).toEqual({ A: HAIKU, B: HAIKU, C: HAIKU, judge: HAIKU });
    expect(ex.fileSource).toBe('default');
    const raw = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'experiment.json'), 'utf8'));
    expect(Object.keys(raw.groups).sort()).toEqual(['A', 'B', 'C', 'judge']);
  });

  it('PARITY-R9-cfg AC2: R9 takes its models from the configuration: the profile opts in, carries no model fields, and the model reaches argv --model (A), provider.model (B, C), the oracle pin and the judge', () => {
    const led = JSON.parse(fs.readFileSync(LG.ledgerPathFor('R9'), 'utf8'));
    expect(led.profile.modelConfig).toBe('experiment');
    for (const k of ['model', 'judgeModel', 'armModels']) expect(led.profile[k]).toBeUndefined();
    const opts = { ...D.parseArgs([]), round: 'R9', env: {} };
    const prof = D.roundProfile(opts);
    expect(prof.models).toEqual({ A: HAIKU, B: HAIKU, C: HAIKU, judge: HAIKU });
    expect(prof.judgeModel).toBe(HAIKU);
    for (const g of ['A', 'C', 'judge']) expect(prof.modelSources[g]).toMatchObject({ source: 'json', envVar: null });
    const ctxA = D.makeCtx(opts, [], { arm: 'A', rep: 1 }, true);
    const ctxC = D.makeCtx(opts, [], { arm: 'C', rep: 1 }, true);
    const argv: string[] = D.argvA(ctxA, '<mcp>', null);
    expect(argv[argv.indexOf('--model') + 1]).toBe(HAIKU);
    expect(D.providerFor(ctxC, 'C').model).toBe(HAIKU);
    expect(D.providerFor(D.makeCtx(opts, [], { arm: 'B', rep: 1 }, true), 'B').model).toBe(HAIKU);
    expect(ctxA.spec.pin).toBe(HAIKU);
    expect(ctxC.spec.pin).toBe(HAIKU);
  });
});

describe('PARITY-R9-cfg AC3: environment precedence', () => {
  it('PARITY-R9-cfg AC3: per-group env > PARITY_MODEL > JSON, and each source is reported', () => {
    const none = EX.resolveExperiment({ env: {} });
    expect(none.groups.C).toMatchObject({ model: HAIKU, source: 'json' });
    const all = EX.resolveExperiment({ env: { PARITY_MODEL: OLD } });
    for (const g of ['A', 'B', 'C', 'judge']) expect(all.groups[g]).toMatchObject({ model: OLD, source: 'env', envVar: 'PARITY_MODEL' });
    const mixed = EX.resolveExperiment({ env: { PARITY_MODEL: OLD, PARITY_MODEL_C: 'claude-sonnet-5-5', PARITY_JUDGE_MODEL: 'claude-haiku-5-5-20261001' } });
    expect(mixed.groups.A).toMatchObject({ model: OLD, source: 'env', envVar: 'PARITY_MODEL' });
    expect(mixed.groups.B).toMatchObject({ model: OLD, envVar: 'PARITY_MODEL' });
    expect(mixed.groups.C).toMatchObject({ model: 'claude-sonnet-5-5', source: 'env', envVar: 'PARITY_MODEL_C' });
    expect(mixed.groups.judge).toMatchObject({ model: 'claude-haiku-5-5-20261001', source: 'env', envVar: 'PARITY_JUDGE_MODEL' });
    const onlyA = EX.resolveExperiment({ env: { PARITY_MODEL_A: OLD } });
    expect(onlyA.groups.A).toMatchObject({ model: OLD, envVar: 'PARITY_MODEL_A' });
    expect(onlyA.groups.C).toMatchObject({ model: HAIKU, source: 'json' });
  });

  it('PARITY-R9-cfg AC3: PARITY_EXPERIMENT_FILE (and an explicit file) replace the JSON default; env still wins over the alternate file', () => {
    const alt = writeExperiment(goodFile({ groups: { ...goodGroups(OLD), judge: { provider: 'anthropic', model: HAIKU } } }));
    const viaEnv = EX.resolveExperiment({ env: { PARITY_EXPERIMENT_FILE: alt } });
    expect(viaEnv.fileSource).toBe('env');
    expect(viaEnv.file).toBe(alt);
    expect(viaEnv.groups.A).toMatchObject({ model: OLD, source: 'json' });
    expect(viaEnv.groups.judge).toMatchObject({ model: HAIKU, source: 'json' });
    expect(EX.resolveExperiment({ env: { PARITY_EXPERIMENT_FILE: alt, PARITY_MODEL_A: HAIKU } }).groups.A).toMatchObject({ model: HAIKU, source: 'env', envVar: 'PARITY_MODEL_A' });
    const viaParam = EX.resolveExperiment({ env: {}, file: alt });
    expect(viaParam.fileSource).toBe('param');
    expect(viaParam.models.C).toBe(OLD);
    expect(viaParam.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(viaParam.sha256).not.toBe(EX.resolveExperiment({ env: {} }).sha256);
  });

  it('PARITY-R9-cfg AC3: the opted-in round follows the environment end to end (profile, argv --model, provider.model, spec pin, judge)', () => {
    const { dir } = configuredLedger('R9', {});
    const opts = optsFor('R9', dir, { PARITY_MODEL: OLD, PARITY_MODEL_C: HAIKU });
    const prof = D.roundProfile(opts);
    expect(prof.models).toEqual({ A: OLD, B: OLD, C: HAIKU, judge: OLD });
    const ctxA = D.makeCtx(opts, [], { arm: 'A', rep: 1 }, true);
    const argv: string[] = D.argvA(ctxA, '<mcp>', null);
    expect(argv[argv.indexOf('--model') + 1]).toBe(OLD);
    expect(ctxA.spec.pin).toBe(OLD);
    expect(D.providerFor(D.makeCtx(opts, [], { arm: 'C', rep: 1 }, true), 'C').model).toBe(HAIKU);
  });
});

describe('PARITY-R9-cfg AC4: strict validation, fail fast, zero spend', () => {
  const key = (re: RegExp) => (e: unknown) => { expect((e as Error).name).toBe('ExperimentConfigError'); expect((e as Error).message).toMatch(re); return true; };
  const refuses = (f: () => unknown, re: RegExp) => { let threw = false; try { f(); } catch (e) { threw = true; key(re)(e); } expect(threw).toBe(true); };

  it('PARITY-R9-cfg AC4: a bad model id in the JSON names the group key (empty, non-string, whitespace, alias, versionless, opus in any case)', () => {
    const bad = (id: unknown) => writeExperiment(goodFile({ groups: { ...goodGroups(), B: { provider: 'claudecli', model: id } } }));
    for (const [id, why] of [['', /empty/], [' ', /empty/], [7, /string/], [null, /string/], ['hai ku', /whitespace/], ['haiku', /alias/], ['sonnet', /alias/], ['claude-haiku', /alias|versioned/], ['latest', /alias/],
      ['opus', /opus/], ['claude-opus-4-1', /opus/], ['CLAUDE-OPUS-5-1', /opus/], ['claude-sonnet-opus-5', /opus/]] as const) {
      refuses(() => EX.resolveExperiment({ env: {}, file: bad(id) }), new RegExp(`groups\\.B\\.model.*${why.source}`, 'i'));
    }
  });

  it('PARITY-R9-cfg AC4: unknown top-level key, unknown group, unknown per-group key, wrong provider, missing group and bad schema each name the key', () => {
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment(goodFile({ extra: 1 })) }), /unknown top-level key "extra"/);
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment(goodFile({ groups: { ...goodGroups(), D: { provider: 'anthropic', model: HAIKU } } })) }), /unknown group key "D"/);
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment(goodFile({ groups: { ...goodGroups(), C: { provider: 'anthropic', model: HAIKU, effort: 'high' } } })) }), /groups\.C: unknown key "effort"/);
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment(goodFile({ groups: { ...goodGroups(), C: { provider: 'openai', model: HAIKU } } })) }), /groups\.C\.provider must be "anthropic"/);
    const noJudge: Record<string, unknown> = goodGroups();
    delete noJudge.judge;
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment(goodFile({ groups: noJudge })) }), /groups\.judge is missing/);
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment(goodFile({ schema: 'x' })) }), /"schema"/);
    refuses(() => EX.resolveExperiment({ env: {}, file: writeExperiment('{not json') }), /not valid JSON/);
  });

  it('PARITY-R9-cfg AC4: a bad environment value names the variable (opus, alias, empty, unknown group variable, missing alternate file)', () => {
    refuses(() => EX.resolveExperiment({ env: { PARITY_MODEL: 'claude-opus-4-1' } }), /env PARITY_MODEL: .*opus/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_JUDGE_MODEL: 'Claude-Opus-5' } }), /env PARITY_JUDGE_MODEL: .*opus/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_MODEL_A: 'sonnet' } }), /env PARITY_MODEL_A: .*alias/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_MODEL_B: '' } }), /env PARITY_MODEL_B: .*empty/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_MODEL: '   ' } }), /env PARITY_MODEL: .*empty/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_MODEL_D: HAIKU } }), /env PARITY_MODEL_D: unknown group variable/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_JUDGE: HAIKU } }), /env PARITY_JUDGE: unknown group variable/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_EXPERIMENT_FILE: path.join(os.tmpdir(), 'r9cfg-does-not-exist.json') } }), /env PARITY_EXPERIMENT_FILE: cannot read/);
    refuses(() => EX.resolveExperiment({ env: { PARITY_EXPERIMENT_FILE: '' } }), /env PARITY_EXPERIMENT_FILE: set but empty/);
    // a valid unrelated PARITY_ variable (the existing capture switch) is not a group variable
    expect(EX.resolveExperiment({ env: { PARITY_CAPTURE: '1' } }).models.A).toBe(HAIKU);
  });

  it('PARITY-R9-cfg AC4: an opus id in the alternate FILE is refused through the env file path too, naming the file key', () => {
    const f = writeExperiment(goodFile({ groups: { ...goodGroups(), judge: { provider: 'anthropic', model: 'claude-opus-4-1' } } }));
    refuses(() => EX.resolveExperiment({ env: { PARITY_EXPERIMENT_FILE: f } }), /groups\.judge\.model.*opus/);
  });

  it('PARITY-R9-cfg AC4: profileOf fails closed when modelConfig is combined with the legacy model fields, or carries a bad value', () => {
    const led = (profile: object) => ({ runs: [], judgeCalls: [], profile: { arms: ['A', 'C'], ...profile } });
    expect(LG.profileOf(led({ modelConfig: 'experiment' }))).toMatchObject({ modelConfig: 'experiment' });
    for (const extra of [{ model: HAIKU }, { judgeModel: HAIKU }, { armModels: { C: HAIKU } }]) expect(() => LG.profileOf(led({ modelConfig: 'experiment', ...extra }))).toThrow(/mutually exclusive/);
    expect(() => LG.profileOf(led({ modelConfig: 'json' }))).toThrow(/must be "experiment"/);
    expect(() => LG.profileOf(led({ modelDifferenceReason: 'x' }))).toThrow(/modelDifferenceReason/);
    expect(() => LG.profileOf(led({ modelConfig: 'experiment', modelDifferenceReason: '  ' }))).toThrow(/modelDifferenceReason/);
  });

});

describe('PARITY-R9-cfg AC5: equal-model guard and recorded ids', () => {
  const ids = (a: string, c: string) => ({ A: a, B: a, C: c, judge: a });
  const price = (id: string) => D.pricingIdOf(id);

  it('PARITY-R9-cfg AC5: modelConsistency passes equal and same-priced ids, refuses a mismatch, and honours a recorded deliberate difference', () => {
    expect(EX.modelConsistency({ arms: ['A', 'C'], models: ids(HAIKU, HAIKU), pricingIdOf: price }).ok).toBe(true);
    expect(EX.modelConsistency({ arms: ['A', 'C'], models: ids(HAIKU, 'claude-haiku-5-5-20261001'), pricingIdOf: price }).ok).toBe(true); // same rate card
    const bad = EX.modelConsistency({ arms: ['A', 'C'], models: ids(HAIKU, OLD), pricingIdOf: price });
    expect(bad.ok).toBe(false);
    expect(bad.reasons[0]).toMatch(/A=claude-haiku-5-5/);
    expect(bad.reasons[0]).toMatch(/C=claude-haiku-4-5/);
    expect(bad.reasons[0]).toMatch(/before any spend/);
    expect(EX.modelConsistency({ arms: ['A', 'C'], models: ids(HAIKU, OLD), pricingIdOf: price, differenceReason: 'owner: compare 5-5 with 4-5' })).toMatchObject({ ok: true, deliberate: 'owner: compare 5-5 with 4-5' });
    expect(EX.modelConsistency({ arms: ['A', 'C'], models: { A: HAIKU }, pricingIdOf: price }).ok).toBe(false); // a missing id is never "equal" to itself
    // the judge may differ from the arms: it is not a compared arm
    expect(EX.modelConsistency({ arms: ['A', 'C'], models: { ...ids(HAIKU, HAIKU), judge: OLD }, pricingIdOf: price }).ok).toBe(true);
  });

  it('PARITY-R9-cfg AC5: a configured mismatch is refused by the live `models` gate before preflight, with the ledger untouched and no `claude` spawn', async () => {
    const spy = spyClaude();
    const { dir, file } = configuredLedger('R9', {});
    const before = md5(file);
    let preflights = 0;
    const res = await D.runLiveGates(optsFor('R9', dir, { PARITY_MODEL_C: OLD }, { claude: spy.bin }), { preflight: async () => { preflights++; return { ok: true, legs: [] }; }, judgeCredential: () => ({ present: true }) });
    expect(res).toMatchObject({ ok: false, exitCode: 3, failed: 'models' });
    expect(res.results.at(-1).reasons.join(' ')).toMatch(/different pricing ids/);
    expect(preflights).toBe(0);
    expect(md5(file)).toBe(before);
    expect(LG.readLedger('R9', dir).runs).toEqual([]);
    expect(spy.invoked()).toBe(false);
    // the same mismatch passes when the ledger profile records it as deliberate
    const dl = configuredLedger('R9', { modelDifferenceReason: 'owner-approved cross-model comparison' });
    const ok = await D.runLiveGates(optsFor('R9', dl.dir, { PARITY_MODEL_C: OLD }), { preflight: async () => ({ ok: true, legs: [] }), judgeCredential: () => ({ present: true }) });
    expect(ok.ok).toBe(true);
    // and an invalid id is a red gate (fail closed), not a throw
    const inv = await D.runLiveGates(optsFor('R9', dir, { PARITY_MODEL_A: 'opus' }), { preflight: async () => ({ ok: true, legs: [] }), judgeCredential: () => ({ present: true }) });
    expect(inv).toMatchObject({ ok: false, failed: 'models' });
    expect(inv.results.at(-1).reasons.join(' ')).toMatch(/PARITY_MODEL_A/);
  });

  it('PARITY-R9-cfg AC5: the runtime armModelGuard starts a later arm only when arm A answered with exactly the configured id (another id, two ids, none, no A record all stop with no spawn)', () => {
    const prof = { arms: ['A', 'C'], models: { A: HAIKU, C: HAIKU, judge: HAIKU } };
    const a = (resolved: string[]) => ({ model: { resolved } });
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: a([HAIKU]) })).toEqual({ ok: true, reasons: [] });
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: a([OLD]) }).ok).toBe(false);
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: a([HAIKU, OLD]) }).ok).toBe(false);
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: a([]) }).ok).toBe(false);
    expect(D.armModelGuard({ profile: prof, arm: 'C', aRecord: null }).ok).toBe(false);
    expect(D.armModelGuard({ profile: prof, arm: 'A', aRecord: null }).ok).toBe(true);
    expect(D.armModelGuard({ profile: { ...prof, modelDifferenceReason: 'deliberate' }, arm: 'C', aRecord: a([OLD]) }).ok).toBe(true);
  });

  it('PARITY-R9-cfg AC5: the ledger run entry, the judge call and the record facts carry the resolved ids and where each came from', async () => {
    const { dir, file } = configuredLedger('R9', {});
    const opts = optsFor('R9', dir, { PARITY_MODEL: OLD, PARITY_MODEL_C: OLD, PARITY_MODEL_A: OLD, PARITY_JUDGE_MODEL: HAIKU });
    const prof = D.roundProfile(opts);
    const mc = D.modelConfigFacts(prof, 'C');
    expect(mc).toMatchObject({ id: OLD, provider: 'anthropic', source: 'env', envVar: 'PARITY_MODEL_C', judge: { id: HAIKU, source: 'env', envVar: 'PARITY_JUDGE_MODEL' }, differenceAllowed: null });
    expect(mc.experimentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(D.effectiveConfig(D.makeCtx(opts, [], { arm: 'C', rep: 1 }, true)).modelConfig).toMatchObject({ id: OLD, source: 'env' });
    expect(D.modelConfigFacts({ model: 'haiku' }, 'A')).toBeNull(); // a legacy profile has none: no new field on R5-R8 records
    // rawRun reserves the run with the resolved id, through the real ledger
    const ctx = D.makeCtx({ ...opts, out: path.join(dir, 'out') }, [], { arm: 'A', rep: 1 }, false);
    cleanup.push(path.dirname(ctx.work));
    ctx.ledgerPath = file;
    ctx.executor = async () => { throw new Error('stop at the spawn boundary'); };
    await expect(D.rawRun(ctx)).rejects.toThrow(/stop at the spawn boundary/);
    const led = LG.readLedger('R9', dir);
    expect(led.runs).toHaveLength(1);
    expect(led.runs[0]).toMatchObject({ arm: 'A', model: OLD, modelSource: 'env:PARITY_MODEL_A' });
    LG.recordJudgeCall('R9', { arm: 'A', modelId: HAIKU, inputTokens: 1, outputTokens: 1, costUsd: 0, briefSha: 'x', modelSource: 'env:PARITY_JUDGE_MODEL' }, { dir });
    expect(LG.readLedger('R9', dir).judgeCalls[0]).toMatchObject({ modelId: HAIKU, modelSource: 'env:PARITY_JUDGE_MODEL' });
    // an unconfigured reservation keeps the original entry shape (no model fields)
    const plain = mk();
    fs.writeFileSync(LG.ledgerPathFor('RX', plain), JSON.stringify({ ...LG.emptyLedger('RX'), approvedBy: 'o' }));
    LG.reserveRun('RX', { arm: 'A', runId: 'A1', dir: plain });
    expect(Object.keys(LG.readLedger('RX', plain).runs[0]).sort()).toEqual(['arm', 'at', 'pid', 'runId']);
  });
});

describe('PARITY-R9-cfg AC5: the judge call carries the resolved id through the real judgeRun', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden', 'r4', 'A2.json'), 'utf8'));
  const setup = (env: Record<string, string>) => {
    const { dir } = configuredLedger('R9', {});
    const profile = D.roundProfile(optsFor('R9', dir, env));
    const root = mk('r9cfg-judge-');
    const spec = F.makeSpec({ seed: '20261011', arm: 'A', rep: 1 });
    const repoDir = path.join(root, 'repo');
    F.writeFixture({ repoDir, hiddenDir: path.join(root, 'hidden'), ticketFile: path.join(root, 't.txt') }, spec);
    const record = () => ({ arm: 'A', runId: 'A1', observation: golden.observation, score: O.scoreObservation(golden.observation, golden.expected), metrics: {} });
    return { dir, root, record, ctx: { prompts: F.prompts(), spec, repoDir, ledgerPath: LG.ledgerPathFor('R9', dir), profile } };
  };

  it('PARITY-R9-cfg AC5: a scored judge call is sent the configured judge id and the ledger entry records it with its source (json default and env override)', async () => {
    for (const [env, id, source] of [[{}, HAIKU, 'json'], [{ PARITY_JUDGE_MODEL: OLD }, OLD, 'env:PARITY_JUDGE_MODEL'], [{ PARITY_MODEL: OLD }, OLD, 'env:PARITY_MODEL']] as const) {
      const { dir, root, record, ctx } = setup(env);
      const sent: string[] = [];
      const client = { async complete({ model }: { model: string }) { sent.push(model); const r = await D.fakeJudgeClient().complete(); r.inputTokens = 10; r.outputTokens = 5; r.model = model; return r; } };
      const rec = record();
      const q = await D.judgeRun({ ctx, record: rec, aGenuine: true, dry: false, client, judgeDir: path.join(root, 'out') });
      expect(q.status).toBe('scored');
      expect(sent).toEqual([id]);
      const calls = LG.readLedger('R9', dir).judgeCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ arm: 'A', modelId: id, modelSource: source });
    }
  });

  it('PARITY-R9-cfg AC5: a failed judge call is logged with the configured judge id and its source too', async () => {
    const { dir, root, record, ctx } = setup({ PARITY_JUDGE_MODEL: OLD });
    const client = { async complete() { throw new Error('judge endpoint rejected the request'); } };
    const q = await D.judgeRun({ ctx, record: record(), aGenuine: true, dry: false, client, judgeDir: path.join(root, 'out') });
    expect(q.status).toBe('judge-failed');
    const calls = LG.readLedger('R9', dir).judgeCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'failed', modelId: OLD, modelSource: 'env:PARITY_JUDGE_MODEL', paidCallAttempted: true });
  });
});

describe('PARITY-R9-cfg AC6: R5-R8 are unchanged', () => {
  it('PARITY-R9-cfg AC6: R5-R8 ledgers keep their original model fields and never read the configuration', () => {
    for (const r of ['R5', 'R6', 'R7', 'R8']) {
      const led = JSON.parse(fs.readFileSync(LG.ledgerPathFor(r), 'utf8'));
      expect(led.profile?.modelConfig, r).toBeUndefined();
      const quiet = D.roundProfile({ round: r, env: {} });
      const noisy = D.roundProfile({ round: r, env: { PARITY_MODEL: OLD, PARITY_MODEL_C: 'opus', PARITY_MODEL_D: 'x', PARITY_EXPERIMENT_FILE: '/nonexistent.json' } });
      expect(noisy, r).toEqual(quiet);
      expect(quiet.models, r).toBeUndefined();
    }
    const p8 = D.roundProfile({ round: 'R8', env: {} });
    expect(p8).toMatchObject({ arms: ['A', 'C'], completedArms: ['B'], armModels: { C: HAIKU }, model: 'haiku', judgeModel: 'haiku', effort: 'high', capture: true });
  });

  it('PARITY-R9-cfg AC6: the R5-R8 plans do not change with the PARITY_* environment (an unrelated shell cannot alter an old round)', () => {
    for (const r of ['R5', 'R6', 'R7', 'R8']) {
      const a = D.planText({ ...D.parseArgs([]), round: r, env: {} }) as string;
      const b = D.planText({ ...D.parseArgs([]), round: r, env: { PARITY_MODEL: OLD, PARITY_MODEL_C: 'opus', PARITY_MODEL_D: 'x' } }) as string;
      expect(b, r).toBe(a);
      expect(a, r).not.toMatch(/MODELS \(SCOPE-R9-model-config/);
      expect(a, r).not.toMatch(/PACING/);
    }
  });

  it('PARITY-R9-cfg AC6: the armModels alias path still works for a legacy profile (modelOf order: configured id, then armModels, then model)', () => {
    const ctxOf = (profile: object, arm: string) => ({ runDef: { arm }, profile, opts: {} });
    const legacy = { model: 'haiku', armModels: { C: HAIKU }, effort: 'high' };
    expect(D.providerFor(ctxOf(legacy, 'C'), 'C').model).toBe(HAIKU);
    expect(D.providerFor(ctxOf(legacy, 'B'), 'B').model).toBe('haiku');
    expect(D.providerFor(ctxOf({ ...legacy, models: { C: OLD } }, 'C'), 'C').model).toBe(OLD);
  });
});

describe('PARITY-R9-cfg AC7: --print-plan --round R9', () => {
  it('PARITY-R9-cfg AC7: the default plan shows the resolved model per arm and the judge with source json, the native flag, provider.model and the equal-model verdict', () => {
    const out = plan({});
    expect(out).toMatch(/MODELS \(SCOPE-R9-model-config/);
    expect(out).toMatch(/precedence per-group env > PARITY_MODEL > JSON/);
    expect(out).toMatch(/arm A: provider claude-cli {2}model claude-haiku-5-5 {2}source json/);
    expect(out).toMatch(/arm C: provider anthropic {2}model claude-haiku-5-5 {2}source json/);
    expect(out).toMatch(/judge: provider anthropic {2}model claude-haiku-5-5 {2}source json/);
    expect(out).toMatch(/claude -p \.\.\. --model claude-haiku-5-5/);
    expect(out).toMatch(/provider \{"type":"anthropic","model":"claude-haiku-5-5"\}/);
    expect(out).toMatch(/equal-model guard \(before any spend\): PASS/);
    expect(out).not.toMatch(/ALIAS/);
    expect(out).not.toMatch(/PACING/);
  });

  it('PARITY-R9-cfg AC7: an env override is shown with its variable, PARITY_MODEL covers every group, and a mismatch is shown as REFUSES', () => {
    const all = plan({ PARITY_MODEL: OLD });
    expect(all).toMatch(/arm A: .*model claude-haiku-4-5 {2}source env \(PARITY_MODEL\)/);
    expect(all).toMatch(/judge: .*model claude-haiku-4-5 {2}source env \(PARITY_MODEL\)/);
    expect(all).toMatch(/--model claude-haiku-4-5/);
    expect(all).toMatch(/equal-model guard \(before any spend\): PASS/);
    const split = plan({ PARITY_MODEL_C: OLD });
    expect(split).toMatch(/arm A: .*source json/);
    expect(split).toMatch(/arm C: .*model claude-haiku-4-5 {2}source env \(PARITY_MODEL_C\)/);
    expect(split).toMatch(/equal-model guard \(before any spend\): REFUSES/);
    const alt = writeExperiment(goodFile({ groups: goodGroups(OLD) }));
    const viaFile = plan({ PARITY_EXPERIMENT_FILE: alt });
    expect(viaFile).toMatch(/arm C: .*model claude-haiku-4-5 {2}source json/);
    expect(viaFile).toContain('[env]');
  });
});
