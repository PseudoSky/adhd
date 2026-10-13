import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * R11 design "backlog-operator" (SCOPE-R11-backlog-operator-task), e2e lane (ADR-0009): the real `drive.mjs --round R11` (a bare design round is the OFFLINE dry run) against the REAL built
 * agent-mcp over stdio MCP, the instrument's fake Anthropic upstream, the fake `claude` (arm B), a fake backlog MCP server and a throwaway git repository with real linked worktrees. No model
 * call, no network, no `--live`, no production backlog. The throwaway repo lives under repo-root tmp/ (NOT the OS temp dir, which the sandbox may write by default and so would hide a refused
 * `git commit`). The paid path (`--live --yes --round R11`) is owned by nix (repo owner); it is never run here.
 *   AC2 the exact `task` call as the server received it carries BO.TASK_PROMPT (the single exported constant, SCOPE-R11-prompt-update) byte for byte, for both groups
 *   AC3 worktrees: real, linked, under <main>/.worktrees/, own branch off the base, not removed, main untouched, the real repository's worktree list unchanged
 *   AC4 identical groups: the agent_create calls as sent carry the roster bodies and the same tool lists; only the provider differs
 *   AC5 performance -> backlog-operator -> backlog tool call, end to end through the real server (negative control: no backlog server on the operator => red)
 *   AC10 the read-only review agent is registered in both groups and the performance agent dispatches it through agent-mcp (negative control: review not registered => S3 red)
 *   AC11/AC12 the five flow stages from state (task records, the worktree git log, the backlog read-back) and the failing step named from the trace
 *   AC6 one run per group (a second invocation skips both), `--live` without `--yes` refuses before touching anything
 *   AC7 the record shape, the pause line, analyze, and failure naming (negative control: no sandbox widening => the refused commit is named)
 *   AC9 the bare `--round R11` dry run exits 0 with the full record shape
 */
const BO = await loadParity('backlog-operator.mjs');
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
const OWNER_SENTENCE: string = BO.TASK_PROMPT;   // defined once, in backlog-operator.mjs

const PERFORMANCE = '---\nname: performance\ndescription: Performance agent\ntools: Read, Edit, Bash, Glob, Grep, Task\nmodel: haiku\n---\n# performance\n\nYou are the performance agent (fixture body).\n';
const REVIEW = '---\nname: review\ndescription: Read-only reviewer\ntools: Read, Grep, Glob\nmodel: sonnet\ndisallowedTools: Edit, Write, NotebookEdit\n---\n# review\n\nYou review a change (fixture body).\n';
const OPERATOR = '---\nname: backlog-operator\ndescription: Backlog operator\ntools: Read, Bash, mcp__backlog__*\nmodel: haiku\ndisallowedTools: Edit, NotebookEdit\n---\n# backlog-operator\n\nYou operate the backlog (fixture body).\n';

