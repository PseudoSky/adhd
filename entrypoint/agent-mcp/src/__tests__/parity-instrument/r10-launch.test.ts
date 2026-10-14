/*
 * guards: experiment.json or PARITY_THINKING_C stops configuring thinking for group C only, an invalid shape or a non-anthropic group is accepted, thinkingFacts hides a requested-versus-wire mismatch, the --self-check anthropic.ts guard passes a mutant, the ledger precondition ignores the owner approval or accepts an empty approvedBy, or the README drops the Anthropic-only statement.
 * tier: S (pure functions, temp ledger copies, in-process live-gate sequence)
 * cites: R10 LP AC1, AC3, AC4, AC5, AC6 (SCOPE-R10-thinking-parity, as titled in this file; no backlog uid appears in this file; filed under G9 bucket 003366c1-fef5-4b97-be06-bda8155d31a3).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * R10 launch prep (SCOPE-R10-thinking-parity): arm C's request must carry the same `thinking` setting arm A's native request carries, so the comparison asks the model the same thing.
 * Pure instrument tests (no model call, no subprocess; the real dry-run proofs are in r10-launch.e2e.test.ts). Every `R10 LP AC<n>` below names the acceptance criterion it proves.
 *   AC1 experiment.json: group C carries thinking {"type":"adaptive"}, A / B / judge none; experiment.mjs refuses an invalid shape or a non-anthropic group; PARITY_THINKING_C=none removes it
 *   AC3 thinkingFacts: requested versus wire per arm for main requests, a mismatch is flagged (negative controls: none/none matches, a worker that lost it mismatches)
 *   AC4 the --self-check anthropic.ts guard (conditional pass-through present exactly once, nothing else) has teeth against four mutants
 *   AC5 the ledger precondition sees the owner approval; an empty approvedBy is still refused
 *   AC6 thinking parity is for the Anthropic-backed arm only; the per-group schema rejects it elsewhere; README says so
 */
const EX = await loadParity('experiment.mjs');
const D = await loadParity('drive.mjs');
const LG = await loadParity('ledger.mjs');
const WD = await loadParity('wire-diff.mjs');

const cleanup: string[] = [];
const mk = (p = 'r10lp-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanup.push(d); return d; };
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const ADAPTIVE = { type: 'adaptive' };
/** Write a variant of the shipped experiment file (groups edited by `edit`) and return its path. */
function variant(edit: (groups: Record<string, Record<string, unknown>>) => void): string {
  const j = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'experiment.json'), 'utf8'));
  edit(j.groups);
  const f = path.join(mk(), 'experiment.json'); fs.writeFileSync(f, JSON.stringify(j)); return f;
}
const msg = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).name + ': ' + (e as Error).message; } return null; };

