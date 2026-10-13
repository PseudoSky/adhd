import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * R11 design "backlog-operator" (SCOPE-R11-backlog-operator-task, owner-directed): the parity instrument's SECOND experiment design. Pure instrument tests (no model call, no subprocess,
 * no network); the real dry-run proofs against the built agent-mcp are in r11-design.e2e.test.ts. Every `R11 AC<n>` below names the acceptance criterion it proves.
 *   AC1 design selector (ledger.design), arm A refused, the A-first gate bypassed ONLY by the recorded owner waiver; rounds without the key behave as before
 *   AC2 the task prompt is the ONE exported TASK_PROMPT (SCOPE-R11-prompt-update), byte for byte; this file pins it by byte length and sha256 instead of retyping it
 *   AC3 worktree plan (paths under .worktrees/, own branch), never removed by the harness
 *   AC4 identical groups: same prompts, tools, model, effort, limits; only the provider (and each group's own worktree) differs
 *   AC5 delegation shape: performance dispatches, backlog-operator carries the backlog MCP server
 *   AC6 safety: read-only backlog reader, owned-process-only signalling, not wired into CI or any nx target
 *   AC7 record + pause: failure naming from the evidence, side-by-side analyze
 *   AC8 the correction-by-adapter table is stated (instrument-only change)
 *   AC10 the read-only review agent is registered identically in both groups (flow-stage detector AC11 and failure naming AC12 are in r11-flow.test.ts)
 */
const BO = await loadParity('backlog-operator.mjs');
const LG = await loadParity('ledger.mjs');
const GT = await loadParity('gate.mjs');
const D = await loadParity('drive.mjs');

/** The prompt text lives in ONE place (BO.TASK_PROMPT, SCOPE-R11-prompt-update). This pin (bytes + sha256 of the owner-approved text) fails if the constant drifts from what the owner approved; every byte comparison below uses the constant. */
const PROMPT_PIN = { bytes: 274, sha256: '1dc9373fab8184d75f6db4ba17a814e879f42c6e8649177261411194decd730d' };
const OWNER_APPROVAL = 'no, the experiment design I told you to use, where an agent dispatches backlog operator using agent mcp, gets a random ticket, implements it, etc. only arms b and c. those are the experiments I want you to run';

const cleanup: string[] = [];
const mk = (p = 'r11-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanup.push(d); return d; };
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });
const throws = (fn: () => unknown): string | null => { try { fn(); } catch (e) { return String((e as Error).message); } return null; };

/** Fixture roster (never ~/.claude/agents): the same front-matter shape and tool vocabulary as the shipped agent files. */
const PERFORMANCE = '---\nname: performance\ndescription: Performance agent\ntools: Read, Edit, Bash, Glob, Grep, Task, TodoWrite\nmodel: haiku\n---\n# performance\n\nYou are the performance agent. Delegate to other agents when asked.\n';
const REVIEW = '---\nname: review\ndescription: Read-only reviewer\ntools: Read, Grep, Glob\nmodel: sonnet\ndisallowedTools: Edit, Write, NotebookEdit\n---\n# review\n\nYou review a change and return findings. You never edit or run anything.\n';
const OPERATOR = '---\nname: backlog-operator\ndescription: Backlog operator\ntools: Read, Bash, AskUserQuestion, mcp__backlog__*\nmodel: haiku\ndisallowedTools: Edit, NotebookEdit\n---\n# backlog-operator\n\nYou operate the backlog graph with a fixed playbook.\n';
function roster(over: { performance?: string; operator?: string; review?: string } = {}) {
  const dir = mk('r11-roster-');
  fs.writeFileSync(path.join(dir, 'performance.md'), over.performance ?? PERFORMANCE); fs.writeFileSync(path.join(dir, 'backlog-operator.md'), over.operator ?? OPERATOR); fs.writeFileSync(path.join(dir, 'review.md'), over.review ?? REVIEW);
  return { dir, roster: BO.loadRoster({ dir }) };
}
const BL_SERVER = { transport: 'stdio', command: '/bin/adhd-backlog', args: ['serve', '--transport', 'mcp', '--allow-production-write'] };
function groupFacts(arm: 'B' | 'C', r = roster().roster, over: Record<string, unknown> = {}) {
  const provider = arm === 'B' ? { type: 'claudecli', model: 'claude-haiku-5-5' } : { type: 'anthropic', model: 'claude-haiku-5-5', effort: 'high' };
  const defs = Object.fromEntries(Object.values(r).map((a) => { const x = a as { name: string }; return [x.name, BO.agentDefinition({ agent: a, provider, backlogServer: BL_SERVER })]; }));
  return { defs, facts: BO.groupConfigFacts({ arm, defs, roster: r, model: 'claude-haiku-5-5', providerType: provider.type, effort: 'high', thinking: undefined, cwd: `/wt/r11-${arm}`, ...over }) };
}
const r11Ledger = () => JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger', 'R11.json'), 'utf8'));

