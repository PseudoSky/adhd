/*
 * guards: the R12 round, run against the real built server with a stand-in adhd-backlog CLI in the real sandboxed shell, regresses: the operator
 *   definition gains an MCP backlog server or loses adhd-backlog from the allowlist, the CLI does not run in the sandbox, S1-S5 or the
 *   record (before-snapshot, call ids, bug-candidate kinds) disagree with state, or worktree residue is not reported or gets reverted.
 * tier: P (e2e lane, ADR-0009: spawns drive.mjs, the built agent-mcp, the fake claude, the sandboxed shell and git)
 * gap: This cannot be observed at tier S because the operator definition as the server received it, the sandboxed shell running the CLI and
 *   the uncommitted-change residue exist only across real process boundaries and a real git repository.
 * cites: SCOPE-R12-schema-and-scope, SCOPE-R12-backlog-cli; R12 AC1-AC6 as named in this file; no backlog uid is named in the file.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * R12 (SCOPE-R12-schema-and-scope, SCOPE-R12-backlog-cli), e2e lane (ADR-0009): the real `drive.mjs --round R12` (a bare design round is the OFFLINE dry run) against the REAL built agent-mcp
 * over stdio MCP, the instrument's fake Anthropic upstream, the fake `claude` (arm B), a stand-in `adhd-backlog` CLI that the operator runs through the REAL sandboxed shell tool, and a throwaway
 * git repository with real linked worktrees. No model call, no network, no `--live`, no production backlog is read or written. The throwaway repo lives under repo-root tmp/ (under the home
 * directory, as the sandbox write roots require). The paid path (`--live --yes --round R12`) is owned by nix (repo owner); it is never run here.
 *   AC1 the operator definition as the server received it has NO backlog MCP server and the shell allowlist (product default + adhd-backlog); the CLI really ran in the sandbox; project scope facts
 *   AC2 S1 on the real record: pass; out-of-repo pick; operator died; operator stopped; refused write; and the allowlist and project-resolution negative controls
 *   AC3 the snapshot and the picked item's classification in the record
 *   AC4 task-unique call ids with timestamps, untruncated failure text, bug-candidate kinds
 *   AC5 worktree residue (uncommitted changes per group, BACKLOG.md hand edits flagged, nothing reverted) on a real git repository
 *   AC6 the bare dry run: exit 0, the flow section printed, the ledger untouched, worktrees r12-B / r12-C on parity/r12-B / parity/r12-C
 */
const BO = await loadParity('backlog-operator.mjs');
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');

const PERFORMANCE = '---\nname: performance\ndescription: Performance agent\ntools: Read, Edit, Bash, Glob, Grep, Task\nmodel: haiku\n---\n# performance\n\nYou are the performance agent (fixture body).\n';
const REVIEW = '---\nname: review\ndescription: Read-only reviewer\ntools: Read, Grep, Glob\nmodel: sonnet\ndisallowedTools: Edit, Write, NotebookEdit\n---\n# review\n\nYou review a change (fixture body).\n';
const OPERATOR = '---\nname: backlog-operator\ndescription: Backlog operator\ntools: Read, Bash, mcp__backlog__*\nmodel: haiku\ndisallowedTools: Edit, NotebookEdit\n---\n# backlog-operator\n\nYou operate the backlog (fixture body).\n';

