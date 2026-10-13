import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * R11 AC11 (flow-stage detector) and AC12 (failure naming), SCOPE-R11-stop-condition: the owner stops the experiments when B and C both build a ticket end to end: backlog operator
 * dispatched and an item selected (S1), implemented with a commit (S2), a review dispatched on that code (S3), a revision commit after the review (S4), and the same backlog operator
 * transitioning the item afterwards (S5). Pure tests over synthetic task / git / backlog fixtures (no model call, no subprocess, no network). Absent data is `unknown`, never `pass`.
 */
const FS = await loadParity('flow-stages.mjs');
const BO = await loadParity('backlog-operator.mjs');

type Call = { name: string; input?: unknown; isError?: boolean | null; resultText?: string | null };
type Task = { taskId: string; agent: string | null; sessionId?: string | null; parentTaskId: string | null; status: string; error?: string | null; createdAt: string | null; completedAt: string | null; calls?: Call[] };
type Commit = { sha: string; subject?: string; ts: number | null; files: string[] };

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const epoch = (s: number) => Math.floor((T0 + s * 1000) / 1000);
const transitionCall = (uid = 'u1', isError = false): Call => ({ name: 'mcp__backlog__backlog_transition', input: { data: { input: { uid, toStatus: 'done' } } }, isError, resultText: '{"ok":true}' });
const claimCall = (uid = 'u1'): Call => ({ name: 'mcp__backlog__backlog_claim', input: { data: { input: { uid } } }, isError: false, resultText: '{"ok":true}' });

/** A complete, well-ordered run: op1 0-20s (select + implement), review 21-30s, revision commit at 40s, op2 50-55s (transition). */
function goodTasks(): Task[] {
  return [
    { taskId: 'perf0001-aaaa', agent: 'performance', parentTaskId: null, status: 'completed', createdAt: at(0), completedAt: at(60), calls: [{ name: 'task', isError: false }, { name: 'shell_execute', isError: false }] },
    { taskId: 'op000001-aaaa', agent: 'backlog-operator', sessionId: 'S-op', parentTaskId: 'perf0001-aaaa', status: 'completed', createdAt: at(1), completedAt: at(20), calls: [claimCall(), { name: 'shell_execute', isError: false, resultText: '[master abc] x' }] },
    { taskId: 'rev00001-aaaa', agent: 'review', sessionId: 'S-rev', parentTaskId: 'perf0001-aaaa', status: 'completed', createdAt: at(21), completedAt: at(30), calls: [{ name: 'read_text_file', isError: false }] },
    { taskId: 'op000002-aaaa', agent: 'backlog-operator', sessionId: 'S-op', parentTaskId: 'perf0001-aaaa', status: 'completed', createdAt: at(50), completedAt: at(55), calls: [transitionCall()] },
  ];
}
const goodCommits = (): Commit[] => [
  { sha: 'a'.repeat(40), subject: 'implement u1', ts: epoch(15), files: ['src/a.ts'] },
  { sha: 'b'.repeat(40), subject: 'revise u1 after review', ts: epoch(40), files: ['src/a.ts', 'src/a.test.ts'] },
];
const goodItem = () => ({ picked: 'u1', wasInReadyViewBefore: true, readySnapshotComplete: true, statusBefore: 'open', statusAfter: 'done', transitioned: true as boolean | string, afterError: null as string | null });
const run = (over: { tasks?: Task[] | null; commits?: Commit[] | null; item?: ReturnType<typeof goodItem> | null } = {}) => FS.detectFlow({ tasks: 'tasks' in over ? over.tasks : goodTasks(), commits: 'commits' in over ? over.commits : goodCommits(), item: 'item' in over ? over.item : goodItem() });
const status = (f: { stages: Record<string, { status: string }> }) => Object.fromEntries(FS.STAGE_IDS.map((s: string) => [s, f.stages[s].status]));
const withTask = (id: string, patch: Partial<Task>) => goodTasks().map((t) => (t.taskId.startsWith(id) ? { ...t, ...patch } : t));