describe('R10 LP AC1: experiment configuration of thinking', () => {
  it('R10 LP AC1: experiment.json group C carries thinking {"type":"adaptive"}; A, B and judge carry none', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'experiment.json'), 'utf8'));
    expect(raw.groups.C.thinking).toEqual(ADAPTIVE);
    for (const g of ['A', 'B', 'judge']) expect(raw.groups[g], g).not.toHaveProperty('thinking');
    const ex = EX.resolveExperiment({ env: {} });
    expect(ex.thinking).toEqual({ C: { value: ADAPTIVE, source: 'json', envVar: null } });
    expect(Object.keys(ex.thinking)).toEqual(['C']);
  });

  it('R10 LP AC1: PARITY_THINKING_C=none removes it; a JSON object overrides it and wins over the file; the model ids are unaffected', () => {
    expect(EX.resolveExperiment({ env: { PARITY_THINKING_C: 'none' } }).thinking.C).toEqual({ value: null, source: 'env', envVar: 'PARITY_THINKING_C' });
    expect(EX.resolveExperiment({ env: { PARITY_THINKING_C: '{"type":"adaptive","display":"summarized"}' } }).thinking.C.value).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(EX.resolveExperiment({ env: { PARITY_THINKING_C: '{"type":"disabled"}' } }).thinking.C.value).toEqual({ type: 'disabled' });
    const none = EX.resolveExperiment({ env: { PARITY_THINKING_C: 'none', PARITY_MODEL: 'claude-haiku-5-5' } });
    expect(none.models).toEqual(EX.resolveExperiment({ env: { PARITY_MODEL: 'claude-haiku-5-5' } }).models);
    // the file with no thinking at all resolves to no thinking, and the env still overrides it
    const bare = variant((g) => { delete g.C.thinking; });
    expect(EX.resolveExperiment({ env: {}, file: bare }).thinking.C.value).toBeNull();
    expect(EX.resolveExperiment({ env: { PARITY_THINKING_C: '{"type":"adaptive"}' }, file: bare }).thinking.C.value).toEqual(ADAPTIVE);
  });

  it('R10 LP AC1: an invalid shape is refused with an error naming the key (file and environment)', () => {
    for (const [bad, why] of [[{ type: 'x' }, /thinking\.type must be "adaptive" or "disabled"/], [{ type: 'enabled', budget_tokens: 10 }, /unknown thinking key "budget_tokens"/], [{ type: 'adaptive', display: 'loud' }, /display must be "summarized" or "omitted"/],
      [{ type: 'disabled', display: 'omitted' }, /display is only valid with type "adaptive"/], [[], /must be an object/], ['adaptive', /must be an object/], [null, /must be an object/]] as const) {
      const f = variant((g) => { g.C.thinking = bad; });
      expect(msg(() => EX.resolveExperiment({ env: {}, file: f })), JSON.stringify(bad)).toMatch(/^ExperimentConfigError: experiment config: groups\.C\.thinking: /);
      expect(msg(() => EX.resolveExperiment({ env: {}, file: f })), JSON.stringify(bad)).toMatch(why);
    }
    expect(msg(() => EX.resolveExperiment({ env: { PARITY_THINKING_C: '{"type":"x"}' } }))).toMatch(/env PARITY_THINKING_C: thinking\.type must be/);
    expect(msg(() => EX.resolveExperiment({ env: { PARITY_THINKING_C: '' } }))).toMatch(/env PARITY_THINKING_C: set but empty/);
    expect(msg(() => EX.resolveExperiment({ env: { PARITY_THINKING_C: '{nope' } }))).toMatch(/env PARITY_THINKING_C: not valid JSON and not the literal none/);
    expect(msg(() => EX.resolveExperiment({ env: { PARITY_THINKING_C: 'None' } }))).toMatch(/not valid JSON/);   // only the exact literal removes it
  });

  it('R10 LP AC1/AC6: thinking on a non-anthropic group (claudecli, claude-cli) or on the judge is refused in the file, and the unknown variables are refused in the environment', () => {
    const providerOf: Record<string, string> = { A: 'claude-cli', B: 'claudecli', judge: 'anthropic' };
    for (const g of ['A', 'B', 'judge']) {
      const f = variant((groups) => { groups[g].thinking = ADAPTIVE; });
      expect(msg(() => EX.resolveExperiment({ env: {}, file: f })), g).toMatch(new RegExp(`groups\\.${g}: "thinking" is not allowed on provider "${providerOf[g]}": thinking parity applies to the Anthropic-backed agent-mcp arm \\(group C\\) only`));
    }
    for (const k of ['PARITY_THINKING_A', 'PARITY_THINKING_B', 'PARITY_THINKING_JUDGE', 'PARITY_THINKING']) expect(msg(() => EX.resolveExperiment({ env: { [k]: 'none' } })), k).toMatch(new RegExp(`env ${k}: unknown thinking variable`));
  });

  it('R10 LP AC1: precedence is documented in the module header and the plan text names the source of arm C thinking', () => {
    const src = fs.readFileSync(path.join(PARITY_DIR, 'experiment.mjs'), 'utf8');
    expect(src).toMatch(/PARITY_THINKING_C[\s\S]*the JSON file's groups\.C\.thinking/);
    const plan = D.planText({ ...D.parseArgs([]), round: 'R10', env: {} }) as string;
    expect(plan).toContain('EXPLICIT {"type":"adaptive"} (SCOPE-R10-thinking-parity)');
    expect(plan).toContain('precedence PARITY_THINKING_C > JSON');
    expect(plan).toMatch(/provider: \{"type":"anthropic","model":"claude-haiku-5-5","timeoutMs":600000,"effort":"high","thinking":\{"type":"adaptive"\}\}/);
    expect(D.planText({ ...D.parseArgs([]), round: 'R10', env: { PARITY_THINKING_C: 'none' } })).toContain('EXPLICIT none');
  });
});