const cleanup: string[] = [];
const scratch = path.join(REPO, 'tmp', 'agent-mcp', 'parity', `r11-e2e-${process.pid}`);   // repo-root tmp/: not srt-writable by default (the OS temp dir is)
fs.mkdirSync(scratch, { recursive: true }); cleanup.push(scratch);
const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-e2e-roster-')); cleanup.push(rosterDir);
fs.writeFileSync(path.join(rosterDir, 'performance.md'), PERFORMANCE); fs.writeFileSync(path.join(rosterDir, 'backlog-operator.md'), OPERATOR); fs.writeFileSync(path.join(rosterDir, 'review.md'), REVIEW);
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const env = (extra: Record<string, string> = {}) => { const e: Record<string, string> = {}; for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PARITY_')) e[k] = v; return { ...e, PARITY_AGENTS_DIR: rosterDir, PARITY_DRY_REPO_BASE: path.join(scratch, 'repos'), ...extra }; };
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function dry(extraEnv: Record<string, string> = {}, drive = DRIVE, args: string[] = []) {
  const out = fs.mkdtempSync(path.join(scratch, 'out-'));
  const r = spawnSync(process.execPath, [drive, '--round', 'R11', '--out', out, ...args], { cwd: REPO, encoding: 'utf8', timeout: 420_000, env: env(extraEnv) });
  const rec = (id: string): Rec => readJson(path.join(out, 'runs', id, 'record.json'));
  const calls = (id: string): Rec[] => readJson(path.join(out, 'runs', id, 'mcp-calls.json'));
  return { out, r, stdout: r.stdout, rec, calls };
}
/** Run with a mutated copy of the instrument (written beside the real files, deleted in `finally`; no tracked file is ever modified). */
function mutant(edit: (boSrc: string) => string, args: string[] = []) {
  const bo = fs.readFileSync(path.join(PARITY_DIR, 'backlog-operator.mjs'), 'utf8'); const mutated = edit(bo); expect(mutated, 'the mutation must change the source').not.toBe(bo);
  const boFile = path.join(PARITY_DIR, `backlog-operator.r11-mutant-${process.pid}.mjs`); const driveFile = path.join(PARITY_DIR, `drive.r11-mutant-${process.pid}.mjs`);
  const drv = fs.readFileSync(DRIVE, 'utf8'); expect(drv).toContain("'./backlog-operator.mjs'");
  fs.writeFileSync(boFile, mutated); fs.writeFileSync(driveFile, drv.replace("'./backlog-operator.mjs'", `'./${path.basename(boFile)}'`));
  try { return dry({}, driveFile, args); } finally { fs.rmSync(boFile, { force: true }); fs.rmSync(driveFile, { force: true }); }
}

describe('R11: the backlog-operator design, offline dry run against the real built server', () => {
  const ledgerFile = path.join(PARITY_DIR, 'ledger', 'R11.json');
  const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
  const realWorktreesBefore = git(REPO, 'worktree', 'list', '--porcelain');
  const r11BExistedBefore = fs.existsSync(path.join(path.dirname(REPO), 'r11-B'));   // the real R11 live round created it; the refusal must not change that
  let d: ReturnType<typeof dry>; let B: Rec; let C: Rec;
  beforeAll(() => { d = dry(); B = d.rec('B1'); C = d.rec('C1'); }, 480_000);

  it('R11 AC9: a bare `--round R11` is the offline dry run: exit 0, both groups recorded with the full record shape, ending with the pause line', () => {
    expect(d.r.status, d.stdout + d.r.stderr).toBe(0);
    const lines = d.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.at(-1)).toBe('PAUSED: awaiting owner instruction');
    expect(d.stdout).toMatch(/^DRY-RUN \(no model call\) design backlog-operator plan: B -> C/m);
    for (const r of [B, C]) {
      for (const k of ['design', 'round', 'runId', 'arm', 'mode', 'config', 'prompt', 'submitted', 'wall', 'usage', 'totals', 'agents', 'toolCalls', 'dispatch', 'backlog', 'flow', 'worktree', 'result', 'failure', 'wire', 'model', 'sweep', 'secretScan']) expect(r, `${r.runId}.${k}`).toHaveProperty(k);
      expect(r).toMatchObject({ design: 'backlog-operator', mode: 'dry-run', round: 'R11' });
      expect(r.wall.gradedMs).toBeGreaterThan(0);
      expect(r.result).toMatchObject({ status: 'completed', timedOut: false });
      expect(r.result.finalText).toMatch(/Flow complete for fake-000\d/);
      expect(r.evidence).toBeTruthy();   // tracing evidence (the R11 profile forces traceEvidence)
      expect(fs.existsSync(path.join(d.out, 'runs', r.runId, 'evidence.json'))).toBe(true);
      expect(r.capture?.on).toBe(true);   // wire capture (forced by the profile)
      expect(r.dryRunEgress.breach).toEqual([]);
    }
    expect(readJson(path.join(d.out, 'SUMMARY.json')).groups.map((g: Rec) => g.runId)).toEqual(['B1', 'C1']);
    // the dry run reserved nothing: the tracked ledger is byte-identical and still records no run
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);
  });

  it('R11 AC2: the `task` call as the server received it carries TASK_PROMPT byte for byte for BOTH groups, and nothing else textual (negative control: an appended sentence differs)', () => {
    for (const id of ['B1', 'C1']) {
      const tasks = d.calls(id).filter((c) => c.name === 'task');
      expect(tasks, id).toHaveLength(1);   // one task submission per group: no batching, no retry
      const a = tasks[0].args;
      expect(Object.keys(a).sort()).toEqual(['background', 'cwd', 'prompt', 'session_id']);
      expect(Buffer.compare(Buffer.from(a.prompt, 'utf8'), Buffer.from(OWNER_SENTENCE, 'utf8')), id).toBe(0);
      expect(Buffer.compare(Buffer.from(`${a.prompt} Then add tests.`, 'utf8'), Buffer.from(OWNER_SENTENCE, 'utf8')), `${id} negative control`).not.toBe(0);
      expect(Buffer.compare(Buffer.from(BO.ORIGINAL_PROMPT, 'utf8'), Buffer.from(a.prompt, 'utf8')), `${id}: the superseded design sentence is not what was submitted`).not.toBe(0);
      expect(a.cwd).toBe(d.rec(id).worktree.path);   // AC3: the task runs with the worktree as cwd
    }
  });

  it('R11 AC3: each group ran in a real linked worktree under <main>/.worktrees/ on its own branch off the base; they are still there and the main checkout is untouched', () => {
    for (const [r, arm] of [[B, 'B'], [C, 'C']] as const) {
      const w = r.worktree; const main = w.mainRoot;
      expect(main, 'dry run uses a throwaway repo').not.toBe(REPO);
      expect(w.path).toBe(path.join(main, '.worktrees', `r11-${arm}`));
      expect(w.branch).toBe(`parity/r11-${arm}`);
      expect(fs.existsSync(w.path)).toBe(true);   // the harness never removes it
      expect(fs.statSync(path.join(w.path, '.git')).isFile()).toBe(true);   // a LINKED worktree: .git is a pointer file
      expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(w.branch);
      expect(git(w.path, 'rev-parse', 'HEAD~2')).toBe(w.baseSha);   // exactly two commits on top of the base: the implementation and the revision
      expect(git(main, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan/dry');   // no checkout in the repo root
      expect(git(main, 'rev-parse', 'HEAD')).toBe(w.baseSha);   // the base branch never moved
      expect(git(main, 'worktree', 'list', '--porcelain')).toContain(`worktree ${fs.realpathSync(w.path)}`);
    }
    expect(B.worktree.mainRoot).toBe(C.worktree.mainRoot);
    expect(B.worktree.baseSha).toBe(C.worktree.baseSha);
    // the real repository's worktree list is exactly what it was before the run
    expect(git(REPO, 'worktree', 'list', '--porcelain')).toBe(realWorktreesBefore);
  });

  it('R11 AC3/AC5: `git commit` really happened through the sandboxed shell in the linked worktree (default sandbox refuses it; the narrow widening makes it work)', () => {
    for (const r of [B, C]) {
      expect(r.worktree.commits).toHaveLength(2);
      expect(r.worktree.commits[0].subject).toMatch(/^r11 dry run: execute fake-0001/); expect(r.worktree.commits[1].subject).toMatch(/^r11 dry run: revise fake-0001 after review/);
      expect(r.worktree.commits.every((c: Rec) => c.files.length > 0 && Number.isFinite(c.ts))).toBe(true);   // files + committer time are what the flow detector reads
      expect(git(r.worktree.path, 'log', '-1', '--format=%H')).toBe(r.worktree.commits[1].sha);
      expect(r.worktree.uncommitted).toEqual([]);
      expect(r.config.sandboxWriteExtras.entries).toEqual(expect.arrayContaining([path.join(r.worktree.mainRoot, '.git', 'worktrees', path.basename(r.worktree.path)), path.join(r.worktree.mainRoot, '.git', 'objects'), path.join(r.worktree.mainRoot, '.git', 'packed-refs.lock')]));
      expect(r.config.sandboxWriteExtras.env.ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE_ROOTS).toBe(path.join(r.worktree.mainRoot, '.git'));
    }
  });

  it('R11 AC4: the agent definitions as sent are identical but for the provider (roster bodies verbatim, same tool lists), and the fact table says so', () => {
    const bodyOf = (t: string) => t.slice(t.indexOf('\n---\n', 4) + 5);
    const sent = (id: string) => Object.fromEntries(d.calls(id).filter((c) => c.name === 'agent_create').map((c) => [c.args.name, c.args]));
    const sb = sent('B1'); const sc = sent('C1');
    expect(Object.keys(sb).sort()).toEqual(['backlog-operator', 'performance', 'review']);
    for (const [n, text] of [['performance', PERFORMANCE], ['backlog-operator', OPERATOR], ['review', REVIEW]]) { expect(sb[n].systemPrompt).toBe(bodyOf(text)); expect(sc[n].systemPrompt).toBe(bodyOf(text)); }
    for (const n of ['performance', 'backlog-operator', 'review']) {
      // the provider differs by design; the fake backlog's per-group state files (dry run only) differ by path
      const strip = ({ provider, mcpServers, ...rest }: Rec) => ({ ...rest, mcpServers: mcpServers && Object.fromEntries(Object.entries(mcpServers).map(([k, v]) => [k, { ...(v as Rec), env: undefined }])) }); // eslint-disable-line @typescript-eslint/no-unused-vars
      expect(strip(sb[n])).toEqual(strip(sc[n]));
      expect(sb[n].provider.type).toBe('claudecli'); expect(sc[n].provider.type).toBe('anthropic');
      expect(sb[n].provider.model).toBe(sc[n].provider.model);
    }
    expect(sb['backlog-operator'].mcpServers.backlog.transport).toBe('stdio'); expect(sb.performance.mcpServers).toBeUndefined();
    expect(sb.performance.nativeTooling.dispatch).toBe(true);
    // R11 AC10: the reviewer as sent is read-only in the product's own terms (write tools gated off, no shell, no dispatch, no web)
    expect(sb.review.nativeTooling).toEqual({ fs: { disallowedTools: ['write_file', 'edit_file', 'create_directory', 'move_file'] }, shell: false, dispatch: false }); expect(sb.review.nativeWebTools).toBe(false); expect(sb.review.mcpServers).toBeUndefined();
    expect(B.config.tools.review).toEqual(['fs:readOnly']); expect(C.config.tools.review).toEqual(['fs:readOnly']);
    expect(B.config.systemPromptSha256.review).toBe(C.config.systemPromptSha256.review);
    expect(B.config.systemPromptSha256).toEqual(C.config.systemPromptSha256);
    expect(B.config.tools).toEqual(C.config.tools);
    expect(B.config.model).toBe(C.config.model); expect(B.config.effort).toBe(C.config.effort);
    expect([B.config.provider, C.config.provider]).toEqual(['claudecli', 'anthropic']);
    expect(readJson(path.join(d.out, 'SUMMARY.json')).identicalGroups).toEqual({ ok: true, reasons: [] });
    expect(d.stdout).toMatch(/IDENTICAL GROUPS .*: yes/);
  });

  it('R11 AC5: performance dispatched backlog-operator through agent-mcp, and the backlog tool calls (query, claim, transition) arrived at the backlog MCP server from the operator task', () => {
    for (const r of [B, C]) {
      expect(r.dispatch.viaAgentMcp).toBe(true);
      const child = r.dispatch.children.find((c: Rec) => c.agent === 'backlog-operator');
      expect(child.parentTaskId).toBe(r.dispatch.performanceTask);
      const byAgent = (a: string) => r.toolCalls.filter((t: Rec) => t.agent === a).flatMap((t: Rec) => t.calls.map((c: Rec) => c.name));
      expect(byAgent('performance').filter((n: string) => /backlog_/.test(n)), 'performance has no backlog tool').toEqual([]);
      expect(byAgent('performance').some((n: string) => /(^|__)task$/.test(n))).toBe(true);
      expect(byAgent('backlog-operator').filter((n: string) => /backlog_/.test(n)).map((n: string) => n.replace(/^.*backlog_/, ''))).toEqual(['query', 'claim', 'transition']);
      const log = fs.readFileSync(r.fakeBacklog.log, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
      expect(log.map((e: Rec) => e.tool)).toEqual(['backlog_query', 'backlog_claim', 'backlog_transition']);
      expect(log[0].input).toMatchObject({ view: 'ready' });
      expect(log[2].input).toMatchObject({ uid: 'fake-0001', toStatus: 'done' });
      expect(r.backlog.item).toMatchObject({ picked: 'fake-0001', wasInReadyViewBefore: true, statusBefore: 'open', statusAfter: 'done', transitioned: true });
      expect(r.backlog.before.ready.map((i: Rec) => i.uid)).toEqual(['fake-0001', 'fake-0002']);   // the blocked fixture item is not in the ready view
      expect(r.failure).toMatchObject({ failedStep: null, gaps: [] });
      expect(r.agents.map((a: Rec) => a.agent)).toEqual(['performance', 'backlog-operator', 'review', 'backlog-operator']);   // select+implement, review, then the SAME operator transitions
    }
  });

  it('R11 AC10: the review agent was dispatched through agent-mcp by performance, with only the read tools offered to the model (the tools offered are the product\'s resolved surface, not our definition)', () => {
    for (const r of [B, C]) {
      const review = r.agents.find((a: Rec) => a.agent === 'review');
      expect(review).toMatchObject({ status: 'completed', parentTaskId: r.dispatch.performanceTask });
      const offered: string[] = r.observedTools.review.map((t: string) => t.replace(/^.*__/, ''));
      expect(offered).toEqual(expect.arrayContaining(['read_text_file', 'list_allowed_directories']));
      for (const forbidden of ['shell_execute', 'write_file', 'edit_file', 'create_directory', 'move_file', 'task', 'agent', 'web_fetch', 'web_search']) expect(offered, `${r.runId} review must not be offered ${forbidden}`).not.toContain(forbidden);
      const operator: string[] = r.observedTools['backlog-operator'].map((t: string) => t.replace(/^.*__/, ''));
      expect(operator).toEqual(expect.arrayContaining(['backlog_query', 'shell_execute'])); expect(operator).not.toContain('write_file'); expect(operator).not.toContain('task');
    }
  });

  it('R11 AC11: the flow detector reads all five stages as pass from state for both groups, each with an evidence pointer; analyze --section flow prints them side by side', () => {
    for (const r of [B, C]) {
      expect(r.flow.flowComplete, JSON.stringify(r.flow.stages)).toBe(true);
      for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) { expect(r.flow.stages[id].status, `${r.runId} ${id}: ${r.flow.stages[id].detail}`).toBe('pass'); expect(r.flow.stages[id].evidence.length, `${r.runId} ${id} evidence`).toBeGreaterThan(0); }
      expect(r.flow.stages.S5.detail).toMatch(/same operator session/);   // the second operator task reused the first operator's session
      expect(r.failure).toMatchObject({ failedStep: null, flowStep: null, stageFailures: [], repeatedToolErrors: [], bugCandidate: false });
    }
    expect(d.stdout).toMatch(/B1 .*FLOW S1 pass S2 pass S3 pass S4 pass S5 pass \| flow COMPLETE/); expect(d.stdout).toMatch(/C1 .*FLOW S1 pass S2 pass S3 pass S4 pass S5 pass \| flow COMPLETE/);
    const a = spawnSync(process.execPath, [DRIVE, 'analyze', 'R11', 'B1', 'C1', '--section', 'flow', '--out', d.out], { cwd: REPO, encoding: 'utf8', env: env() });
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toMatch(/flow complete \| true \| true/); expect(a.stdout).toMatch(/S5 backlog-operator \(again, after the revision\)[^\n]* \| pass \| pass/); expect(a.stdout).toMatch(/S3 evidence \| task review/);
  });

  it('R11 AC11: the order the detector found is the order the tasks actually ran in (operator, review, operator) and the revision commit follows the review', () => {
    for (const r of [B, C]) {
      const rows = r.agents.filter((a: Rec) => a.parentTaskId); const created = rows.map((a: Rec) => Date.parse(a.createdAt));
      expect(created).toEqual([...created].sort((x: number, y: number) => x - y));
      const review = rows.find((a: Rec) => a.agent === 'review'); const ops = rows.filter((a: Rec) => a.agent === 'backlog-operator');
      expect(ops).toHaveLength(2); expect(Date.parse(ops[1].createdAt)).toBeGreaterThanOrEqual(Date.parse(review.completedAt)); expect(Date.parse(review.createdAt)).toBeGreaterThanOrEqual(Date.parse(ops[0].completedAt));
      expect(r.worktree.commits[1].ts).toBeGreaterThanOrEqual(Math.floor(Date.parse(review.completedAt) / 1000));
    }
  });

  it('R11 AC7: analyze prints the per-group facts side by side from the saved records', () => {
    const r = spawnSync(process.execPath, [DRIVE, 'analyze', 'R11', 'B1', 'C1', '--section', 'all', '--out', d.out], { cwd: REPO, encoding: 'utf8', env: env() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/== CONFIG FACT TABLE \(B1 \| C1\) ==/);
    expect(r.stdout).toMatch(/provider \| claudecli \| anthropic/);
    expect(r.stdout).toMatch(/picked item uid \| fake-0001 \| fake-0001/);
    expect(r.stdout).toMatch(/commit shas \| [0-9a-f]{10},[0-9a-f]{10} \| [0-9a-f]{10},[0-9a-f]{10}/);
    expect(r.stdout).toMatch(/submitted prompt byte-identical to TASK_PROMPT \| true \| true/);
    const bad = spawnSync(process.execPath, [DRIVE, 'analyze', 'R11', 'B1', 'C1', '--section', 'nope', '--out', d.out], { cwd: REPO, encoding: 'utf8', env: env() });
    expect(bad.status).toBe(2);
  });

  it('R11 AC6: a second invocation on the same output runs nothing (one run per group, no retry): both groups are skipped and their records are untouched', () => {
    const before = ['B1', 'C1'].map((id) => fs.statSync(path.join(d.out, 'runs', id, 'record.json')).mtimeMs);
    const r = spawnSync(process.execPath, [DRIVE, '--round', 'R11', '--out', d.out], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: env() });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/skip B1: record exists/); expect(r.stdout).toMatch(/skip C1: record exists/);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('PAUSED: awaiting owner instruction');
    expect(['B1', 'C1'].map((id) => fs.statSync(path.join(d.out, 'runs', id, 'record.json')).mtimeMs)).toEqual(before);
  }, 180_000);

  it('R11 AC6: `--live` without `--yes` refuses before any gate, reservation, worktree or spawn; `verdict`/`grid` do not apply to a design round', () => {
    const r = spawnSync(process.execPath, [DRIVE, '--live', '--round', 'R11'], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: env() });
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/Re-run with --yes/);
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);
    expect(fs.existsSync(path.join(path.dirname(REPO), 'r11-B'))).toBe(r11BExistedBefore);
    for (const m of ['verdict', 'grid']) { const v = spawnSync(process.execPath, [DRIVE, m, '--round', 'R11'], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: env() }); expect(v.status, m).toBe(2); expect(v.stderr).toMatch(/does not apply to design backlog-operator/); }
    expect(git(REPO, 'worktree', 'list', '--porcelain')).toBe(realWorktreesBefore);
  });

  it('R11 AC5 negative control: a mutant that drops mcpServers.backlog from backlog-operator leaves the backlog server with no call and no commit; the flow and the record say where it stopped', () => {
    const m = mutant((src) => src.replace("if (s.mcp.includes('backlog')) { if (!backlogServer)", 'if (false) { if (!backlogServer)'));
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.config.tools['backlog-operator'], id).not.toContain('mcp:backlog');   // AC4/AC5 expectation: ['fs:readOnly','mcp:backlog','shell']
      expect(fs.readFileSync(r.fakeBacklog.log, 'utf8').trim(), id).toBe('');   // AC5 expectation: query, claim, transition
      expect(r.worktree.commits, id).toHaveLength(0);
      expect(r.flow.flowComplete, id).toBe(false);
      expect(r.flow.stages.S1.status, id).toBe('fail');   // no item was selected, and the stage says so
      expect(r.failure.gaps, id).toContain('backlog-operator made no backlog tool call');
      expect(r.failure.stageFailures[0], id).toMatchObject({ stage: 'S1', status: 'fail', task: { agent: 'backlog-operator' } });   // AC12: the step, task and agent are named
      expect(r.failure.flowStep, id).toMatch(/^S1 backlog-operator dispatched/);
    }
    expect(m.stdout).toMatch(/FLOW S1 fail/);
  }, 480_000);

  it('R11 AC10/AC11 negative control: a mutant that does not register the review agent cannot pass S3, and the failing step is named', () => {
    const m = mutant((src) => src.replace('[DELEGATE_AGENT, REVIEW_AGENT, PARENT_AGENT]', '[DELEGATE_AGENT, PARENT_AGENT]'));
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.flow.flowComplete, id).toBe(false);
      expect(r.flow.stages.S1.status, `${id} S1`).toBe('pass');
      expect(r.flow.stages.S2.status, `${id} S2`).toBe('pass');
      expect(r.flow.stages.S3.status, `${id} S3: ${r.flow.stages.S3.detail}`).not.toBe('pass');
      expect(r.flow.stages.S5.status, `${id} S5`).not.toBe('pass');
      expect(r.failure.stageFailures.map((x: Rec) => x.stage), id).toEqual(expect.arrayContaining(['S3']));
      expect(r.failure.flowStep, id).toMatch(/^S3 review agent dispatched/);
    }
    expect(m.stdout).toMatch(/FLOW S1 pass S2 pass S3 (fail|unknown)/);
  }, 480_000);

  it('R11 AC7/AC12 negative control: without the sandbox widening the commit is refused, and the record names the refusal (Operation not permitted), the task, the agent and the last tool call', () => {
    const m = mutant((src) => src.replace("return { ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE_ROOTS: [set.root, ...extraRoots].join(','), ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE: [...keepDefaults, ...set.entries].join(',') };", 'return {};'));
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.worktree.commits, id).toHaveLength(0);
      expect(r.failure.gaps).toEqual(expect.arrayContaining(['no commit was made in the group worktree', 'no backlog_transition call was made']));
      expect(r.failure.evidence.join(' | ')).toMatch(/Operation not permitted/);
      expect(r.failure.evidence.join(' | ')).toMatch(/index\.lock/);
      expect(r.flow.stages.S2.status, id).toBe('fail');
      const s2 = r.failure.stageFailures.find((x: Rec) => x.stage === 'S2');
      expect(s2, id).toMatchObject({ status: 'fail', task: { agent: 'backlog-operator', status: 'completed' } });
      expect(s2.lastToolCall.name, id).toMatch(/shell_execute$/);
      expect(s2.errorText, id).toMatch(/Operation not permitted/);
      // the operator's `git add` and `git commit` were both refused: two errors from one tool in one task is the owner's "repeated tool errors are bugs" signal
      expect(r.failure.repeatedToolErrors, id).toEqual([expect.objectContaining({ agent: 'backlog-operator', tool: expect.stringMatching(/shell_execute$/), count: 2, bugCandidate: true, sample: expect.stringMatching(/Operation not permitted/) })]);
      expect(r.failure.bugCandidate, id).toBe(true);
    }
    expect(m.stdout).toMatch(/GAPS: .*no commit was made/); expect(m.stdout).toMatch(/BUG CANDIDATE: repeated tool errors/);
    expect(m.stdout.trim().split('\n').at(-1)).toBe('PAUSED: awaiting owner instruction');
  }, 480_000);
});

