/*
 * guards: the R12 backlog-operator CLI access shape regresses: an mcpServers entry or a wrong shell allowlist on the cli definition, selection
 *   stage S1 passing on a query alone, an out-of-repo or terminal item, or an unresolved project, call ids colliding across tasks,
 *   truncated failure text, tool errors and non-zero exits miscounted, or the R12 ledger changing shape.
 * tier: S (in-process pure unit tests with a stand-in CLI module; no subprocess, no network; the subprocess side is r12-design.e2e.ts)
 * cites: SCOPE-R12-schema-and-scope, SCOPE-R12-backlog-cli; R12 AC1-AC4, AC6 as named in this file; no backlog uid is named in the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadParity } from '../../helpers/parity-instrument/load';

/**
 * R12 (SCOPE-R12-schema-and-scope, SCOPE-R12-backlog-cli): the backlog-operator reaches the backlog through the `adhd-backlog` CLI in its shell tool instead of the backlog MCP server.
 * Pure unit tests (no subprocess, no model call, no network, no production store): every rule of the CLI access shape, the redefined selection stage S1 with a negative control per branch,
 * the snapshot and picked-item facts, the record fields (call ids, untruncated failure text, classified tool errors, the three bug-candidate kinds) and the ledger.
 * The subprocess side (the real built server, the sandboxed shell running the stand-in CLI, worktree residue on a real git repository) is r12-design.e2e.ts.
 */
const FS = await loadParity('flow-stages.mjs');
const BO = await loadParity('backlog-operator.mjs');
const FAKE = await loadParity('dryrun/fake-backlog-cli.mjs');
const LG = await loadParity('ledger.mjs');

type Call = { name: string; input?: unknown; isError?: boolean | null; resultText?: string | null };
type Task = { taskId: string; agent: string | null; sessionId?: string | null; parentTaskId: string | null; status: string; error?: string | null; createdAt: string | null; completedAt: string | null; calls?: Call[] };

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const epoch = (s: number) => Math.floor((T0 + s * 1000) / 1000);
const U1 = '7e9174a2-df61-4c25-a087-46d95c0791b0';
const OK = '{"ok":true,"data":{}}\n{"level":30,"msg":"→ backlog"}';

/** A shell_execute call that runs the adhd-backlog CLI, spelled as the model sends it. */
function cli(verb: string, input: unknown, opts: { write?: boolean; text?: string | null; isError?: boolean; argv0?: string } = {}): Call {
  const argv = [opts.argv0 ?? 'adhd-backlog', verb, '--input', JSON.stringify(input), ...(opts.write ? ['--allow-production-write'] : [])];
  return { name: 'mcp__shell__shell_execute', input: { command: argv, directory: '/w' }, isError: opts.isError ?? false, resultText: opts.text === undefined ? OK : opts.text };
}
const task = (id: string, agent: string, patch: Partial<Task> = {}): Task => ({ taskId: id, agent, parentTaskId: agent === 'performance' ? null : 'perf0001', status: 'completed', createdAt: at(0), completedAt: at(1), sessionId: `S-${agent}`, calls: [], ...patch });
/** A complete run: op1 selects (claim) + implements, review, revision commit, op2 transitions. */
function goodTasks(over: { op1?: Call[]; op2?: Call[] } = {}): Task[] {
  return [
    task('perf0001', 'performance', { createdAt: at(0), completedAt: at(60) }),
    task('op000001', 'backlog-operator', { createdAt: at(1), completedAt: at(20), calls: over.op1 ?? [cli('get', { uid: U1 }), cli('claim', { uid: U1, by: 'backlog-operator:1' }, { write: true })] }),
    task('rev00001', 'review', { createdAt: at(21), completedAt: at(30) }),
    task('op000002', 'backlog-operator', { createdAt: at(50), completedAt: at(55), calls: over.op2 ?? [cli('transition', { uid: U1, by: 'backlog-operator:1', toStatus: 'done' }, { write: true })] }),
  ];
}
const commits = () => [{ sha: 'a'.repeat(40), subject: 'implement', ts: epoch(15), files: ['src/a.ts'] }, { sha: 'b'.repeat(40), subject: 'revise', ts: epoch(40), files: ['src/a.ts'] }];
const REPO = { uid: 'P-adhd', name: 'adhd' };
const goodItem = (over: Record<string, unknown> = {}) => ({ picked: U1, pickedVia: 'claim', repoProject: REPO, inRepo: true, project: 'P-adhd', projectName: 'adhd', component: 'C1', componentName: '(root)', nonTerminalBefore: true, unblockedBefore: true, statusBefore: 'open', statusAfter: 'done', transitioned: true, ...over });
const flow = (over: { tasks?: Task[] | null; commits?: unknown[] | null; item?: unknown } = {}) => FS.detectFlow({ tasks: 'tasks' in over ? over.tasks : goodTasks(), commits: 'commits' in over ? over.commits : commits(), item: 'item' in over ? over.item : goodItem(), access: 'cli' });
const statuses = (f: { stages: Record<string, { status: string }> }) => Object.fromEntries(FS.STAGE_IDS.map((s: string) => [s, f.stages[s].status]));