describe('R10 LP: only a round that lists the scope applies the configured thinking', () => {
  it('R10 LP AC1: the R10 profile carries thinking {C: adaptive}; R9 (no scope) and R8 carry none, so their providers, plans and records are unchanged by editing experiment.json', () => {
    const p10 = D.roundProfile({ round: 'R10', env: {} });
    expect(p10.thinking).toEqual({ C: ADAPTIVE });
    expect(D.thinkingOf({ profile: p10, runDef: { arm: 'C' } })).toEqual(ADAPTIVE);
    expect(D.thinkingOf({ profile: p10, runDef: { arm: 'A' } })).toBeUndefined();   // the harness sets nothing on A / B
    expect(D.thinkingOf({ profile: p10, runDef: { arm: 'B' } })).toBeUndefined();
    expect(D.roundProfile({ round: 'R10', env: { PARITY_THINKING_C: 'none' } }).thinking).toEqual({ C: null });
    for (const r of ['R9', 'R8', 'R7']) { const p = D.roundProfile({ round: r, env: {} }); expect(p.thinking, r).toBeUndefined(); expect(D.thinkingOf({ profile: p, runDef: { arm: 'C' } }), r).toBeUndefined(); }
    const r9 = D.planText({ ...D.parseArgs([]), round: 'R9', env: {} }) as string;
    expect(r9).not.toContain('EXPLICIT'); expect(r9).toContain('no thinking key');
  });

  it('R10 LP AC1 teeth: the same R10 ledger without the scope entry applies no thinking (a temp ledger copy)', () => {
    const dir = mk(); const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R10.json'), 'utf8'));
    led.scopeChanges = led.scopeChanges.filter((s: string) => s !== 'SCOPE-R10-thinking-parity');
    fs.writeFileSync(path.join(dir, 'R10.json'), JSON.stringify(led));
    expect(D.roundProfile({ round: 'R10', env: {}, ledgerDir: dir }).thinking).toBeUndefined();
  });
});