const cleanup: string[] = [];
const scratch = path.join(REPO, 'tmp', 'agent-mcp', 'parity', `r12-e2e-${process.pid}`);
fs.mkdirSync(scratch, { recursive: true }); cleanup.push(scratch);
const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-e2e-roster-')); cleanup.push(rosterDir);
fs.writeFileSync(path.join(rosterDir, 'performance.md'), PERFORMANCE); fs.writeFileSync(path.join(rosterDir, 'backlog-operator.md'), OPERATOR); fs.writeFileSync(path.join(rosterDir, 'review.md'), REVIEW);
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const env = (extra: Record<string, string> = {}) => { const e: Record<string, string> = {}; for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PARITY_')) e[k] = v; return { ...e, PARITY_AGENTS_DIR: rosterDir, PARITY_DRY_REPO_BASE: path.join(scratch, 'repos'), ...extra }; };
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function dry(extraEnv: Record<string, string> = {}, drive = DRIVE, args: string[] = []) {
  const out = fs.mkdtempSync(path.join(scratch, 'out-'));
  const r = spawnSync(process.execPath, [drive, '--round', 'R12', '--out', out, ...args], { cwd: REPO, encoding: 'utf8', timeout: 420_000, env: env(extraEnv) });
  const rec = (id: string): Rec => readJson(path.join(out, 'runs', id, 'record.json'));
  const calls = (id: string): Rec[] => readJson(path.join(out, 'runs', id, 'mcp-calls.json'));
  return { out, r, stdout: r.stdout, rec, calls };
}
/** Run with a mutated copy of the instrument (written beside the real files, deleted in `finally`; no tracked file is ever modified). */
function mutant(edit: (boSrc: string) => string, extraEnv: Record<string, string> = {}) {
  const bo = fs.readFileSync(path.join(PARITY_DIR, 'backlog-operator.mjs'), 'utf8'); const mutated = edit(bo); expect(mutated, 'the mutation must change the source').not.toBe(bo);
  const boFile = path.join(PARITY_DIR, `backlog-operator.r12-mutant-${process.pid}.mjs`); const driveFile = path.join(PARITY_DIR, `drive.r12-mutant-${process.pid}.mjs`);
  const drv = fs.readFileSync(DRIVE, 'utf8'); expect(drv).toContain("'./backlog-operator.mjs'");
  fs.writeFileSync(boFile, mutated); fs.writeFileSync(driveFile, drv.replace("'./backlog-operator.mjs'", `'./${path.basename(boFile)}'`));
  try { return dry(extraEnv, driveFile); } finally { fs.rmSync(boFile, { force: true }); fs.rmSync(driveFile, { force: true }); }
}
const callLog = (r: Rec) => fs.readFileSync(path.join(r.worktree.mainRoot, `.fake-backlog-${r.arm}`, 'backlog-calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('R12: the backlog-operator design with CLI access, offline dry run against the real built server', () => {
  const ledgerFile = path.join(PARITY_DIR, 'ledger', 'R12.json');
  const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
  const realWorktreesBefore = git(REPO, 'worktree', 'list', '--porcelain');
  let d: ReturnType<typeof dry>; let B: Rec; let C: Rec;
  beforeAll(() => { d = dry(); B = d.rec('B1'); C = d.rec('C1'); }, 480_000);

  it('R12 AC6: a bare `--round R12` is the offline dry run: exit 0, both groups recorded, the flow section printed, ending with the pause line; the ledger is untouched and records no run', () => {
    expect(d.r.status, d.stdout + d.r.stderr).toBe(0);
    const lines = d.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.at(-1)).toBe('PAUSED: awaiting owner instruction');
    expect(d.stdout).toMatch(/^DRY-RUN \(no model call\) design backlog-operator plan: B -> C/m);
    expect(d.stdout).toMatch(/== FLOW STAGES .*\(B1 \| C1\) ==/);   // the flow section is part of the run output
    expect(d.stdout).toMatch(/flow complete \| true \| true/);
    expect(d.stdout).toMatch(/B1 .*\[in-repo: project adhd\].*FLOW S1 pass S2 pass S3 pass S4 pass S5 pass \| flow COMPLETE/);
    for (const r of [B, C]) expect(r).toMatchObject({ design: 'backlog-operator', mode: 'dry-run', round: 'R12', result: { status: 'completed' } });
    expect(readJson(path.join(d.out, 'SUMMARY.json'))).toMatchObject({ backlogAccess: 'cli', identicalGroups: { ok: true } });
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);
    expect(readJson(ledgerFile).runs).toEqual([]);
    expect(git(REPO, 'worktree', 'list', '--porcelain')).toBe(realWorktreesBefore);   // the real repository's worktree list is exactly what it was
  });

  it('R12 AC6: the groups ran in worktrees r12-B and r12-C on branches parity/r12-B and parity/r12-C (R11\'s names are untouched)', () => {
    for (const [r, arm] of [[B, 'B'], [C, 'C']] as const) {
      expect(r.worktree.path).toBe(path.join(r.worktree.mainRoot, '.worktrees', `r12-${arm}`));
      expect(r.worktree.branch).toBe(`parity/r12-${arm}`);
      expect(fs.existsSync(r.worktree.path)).toBe(true);
      expect(r.worktree.commits).toHaveLength(2);
    }
    expect(BO.worktreePlan({ round: 'R11', arms: ['B'], mainRoot: '/m' })[0]).toMatchObject({ path: '/m/.worktrees/r11-B', branch: 'parity/r11-B' });
  });

  it('R12 AC1: the backlog-operator as the server received it has NO backlog MCP server and the shell allowlist = the product default plus exactly adhd-backlog, identical in B and C; the fact table records it', () => {
    const sent = (id: string) => Object.fromEntries(d.calls(id).filter((c) => c.name === 'agent_create').map((c) => [c.args.name, c.args]));
    const sb = sent('B1'); const sc = sent('C1');
    for (const s of [sb, sc]) {
      expect(s['backlog-operator'].mcpServers).toBeUndefined();
      expect(s.performance.mcpServers).toBeUndefined(); expect(s.review.mcpServers).toBeUndefined();
      const allow: string[] = s['backlog-operator'].nativeTooling.shell.allowCommands;
      expect(allow).toContain('adhd-backlog'); expect(allow).toContain('git');
      expect(allow.filter((x) => !BO.productShellDefault().commands.includes(x))).toEqual(['adhd-backlog']);
      expect(s.review.nativeTooling.shell).toBe(false);
    }
    expect(sb['backlog-operator'].nativeTooling.shell).toEqual(sc['backlog-operator'].nativeTooling.shell);
    expect(B.config.shellAllowCommands['backlog-operator'].sha256).toBe(C.config.shellAllowCommands['backlog-operator'].sha256);
    expect(B.config).toMatchObject({ backlogAccess: 'cli', shellAllowAddedToProductDefault: ['adhd-backlog'] });
    expect(B.config.backlogServer).toBeUndefined();
    expect(B.config.backlogCli).toMatchObject({ executable: 'adhd-backlog', mcpServerAttached: false, productionWriteFlag: '--allow-production-write', fake: true });
    expect(B.config.tools['backlog-operator']).not.toContain('mcp:backlog');
    expect(readJson(path.join(d.out, 'SUMMARY.json')).identicalGroups).toEqual({ ok: true, reasons: [] });
  });

  it('R12 AC1: project scope is not cwd-derived; the resolved repository project is recorded in the config facts, identically for both groups', () => {
    for (const r of [B, C]) {
      expect(r.config.backlogScope).toMatchObject({ cwdDerived: false, repoProject: { name: 'adhd', resolvedBy: 'registered path equals the main checkout' }, registryErrors: [] });
      expect(r.config.backlogScope.how).toMatch(/not scoped by the shell cwd/i);
    }
    expect(B.config.backlogScope).toEqual(C.config.backlogScope);
  });

  it('R12 AC1: the stand-in CLI really ran INSIDE the sandboxed shell: claim and transition carried --allow-production-write, reads did not need it, and the call order is query, get, claim, then the transition by the SAME operator', () => {
    for (const r of [B, C]) {
      const log = callLog(r);
      expect(log.map((e) => e.verb)).toEqual(['query', 'get', 'claim', 'transition']);
      expect(log.filter((e) => ['claim', 'transition'].includes(e.verb)).every((e) => e.allowProductionWrite === true && e.ok === true)).toBe(true);
      expect(log[0].argv).toEqual(['query', '--input', expect.stringContaining('"view":"ready"')]);
      const opCalls = r.toolCalls.filter((t: Rec) => t.agent === 'backlog-operator').flatMap((t: Rec) => t.calls.map((c: Rec) => c.name));
      expect(opCalls.filter((n: string) => /backlog_/.test(n)), 'no backlog MCP tool exists').toEqual([]);
      expect(opCalls.filter((n: string) => /shell_execute$/.test(n)).length).toBeGreaterThanOrEqual(4);
      const observed: string[] = r.observedTools['backlog-operator'].map((t: string) => t.replace(/^.*__/, ''));
      expect(observed).toEqual(expect.arrayContaining(['shell_execute'])); expect(observed.filter((n) => /^backlog_/.test(n))).toEqual([]);   // the tools OFFERED to the model carry no backlog MCP tool
    }
  });

  it('R12 AC2: S1-S5 all pass from state for both groups, with S1 reason "selected"; the S5 evidence is the operator\'s transition CLI call plus the read-back status change', () => {
    for (const r of [B, C]) {
      expect(r.flow.flowComplete, JSON.stringify(r.flow.stages)).toBe(true);
      expect(r.flow.stages.S1.reason).toBe('selected');
      expect(r.flow.stages.S1.detail).toMatch(/selected through a successful adhd-backlog transition \(project adhd/);
      expect(r.flow.stages.S5.detail).toMatch(/open -> done/);
      expect(r.failure).toMatchObject({ failedStep: null, flowStep: null });
    }
  });

  it('R12 AC3: the record has the before-snapshot (project, component per item, truthful complete), the picked item classified in-repo from state, and the resolved registry', () => {
    for (const r of [B, C]) {
      const b = r.backlog.before;
      expect(b).toMatchObject({ complete: true, total: 3, itemsRead: 3, distinct: 3 });
      expect(b.items.every((i: Rec) => i.project === b.repoProject.uid && typeof i.component === 'string')).toBe(true);
      expect(b.items.map((i: Rec) => i.status)).toEqual(['open', 'open', 'open']);
      expect(r.backlog.registry.projects.map((p: Rec) => p.name)).toEqual(['adhd', 'scratch']);
      expect(r.backlog.item).toMatchObject({ classification: 'in-repo', inRepo: true, projectName: 'adhd', componentName: '(root)', nonTerminalBefore: true, unblockedBefore: true, statusBefore: 'open', statusAfter: 'done', transitioned: true, pickedVia: 'transition' });
      expect(r.backlog.after.items[0]).toMatchObject({ status: 'done', projectName: 'adhd' });
      expect(r.backlog.calls).toMatchObject({ refusedWrites: 0, pickedVia: 'transition' });
    }
  });

  it('R12 AC4: every call in the record has a task-unique id and a timestamp, even though both claudecli tasks start numbering at bridge-1; the failure detail is whole', () => {
    for (const r of [B, C]) {
      const calls = r.toolCalls.flatMap((t: Rec) => t.calls) as Rec[];
      const ids = calls.map((c) => c.id);
      expect(new Set(ids).size, `${r.runId}: ${ids.length} calls`).toBe(ids.length);
      expect(calls.every((c) => typeof c.ts === 'string' && !Number.isNaN(Date.parse(c.ts)) && c.tsSource)).toBe(true);
      expect(r.callIds).toEqual({ total: ids.length, unique: ids.length, withTime: ids.length });
      for (const t of r.toolCalls) for (const c of t.calls) expect(c.id.startsWith(`${t.taskId}:`)).toBe(true);
    }
    const bridgeIds = (B.toolCalls.flatMap((t: Rec) => t.calls) as Rec[]).filter((c) => /:bridge-\d+$/.test(c.id)).map((c) => c.id.replace(/^.*:/, ''));
    expect(new Set(bridgeIds).size, 'arm B restarts bridge-N per task, so the bare ids repeat').toBeLessThan(bridgeIds.length);
    expect(B.failure.bugCandidate).toEqual({ operatorDied: [], operatorStopped: [], repeatedToolErrors: [], any: false });
  });

  it('R12 AC5: a clean run leaves no residue and says so; the groups\' worktrees are reported uncommitted-free', () => {
    for (const r of [B, C]) {
      expect(r.worktree).toMatchObject({ uncommittedChanges: [], uncommittedCount: 0, backlogMdHandEdited: false });
      expect(r.worktree.backlogMdPaths).toEqual({ committed: [], uncommitted: [] });
    }
  });
});