describe('R11 AC1: design selector', () => {
  it('R11 AC1: ledger/R11.json declares design backlog-operator, arms B and C, cap 2, the scope id, and the owner approval verbatim', () => {
    const led = r11Ledger();
    expect(led.design).toBe('backlog-operator');
    expect(led.cap).toBe(2);
    expect(led.scopeChanges).toEqual(['SCOPE-R11-backlog-operator-task', 'SCOPE-R11-stop-condition', 'SCOPE-R11-prompt-update']);
    expect(led.scopeChanges).toEqual([...BO.SCOPE_IDS]);
    expect(led.approvedBy).toBe(OWNER_APPROVAL);
    expect(led.profile.arms).toEqual(['B', 'C']);
    expect(led.profile.armAWaiver).toContain(OWNER_APPROVAL);
    expect(LG.designOf(led)).toBe('backlog-operator');
    expect(LG.capOf(led)).toBe(2);
    expect(led.armA).toBeNull();
  });

  it('R11 AC1: rounds without the design key are not design rounds (R5-R10 untouched)', () => {
    for (const r of ['R5', 'R6', 'R7', 'R8', 'R9', 'R10']) expect(LG.designOf(LG.readLedger(r)), r).toBeNull();
    expect(D.roundProfile({ round: 'R10', env: {} }).arms).toEqual(['A', 'C']);
  });

  it('R11 AC1: roundProfile of R11 resolves arms B,C with the configured models and effort, and sends no thinking (the ledger does not list SCOPE-R10-thinking-parity)', () => {
    const p = D.roundProfile({ round: 'R11', env: {} });
    expect(p.arms).toEqual(['B', 'C']);
    expect(p.models.B).toBe(p.models.C);
    expect(p.effort).toBe('high');
    expect(p.thinking).toBeUndefined();
  });

  it('R11 AC1: design validation fails closed (negative controls: unknown design, arm A listed, no profile, no waiver)', () => {
    const led = r11Ledger();
    expect(throws(() => LG.designOf({ ...led, design: 'nope' }))).toMatch(/not a known design/);
    expect(throws(() => LG.designOf({ ...led, profile: { ...led.profile, arms: ['A', 'B', 'C'] } }))).toMatch(/arm A is refused|does not run arm A/);
    expect(throws(() => LG.designOf({ ...led, profile: undefined }))).toMatch(/needs a ledger.profile/);
    expect(throws(() => LG.designOf({ ...led, profile: { ...led.profile, armAWaiver: '  ' } }))).toMatch(/armAWaiver/);
    // R11 is spent (its live round ran: B1 and C1 are recorded, cap 2/2): the tracked ledger is no longer live-ready, and a pristine copy of its design (no runs) is
    expect(LG.checkLedgerForLive('R11')).toMatchObject({ ok: false, reasons: [expect.stringMatching(/run cap 2\/2 reached/)] });
    const fresh = mk('r11-fresh-'); fs.writeFileSync(path.join(fresh, 'R11.json'), JSON.stringify({ ...led, runs: [], armOrder: [], startedAt: null }));
    expect(LG.checkLedgerForLive('R11', fresh).ok).toBe(true);
    const dir = mk('r11-led-'); fs.writeFileSync(path.join(dir, 'R11.json'), JSON.stringify({ ...led, profile: { ...led.profile, arms: ['A', 'B', 'C'] } }));
    const live = LG.checkLedgerForLive('R11', dir);
    expect(live.ok).toBe(false);
    expect(live.reasons.join(' ')).toMatch(/arm A/);
  });

  it('R11 AC1: reserveRun refuses arm A in the design, reserves B then C without the A-first gate, and enforces the cap of 2', () => {
    const dir = mk('r11-led-'); fs.writeFileSync(path.join(dir, 'R11.json'), JSON.stringify({ ...r11Ledger(), runs: [], armOrder: [], startedAt: null }));
    expect(throws(() => LG.reserveRun('R11', { arm: 'A', runId: 'A1', dir }))).toMatch(/arm A is not run in design backlog-operator/);
    expect(LG.reserveRun('R11', { arm: 'B', runId: 'B1', dir })).toEqual({ used: 1, cap: 2 });
    expect(LG.reserveRun('R11', { arm: 'C', runId: 'C1', dir })).toEqual({ used: 2, cap: 2 });
    expect(throws(() => LG.reserveRun('R11', { arm: 'B', runId: 'B2', dir }))).toMatch(/cap reached/);
    // negative control: the same arms on a NON-design ledger without a waiver are stopped by the A-first gate (the bypass is the design + recorded waiver, not a code default)
    const legacy = mk('r11-led-'); fs.writeFileSync(path.join(legacy, 'R11.json'), JSON.stringify({ round: 'R11', cap: 3, approvedBy: 'x', runs: [], judgeCalls: [], armOrder: [], scenarioSha: '', scopeChanges: [], startedAt: null, armA: null, releases: [] }));
    expect(throws(() => LG.reserveRun('R11', { arm: 'B', runId: 'B1', dir: legacy }))).toMatch(/arm A runs first/);
  });

  it('R11 AC1: the design gate order replaces the judge credential and the web preflight; the live gates run in that order and stop at the first red one', async () => {
    expect(GT.DESIGN_GATE_ORDER).toEqual(['ledger', 'scope', 'models', 'credential', 'designPreflight']);
    const { dir: agentsDir, roster: r } = roster();
    const ledgerDir = mk('r11-led-');
    fs.writeFileSync(path.join(ledgerDir, 'R11.json'), JSON.stringify({ ...r11Ledger(), runs: [], scenarioSha: BO.scenarioShaOf({ roster: r }) }));
    const opts = { round: 'R11', ledgerDir, agentsDir, env: {}, wt: PARITY_DIR, claude: 'claude' };
    const green = await D.runDesignGates(opts, { credential: () => ({ present: true }), preflight: () => ({ ok: true, reasons: [] }) });
    expect(green.results.map((x: { gate: string }) => x.gate)).toEqual(GT.DESIGN_GATE_ORDER);
    expect(green.ok).toBe(true);
    const noCred = await D.runDesignGates(opts, { credential: () => ({ present: false }), preflight: () => { throw new Error('must not run'); } });
    expect(noCred.ok).toBe(false); expect(noCred.failed).toBe('credential');
    expect(noCred.results.map((x: { gate: string }) => x.gate)).toEqual(['ledger', 'scope', 'models', 'credential']);
    // an unreadable roster file turns the scope gate red (never a throw out of the runner)
    const noRoster = await D.runDesignGates({ ...opts, agentsDir: mk('r11-empty-') }, { credential: () => ({ present: true }), preflight: () => ({ ok: true, reasons: [] }) });
    expect(noRoster.failed).toBe('scope');
  });
});