describe('R11 AC11: the five flow stages are read from state', () => {
  it('R11 AC11: a complete, well-ordered run passes S1-S5, flowComplete is true, and every stage names its evidence', () => {
    const f = run();
    expect(status(f)).toEqual({ S1: 'pass', S2: 'pass', S3: 'pass', S4: 'pass', S5: 'pass' });
    expect(f.flowComplete).toBe(true); expect(f.firstNotPassed).toBeNull();
    expect(f.line).toBe('S1 pass S2 pass S3 pass S4 pass S5 pass | flow COMPLETE');
    expect(f.stages.S1.evidence.join(' ')).toMatch(/task backlog-operator op000001 \(parent perf0001\)/);
    expect(f.stages.S2.evidence.join(' ')).toMatch(/commit aaaaaaaaaa "implement u1" files \[src\/a\.ts\]/);
    expect(f.stages.S3.evidence.join(' ')).toMatch(/task review rev00001/);
    expect(f.stages.S4.evidence.join(' ')).toMatch(/commit bbbbbbbbbb/);
    expect(f.stages.S5.detail).toMatch(/op000002.*transitioned u1.*open -> done.*same operator session/);
    expect(FS.STAGE_IDS).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  it('R11 AC11: S5 says when the transition came from a DIFFERENT operator session than the selecting task (reported, still a pass: the owner\'s "same operator" is evidence, not a gate the harness can prove)', () => {
    const f = run({ tasks: withTask('op000002', { sessionId: 'S-other' }) });
    expect(f.stages.S5.status).toBe('pass'); expect(f.stages.S5.detail).toMatch(/different operator session/);
  });

  // ----- S1 negative controls
  it('R11 AC11 S1: no backlog-operator child task => fail; an operator that picked nothing => fail; an item outside the ready view => fail; an incomplete ready snapshot => unknown', () => {
    expect(run({ tasks: goodTasks().filter((t) => t.agent !== 'backlog-operator') }).stages.S1.status).toBe('fail');
    expect(run({ tasks: goodTasks().map((t) => (t.agent === 'backlog-operator' ? { ...t, parentTaskId: null } : t)) }).stages.S1.status, 'an operator that was not dispatched through agent-mcp (no parent task)').toBe('fail');
    expect(run({ item: { ...goodItem(), picked: null } }).stages.S1.status).toBe('fail');
    const out = run({ item: { ...goodItem(), wasInReadyViewBefore: false } });
    expect(out.stages.S1.status).toBe('fail'); expect(out.stages.S1.detail).toMatch(/not in the pre-run ready \(unblocked\) view/);
    expect(run({ item: { ...goodItem(), wasInReadyViewBefore: false, readySnapshotComplete: false } }).stages.S1.status).toBe('unknown');
  });

  // ----- S2 negative controls
  it('R11 AC11 S2: no commit => fail; commits that touch no file => fail; only commits made after the review was dispatched => fail', () => {
    expect(run({ commits: [] }).stages.S2).toMatchObject({ status: 'fail', detail: 'no commit was made in the group worktree' });
    expect(run({ commits: [{ sha: 'c'.repeat(40), ts: epoch(15), files: [] }] }).stages.S2.status).toBe('fail');
    const late = run({ commits: [{ sha: 'c'.repeat(40), ts: epoch(40), files: ['a.ts'] }] });
    expect(late.stages.S2.status).toBe('fail'); expect(late.stages.S2.detail).toMatch(/later than the review dispatch/);
    expect(run({ commits: [{ sha: 'c'.repeat(40), ts: null, files: ['a.ts'] }] }).stages.S2.status, 'a commit without a time cannot be ordered before the review').toBe('unknown');
  });

  // ----- S3 negative controls
  it('R11 AC11 S3: no review task => fail; a review that ended failed => fail; a review with no implementation commit before it => fail', () => {
    const none = run({ tasks: goodTasks().filter((t) => t.agent !== 'review') });
    expect(none.stages.S3.status).toBe('fail'); expect(none.stages.S3.detail).toMatch(/no review task was dispatched through agent-mcp/);
    const failed = run({ tasks: withTask('rev0', { status: 'failed', error: 'provider 500' }) });
    expect(failed.stages.S3.status).toBe('fail'); expect(failed.stages.S3.detail).toMatch(/ended failed \(provider 500\)/);
    expect(run({ tasks: goodTasks().map((t) => (t.agent === 'review' ? { ...t, parentTaskId: null } : t)) }).stages.S3.status, 'a review that was not dispatched through agent-mcp').toBe('fail');
    const noImpl = run({ commits: [] });
    expect(noImpl.stages.S3.status).toBe('fail'); expect(noImpl.stages.S3.detail).toMatch(/no implementation commit precedes it/);
  });

  it('R11 AC11 S3: a review dispatched BEFORE the operator ran does not count (it is not a review of the implemented code)', () => {
    const tasks = withTask('rev0', { createdAt: at(0.5), completedAt: at(0.9) });
    const f = run({ tasks });
    expect(f.stages.S3.status).toBe('fail');
  });

  // ----- S4 negative controls
  it('R11 AC11 S4: no revision commit => fail; the only later commit predates the review completion => fail; one commit cannot be both implementation and revision', () => {
    expect(run({ commits: [goodCommits()[0]] }).stages.S4).toMatchObject({ status: 'fail' });
    const early = run({ commits: [goodCommits()[0], { sha: 'd'.repeat(40), ts: epoch(25), files: ['a.ts'] }] });
    expect(early.stages.S4.status).toBe('fail'); expect(early.stages.S4.detail).toMatch(/predate the review completion/);
    const oneSecond = run({ tasks: [...goodTasks().map((t) => (t.agent === 'review' ? { ...t, createdAt: at(20.2), completedAt: at(20.8) } : t))], commits: [{ sha: 'e'.repeat(40), ts: epoch(20.5), files: ['a.ts'] }] });
    expect(oneSecond.stages.S2.status).toBe('pass'); expect(oneSecond.stages.S4.status).toBe('fail');
    expect(run({ commits: [goodCommits()[0], { sha: 'f'.repeat(40), ts: epoch(40), files: [] }] }).stages.S4.status, 'a revision commit that touches no file').toBe('fail');
    expect(run({ tasks: withTask('rev0', { completedAt: null }) }).stages.S4.status).toBe('unknown');
  });

  it('R11 AC11: implementation, review and revision inside the same wall-clock second resolve toward the true order when two DISTINCT commits exist', () => {
    const tasks = withTask('rev0', { createdAt: at(20.2), completedAt: at(20.6) });
    const commits = [{ sha: '1'.repeat(40), ts: epoch(20), files: ['a.ts'] }, { sha: '2'.repeat(40), ts: epoch(20), files: ['a.ts'] }];
    const f = run({ tasks, commits });
    expect([f.stages.S2.status, f.stages.S3.status, f.stages.S4.status]).toEqual(['pass', 'pass', 'pass']);
    expect(f.stages.S4.evidence[0]).toMatch(/commit 2222222222/);   // the later commit in git order is the revision
  });

  // ----- S5 negative controls
  it('R11 AC11 S5: the transition made BEFORE the review (operator did everything in one task) => fail and the earlier task is named', () => {
    const tasks = goodTasks().filter((t) => t.taskId !== 'op000002-aaaa').map((t) => (t.taskId === 'op000001-aaaa' ? { ...t, calls: [...(t.calls ?? []), transitionCall()] } : t));
    const f = run({ tasks });
    expect(f.stages.S5.status).toBe('fail'); expect(f.stages.S5.detail).toMatch(/only in earlier task\(s\): op000001/);
  });

  it('R11 AC11 S5: a transition call that errored => fail; a transition on a different item => fail; no status change in the read-back => fail; a failed read-back or an unknown before-status => unknown', () => {
    expect(run({ tasks: withTask('op000002', { calls: [transitionCall('u1', true)] }) }).stages.S5.status).toBe('fail');
    expect(run({ tasks: withTask('op000002', { calls: [transitionCall('other')] }) }).stages.S5.status).toBe('fail');
    const same = run({ item: { ...goodItem(), statusAfter: 'open', transitioned: false } });
    expect(same.stages.S5.status).toBe('fail'); expect(same.stages.S5.detail).toMatch(/status did not change/);
    expect(run({ item: { ...goodItem(), afterError: 'not_found: gone' } }).stages.S5.status).toBe('unknown');
    expect(run({ item: { ...goodItem(), transitioned: 'unknown (no before-status: the item was not in the ready snapshot)' } }).stages.S5.status).toBe('unknown');
  });

  it('R11 AC11 S5: with no revision (S4 fail) S5 cannot pass even if a transition exists after the review', () => {
    const f = run({ commits: [goodCommits()[0]] });
    expect(f.stages.S4.status).toBe('fail'); expect(f.stages.S5.status).toBe('fail'); expect(f.stages.S5.detail).toMatch(/S4 did not pass/);
    expect(f.flowComplete).toBe(false); expect(f.firstNotPassed).toBe('S4');
  });

  // ----- absent data
  it('R11 AC11: absent data is unknown, never pass (no tasks, no git log, no backlog read-back, nothing at all)', () => {
    const noTasks = run({ tasks: null });
    expect(status(noTasks)).toEqual({ S1: 'unknown', S2: 'pass', S3: 'unknown', S4: 'unknown', S5: 'unknown' });
    const noGit = run({ commits: null });
    expect(status(noGit)).toEqual({ S1: 'pass', S2: 'unknown', S3: 'unknown', S4: 'unknown', S5: 'unknown' });
    const noItem = run({ item: null });
    expect(status(noItem)).toEqual({ S1: 'unknown', S2: 'pass', S3: 'pass', S4: 'pass', S5: 'unknown' });
    const nothing = run({ tasks: null, commits: null, item: null });
    expect(status(nothing)).toEqual({ S1: 'unknown', S2: 'unknown', S3: 'unknown', S4: 'unknown', S5: 'unknown' });
    for (const f of [noTasks, noGit, noItem, nothing]) { expect(f.flowComplete).toBe(false); expect(f.firstNotPassed).not.toBeNull(); }
    expect(FS.detectFlow({}).flowComplete).toBe(false);
  });

  it('R11 AC11: flowComplete needs ALL five stages: breaking any single stage of the complete fixture turns it false (one mutation per stage)', () => {
    const mutations: Record<string, () => ReturnType<typeof run>> = {
      S1: () => run({ item: { ...goodItem(), picked: null } }),
      S2: () => run({ commits: [] }),
      S3: () => run({ tasks: goodTasks().filter((t) => t.agent !== 'review') }),
      S4: () => run({ commits: [goodCommits()[0]] }),
      S5: () => run({ item: { ...goodItem(), transitioned: false, statusAfter: 'open' } }),
    };
    for (const [stageId, mutate] of Object.entries(mutations)) { const f = mutate(); expect(f.flowComplete, stageId).toBe(false); expect(f.stages[stageId].status, stageId).toBe('fail'); }
  });

  it('R11 AC11: the detector never reads the agent\'s own report (a final text claiming success changes nothing)', () => {
    const tasks = goodTasks().filter((t) => t.agent !== 'review').map((t) => ({ ...t, finalText: 'review done, all five stages complete' }));
    expect(run({ tasks }).stages.S3.status).toBe('fail');
  });

  it('R11 AC11: the detector is a pure function with no imports (no fs, no process, no clock)', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'parity', 'flow-stages.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/^\s*import\s/m); expect(src).not.toMatch(/\bDate\.now\b|\bprocess\.|require\(/);
  });
});

describe('R11 AC12: failure naming and repeated tool errors', () => {
  it('R11 AC12: a failed stage names the failing step: task id, agent, last tool call and the error text from the trace', () => {
    const refused = 'fatal: Unable to create \'/repo/.git/worktrees/r11-B/index.lock\': Operation not permitted';
    const tasks = withTask('op000001', { calls: [claimCall(), { name: 'shell_execute', isError: false, resultText: `[exit status: 128]\n${refused}` }] });
    const flow = run({ tasks, commits: [] });
    const named = FS.explainStages({ flow, tasks });
    const s2 = named.find((x: { stage: string }) => x.stage === 'S2');
    expect(s2).toMatchObject({ stage: 'S2', status: 'fail', task: { taskId: 'op000001-aaaa', agent: 'backlog-operator' }, lastToolCall: { name: 'shell_execute' } });
    expect(s2.step).toMatch(/^S2 implementation commit/);
    expect(s2.errorText).toMatch(/Operation not permitted/); expect(s2.errorText).toMatch(/index\.lock/);
    expect(named.map((x: { stage: string }) => x.stage)).toEqual(['S2', 'S3', 'S4', 'S5']);   // only S1 (operator dispatched, item selected) still passes; every later stage depends on the missing implementation commit
    expect(FS.explainStages({ flow: run(), tasks: goodTasks() })).toEqual([]);
  });

  it('R11 AC12: a stage that failed on a task error names the error from the task record when no tool call carried one', () => {
    const tasks = withTask('rev0', { status: 'failed', error: 'provider unavailable (HTTP 529)', calls: [] });
    const named = FS.explainStages({ flow: run({ tasks }), tasks });
    const s3 = named.find((x: { stage: string }) => x.stage === 'S3');
    expect(s3).toMatchObject({ task: { agent: 'review', status: 'failed' }, lastToolCall: null }); expect(s3.errorText).toMatch(/HTTP 529/);
  });

  it('R11 AC12: repeated tool errors in one task are a bug candidate (isError or refusal text), per task and tool; one error alone is not', () => {
    const err = (n: number): Call[] => Array.from({ length: n }, () => ({ name: 'shell_execute', isError: true, resultText: 'Permission denied: /x' }));
    const rep = FS.repeatedToolErrors(withTask('op000001', { calls: err(3) }));
    expect(rep).toEqual([{ taskId: 'op000001-aaaa', agent: 'backlog-operator', tool: 'shell_execute', count: 3, sample: expect.stringMatching(/Permission denied/), bugCandidate: true }]);
    expect(FS.repeatedToolErrors(withTask('op000001', { calls: err(1) }))).toEqual([]);
    const viaText = FS.repeatedToolErrors(withTask('op000001', { calls: [{ name: 'shell_execute', isError: false, resultText: '[exit status: 1] a' }, { name: 'shell_execute', isError: false, resultText: 'Operation not permitted' }] }));
    expect(viaText).toHaveLength(1); expect(viaText[0].count).toBe(2);
    expect(FS.repeatedToolErrors(withTask('op000001', { calls: [{ name: 'a', isError: true }, { name: 'b', isError: true }] }), { threshold: 2 }), 'different tools do not add up').toEqual([]);
    expect(FS.repeatedToolErrors(goodTasks())).toEqual([]);
    expect(FS.repeatedToolErrors(null)).toEqual([]);
  });

  it('R11 AC12: the refusal patterns the record relies on (sandbox, permission, git fatal, exit status, hook) match, and prose containing the word error does not', () => {
    for (const t of ['Operation not permitted', 'Permission denied', 'EACCES: x', 'fatal: not a git repository', '[exit status: 1]', 'pre-commit hook declined', 'hook failed']) expect(FS.ERROR_LIKE.test(t), t).toBe(true);
    for (const t of ['no error found', 'exit status: 0', '[exit status: 0]', 'the review found 0 errors']) expect(FS.ERROR_LIKE.test(t), t).toBe(false);
    expect(FS.errorSnippet(`${'x '.repeat(200)}fatal: bad thing ${'y '.repeat(200)}`)).toMatch(/fatal: bad thing/);
    expect(BO.ERROR_LIKE).toBe(FS.ERROR_LIKE);   // one definition, shared by the detector and the failure naming
  });

  it('R11 AC12: explainFailure names a refusal that a COMPLETED run carried in a tool result (errorTexts), so "no commit" is never unexplained', () => {
    const base = { submit: { taskId: 't-1' }, final: { status: 'completed' }, tasks: [{ id: 't-1', agent: 'performance', status: 'completed', depth: 0 }], dispatched: true, backlogCalls: 3, transitions: [{ uid: 'u', isError: false }], commits: 0 };
    const f = BO.explainFailure({ ...base, errorTexts: [{ name: 'shell__shell_execute', text: 'fatal: Unable to create index.lock: Operation not permitted' }] });
    expect(f.gaps).toContain('no commit was made in the group worktree');
    expect(f.evidence.join(' ')).toMatch(/tool output that looks like a failure: shell__shell_execute: fatal: Unable to create index\.lock: Operation not permitted/);
    expect(BO.explainFailure({ ...base, commits: 1, errorTexts: [] }).evidence).toEqual([]);
  });

  it('R11 AC12: the group line prints the flow stages and the bug-candidate flag; the summary carries them', () => {
    const flow = run();
    const rec = { runId: 'C1', config: { provider: 'anthropic', model: 'm' }, result: { status: 'completed' }, wall: { gradedMs: 1000 }, totals: { costUsd: 0.01, toolCalls: 3 }, backlog: { item: { picked: 'u1', statusBefore: 'open', statusAfter: 'done' } }, worktree: { commits: [{ sha: 'abc' }, { sha: 'def' }] }, flow, failure: { failedStep: null, gaps: [], bugCandidate: true } };
    expect(BO.groupLine(rec)).toMatch(/\| FLOW S1 pass S2 pass S3 pass S4 pass S5 pass \| flow COMPLETE \| BUG CANDIDATE: repeated tool errors$/);
    expect(BO.groupSummary(rec)).toMatchObject({ flow: { stages: { S1: 'pass', S5: 'pass' }, flowComplete: true, firstNotPassed: null }, bugCandidate: true });
    const out = BO.formatSideBySide([rec, { ...rec, runId: 'B1', flow: run({ commits: [] }) }], 'flow');
    expect(out).toMatch(/flow complete \| true \| false/); expect(out).toMatch(/first stage not passed \| none \| S2/); expect(out).toMatch(/S2 implementation commit touching files in the group worktree \| pass \| fail/);
  });
});