describe('R12 AC2/AC4: the real record under each negative control (scripted operator behaviour in the dry run)', () => {
  it('another project\'s item is picked: S1 FAIL "out-of-repo pick" naming uid, project and component; the item is classified out-of-repo from state', () => {
    const m = dry({ PARITY_FAKE_BO_MODE: 'other-project' });
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.flow.stages.S1, id).toMatchObject({ status: 'fail', reason: 'out-of-repo-pick' });
      expect(r.flow.stages.S1.detail, id).toMatch(/a0000005-0000-4000-8000-000000000005/); expect(r.flow.stages.S1.detail).toMatch(/scratch/); expect(r.flow.stages.S1.detail).toMatch(/reaper/);
      expect(r.backlog.item).toMatchObject({ classification: 'out-of-repo', inRepo: false, projectName: 'scratch', componentName: 'reaper' });
      expect(r.flow.flowComplete).toBe(false); expect(r.failure.flowStep).toMatch(/^S1 /);
      expect(r.failure.stageFailures[0]).toMatchObject({ stage: 'S1', status: 'fail' });
    }
    expect(m.stdout).toMatch(/\[out-of-repo: project scratch\]/);
  }, 480_000);

  it('the operator died before any read: S1 FAIL operator-died naming the failing step; bugCandidate.operatorDied, not operatorStopped', () => {
    const m = dry({ PARITY_FAKE_BO_MODE: 'die' });
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.flow.stages.S1, id).toMatchObject({ status: 'fail', reason: 'operator-died' });
      expect(r.flow.stages.S1.detail, id).toMatch(/died before selecting an item/); expect(r.flow.stages.S1.detail).toMatch(/failing step/);
      expect(r.failure.bugCandidate.operatorDied.length, id).toBeGreaterThan(0); expect(r.failure.bugCandidate.operatorStopped).toEqual([]); expect(r.failure.bugCandidate.any).toBe(true);
      expect(r.flow.flowComplete).toBe(false);
    }
    expect(m.stdout).toMatch(/BUG CANDIDATE: operatorDied/);
  }, 480_000);

  it('the operator read the ready view and stopped: S1 FAIL operator-stopped; bugCandidate.operatorStopped, not operatorDied', () => {
    const m = dry({ PARITY_FAKE_BO_MODE: 'stop' });
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.flow.stages.S1, id).toMatchObject({ status: 'fail', reason: 'operator-stopped' });
      expect(r.backlog.item.picked).toBeNull();
      expect(r.failure.bugCandidate.operatorStopped.length, id).toBeGreaterThan(0); expect(r.failure.bugCandidate.operatorDied).toEqual([]);
    }
    expect(m.stdout).toMatch(/BUG CANDIDATE: operatorStopped/);
  }, 480_000);

  it('a claim without --allow-production-write is REFUSED by the CLI: it is counted as a refused write, selects nothing by itself (the get does), and S5 fails; the item is unchanged', () => {
    const m = dry({ PARITY_FAKE_BO_MODE: 'noflag' });
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.backlog.calls).toMatchObject({ refusedWrites: 1, pickedVia: 'get' });
      expect(r.backlog.item).toMatchObject({ statusBefore: 'open', statusAfter: 'open' });
      expect(r.flow.stages.S5.status, id).not.toBe('pass'); expect(r.flow.flowComplete).toBe(false);
      const refused = r.toolCalls.flatMap((t: Rec) => t.calls).find((c: Rec) => /Refused: \\?"claim\\?" would write/.test(String(c.resultText)));
      expect(refused, id).toBeTruthy(); expect(refused.resultText).toMatch(/--allow-production-write/);
      expect(r.failure.toolErrorGroups.every((g: Rec) => g.cls !== 'nonzero-exit' || g.bugCandidate === false)).toBe(true);
    }
  }, 480_000);

  it('negative control (allowlist): without adhd-backlog in the operator\'s shell allowlist the real shell server refuses every CLI call and S1 cannot pass', () => {
    const m = mutant((src) => src.replace("def.nativeTooling = { ...def.nativeTooling, shell: { allowCommands: [...shellAllow.commands] } };", 'def.nativeTooling = { ...def.nativeTooling };'));
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.flow.stages.S1.status, id).toBe('fail'); expect(r.flow.flowComplete).toBe(false);
      const texts = r.toolCalls.flatMap((t: Rec) => t.calls).map((c: Rec) => String(c.resultText)).join('\n');
      expect(texts).toMatch(/Command not allowed: adhd-backlog|rejected by default security policy: adhd-backlog/);
      const cliCalls = r.toolCalls.flatMap((t: Rec) => t.calls).filter((c: Rec) => /shell_execute$/.test(c.name) && /adhd-backlog/.test(JSON.stringify(c.input)));
      expect(cliCalls.length, id).toBeGreaterThan(0); expect(cliCalls.every((c: Rec) => c.isError === true), `${id}: every adhd-backlog call was rejected by the shell server`).toBe(true);
      expect(r.backlog.calls.successfulCliCalls, id).toBe(0);
    }
  }, 480_000);

  it('negative control (project scope): when the repository project cannot be resolved, S1 is unknown with reason project-unresolved, never pass', () => {
    const m = mutant((src) => src.replace('export function resolveRepoProject(registry, { mainRoot }) {', 'export function resolveRepoProject(registry, { mainRoot }) { return null;'));
    expect(m.r.status, m.stdout + m.r.stderr).toBe(0);
    for (const id of ['B1', 'C1']) {
      const r = m.rec(id);
      expect(r.config.backlogScope.repoProject).toBeNull();
      expect(r.backlog.before).toMatchObject({ complete: false, error: expect.stringMatching(/could not be resolved/) });
      expect(r.flow.stages.S1.status, id).not.toBe('pass'); expect(r.flow.flowComplete).toBe(false);
    }
  }, 480_000);
});