describe('R11 AC2: verbatim prompt', () => {
  const P: string = BO.TASK_PROMPT;
  it('R11 AC2: TASK_PROMPT is the owner-approved full-flow text (pinned by bytes and sha256), has no trailing newline or period, and the original design sentence is only quoted in OWNER_DESIGN', async () => {
    const { createHash } = await import('node:crypto');
    expect(Buffer.byteLength(P, 'utf8')).toBe(PROMPT_PIN.bytes);
    expect(createHash('sha256').update(P).digest('hex')).toBe(PROMPT_PIN.sha256);
    expect(P).not.toMatch(/[\n.]$/); expect(P).toBe(P.trim());
    expect(P).not.toBe(BO.ORIGINAL_PROMPT);
    expect(P).toMatch(/dispatch a review on the code, revise it based on the review and commit, and have the same backlog operator transition the item before you return$/);
    expect(BO.OWNER_DESIGN).toContain(`"${BO.ORIGINAL_PROMPT}"`);
    expect(BO.OWNER_DESIGN).not.toContain(P);
  });

  it('R11 AC2: the task payload prompt is byte-identical to TASK_PROMPT and carries only transport fields; promptFact reports the same constant', () => {
    const p = BO.taskPayload({ sessionId: 'S1', cwd: '/w/r11-B' });
    expect(Buffer.compare(Buffer.from(p.prompt, 'utf8'), Buffer.from(P, 'utf8'))).toBe(0);
    expect(Object.keys(p).sort()).toEqual(['background', 'cwd', 'prompt', 'session_id']);
    expect(BO.assertVerbatimPayload(p)).toBe(true);
    expect(BO.promptFact()).toMatchObject({ bytes: Buffer.byteLength(P), text: P });
  });

  it('R11 AC2: negative controls - an appended sentence, a trailing period or newline, a leading space, a case change, the ORIGINAL design sentence or an extra field turns the assertion red', () => {
    const base = BO.taskPayload({ sessionId: 'S1', cwd: '/w' });
    for (const bad of [`${P}. Be careful.`, `${P} Then add tests.`, `${P}.`, `${P}\n`, ` ${P}`, P.replace('Have', 'have'), BO.ORIGINAL_PROMPT]) {
      expect(throws(() => BO.assertVerbatimPayload({ ...base, prompt: bad })), JSON.stringify(bad.slice(-40))).toMatch(/not byte-identical/);
    }
    expect(throws(() => BO.assertVerbatimPayload({ ...base, hint: 'use the backlog tools' }))).toMatch(/extra field/);
  });

  it('R11 AC2: the driver, the dry-run scripts and analyze do not retype the prompt (it is defined once)', () => {
    const head = P.slice(0, 60);
    for (const f of ['drive.mjs', 'flow-stages.mjs', 'dryrun/script-bo.mjs', 'dryrun/fake-anthropic.mjs', 'dryrun/fake-claude.mjs']) expect(fs.readFileSync(path.join(PARITY_DIR, f), 'utf8'), f).not.toContain(head);
    const own = fs.readFileSync(path.join(PARITY_DIR, 'backlog-operator.mjs'), 'utf8');
    expect(own.split(P).length - 1, 'TASK_PROMPT is spelled out exactly once in backlog-operator.mjs').toBe(1);
  });
});