describe('R11 AC3: worktree creation and refusals against a real git repository', () => {
  function repo(branch = 'plan/x') {
    const dir = fs.mkdtempSync(path.join(scratch, 'wt-repo-'));
    git(dir, 'init', '-q', '-b', branch); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@invalid'); fs.writeFileSync(path.join(dir, 'f'), 'x'); git(dir, 'add', 'f'); git(dir, 'commit', '-q', '-m', 'base');
    return { dir, base: git(dir, 'rev-parse', 'HEAD') };
  }
  it('R11 AC3: createWorktree cuts parity/r11-B off the base into <main>/.worktrees/r11-B; a second attempt on the same path or branch is refused and nothing is removed', () => {
    const { dir, base } = repo(); const [wt] = BO.worktreePlan({ round: 'R11', arms: ['B'], mainRoot: dir });
    expect(BO.worktreeFreeReasons({ repoRoot: dir, plan: [wt] })).toEqual([]);
    const rec = BO.createWorktree({ repoRoot: dir, wt, baseSha: base });
    expect(rec).toMatchObject({ path: wt.path, branch: 'parity/r11-B', baseSha: base, headAtCreate: base });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan/x');
    expect(BO.worktreeFreeReasons({ repoRoot: dir, plan: [wt] }).join(' ')).toMatch(/already exists/);
    expect(() => BO.createWorktree({ repoRoot: dir, wt, baseSha: base })).toThrow(/already exists/);
    fs.rmSync(wt.path, { recursive: true, force: true }); git(dir, 'worktree', 'prune');   // test cleanup of its own throwaway repo only
    expect(BO.worktreeFreeReasons({ repoRoot: dir, plan: [wt] }).join(' ')).toMatch(/branch parity\/r11-B already exists/);
    const facts = BO.worktreeFacts({ wtPath: dir, baseSha: base });
    expect(facts).toMatchObject({ commits: [], uncommitted: [] });
  });
  it('R11 AC3: a repository on main (or a detached HEAD) is refused as the base: the worktrees are cut from the plan branch, never from main', () => {
    const { dir } = repo('main'); const plan = BO.worktreePlan({ round: 'R11', arms: ['B'], mainRoot: dir });
    expect(BO.worktreeFreeReasons({ repoRoot: dir, plan }).join(' ')).toMatch(/never from main/);
    const d2 = repo(); git(d2.dir, 'checkout', '-q', '--detach');
    expect(BO.worktreeFreeReasons({ repoRoot: d2.dir, plan: BO.worktreePlan({ round: 'R11', arms: ['B'], mainRoot: d2.dir }) }).join(' ')).toMatch(/detached HEAD/);
    expect(BO.mainCheckoutOf(d2.dir)).toBe(fs.realpathSync(d2.dir));
  });
  it('R11 AC6: the design preflight skips arms that already hold a ledger run, so a resumed round is not wedged by its own worktree', () => {
    const { dir } = repo(); const plan = BO.worktreePlan({ round: 'R11', arms: ['B', 'C'], mainRoot: dir });
    BO.createWorktree({ repoRoot: dir, wt: plan[0], baseSha: git(dir, 'rev-parse', 'HEAD') });
    const common = { repoRoot: dir, round: 'R11', arms: ['B', 'C'], agentsDir: rosterDir, distEntry: process.execPath, claude: process.execPath, mainRoot: dir, env: { PATH: '' }, spawn: () => ({ status: 0, stdout: '', stderr: '' }) };
    const all = BO.designPreflight({ ...common, pendingArms: ['B', 'C'] });
    expect(all.reasons.join(' ')).toMatch(/r11-B already exists/);
    const resumed = BO.designPreflight({ ...common, pendingArms: ['C'] });
    expect(resumed.reasons.join(' ')).not.toMatch(/r11-B/);
  });
});