describe('R12 AC5: worktree residue on a real git repository; the harness only reports and never reverts or deletes', () => {
  function repo() {
    const dir = fs.mkdtempSync(path.join(scratch, 'resid-'));
    git(dir, 'init', '-q', '-b', 'plan/x'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@invalid');
    fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# backlog\n'); fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
    return { dir, base: git(dir, 'rev-parse', 'HEAD') };
  }
  it('uncommitted changes are listed per path with their status, an uncommitted BACKLOG.md edit is flagged, and every file is left exactly as found', () => {
    const { dir, base } = repo();
    fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# backlog\n- hand edit\n'); fs.writeFileSync(path.join(dir, 'f.txt'), 'changed\n'); fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
    const before = { b: fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8'), f: fs.readFileSync(path.join(dir, 'f.txt'), 'utf8') };
    const facts = BO.worktreeFacts({ wtPath: dir, baseSha: base });
    expect(facts.uncommittedCount).toBe(3);
    expect(facts.uncommittedChanges).toEqual(expect.arrayContaining([{ status: 'M', path: 'BACKLOG.md' }, { status: 'M', path: 'f.txt' }, { status: '??', path: 'new.txt' }]));
    expect(facts.backlogMdHandEdited).toBe(true); expect(facts.backlogMdPaths).toEqual({ committed: [], uncommitted: ['BACKLOG.md'] });
    expect(fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8')).toBe(before.b); expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(before.f);   // nothing reverted
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(true);   // nothing deleted
    expect(git(dir, 'status', '--porcelain').split('\n')).toHaveLength(3);
  });
  it('a COMMITTED BACKLOG.md edit is flagged too; a clean tree is not (negative control)', () => {
    const { dir, base } = repo();
    expect(BO.worktreeFacts({ wtPath: dir, baseSha: base })).toMatchObject({ backlogMdHandEdited: false, uncommittedChanges: [], uncommittedCount: 0 });
    fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'BACKLOG.md'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'edit backlog');
    const facts = BO.worktreeFacts({ wtPath: dir, baseSha: base });
    expect(facts.backlogMdHandEdited).toBe(true); expect(facts.backlogMdPaths.committed).toEqual(['sub/BACKLOG.md']);
    fs.writeFileSync(path.join(dir, 'g.txt'), 'g\n'); git(dir, 'add', 'g.txt');
    expect(BO.worktreeFacts({ wtPath: dir, baseSha: base }).uncommittedChanges).toEqual([{ status: 'A', path: 'g.txt' }]);
  });
});