describe('R11 AC3: worktree plan', () => {
  it('R11 AC3: one worktree per group under <main>/.worktrees/, on its own parity/ branch, never the repo root', () => {
    const plan = BO.worktreePlan({ round: 'R11', arms: ['B', 'C'], mainRoot: '/repo/adhd' });
    expect(plan).toEqual([
      { arm: 'B', path: '/repo/adhd/.worktrees/r11-B', branch: 'parity/r11-B' },
      { arm: 'C', path: '/repo/adhd/.worktrees/r11-C', branch: 'parity/r11-C' },
    ]);
    for (const w of plan) { expect(w.path).not.toBe('/repo/adhd'); expect(w.path.startsWith('/repo/adhd/.worktrees/')).toBe(true); expect(w.branch).not.toMatch(/^(main|master)$/); }
  });

  it('R11 AC3: the module never removes a worktree or a branch (static check)', () => {
    const src = fs.readFileSync(path.join(PARITY_DIR, 'backlog-operator.mjs'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [/worktree['", ]+remove/, /worktree['", ]+prune/, /branch['", ]+-[dD]\b/, /\brmSync\b/, /\bunlinkSync\b/, /\brmdirSync\b/, /\brm\s+-/, /['"]checkout['"]/, /reset['", ]+--hard/, /git['", ]+stash/, /git['", ]+clean/]) expect(src, String(forbidden)).not.toMatch(forbidden);
  });
});

describe('R11 AC4: identical groups', () => {
  it('R11 AC4: B and C carry the same system prompt shas, tool lists, model, effort and limits; only the provider (and cwd) differ', () => {
    const r = roster().roster;
    const b = groupFacts('B', r).facts; const c = groupFacts('C', r).facts;
    expect(b.systemPromptSha256).toEqual(c.systemPromptSha256);
    expect(b.tools).toEqual(c.tools);
    expect(b.tools.performance).toEqual(['dispatch', 'fs', 'shell']);
    expect(b.tools['backlog-operator']).toEqual(['fs:readOnly', 'mcp:backlog', 'shell']);
    expect(b.tools.review).toEqual(['fs:readOnly']);
    expect(b.model).toBe(c.model); expect(b.effort).toBe(c.effort); expect(b.limits).toEqual(c.limits);
    expect(b.provider).toBe('claudecli'); expect(c.provider).toBe('anthropic'); expect(b.cwd).not.toBe(c.cwd);
    expect(BO.identicalGroupsCheck(b, c)).toEqual({ ok: true, reasons: [] });
    // the system prompt IS the roster body, verbatim
    expect(b.systemPromptSha256.performance).toBe(r.performance.bodySha256);
    expect(b.systemPromptSha256['backlog-operator']).toBe(r['backlog-operator'].bodySha256);
    expect(b.systemPromptSha256.review).toBe(r.review.bodySha256);
  });

  it('R11 AC4: negative controls - a different tool list, prompt, model, effort, limit, a shared provider or a shared cwd turns the check red', () => {
    const b = groupFacts('B').facts;
    const other = roster({ operator: OPERATOR.replace('tools: Read, Bash,', 'tools: Read,') }).roster;
    expect(BO.identicalGroupsCheck(b, groupFacts('C', other).facts).reasons.join(' ')).toMatch(/tools differs/);
    const reviewWrites = roster({ review: REVIEW.replace('tools: Read, Grep, Glob', 'tools: Read, Grep, Glob, Edit').replace('disallowedTools: Edit, Write, NotebookEdit', 'disallowedTools: NotebookEdit') }).roster;
    expect(BO.identicalGroupsCheck(b, groupFacts('C', reviewWrites).facts).reasons.join(' ')).toMatch(/tools differs/);   // R11 AC10: a review agent that gained a write tool is not the registered read-only reviewer
    const otherPrompt = roster({ performance: PERFORMANCE.replace('Delegate', 'Never delegate') }).roster;
    expect(BO.identicalGroupsCheck(b, groupFacts('C', otherPrompt).facts).reasons.join(' ')).toMatch(/systemPromptSha256 differs/);
    const c = groupFacts('C').facts;
    expect(BO.identicalGroupsCheck(b, { ...c, model: 'claude-haiku-4-5' }).reasons.join(' ')).toMatch(/model differs/);
    expect(BO.identicalGroupsCheck(b, { ...c, effort: 'low' }).reasons.join(' ')).toMatch(/effort differs/);
    expect(BO.identicalGroupsCheck(b, { ...c, limits: { ...c.limits, maxToolLoops: 1 } }).reasons.join(' ')).toMatch(/limits differs/);
    expect(BO.identicalGroupsCheck(b, { ...c, provider: 'claudecli' }).reasons.join(' ')).toMatch(/differ in the provider/);
    expect(BO.identicalGroupsCheck(b, { ...c, cwd: b.cwd }).reasons.join(' ')).toMatch(/share one cwd/);
  });

  it('R11 AC4: the roster parser keeps the body bytes untouched and refuses files without front matter, a name mismatch or an empty body', () => {
    const a = BO.parseAgentFile(PERFORMANCE);
    expect(a.body).toBe('# performance\n\nYou are the performance agent. Delegate to other agents when asked.\n');
    expect(a.tools).toEqual(['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'TodoWrite']);
    expect(throws(() => BO.parseAgentFile('no front matter'))).toMatch(/no YAML front matter/);
    expect(throws(() => BO.parseAgentFile('---\nname: x\n---\n   \n'))).toMatch(/empty body/);
    const dir = mk('r11-roster-'); fs.writeFileSync(path.join(dir, 'performance.md'), OPERATOR); fs.writeFileSync(path.join(dir, 'backlog-operator.md'), OPERATOR); fs.writeFileSync(path.join(dir, 'review.md'), REVIEW);
    expect(throws(() => BO.loadRoster({ dir }))).toMatch(/is not "performance"/);
    expect(throws(() => BO.loadRoster({ dir: mk('r11-empty-') }))).toMatch(/not readable/);
  });
});

describe('R11 AC5: delegation shape', () => {
  it('R11 AC5: performance gets the dispatch tools and no MCP server; backlog-operator carries the backlog stdio MCP server, a write-gated fs and no dispatch', () => {
    const { defs } = groupFacts('C');
    expect(defs.performance.nativeTooling).toEqual({ fs: true, shell: true, dispatch: true });
    expect(defs.performance.mcpServers).toBeUndefined();
    expect(defs['backlog-operator'].mcpServers).toEqual({ backlog: BL_SERVER });
    // the product treats an ABSENT native member as enabled and ignores fs.readOnly (reserved): read-only and no-dispatch are expressed as explicit gates / false
    expect(defs['backlog-operator'].nativeTooling).toEqual({ fs: { disallowedTools: [...BO.FS_WRITE_TOOLS] }, shell: true, dispatch: false });
    for (const d of Object.values(defs) as Array<{ nativeWebTools: boolean; nativeTooling: Record<string, unknown> }>) { expect(d.nativeWebTools).toBe(false); expect(JSON.stringify(d.nativeTooling)).not.toContain('readOnly'); }
    expect(defs.performance.maxToolLoops).toBe(BO.LIMITS.maxToolLoops);
  });

  it('R11 AC5: negative controls - a roster operator without mcp__backlog__* gets no backlog server; one that names it with no server config is refused', () => {
    const noBacklog = roster({ operator: OPERATOR.replace(', mcp__backlog__*', '') }).roster;
    const d = BO.agentDefinition({ agent: noBacklog['backlog-operator'], provider: { type: 'anthropic', model: 'm' }, backlogServer: BL_SERVER });
    expect(d.mcpServers).toBeUndefined();
    expect(throws(() => BO.agentDefinition({ agent: roster().roster['backlog-operator'], provider: { type: 'anthropic', model: 'm' } }))).toMatch(/no backlog MCP server config/);
  });

  it('R11 AC5: roster tools with no agent-mcp equivalent are listed as unmapped, never dropped silently', () => {
    const s = BO.toolSurface(BO.parseAgentFile(PERFORMANCE));
    expect(s.unmapped).toEqual([{ tool: 'TodoWrite', why: 'no agent-mcp equivalent in this design' }]);
    expect(BO.toolSurface(BO.parseAgentFile(OPERATOR)).unmapped.map((u: { tool: string }) => u.tool)).toEqual(['AskUserQuestion']);
  });

  it('R11 AC5: the live backlog server config is the installed binary with the owner .mcp.json flags and no env key; the dry config points at the fake', () => {
    const bin = { path: '/usr/local/bin/adhd-backlog', realpath: '/x/index.js', version: '1.0.16' };
    expect(BO.backlogServerConfig({ binary: bin })).toEqual({ transport: 'stdio', command: '/usr/local/bin/adhd-backlog', args: ['serve', '--transport', 'mcp', '--allow-production-write'] });
    expect(throws(() => BO.backlogServerConfig({ binary: null }))).toMatch(/not on PATH/);
    const dry = BO.backlogServerConfig({ dry: true, fakeItems: '/i.json', fakeLog: '/l.log' });
    expect(dry.args[0]).toMatch(/fake-backlog-server\.mjs$/); expect(dry.env).toEqual({ R2_BACKLOG_ITEMS: '/i.json', R2_BACKLOG_LOG: '/l.log' });
  });

  it('R11 AC5: the git write set that lets a linked-worktree commit work is narrow, group-specific and carried by the server env', () => {
    const set = BO.gitWriteSet({ mainRoot: '/repo/adhd', wtName: 'r11-B' });
    expect(set.root).toBe('/repo/adhd/.git');
    expect(set.entries).toEqual(['/repo/adhd/.git/worktrees/r11-B', '/repo/adhd/.git/objects', '/repo/adhd/.git/refs/heads/parity', '/repo/adhd/.git/logs/refs/heads/parity', '/repo/adhd/.git/packed-refs', '/repo/adhd/.git/packed-refs.lock']);
    const env = BO.sandboxWriteEnv(set);
    expect(env.ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE_ROOTS).toBe('/repo/adhd/.git');
    expect(env.ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE.split(',')[0]).toBe('~/.adhd/backlog/production/data');
    expect(env.ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE).not.toContain('/repo/adhd/.git,');
    expect(throws(() => BO.sandboxWriteEnv({ root: '/a,b/.git', entries: [] }))).toMatch(/comma/);
    // the server env of a design run carries it; a composite run's does not
    expect(D.serverEnv({ runDef: { arm: 'C' }, dry: false, profile: {}, spec: { runId: 'C1' }, runDir: '/r', repoDir: '/w', sandboxEnv: env }, '/s', '/l')).toMatchObject(env);
    expect(D.serverEnv({ runDef: { arm: 'C' }, dry: false, profile: {}, spec: { runId: 'C1' }, runDir: '/r', repoDir: '/w' }, '/s', '/l')).not.toHaveProperty('ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE');
  });
});

const READY_PAGE = (items: unknown[], more: boolean, total: number) => ({ ok: true, data: { view: 'ready', items }, meta: { total, returned: items.length, limit: 2, total_relation: 'gte', has_more: more } });
describe('R11 AC6: safety', () => {
  it('R11 AC6: the backlog reader refuses every write verb whatever runner stands behind it, and allows the read verbs', async () => {
    let calls = 0; const reader = BO.makeBacklogReader(async () => { calls += 1; return { ok: true }; });
    for (const v of ['create', 'update', 'transition', 'claim', 'delete', 'attest', 'relate', 'restore', 'remove']) expect(await reader.call(v, {}).then(() => 'ran', (e: Error) => e.message), v).toMatch(/read-only: refused verb/);
    expect(calls).toBe(0);
    for (const v of BO.READ_ONLY_VERBS) expect((await reader.call(v, {})).ok).toBe(true);
  });

  it('R11 AC6: the CLI runner passes exactly <verb> --input <json> and never --allow-production-write; it parses the single-line envelope', async () => {
    const seen: string[][] = [];
    const run = BO.cliBacklogRunner({ binary: '/bin/adhd-backlog', spawn: (_b: string, argv: string[]) => { seen.push(argv); return { status: 0, stdout: `${JSON.stringify(READY_PAGE([], false, 0))}\n`, stderr: '{"level":30}' }; } });
    expect((await run('query', { view: 'ready' })).ok).toBe(true);
    expect(seen[0]).toEqual(['query', '--input', '{"view":"ready"}']);
    expect(seen.flat()).not.toContain('--allow-production-write');
    const bad = BO.cliBacklogRunner({ binary: '/bin/x', spawn: () => ({ status: 1, stdout: 'boom', stderr: 'denied' }) });
    expect(await bad('query', {})).toMatchObject({ ok: false, error: { code: 'no_envelope' } });
  });

  it('R11 AC6: snapshotBefore pages the ready view with offset until has_more is false and records status counts; snapshotAfter reads the picked item through get', async () => {
    const pages = [READY_PAGE([{ uid: 'a', title: 'A', status: 'open' }, { uid: 'b', title: 'B', status: 'PARTIAL' }], true, 3), READY_PAGE([{ uid: 'c', title: 'C', status: 'open' }], false, 3)];
    const seen: unknown[] = []; const reader = BO.makeBacklogReader(async (_v: string, input: { offset: number }) => { seen.push(input.offset); return pages[input.offset / 2]; });
    const snap = await BO.snapshotBefore(reader, { pageSize: 2 });
    expect(seen).toEqual([0, 2]); expect(snap.ready.map((i: { uid: string }) => i.uid)).toEqual(['a', 'b', 'c']); expect(snap.complete).toBe(true); expect(snap.statusCounts).toEqual({ open: 2, PARTIAL: 1 });
    const capped = await BO.snapshotBefore(BO.makeBacklogReader(async () => READY_PAGE([{ uid: 'x', title: 'X', status: 'open' }], true, 99)), { pageSize: 1, maxPages: 3 });
    expect(capped.complete).toBe(false); expect(capped.ready).toHaveLength(3);
    const failed = await BO.snapshotBefore(BO.makeBacklogReader(async () => ({ ok: false, error: { code: 'x', message: 'down' } })));
    expect(failed).toMatchObject({ complete: false, error: 'x: down' });
    const after = await BO.snapshotAfter(BO.makeBacklogReader(async (_v: string, i: { uid: string }) => ({ ok: true, data: { uid: i.uid, title: 'A', status: 'DONE', updatedAt: 't', auditTrail: [1, 2, 3, 4, 5, 6, 7] } })), ['a']);
    expect(after.items[0]).toMatchObject({ uid: 'a', status: 'DONE' }); expect(after.items[0].auditTail).toHaveLength(5);
  });

  it('R11 AC6: the picked item comes from the backlog-operator\'s own successful tool calls (envelope-tolerant); the transition fact compares the before view with the after read', () => {
    const calls = [
      { name: 'mcp__backlog__backlog_query', input: { data: { input: { view: 'ready' } } } },
      { name: 'mcp__backlog__backlog_claim', input: { data: { input: { uid: 'u1', action: 'claim' } } } },
      { name: 'mcp__backlog__backlog_transition', input: { data: { input: { uid: 'u1', toStatus: 'DONE' } } }, isError: false },
      { name: 'backlog__backlog_transition', input: { input: { uid: 'u2', toStatus: 'DONE' } }, isError: true },
    ];
    const pick = BO.pickedFromCalls(calls);
    expect(pick.picked).toBe('u1'); expect(pick.distinctUids).toEqual(['u1', 'u2']); expect(pick.otherBacklogCalls).toBe(1);
    expect(BO.pickedFromCalls([{ name: 'shell', input: {} }]).picked).toBeNull();
    const fact = BO.transitionFact({ before: { ready: [{ uid: 'u1', status: 'open', title: 'T' }], complete: true }, after: { items: [{ uid: 'u1', status: 'DONE', title: 'T', auditTail: [] }] }, picked: 'u1', transitions: pick.transitions });
    expect(fact).toMatchObject({ picked: 'u1', wasInReadyViewBefore: true, statusBefore: 'open', statusAfter: 'DONE', requestedStatus: 'DONE', transitioned: true });
    expect(BO.transitionFact({ before: { ready: [], complete: false }, after: { items: [] }, picked: null, transitions: [] }).picked).toBeNull();
  });

  it('R11 AC6: the module signals no process itself (static) and reaches the owned-process sweep through the host', () => {
    const src = fs.readFileSync(path.join(PARITY_DIR, 'backlog-operator.mjs'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [/process\.kill/, /\bpkill\b/, /\bkillall\b/, /\.kill\(/, /killOwnedGroup/, /sweepPids/]) expect(src, String(forbidden)).not.toMatch(forbidden);
    expect(src).toMatch(/host\.sweepOwned\(/);
    expect(typeof D.designHost.sweepOwned).toBe('function');
  });

  it('R11 AC6: nothing in CI or any nx target runs the design (no workflow, project.json, nx.json or package.json script mentions it)', () => {
    const repo = path.resolve(PARITY_DIR, '..', '..', '..');
    const files: string[] = [];
    const add = (p: string) => { if (fs.existsSync(p)) files.push(p); };
    add(path.join(repo, 'nx.json')); add(path.join(repo, 'package.json')); add(path.join(repo, 'entrypoint', 'agent-mcp', 'project.json')); add(path.join(repo, 'entrypoint', 'agent-mcp', 'package.json'));
    for (const dir of [path.join(repo, '.github', 'workflows'), path.join(repo, '.githooks')]) if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { const full = path.join(dir, f); if (fs.statSync(full).isFile() && (/\.(ya?ml|js|mjs|sh)$/.test(f) || !f.includes('.'))) add(full); }
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/parity\/drive/);
      expect(t, f).not.toMatch(/backlog-operator\.mjs/);
      expect(t, f).not.toMatch(/--round R11/);
    }
  });

  it('R11 AC6: the paid path is documented with its owner in the README, AGENTS.md and the code header', () => {
    const readme = fs.readFileSync(path.join(PARITY_DIR, 'README.md'), 'utf8');
    const agents = fs.readFileSync(path.join(PARITY_DIR, '..', 'AGENTS.md'), 'utf8');
    const header = fs.readFileSync(path.join(PARITY_DIR, 'backlog-operator.mjs'), 'utf8').slice(0, 4000);
    for (const [name, t] of [['README', readme], ['AGENTS', agents], ['header', header]] as const) { expect(t, name).toMatch(/nix \(repo owner\)/); expect(t, name).toMatch(/--live --yes/); }
  });
});

describe('R11 AC7: record, failure naming and analyze', () => {
  const base = { submit: { taskId: 't-1' }, final: { status: 'completed' }, tasks: [{ id: 't-1', agent: 'performance', status: 'completed', depth: 0 }, { id: 't-2', agent: 'backlog-operator', status: 'completed', depth: 1 }], dispatched: true, backlogCalls: 3, transitions: [{ uid: 'u', isError: false }], commits: 1 };

  it('R11 AC7: a completed run that did the whole job has no failing step and no gaps', () => {
    expect(BO.explainFailure(base)).toEqual({ failedStep: null, detail: null, evidence: [], gaps: [] });
  });

  it('R11 AC7: a completed run that skipped parts of the job lists each gap (no dispatch, no backlog call, no transition, no commit)', () => {
    expect(BO.explainFailure({ ...base, dispatched: false, backlogCalls: 0, transitions: [], commits: 0 }).gaps).toEqual([
      'performance did not dispatch backlog-operator through agent-mcp (no child task)', 'no commit was made in the group worktree']);
    expect(BO.explainFailure({ ...base, backlogCalls: 0 }).gaps).toContain('backlog-operator made no backlog tool call');
    expect(BO.explainFailure({ ...base, transitions: [] }).gaps).toContain('no backlog_transition call was made');
    expect(BO.explainFailure({ ...base, transitions: [{ uid: 'u', isError: true }] }).gaps).toContain('every backlog_transition call returned an error');
  });

  it('R11 AC7: a failure names the step - harness fault, task submit, a failed child task with its tool error and the HTTP status on the wire, a timeout', () => {
    expect(BO.explainFailure({ harnessFailure: 'Error: agent_create failed' })).toMatchObject({ failedStep: 'harness', detail: 'Error: agent_create failed' });
    expect(BO.explainFailure({ submit: { taskId: null, text: 'session not found' } })).toMatchObject({ failedStep: 'task-submit', detail: 'session not found' });
    const f = BO.explainFailure({ ...base, final: { status: 'failed', error: 'child failed' }, tasks: [{ id: 't-1', agent: 'performance', status: 'failed', depth: 0, createdAt: '1' }, { id: 't-2', agent: 'backlog-operator', status: 'failed', depth: 1, createdAt: '2', error: 'mcp backlog: connection refused' }],
      toolErrors: [{ task: 't-2', name: 'mcp__backlog__backlog_query', text: 'connection refused' }], wireErrors: [{ seq: 7, status: 429, task: 't-2' }] });
    expect(f.failedStep).toMatch(/task backlog-operator \(t-2\) ended failed/);
    expect(f.detail).toMatch(/connection refused/);
    expect(f.evidence.join(' | ')).toMatch(/last tool error \(trace\): mcp__backlog__backlog_query/);
    expect(f.evidence.join(' | ')).toMatch(/request #7 answered HTTP 429/);
    expect(BO.explainFailure({ ...base, final: { status: 'running' }, timedOut: true }).failedStep).toMatch(/deadline: the performance task had not finished/);
  });

  it('R11 AC7: the run ends with the pause line and the group line carries wall, cost, picked item, status transition and commits', () => {
    expect(BO.PAUSE_LINE).toBe('PAUSED: awaiting owner instruction');
    const rec = { runId: 'B1', config: { provider: 'claudecli', model: 'm' }, result: { status: 'completed' }, wall: { gradedMs: 12_345 }, totals: { costUsd: 0.0123, toolCalls: 9 }, backlog: { item: { picked: 'u1', statusBefore: 'open', statusAfter: 'DONE' } }, worktree: { commits: [{ sha: 'abc' }] }, failure: { failedStep: null, gaps: [] } };
    expect(BO.groupLine(rec)).toBe('B1 (claudecli m): completed | wall 12.3s | cost $0.0123 | picked u1 (open -> DONE) | commits 1');
  });

  it('R11 AC7: analyze prints the per-group facts side by side for every section, refuses an unknown section, and reports a missing run', () => {
    const mkRec = (arm: string, prov: string) => ({ runId: `${arm}1`, arm, submitted: BO.taskPayload({ sessionId: 's', cwd: '/w' }), prompt: BO.promptFact(), config: { provider: prov, model: 'm', effort: 'high', cwd: `/wt/${arm}`, systemPromptSha256: { performance: 'a'.repeat(64), 'backlog-operator': 'b'.repeat(64) }, tools: { performance: ['dispatch'], 'backlog-operator': ['mcp:backlog'] }, limits: {} },
      result: { status: 'completed', finalText: `done by ${arm}` }, dispatch: { viaAgentMcp: true }, wall: { gradedMs: 1000, observedMs: 1010, bootMs: 5 }, totals: { tasks: 2, turns: 4, costUsd: 0.01 }, usage: { repoEstimateUsd: 0.02 }, agents: [{ agent: 'performance', turns: 1, costUsd: 0.001, toolCounts: { byName: { task: 1 } } }],
      observedTools: { performance: ['task'] }, worktree: { path: `/wt/${arm}`, branch: `parity/r11-${arm}`, baseSha: 'base', commits: [{ sha: 'deadbeefcafe1234' }], uncommitted: [], nodeModulesPresent: false, hooksPath: '.githooks' },
      backlog: { before: { readyTotal: 5 }, item: { picked: 'u-1', wasInReadyViewBefore: true, statusBefore: 'open', statusAfter: 'DONE', transitioned: true } }, failure: { failedStep: null, detail: null, gaps: [], evidence: [] } });
    const out = BO.formatSideBySide([mkRec('B', 'claudecli'), mkRec('C', 'anthropic')], 'all');
    for (const s of BO.SECTIONS) { const one = BO.formatSideBySide([mkRec('B', 'claudecli'), mkRec('C', 'anthropic')], s); expect(one, s).toMatch(/^== .* \(B1 \| C1\) ==/m); }
    expect(BO.SECTIONS).toEqual(['prompt', 'config', 'result', 'timing', 'usage', 'tools', 'worktree', 'backlog', 'flow', 'failure']);
    expect(out).toMatch(/provider \| claudecli \| anthropic/); expect(out).toMatch(/picked item uid \| u-1 \| u-1/); expect(out).toMatch(/submitted prompt byte-identical to TASK_PROMPT \| true \| true/);
    const dir = mk('r11-an-'); const runs = path.join(dir, 'runs');
    for (const [id, arm, prov] of [['B1', 'B', 'claudecli'], ['C1', 'C', 'anthropic']]) { fs.mkdirSync(path.join(runs, id), { recursive: true }); fs.writeFileSync(path.join(runs, id, 'record.json'), JSON.stringify(mkRec(arm, prov))); }
    const cli = BO.analyzeDesignCli(['R11', 'B1', 'C1', '--section', 'backlog', '--out', dir], { tmpRoot: () => '/nope' });
    expect(cli.code).toBe(0); expect(cli.out).toMatch(/== BACKLOG \(B1 \| C1\) ==/); expect(cli.out).not.toMatch(/== PROMPT/);
    expect(BO.analyzeDesignCli(['R11', 'B1', 'C1', '--section', 'bogus', '--out', dir], { tmpRoot: () => '/nope' }).code).toBe(2);
    expect(BO.analyzeDesignCli(['R11', 'B1', 'Z9', '--out', dir], { tmpRoot: () => '/nope' })).toMatchObject({ code: 1 });
  });
});

describe('R11 AC8: correction-by-adapter table', () => {
  it('R11 AC8: the README states the adapter table (anthropic, openai/deepseek, claudecli) and that this is an instrument change with no product code change', () => {
    const readme = fs.readFileSync(path.join(PARITY_DIR, 'README.md'), 'utf8');
    const at = readme.indexOf('R11 adapter table');
    expect(at).toBeGreaterThan(-1);
    const section = readme.slice(at, at + 3000);
    for (const adapter of ['anthropic', 'openai/deepseek', 'claudecli']) expect(section, adapter).toContain(adapter);
    expect(section).toMatch(/no product code (was )?changed/i);
  });
});

describe('R11 AC10: the read-only review agent', () => {
  it('R11 AC10: review is part of the roster, loaded from review.md, and registered with the roster body as its system prompt in BOTH groups', () => {
    expect(BO.ROSTER_NAMES).toEqual(['performance', 'backlog-operator', 'review']);
    const r = roster().roster;
    expect(Object.keys(r)).toEqual(['performance', 'backlog-operator', 'review']);
    const b = groupFacts('B', r); const c = groupFacts('C', r);
    for (const g of [b, c]) { expect(Object.keys(g.defs)).toEqual(['performance', 'backlog-operator', 'review']); expect(g.defs.review.systemPrompt).toBe(r.review.body); }
    expect(b.facts.systemPromptSha256.review).toBe(c.facts.systemPromptSha256.review);
    expect(b.facts.systemPromptSha256.review).toBe(r.review.bodySha256);
    expect(b.facts.tools.review).toEqual(c.facts.tools.review);
    expect(BO.identicalGroupsCheck(b.facts, c.facts)).toEqual({ ok: true, reasons: [] });
    expect(throws(() => BO.loadRoster({ dir: mk('r11-roster-') }))).toMatch(/performance\.md/);
    const noReview = mk('r11-roster-'); fs.writeFileSync(path.join(noReview, 'performance.md'), PERFORMANCE); fs.writeFileSync(path.join(noReview, 'backlog-operator.md'), OPERATOR);
    expect(throws(() => BO.loadRoster({ dir: noReview }))).toMatch(/review\.md is not readable/);   // negative control: a roster without the review file is refused, not silently run without a reviewer
  });

  it('R11 AC10: review is read-only as the PRODUCT enforces it: write tools gated off, no shell, no dispatch, no web (an absent native member would be enabled by default)', () => {
    const { defs } = groupFacts('C');
    expect(defs.review.nativeTooling).toEqual({ fs: { disallowedTools: ['write_file', 'edit_file', 'create_directory', 'move_file'] }, shell: false, dispatch: false });
    expect(defs.review.nativeWebTools).toBe(false);
    expect(defs.review.mcpServers).toBeUndefined();
    expect(BO.configuredTools(defs.review)).toEqual(['fs:readOnly']);
    // negative control: the same agent file WITH Edit becomes a writer, and the surface says so
    const writer = BO.toolSurface(BO.parseAgentFile(REVIEW.replace('tools: Read, Grep, Glob', 'tools: Read, Grep, Glob, Edit').replace('disallowedTools: Edit, Write, NotebookEdit', 'disallowedTools: NotebookEdit')));
    expect(writer.nativeTooling.fs).toBe(true);
  });

  it('R11 AC10: the scenario sha covers the review agent (changing the reviewer prompt changes it), so the scope gate sees a reviewer change', () => {
    const base = BO.scenarioShaOf({ roster: roster().roster });
    expect(BO.scenarioShaOf({ roster: roster({ review: REVIEW.replace('never edit', 'always edit') }).roster })).not.toBe(base);
    expect(BO.scenarioShaOf({ roster: roster().roster })).toBe(base);
  });
});