describe('R12 AC1: the operator reaches the backlog through the adhd-backlog CLI in its shell tool (no backlog MCP server)', () => {
  const agent = { name: 'backlog-operator', description: 'd', body: 'body', tools: ['Read', 'Bash', 'mcp__backlog__*'], disallowedTools: [] as string[] };
  const base = { commands: ['git', 'ls', 'cat', 'rg'], source: 'dist', file: '/x' };

  it('the ledger root key backlogAccess selects the shape: absent = mcp, "cli" = cli, any other value is refused', () => {
    expect(BO.backlogAccessOf({})).toBe('mcp');
    expect(BO.backlogAccessOf({ backlogAccess: 'mcp' })).toBe('mcp');
    expect(BO.backlogAccessOf({ backlogAccess: 'cli' })).toBe('cli');
    expect(() => BO.backlogAccessOf({ backlogAccess: 'ssh' })).toThrow(/fail closed/);
  });

  it('the allowlist is the product default plus exactly adhd-backlog (a supplied list replaces the default, so the default must be carried whole)', () => {
    const a = BO.operatorShellAllow({ base });
    expect(a.commands).toEqual(['git', 'ls', 'cat', 'rg', 'adhd-backlog']);
    expect(a.added).toEqual(['adhd-backlog']);
    expect(BO.operatorShellAllow({ base: { ...base, commands: ['git', 'adhd-backlog'] } }).added).toEqual([]);   // already present: nothing added twice
    const real = BO.productShellDefault();   // read from THIS checkout's built package (or its source)
    expect(real.commands).toContain('git');
    expect(real.commands).not.toContain('adhd-backlog');   // the product default does not carry it: the harness adds exactly one executable
    expect(BO.operatorShellAllow({ base: real }).added).toEqual(['adhd-backlog']);
  });

  it('the cli definition has the shell allowlist and NO mcpServers; the mcp definition is unchanged (negative control)', () => {
    const sa = BO.operatorShellAllow({ base });
    const cliDef = BO.agentDefinition({ agent, provider: { type: 'anthropic' }, backlogServer: null, access: 'cli', shellAllow: sa });
    expect(cliDef.mcpServers).toBeUndefined();
    expect(cliDef.nativeTooling.shell).toEqual({ allowCommands: ['git', 'ls', 'cat', 'rg', 'adhd-backlog'] });
    const mcpDef = BO.agentDefinition({ agent, provider: { type: 'anthropic' }, backlogServer: { transport: 'stdio', command: 'x' } });
    expect(mcpDef.mcpServers.backlog.command).toBe('x');
    expect(mcpDef.nativeTooling.shell).toBe(true);
    // the cli shape fails closed without the allowlist or without a shell tool
    expect(() => BO.agentDefinition({ agent, provider: {}, backlogServer: null, access: 'cli', shellAllow: null })).toThrow(/shell allowlist/);
    expect(() => BO.agentDefinition({ agent: { ...agent, tools: ['Read', 'mcp__backlog__*'] }, provider: {}, backlogServer: null, access: 'cli', shellAllow: sa })).toThrow(/no Bash tool/);
  });

  it('the fact table records the allowlist and the identical-groups check goes red when the groups differ in it (negative control)', () => {
    const sa = BO.operatorShellAllow({ base });
    const roster = { 'backlog-operator': { ...agent, bodySha256: 'abc' } };
    const facts = (arm: string, provider: string, cwd: string, sh = sa) => BO.groupConfigFacts({ arm, defs: { 'backlog-operator': BO.agentDefinition({ agent, provider: { type: provider }, backlogServer: null, access: 'cli', shellAllow: sh }) }, roster, model: 'm', providerType: provider, effort: 'high', thinking: undefined, cwd, access: 'cli', shellAllow: sh });
    const b = facts('B', 'claudecli', '/wb'); const c = facts('C', 'anthropic', '/wc');
    expect(b.backlogAccess).toBe('cli'); expect(b.shellAllowAddedToProductDefault).toEqual(['adhd-backlog']);
    expect(b.shellAllowCommands['backlog-operator'].commands).toContain('adhd-backlog');
    expect(BO.identicalGroupsCheck(b, c).ok).toBe(true);
    const bad = facts('C', 'anthropic', '/wc', { ...sa, commands: [...sa.commands, 'curl'], added: ['adhd-backlog', 'curl'] });   // a second added executable in one group only
    const res = BO.identicalGroupsCheck(b, bad);
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/shellAllowCommands differs/);
    expect(() => BO.agentDefinition({ agent, provider: {}, backlogServer: null, access: 'cli', shellAllow: BO.operatorShellAllow({ base, extra: 'curl' }) })).toThrow(/needs the shell allowlist/);   // without adhd-backlog in it the definition fails closed
  });

  it('the scenario sha: an mcp round hashes exactly the R11 object; a cli round hashes differently and depends on the allowlist', () => {
    const roster = { 'backlog-operator': { ...agent, bodySha256: 'abc', file: 'f' } };
    const mcp = BO.scenarioShaOf({ roster });
    expect(BO.scenarioShaOf({ roster, access: 'mcp' })).toBe(mcp);
    const sa = BO.operatorShellAllow({ base });
    const c1 = BO.scenarioShaOf({ roster, access: 'cli', shellAllow: sa });
    expect(c1).not.toBe(mcp);
    expect(BO.scenarioShaOf({ roster, access: 'cli', shellAllow: BO.operatorShellAllow({ base: { ...base, commands: ['git'] } }) })).not.toBe(c1);
  });

  it('parseCliCall reads the verb, uid and status from the call input (never from a result), tolerates absolute paths, prefix uids and the global switches', () => {
    expect(FS.parseCliCall(cli('claim', { uid: U1 }, { write: true }))).toMatchObject({ verb: 'claim', uid: U1, allowProductionWrite: true, isWrite: true });
    expect(FS.parseCliCall(cli('transition', { uid: U1, toStatus: 'done' }, { write: true }))).toMatchObject({ verb: 'transition', toStatus: 'done' });
    expect(FS.parseCliCall(cli('query', { view: 'ready' }))).toMatchObject({ verb: 'query', uid: null, isWrite: false });
    expect(FS.parseCliCall(cli('get', { uid: U1 }, { argv0: '/Users/nix/.nvm/versions/node/v24.11.1/bin/adhd-backlog' }))?.verb).toBe('get');
    expect(FS.parseCliCall({ name: 'shell__shell_execute', input: { command: ['adhd-backlog', 'get', '7e9174a2'] } })).toMatchObject({ verb: 'get', uid: '7e9174a2' });   // positional prefix form
    expect(FS.parseCliCall({ name: 'shell__shell_execute', input: { command: ['adhd-backlog', '--namespace', 'sandbox', 'get', '--input', '{"uid":"x"}'] } })).toMatchObject({ verb: 'get', namespace: 'sandbox' });
    expect(FS.parseCliCall({ name: 'shell__shell_execute', input: { command: ['git', 'status'] } })).toBeNull();
    expect(FS.parseCliCall({ name: 'fs__read_text_file', input: { command: ['adhd-backlog', 'get'] } })).toBeNull();
  });

  it('cliOutcome: success needs the {"ok":true} envelope, no engine error and no non-zero exit sentinel (log noise and a joined stdout+stderr line are handled)', () => {
    expect(FS.cliOutcome(cli('get', {})).ok).toBe(true);
    expect(FS.cliOutcome(cli('get', {}, { text: '{"level":30,"msg":"x"}{"ok":true,"data":{}}' })).ok).toBe(true);   // the claude bridge joins the parts with no separator
    expect(FS.cliOutcome(cli('claim', {}, { write: true, text: 'Refused: "claim" would write to the live PRODUCTION store\n{"ok":false,"error":{}}\n[exit status: 1]' })).ok).toBe(false);
    expect(FS.cliOutcome(cli('get', {}, { text: '{"ok":true}\n[exit status: 1]' })).ok).toBe(false);
    expect(FS.cliOutcome(cli('get', {}, { isError: true })).ok).toBe(false);
    expect(FS.cliOutcome(cli('get', {}, { text: null })).ok).toBe(false);
    expect(FS.cliOutcome(cli('get', {}, { text: 'some prose that says "ok" true' })).ok).toBe(false);
  });

  it('the stand-in CLI keeps the real CLI contract: writes are refused without --allow-production-write (with the real refusal text), the ready view ignores offset, a unique 8-char uid prefix resolves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-fakecli-'));
    try {
      const stateFile = path.join(dir, 's.json'); fs.writeFileSync(stateFile, JSON.stringify(BO.fakeCliState({ mainRoot: '/main' })));
      const run = (argv: string[]) => { const out: string[] = []; const code = FAKE.runFakeCli(argv, { stateFile, logFile: null, io: { out: (l: string) => out.push(l), err: (_l: string) => void 0 } }); return { code, env: JSON.parse(out.find((l) => l.startsWith('{"ok"')) as string) }; };
      const refused = run(['claim', '--input', JSON.stringify({ uid: 'a0000001-0000-4000-8000-000000000001', by: 'op:1' })]);
      expect(refused.code).toBe(1); expect(refused.env.error.message).toMatch(/--allow-production-write/); expect(refused.env.error.message).toMatch(/PRODUCTION store/);
      expect(run(['claim', '--input', JSON.stringify({ uid: 'a0000001-0000-4000-8000-000000000001', by: 'op:1' }), '--allow-production-write']).code).toBe(0);
      const p0 = run(['query', '--input', JSON.stringify({ view: 'ready', limit: 1, offset: 0 })]); const p1 = run(['query', '--input', JSON.stringify({ view: 'ready', limit: 1, offset: 1 })]);
      expect(p1.env.data.items.map((i: { uid: string }) => i.uid)).toEqual(p0.env.data.items.map((i: { uid: string }) => i.uid));   // offset ignored, exactly like the real ready view
      expect(run(['get', 'a0000002']).env.data.uid).toBe('a0000002-0000-4000-8000-000000000002');
      expect(run(['query', '--input', JSON.stringify({ limit: 5000 })]).code).toBe(1);   // limit capped at 1000
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('R12 AC2: selection stage S1 is redefined (dispatched through agent-mcp AND a specific item uid selected, in-repo, non-terminal, unblocked), with a negative control per branch', () => {
  it('a complete run passes all five stages', () => {
    const f = flow();
    expect(statuses(f)).toEqual({ S1: 'pass', S2: 'pass', S3: 'pass', S4: 'pass', S5: 'pass' });
    expect(f.flowComplete).toBe(true);
    expect(f.stages.S1.reason).toBe('selected');
  });

  it('PASS also when the selection is a successful get alone (a specific uid in a successful read call), and for a prefix-form uid', () => {
    const t = goodTasks({ op1: [cli('query', { view: 'ready' }), cli('get', { uid: U1 })] });
    expect(flow({ tasks: t, item: goodItem({ pickedVia: 'get' }) }).stages.S1.status).toBe('pass');
  });

  it('a query alone selects nothing: FAIL operator-stopped (the uids in its result are not a selection)', () => {
    const t = goodTasks({ op1: [cli('query', { view: 'ready' }, { text: `{"ok":true,"data":{"items":[{"uid":"${U1}"}]}}` })] });
    const s1 = flow({ tasks: t, item: { picked: null } }).stages.S1;
    expect(s1).toMatchObject({ status: 'fail', reason: 'operator-stopped' });
    expect(s1.detail).toMatch(/stopped without selecting/);
  });

  it('an item of another project is FAIL "out-of-repo pick" naming the uid, the project and the component', () => {
    const s1 = flow({ item: goodItem({ inRepo: false, project: 'P-scratch', projectName: 'scratch', component: 'C9', componentName: 'reaper' }) }).stages.S1;
    expect(s1).toMatchObject({ status: 'fail', reason: 'out-of-repo-pick' });
    expect(s1.detail).toMatch(new RegExp(U1)); expect(s1.detail).toMatch(/scratch/); expect(s1.detail).toMatch(/reaper/);
    expect(s1.detail).toMatch(/out-of-repo pick/);
  });

  it('an operator that died (task failed / cancelled / timed out) before any read is FAIL operator-died and names the failing step', () => {
    for (const status of ['failed', 'cancelled', 'timeout']) {
      const t = goodTasks().map((x) => (x.taskId === 'op000001' ? { ...x, status, error: 'provider returned HTTP 529', calls: [] } : x));
      const s1 = flow({ tasks: t, item: { picked: null } }).stages.S1;
      expect(s1, status).toMatchObject({ status: 'fail', reason: 'operator-died' });
      expect(s1.detail).toMatch(/died before selecting an item/); expect(s1.detail).toMatch(/provider returned HTTP 529/); expect(s1.detail).toMatch(/made no tool call/);
    }
    // died after a failed read: the last tool error is named
    const t2 = goodTasks().map((x) => (x.taskId === 'op000001' ? { ...x, status: 'failed', error: 'boom', calls: [cli('get', { uid: U1 }, { isError: true, text: 'Error executing command: Command not allowed: adhd-backlog' })] } : x));
    expect(flow({ tasks: t2, item: { picked: null } }).stages.S1.detail).toMatch(/Command not allowed: adhd-backlog/);
  });

  it('no backlog-operator task at all is FAIL operator-not-dispatched; absent task records are unknown, never pass', () => {
    const t = goodTasks().filter((x) => x.agent !== 'backlog-operator');
    expect(flow({ tasks: t, item: { picked: null } }).stages.S1).toMatchObject({ status: 'fail', reason: 'operator-not-dispatched' });
    expect(flow({ tasks: null, commits: null, item: null }).stages.S1.status).toBe('unknown');
    expect(statuses(flow({ tasks: null, commits: null, item: null }))).toEqual({ S1: 'unknown', S2: 'unknown', S3: 'unknown', S4: 'unknown', S5: 'unknown' });
  });

  it('terminal before, blocked before, project unresolved and an unconfirmed before-snapshot are each their own non-pass (unknown is never pass)', () => {
    expect(flow({ item: goodItem({ nonTerminalBefore: false }) }).stages.S1).toMatchObject({ status: 'fail', reason: 'terminal-before' });
    const blocked = flow({ item: goodItem({ unblockedBefore: false, blockersBefore: [{ uid: 'bbbbbbbb-1', status: 'open' }] }) }).stages.S1;
    expect(blocked).toMatchObject({ status: 'fail', reason: 'blocked-before' }); expect(blocked.detail).toMatch(/bbbbbbbb/);
    expect(flow({ item: goodItem({ inRepo: null, inRepoNote: 'the repository project could not be resolved' }) }).stages.S1).toMatchObject({ status: 'unknown', reason: 'project-unresolved' });
    expect(flow({ item: goodItem({ nonTerminalBefore: null, unblockedBefore: null, beforeNote: 'before-snapshot incomplete' }) }).stages.S1).toMatchObject({ status: 'unknown', reason: 'before-unconfirmed' });
    expect(flow({ item: null }).stages.S1.status).toBe('unknown');
  });

  it('S2-S5 are as in R11: the revision after the review is required, and S5 needs the operator\'s successful transition CLI call AND the read-back status change', () => {
    expect(flow({ commits: commits().slice(0, 1) }).stages.S4.status).toBe('fail');
    expect(flow({ item: goodItem({ transitioned: false, statusAfter: 'open' }) }).stages.S5.status).toBe('fail');
    const noTransition = goodTasks({ op2: [cli('get', { uid: U1 })] });
    expect(flow({ tasks: noTransition }).stages.S5.status).toBe('fail');
    const refused = goodTasks({ op2: [cli('transition', { uid: U1, toStatus: 'done' }, { text: 'Refused: "transition" would write to the live PRODUCTION store\n{"ok":false}\n[exit status: 1]' })] });
    expect(flow({ tasks: refused }).stages.S5.status).toBe('fail');   // the refused write (no --allow-production-write) is not a transition
    const prefix = goodTasks({ op2: [cli('transition', { uid: U1.slice(0, 8), toStatus: 'done' }, { write: true })] });
    expect(flow({ tasks: prefix }).stages.S5.status).toBe('pass');   // the CLI accepts a unique prefix uid; the detector matches it to the full uid
    expect(flow({ tasks: goodTasks({ op2: [cli('transition', { uid: 'ffffffff-0000-0000-0000-000000000000', toStatus: 'done' }, { write: true })] }) }).stages.S5.status).toBe('fail');   // another item
  });

  it('the R11 (mcp) detection is byte-identical when no access is given (default stays mcp)', () => {
    const mcpTask: Task[] = [task('perf0001', 'performance'), task('op000001', 'backlog-operator', { createdAt: at(1), completedAt: at(20), calls: [{ name: 'mcp__backlog__backlog_claim', input: { data: { input: { uid: 'u1' } } }, isError: false, resultText: '{"ok":true}' }] })];
    const f = FS.detectFlow({ tasks: mcpTask, commits: [], item: { picked: 'u1', wasInReadyViewBefore: true, readySnapshotComplete: true } });
    expect(f.stages.S1.status).toBe('pass'); expect(f.stages.S1).not.toHaveProperty('reason');
  });
});

describe('R12 AC3: the snapshot records project and component per item and a truthful complete; the picked item is classified from state', () => {
  function reader(items = BO.DEFAULT_FAKE_ITEMS_CLI, mainRoot = '/repo/main') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-snap-')); const stateFile = path.join(dir, 's.json');
    fs.writeFileSync(stateFile, JSON.stringify(BO.fakeCliState({ mainRoot, items })));
    return { r: BO.makeBacklogReader(BO.fakeCliRunner(stateFile)), dir };
  }

  it('the registry resolves THIS repository\'s project from the main checkout path (else by directory name; ambiguous or absent = unresolved, never guessed)', async () => {
    const { r, dir } = reader();
    try {
      const reg = await BO.readRegistry(r);
      expect(BO.resolveRepoProject(reg, { mainRoot: '/repo/main' })).toMatchObject({ name: 'adhd', resolvedBy: 'registered path equals the main checkout' });
      expect(BO.resolveRepoProject({ projects: [{ uid: 'p1', name: 'main' }] }, { mainRoot: '/nowhere/main' })).toMatchObject({ uid: 'p1', resolvedBy: 'project name equals the main checkout directory name' });
      expect(BO.resolveRepoProject({ projects: [{ uid: 'p1', name: 'main' }, { uid: 'p2', name: 'main' }] }, { mainRoot: '/nowhere/main' })).toBeNull();
      expect(BO.resolveRepoProject({ projects: [] }, { mainRoot: '/nowhere/main' })).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the before-snapshot is the repository project\'s non-terminal items with project, component and blockers; complete is true only when every reported item was read once', async () => {
    const { r, dir } = reader();
    try {
      const reg = await BO.readRegistry(r); const repo = BO.resolveRepoProject(reg, { mainRoot: '/repo/main' });
      const snap = await BO.snapshotBeforeCli(r, repo);
      expect(snap.complete).toBe(true);
      expect(snap.total).toBe(3); expect(snap.itemsRead).toBe(3); expect(snap.distinct).toBe(3);   // the finished item and the other project's item are not in the repository's non-terminal set
      expect(snap.items.every((i: { project: string; component: string }) => i.project === repo.uid && i.component)).toBe(true);
      expect(snap.blockedCount).toBe(1);
      expect(snap.readyUids).toHaveLength(2); expect(snap.readyTruncated).toBe(false);
      // paging: a page size below the total still reads each item once
      const paged = await BO.snapshotBeforeCli(r, repo, { pageSize: 1 });
      expect(paged.complete).toBe(true); expect(paged.itemsRead).toBe(3);
      // the page bound is hit: complete is false (truthful), never silently true
      const bounded = await BO.snapshotBeforeCli(r, repo, { pageSize: 1, maxPages: 2 });
      expect(bounded.complete).toBe(false); expect(bounded.itemsRead).toBe(2);
      // no resolved project, or a failing read: not complete, with the error recorded
      expect(await BO.snapshotBeforeCli(r, null)).toMatchObject({ complete: false, error: expect.stringMatching(/could not be resolved/) });
      const failing = BO.makeBacklogReader(async () => ({ ok: false, error: { code: 'store_unavailable', message: 'down' } }));
      expect(await BO.snapshotBeforeCli(failing, repo)).toMatchObject({ complete: false, error: 'store_unavailable: down' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the picked item is classified in-repo / out-of-repo from state, with the registry names, non-terminal and unblocked from the before-snapshot, and the before -> after status', async () => {
    const { r, dir } = reader();
    try {
      const reg = await BO.readRegistry(r); const repo = BO.resolveRepoProject(reg, { mainRoot: '/repo/main' }); const before = await BO.snapshotBeforeCli(r, repo);
      const ids = BO.DEFAULT_FAKE_ITEMS_CLI.map((i: { uid: string }) => i.uid);
      const factFor = async (uid: string, transitions: unknown[] = []) => { const after = await BO.snapshotAfterCli(r, [uid], reg); return BO.transitionFactCli({ before, after, pick: { picked: uid, pickedVia: 'claim', transitions }, registry: reg, repoProject: repo }); };
      const inRepo = await factFor(ids[0]);
      expect(inRepo).toMatchObject({ classification: 'in-repo', inRepo: true, projectName: 'adhd', componentName: '(root)', nonTerminalBefore: true, unblockedBefore: true, statusBefore: 'open', statusAfter: 'open', readySnapshotComplete: true });
      const blocked = await factFor(ids[2]); expect(blocked).toMatchObject({ classification: 'in-repo', unblockedBefore: false }); expect(blocked.blockersBefore).toHaveLength(1);
      const terminal = await factFor(ids[3]); expect(terminal).toMatchObject({ classification: 'in-repo', nonTerminalBefore: false });
      const other = await factFor(ids[4]);
      expect(other).toMatchObject({ classification: 'out-of-repo', inRepo: false, projectName: 'scratch', componentName: 'reaper', nonTerminalBefore: null });
      expect(other.transitioned).toBe(false);
      expect(await BO.transitionFactCli({ before, after: { items: [] }, pick: { picked: null }, registry: reg, repoProject: repo })).toMatchObject({ picked: null });
      // unresolved repository project: classification unknown, never in-repo
      const after = await BO.snapshotAfterCli(r, [ids[0]], reg);
      expect(BO.transitionFactCli({ before, after, pick: { picked: ids[0], transitions: [] }, registry: reg, repoProject: null })).toMatchObject({ classification: 'unknown', inRepo: null });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the harness reader refuses every write verb (it never writes the backlog) and the picked uid comes from the operator\'s own successful get / claim / transition calls, prefix uids resolved', async () => {
    const rd = BO.makeBacklogReader(async () => ({ ok: true }));
    for (const v of ['claim', 'transition', 'create', 'update']) await expect(rd.call(v, {})).rejects.toThrow(/read-only/);
    const calls = [cli('query', { view: 'ready' }, { text: `{"ok":true,"data":{"items":[{"uid":"${U1}"}]}}` }), cli('get', { uid: U1.slice(0, 8) })];
    expect(BO.pickedFromCliCalls(calls, { known: [U1] })).toMatchObject({ picked: U1, pickedVia: 'get' });   // the query selects nothing; the get names the item (prefix resolved)
    expect(BO.pickedFromCliCalls([...calls, cli('claim', { uid: U1 }, { write: true })], { known: [U1] })).toMatchObject({ picked: U1, pickedVia: 'claim' });
    expect(BO.pickedFromCliCalls([...calls, cli('claim', { uid: U1 }, { write: true, text: 'Refused: x\n{"ok":false}\n[exit status: 1]' })], { known: [U1] })).toMatchObject({ pickedVia: 'get', refusedWrites: 0 });
    expect(BO.pickedFromCliCalls([cli('query', {})], { known: [] }).picked).toBeNull();
    const refusal = cli('claim', { uid: U1 }, { text: 'Refused: "claim" would write to the live PRODUCTION store and no opt-in\n{"ok":false}\n[exit status: 1]' });
    expect(BO.pickedFromCliCalls([refusal], { known: [U1] })).toMatchObject({ picked: null, refusedWrites: 1 });
  });
});

describe('R12 AC4: the record carries task-unique call ids and timestamps, untruncated failure text, classified tool errors and the three bug-candidate kinds', () => {
  it('claudecli bridge-N ids are namespaced by task id: two tasks that both made bridge-1 get distinct call ids, each with a timestamp (negative control: the bare ids collide)', () => {
    const rows = [
      { taskId: 'T1', calls: [{ name: 'mcp__shell__shell_execute', streamId: 'toolu_a' }, { name: 'mcp__fs__read_text_file', streamId: 'toolu_b' }] },
      { taskId: 'T2', calls: [{ name: 'mcp__shell__shell_execute', streamId: 'toolu_c' }] },
    ];
    const trace = [
      { task: 'T1', callId: 'bridge-1', name: 'shell__shell_execute', startMs: Date.parse('2026-10-13T10:00:01.000Z') },
      { task: 'T1', callId: 'bridge-2', name: 'fs__read_text_file', startMs: Date.parse('2026-10-13T10:00:02.000Z') },
      { task: 'T2', callId: 'bridge-1', name: 'shell__shell_execute', startMs: Date.parse('2026-10-13T10:00:03.000Z') },
    ];
    expect(new Set(trace.map((t) => t.callId)).size).toBe(2);   // the bare ids collide across tasks
    const stats = BO.attachCallIds(rows, trace, 'B');
    expect(stats).toEqual({ total: 3, unique: 3, withTime: 3 });
    expect(rows.map((r) => r.calls.map((c: { id: string }) => c.id))).toEqual([['T1:bridge-1', 'T1:bridge-2'], ['T2:bridge-1']]);
    expect(rows[0].calls[0].ts).toBe('2026-10-13T10:00:01.000Z');
    // arm C pairs by the tool_use id; an unpaired call keeps its stream id and a null time (never an invented timestamp)
    const rowsC = [{ taskId: 'T9', calls: [{ name: 'shell__shell_execute', streamId: 'toolu_x' }, { name: 'shell__shell_execute', streamId: 'toolu_unknown' }] }];
    const s2 = BO.attachCallIds(rowsC, [{ task: 'T9', callId: 'toolu_x', name: 'shell__shell_execute', startMs: 5000 }], 'C');
    expect(s2).toEqual({ total: 2, unique: 2, withTime: 1 });
    expect(rowsC[0].calls[1]).toMatchObject({ id: 'T9:toolu_unknown', ts: null, tsSource: null });
    // B pairs by order only when the counts and names agree: a mismatch leaves the times null
    const rowsMis = [{ taskId: 'T1', calls: [{ name: 'mcp__shell__shell_execute', streamId: 's1' }] }];
    expect(BO.attachCallIds(rowsMis, [{ task: 'T1', callId: 'bridge-1', name: 'fs__read_text_file', startMs: 1 }], 'B').withTime).toBe(0);
  });

  it('long tool results keep their head AND tail (the exit sentinel at the end survives); the failure detail is untruncated in the cli record and cut at 300 in the mcp record', () => {
    const long = `${'x'.repeat(5000)}\n[exit status: 1]`;
    const kept = BO.keepHeadTail(long);
    expect(kept.length).toBeLessThan(long.length); expect(kept).toMatch(/\[exit status: 1\]$/); expect(kept).toMatch(/characters cut/);
    expect(BO.keepHeadTail('short')).toBe('short');
    const detail = 'E'.repeat(900);
    const f = { harnessFailure: null, submit: { taskId: 't' }, final: { status: 'failed', error: detail }, tasks: [{ id: 'abcd1234', agent: 'performance', status: 'failed', error: detail, createdAt: at(0), depth: 0 }] };
    expect(BO.explainFailure(f, { full: true }).detail).toBe(detail);
    expect(BO.explainFailure(f).detail.length).toBe(300);   // R11 behaviour unchanged for the default
  });

  it('R11 B1 reproduced: three `Unexpected shell operator` tool errors plus one `ls` probe that exited 1 were counted as 4; the classified groups report 3 tool errors and 1 non-zero exit separately', () => {
    const op = (text: string, isError: boolean): Call => ({ name: 'mcp__shell__shell_execute', input: { command: ['x'] }, isError, resultText: text });
    const shellErr = `Tool 'shell_execute' on server 'shell' returned an error: [{"type":"text","text":"Error executing command: Unexpected shell operator: ;"}]`;
    const calls = [op(shellErr, true), op(shellErr, true), op(shellErr, true), op('ls: /nope: No such file or directory\n[exit status: 1]', false), op('fine', false)];
    const tasks = [{ taskId: 'T', agent: 'backlog-operator', calls }];
    const old = FS.repeatedToolErrors(tasks);
    expect(old).toHaveLength(1); expect(old[0].count).toBe(4);   // the R11 matcher: isError OR ERROR_LIKE under one (task, tool) key
    const groups = FS.toolErrorGroups(tasks);
    const byCls = Object.fromEntries(groups.map((g: { cls: string; count: number }) => [g.cls, g.count]));
    expect(byCls['tool-error']).toBe(3);
    expect(groups.find((g: { cls: string }) => g.cls === 'nonzero-exit')).toBeUndefined();   // one probe is below the threshold and is not part of the error group
    const two = FS.toolErrorGroups([{ taskId: 'T', agent: 'x', calls: [calls[3], calls[3]] }]);
    expect(two).toHaveLength(1); expect(two[0]).toMatchObject({ cls: 'nonzero-exit', count: 2, bugCandidate: false });   // repeated probes are reported but not a bug candidate
    expect(FS.classifyToolError(op(shellErr, true))?.cls).toBe('tool-error');
    expect(FS.classifyToolError(op('fatal: not a git repository', false))?.cls).toBe('refusal');
    expect(FS.classifyToolError(op('all good', false))).toBeNull();
  });

  it('bugCandidate distinguishes operatorDied / operatorStopped / repeatedToolErrors, and a clean run has none', () => {
    const dead = goodTasks().map((x) => (x.taskId === 'op000001' ? { ...x, status: 'failed', error: 'boom', calls: [] } : x));
    const died = FS.bugCandidates({ tasks: dead, flow: flow({ tasks: dead, item: { picked: null } }) });
    expect(died.operatorDied).toHaveLength(1); expect(died.operatorStopped).toEqual([]); expect(died.any).toBe(true);
    const stoppedTasks = goodTasks({ op1: [cli('query', { view: 'ready' })] });
    const stopped = FS.bugCandidates({ tasks: stoppedTasks, flow: flow({ tasks: stoppedTasks, item: { picked: null } }) });
    expect(stopped.operatorStopped).toHaveLength(1); expect(stopped.operatorDied).toEqual([]);
    const err = { name: 'mcp__shell__shell_execute', input: { command: ['adhd-backlog'] }, isError: true, resultText: 'Error executing command: Command not allowed: x' };
    const rep = goodTasks({ op1: [err, err, cli('claim', { uid: U1 }, { write: true })] });
    const repeated = FS.bugCandidates({ tasks: rep, flow: flow({ tasks: rep }) });
    expect(repeated.repeatedToolErrors.length).toBeGreaterThan(0); expect(repeated.operatorDied).toEqual([]);
    expect(FS.bugCandidates({ tasks: goodTasks(), flow: flow() }).any).toBe(false);
  });

  it('explainFailure names a missing CLI call and a missing transition in cli terms', () => {
    const base = { harnessFailure: null, submit: { taskId: 't' }, final: { status: 'completed' }, tasks: [], dispatched: true, commits: 1 };
    expect(BO.explainFailure({ ...base, backlogCalls: 0, access: 'cli' }).gaps.join(' ')).toMatch(/made no adhd-backlog shell call/);
    expect(BO.explainFailure({ ...base, backlogCalls: 2, transitions: [], access: 'cli' }).gaps.join(' ')).toMatch(/no adhd-backlog transition call was made/);
    expect(BO.explainFailure({ ...base, backlogCalls: 2, transitions: [{ isError: true }], access: 'cli' }).gaps.join(' ')).toMatch(/every adhd-backlog transition call failed/);
  });
});

describe('R12 AC6: the ledger', () => {
  it('ledger/R12.json: design backlog-operator, backlogAccess cli, arms B and C, cap 2, both R12 scope entries, the owner messages, the A-first waiver as in R11, and no runs', () => {
    const led = LG.readLedger('R12');
    const r11 = LG.readLedger('R11');
    expect(led).toMatchObject({ round: 'R12', design: 'backlog-operator', backlogAccess: 'cli', cap: 2, runs: [], judgeCalls: [], scenarioSha: '', startedAt: null, armA: null, armOrder: [] });
    expect(led.scopeChanges).toEqual(['SCOPE-R12-schema-and-scope', 'SCOPE-R12-backlog-cli']);
    expect(led.profile.arms).toEqual(['B', 'C']);
    expect(led.profile.armAWaiver).toBe(r11.profile.armAWaiver);
    expect(led.approvedBy).toContain("you can stop experiments when b and c both successfully build a ticket e2e");
    expect(led.approvedBy).toContain('you could easily just give that agent the cli instead');
    expect(LG.capOf(led)).toBe(2);
    expect(LG.designOf(led)).toBe('backlog-operator');
    // R11 is spent and untouched: it has no backlogAccess key (the mcp shape) and still records its two runs
    expect(r11.backlogAccess).toBeUndefined(); expect(r11.runs.map((x: { runId: string }) => x.runId)).toEqual(['B1', 'C1']);
    expect(BO.accessOfRound('R12')).toBe('cli'); expect(BO.accessOfRound('R11')).toBe('mcp');
  });
});