describe('R10 LP AC3: thinkingFacts compares the requested option with the wire', () => {
  const body = (thinking: unknown, tools = ['task']) => ({ model: 'm', tools: tools.map((name) => ({ name })), ...(thinking === undefined ? {} : { thinking }) });
  const wire = (...bodies: unknown[]) => WD.summarizeThinking(bodies);

  it('R10 LP AC3: C requested adaptive and every main request (parent and worker) carried it => verified, match true, with a verdict line', () => {
    const f = D.thinkingFacts({ requested: ADAPTIVE, arm: 'C', wire: wire(body(ADAPTIVE, ['task', 'r2info_get_ticket']), body(ADAPTIVE), body(ADAPTIVE), body(undefined, [])) });   // the tool-less side call is not a main request
    expect(f).toMatchObject({ arm: 'C', requested: '{"type":"adaptive"}', status: 'verified', match: true, observed: ['{"type":"adaptive"}'], mainRequests: 3 });
    expect(f.verdict).toBe('thinking arm C: requested {"type":"adaptive"}, wire [{"type":"adaptive"}] on 3 main request(s): MATCH');
  });

  it('R10 LP AC3: negative control, PARITY_THINKING_C=none (requested none) with a wire that carried none => requested none, wire none, match', () => {
    const f = D.thinkingFacts({ requested: D.thinkingOf({ profile: D.roundProfile({ round: 'R10', env: { PARITY_THINKING_C: 'none' } }), runDef: { arm: 'C' } }), arm: 'C', wire: wire(body(undefined), body(undefined)) });
    expect(f).toMatchObject({ requested: 'none', observed: ['none'], status: 'verified', match: true });
    expect(f.verdict).toContain('requested none, wire [none]');
    // teeth: requested none but a main request still carried one => mismatch
    expect(D.thinkingFacts({ requested: null, arm: 'C', wire: wire(body(undefined), body(ADAPTIVE)) })).toMatchObject({ status: 'mismatch', match: false });
  });

  it('R10 LP AC3 mutant "worker definition forgotten": parent requests adaptive, worker requests carry none => MISMATCH naming both values', () => {
    const f = D.thinkingFacts({ requested: ADAPTIVE, arm: 'C', wire: wire(body(ADAPTIVE, ['task', 'r2info_get_ticket']), body(undefined, ['read', 'shell'])) });
    expect(f).toMatchObject({ status: 'mismatch', match: false, observed: ['{"type":"adaptive"}', 'none'] });
    expect(f.detail).toBe('requested thinking {"type":"adaptive"}, wire carried [{"type":"adaptive"}, none] on 2 main request(s)');
    expect(f.verdict).toMatch(/MISMATCH$/);
  });

  it('R10 LP AC3: the FULL thinking object is compared (display counts), key order does not matter, and a different type mismatches', () => {
    expect(D.thinkingFacts({ requested: { type: 'adaptive', display: 'summarized' }, arm: 'C', wire: wire(body({ display: 'summarized', type: 'adaptive' })) }).status).toBe('verified');
    expect(D.thinkingFacts({ requested: { type: 'adaptive', display: 'summarized' }, arm: 'C', wire: wire(body({ type: 'adaptive' })) }).status).toBe('mismatch');
    expect(D.thinkingFacts({ requested: ADAPTIVE, arm: 'C', wire: wire(body({ type: 'disabled' })) }).status).toBe('mismatch');
  });

  it('R10 LP AC3: capture off => unverified; no main request => unobserved; arms A and B are observed only (never a mismatch, whatever the wire carries)', () => {
    expect(D.thinkingFacts({ requested: ADAPTIVE, arm: 'C', wire: null })).toMatchObject({ status: 'unverified', match: null, observed: null });
    expect(D.thinkingFacts({ requested: ADAPTIVE, arm: 'C', wire: wire(body(ADAPTIVE, [])) })).toMatchObject({ status: 'unobserved', match: null });
    for (const arm of ['A', 'B']) {
      const f = D.thinkingFacts({ requested: undefined, arm, wire: wire(body({ type: 'adaptive', display: 'omitted' })) });
      expect(f).toMatchObject({ arm, requested: null, controlled: false, status: 'not-controlled', match: null, observed: ['{"type":"adaptive","display":"omitted"}'] });
      expect(f.verdict).toContain('(not set by the harness)');
    }
  });

  it('R10 LP AC3: wireThinkingFor reads the raw request bodies of an arm from the capture files (main = declares tools)', () => {
    const dir = mk(); const file = path.join(dir, 'proxy-C-anthropic.jsonl');
    const ev = [{ type: 'session_start', arm: 'C', provider: 'anthropic' }, { type: 'raw_request', seq: 1, body: body(ADAPTIVE) }, { type: 'raw_request', seq: 2, body: body(undefined, ['read']) }, { type: 'raw_request', seq: 3, body: body(undefined, []) }];
    fs.writeFileSync(file, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const w = WD.wireThinkingFor(WD.analyzeWire([file]), 'C');
    expect(w).toEqual({ requests: 3, mainRequests: 2, mainThinking: ['{"type":"adaptive"}', null], sideThinking: [null] });
    expect(D.thinkingFacts({ requested: ADAPTIVE, arm: 'C', wire: w }).status).toBe('mismatch');
    // wireFactsFor keeps its pinned shape (no thinking key leaked into it)
    expect(Object.keys(WD.wireFactsFor(WD.analyzeWire([file]), 'C')).sort()).toEqual(['mainEfforts', 'mainModels', 'mainRequests', 'requests', 'sideEfforts', 'sideModels']);
  });
});

describe('R10 LP AC4: the --self-check anthropic.ts guard', () => {
  const real = fs.readFileSync(path.resolve(PARITY_DIR, '..', '..', '..', 'packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts'), 'utf8');
  const pass = '...(this.providerConfig.thinking !== undefined && { thinking: this.providerConfig.thinking })';
  it('R10 LP AC4: the real provider source passes (conditional pass-through present exactly once, nothing else mentions thinking)', () => {
    expect(real).toContain(pass);
    expect(D.anthropicThinkingGuard(real)).toEqual({ ok: true, reasons: [] });
  });
  it('R10 LP AC4 mutants: unconditional key, `!== null`, `true &&`, removed pass-through, a second copy and a stray thinking token all turn the guard red', () => {
    const mutants: Record<string, string> = {
      unconditional: real.replace(pass, '...{ thinking: this.providerConfig.thinking }'),
      'not-null': real.replace(pass, '...(this.providerConfig.thinking !== null && { thinking: this.providerConfig.thinking })'),
      'true-and': real.replace(pass, '...(true && { thinking: this.providerConfig.thinking })'),
      removed: real.replace(pass, ''),
      duplicated: real.replace(pass, `${pass},\n${pass}`),
      stray: real.replace(pass, `${pass},\n thinking: { type: 'enabled' }`),
    };
    for (const [name, src] of Object.entries(mutants)) { expect(src, `${name} actually mutated`).not.toBe(real); expect(D.anthropicThinkingGuard(src).ok, name).toBe(false); }
    expect(D.anthropicThinkingGuard(mutants.removed).reasons[0]).toMatch(/exactly once, found 0/);
    expect(D.anthropicThinkingGuard(mutants['not-null']).reasons.join()).toMatch(/exactly once, found 0/);
  });
});

describe('R10 LP AC5: the ledger precondition sees the owner approval', () => {
  const APPROVAL = "I approve your next 3 experiment rounds as long as you're making serious progress";
  const stubs = { preflight: async () => ({ ok: true, legs: [] }), judgeCredential: () => ({ present: true }) };
  it('R10 LP AC5: the tracked R10 ledger records the owner message verbatim, keeps cap 2, lists both scope entries, and records the live round: A1 and C1 once each, one judge call each, a start time', () => {
    const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R10.json'), 'utf8'));
    expect(led.approvedBy).toBe(APPROVAL); expect(led.cap).toBe(2);
    expect(led.scopeChanges).toEqual(['SCOPE-R10-prep', 'SCOPE-R10-thinking-parity']);
    expect(led.runs.map((x: { runId: string }) => x.runId)).toEqual(['A1', 'C1']); expect(led.judgeCalls).toHaveLength(2); expect(typeof led.startedAt).toBe('string');
  });
  it('R10 LP AC5: checkLedgerForLive (read-only precondition, no --live) refuses R10 now that its cap of 2 is spent (a spent round cannot be launched again), and the first live gate "ledger" is red; the ledger file is not touched', async () => {
    const before = fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R10.json'), 'utf8');
    const r = LG.checkLedgerForLive('R10');
    console.log(`R10 LP AC5 precondition: ${JSON.stringify({ ok: r.ok, reasons: r.reasons, approvedBy: r.ledger.approvedBy, cap: LG.capOf(r.ledger), runs: r.ledger.runs.length })}`);
    expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/run cap 2\/2 reached/);
    const g = await D.runLiveGates({ round: 'R10' }, stubs);
    expect(g.results[0]).toMatchObject({ gate: 'ledger', ok: false });
    expect(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R10.json'), 'utf8')).toBe(before);   // read-only
  });
  it('R10 LP AC5 (pre-launch shape): the same ledger with the live round removed passes the precondition and the first live gate is green (the approval alone is sufficient)', async () => {
    const dir = mk(); const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R10.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'R10.json'), JSON.stringify({ ...led, runs: [], judgeCalls: [], armOrder: [], startedAt: null }));
    const r = LG.checkLedgerForLive('R10', dir);
    expect(r.ok).toBe(true); expect(r.reasons).toEqual([]);
    const g = await D.runLiveGates({ round: 'R10', ledgerDir: dir }, stubs);
    expect(g.results[0]).toMatchObject({ gate: 'ledger', ok: true });
  });
  it('R10 LP AC5 teeth: the same ledger with an empty approvedBy is refused by the precondition and by the live gate sequence (exit 3, failed "ledger")', async () => {
    const dir = mk(); const led = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R10.json'), 'utf8')); led.approvedBy = '';
    fs.writeFileSync(path.join(dir, 'R10.json'), JSON.stringify(led));
    const r = LG.checkLedgerForLive('R10', dir);
    expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/ledger\.approvedBy is empty/);
    const g = await D.runLiveGates({ round: 'R10', ledgerDir: dir }, stubs);
    expect(g).toMatchObject({ ok: false, exitCode: 3, failed: 'ledger' });
    expect(() => LG.reserveRun('R10', { arm: 'A', runId: 'A1', dir })).toThrow(/approvedBy is empty/);
  });
});

describe('R10 LP AC6: thinking parity is for the Anthropic-backed arm only', () => {
  it('R10 LP AC6: the README states it, and openai / deepseek are not an arm of the experiment (GROUP_PROVIDER)', () => {
    const readme = fs.readFileSync(path.join(PARITY_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/## Thinking parity \(SCOPE-R10-thinking-parity/);
    expect(readme).toMatch(/Thinking parity applies to arm C \(the agent-mcp anthropic provider\)/);
    expect(readme).toMatch(/per-group schema therefore \*\*rejects\*\* a `thinking` key on `A`, `B` and `judge`/);
    expect(readme).toMatch(/OpenAI \/ DeepSeek adapters are not arms of this experiment/);
    expect(Object.values(EX.GROUP_PROVIDER)).not.toContain('openai'); expect(Object.values(EX.GROUP_PROVIDER)).not.toContain('deepseek');
    expect(EX.THINKING_GROUPS).toEqual(['C']);
  });
});
