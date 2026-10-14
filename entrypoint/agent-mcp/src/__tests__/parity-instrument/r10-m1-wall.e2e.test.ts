/*
 * guards: an attribute the real server wrote into logs/trace is missing or altered in the evidence bundle, analyze --section wall prints numbers that differ from ones computed independently from the raw trace, the thinking_config and thinking_blocks table is wrong, arm A is not n/a, --self-check, --check-lib or --check-oracle exits non-zero (also under FORCE_COLOR=true), or a pre-existing analyze section changes bytes.
 * tier: P (spawns drive.mjs --dry-run, the built agent-mcp and the analyze CLI; e2e lane, ADR-0009)
 * gap: This cannot be observed at tier S because the trace under test is the one a freshly started real server just wrote, and the analyze and drive exit codes are those of separate processes.
 * cites: dcf8b7da AC1; R10 M1 AC1, AC2, AC4, AC6, AC7 (as titled in this file).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PARITY_DIR } from './load';
import { ATTR_SPECS, GOLDEN, compareBundleToRaw, expectedPrestart, expectedTaskFacts, kv, rawLines, wallBlock } from './r10-m1-fixture';

/**
 * R10 M1 - e2e lane (ADR-0009). `drive.mjs --dry-run --round R10` end to end against the REAL built agent-mcp (arm C over stdio MCP, tracing plugin sink pinned to the run dir), the instrument's fake
 * `claude` (arm A) and the in-process fake Anthropic server. No model, no network. The trace this test reads is the one the real server just wrote, and the `analyze` CLI is run as a subprocess.
 *   AC1  every attribute the real server emits is in the evidence bundle the dry run wrote (compared record by record with the raw trace file)
 *   AC2  `analyze ... --section wall` prints, per task thread and per dispatch, numbers equal to the ones computed independently from the raw trace file
 *   AC4  the model-call table shows thinking_config=none together with thinking_blocks>0 on the real trace
 *   AC6  --self-check / --check-lib / --check-oracle exit 0; every pre-existing analyze section on the r9 goldens is byte-identical to the pre-change capture
 *   AC7  arm A prints `n/a (native arm has no trace)`; arm C works (its sink is the run dir)
 */
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
let out = '';
beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-m1-dry-')); });
afterAll(() => { fs.rmSync(out, { recursive: true, force: true }); });

const run = (args: string[], timeout = 180_000, env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [DRIVE, ...args], { cwd: REPO, encoding: 'utf8', timeout, env });
/** The ambient environment with FORCE_COLOR pinned: nx exports FORCE_COLOR=true to every task, a bare shell does not - the instrument must pass in both. */
const withColor = (forceColor: string | undefined): NodeJS.ProcessEnv => { const e = { ...process.env }; if (forceColor === undefined) delete e.FORCE_COLOR; else e.FORCE_COLOR = forceColor; return e; };
const evidence = (id: string) => JSON.parse(fs.readFileSync(path.join(out, 'runs', id, 'evidence.json'), 'utf8'));
/** The tracing sink names its file by the UTC date it was opened on (the live run's date, never a constant), and writes a sibling metrics-snapshot file the regex excludes. */
const TRACE_FILE_RE = /^agent-mcp\.live-service-\d{4}-\d{2}-\d{2}\.jsonl$/;
const traceOf = (id: string) => { const d = path.join(out, 'runs', id, 'logs', 'trace'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => TRACE_FILE_RE.test(f)).map((f) => path.join(d, f)) : []; };
let wall = '';

describe('R10 M1: wall attribution on a fresh real-server mock-provider run', () => {
  it('R10 M1 AC7: the dry R10 round runs A1 and C1 to completion; the tracing sink of arm C is the run directory; arm A has no trace file', () => {
    const r = run(['--dry-run', '--round', 'R10', '--out', out], 420_000);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(traceOf('C1')).toHaveLength(1); expect(traceOf('A1')).toHaveLength(0);
  }, 480_000);

  it('R10 M1 AC1: every R10 attribute the real server wrote into logs/trace is present, and equal, in the evidence bundle (record by record)', () => {
    const lines = rawLines(traceOf('C1')[0]); const r = compareBundleToRaw(lines, evidence('C1'));
    const realEmits = ATTR_SPECS.map((s) => s.attr).filter((a) => !['agent.tool.queued_ms', 'agent.dispatch.wait_ms'].includes(a));   // queue_wait_ms / session_ms: stamped on dispatched children since R10 M2, so the real server carries them
    for (const a of realEmits) { expect(r[a].seen, `${a} exercised by the real server`).toBeGreaterThan(0); expect(r[a].mismatches, a).toEqual([]); }
    expect(r['agent.startup.mcp_connect_ms.<server>'].seen).toBeGreaterThan(0); expect(r['agent.startup.mcp_connect_ms.<server>'].mismatches).toEqual([]);
    // an attribute a raw record does not carry is null in the bundle (never 0); one it carries is equal (queue_wait_ms / session_ms appear when the product stamps them, wait_ms on `result` waits)
    const b = evidence('C1');
    for (const r of lines.filter((l) => l.event === 'agent.task.startup.finish')) {
      const su = b.trace.tasks.find((t: { task: string }) => t.task === r['agent.task_id']).startup;
      expect(su.queueWaitMs, String(r['agent.task_id'])).toBe(r['agent.startup.queue_wait_ms'] ?? null); expect(su.sessionMs, String(r['agent.task_id'])).toBe(r['agent.startup.session_ms'] ?? null);
    }
    for (const r of lines.filter((l) => l.event === 'agent.dispatch.finish')) {
      const d = b.trace.dispatches.find((x: { task: string; callId: string }) => x.task === r['agent.task_id'] && x.callId === r['agent.dispatch.call_id']);
      expect(d.waitMs).toBe(r['agent.dispatch.wait_ms'] ?? null);
    }
  });

  it('R10 M1 AC2/AC7: `analyze --section wall` on the live bundles: A prints the native n/a line, C prints per-thread and per-dispatch numbers equal to the independent computation from the raw trace', () => {
    const r = run(['analyze', 'R10', path.join(out, 'runs', 'A1', 'evidence.json'), path.join(out, 'runs', 'C1', 'evidence.json'), '--section', 'wall']);
    expect(r.status, r.stdout + r.stderr).toBe(0); wall = r.stdout;
    expect(wallBlock(wall, 'A1').filter(Boolean)).toEqual(['n/a (native arm has no trace)']);
    const rows = wallBlock(wall, 'C1'); const lines = rawLines(traceOf('C1')[0]);
    const tasks = lines.filter((l) => l.event === 'agent.task.finish');
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    for (const t of tasks) {
      const id = String(t['agent.task_id']); const x = expectedTaskFacts(lines, id); const l = rows.find((q) => q.startsWith(`${id.slice(0, 8)} | `)) as string;
      expect(l, id).toBeDefined(); expect(kv(l, 'model_ms')).toBe(String(x.modelMs)); expect(kv(l, 'tool_ms')).toBe(String(x.toolMs)); expect(kv(l, 'idle_ms')).toBe(String(x.idleMs)); expect(kv(l, 'tools_ready_ms')).toBe(String(x.toolsReadyMs));
      expect(l).toContain(`idle_ms=${x.idleMs} = startup ${x.toolsReadyMs} + unexplained ${(x.idleMs as number) - (x.toolsReadyMs as number)}`);
    }
    const dispatches = lines.filter((l) => l.event === 'agent.dispatch.finish'); expect(dispatches.length).toBeGreaterThanOrEqual(4);
    for (const d of dispatches) {
      const child = String(d['agent.dispatch.child_task_ids']); const l = rows.find((q) => q.includes(` | child ${child.slice(0, 8)} | `)) as string;
      expect(kv(l, 'child_prestart_ms'), child).toBe(String(expectedPrestart(lines, d, child)));
      expect(kv(l, 'parent_blocked_ms')).toBe(String(d['agent.dispatch.parent_blocked_ms']));
      const su = lines.find((q) => q.event === 'agent.task.startup.finish' && q['agent.task_id'] === child) as Raw; const pre = expectedPrestart(lines, d, child);
      expect(l).toContain(`child_prestart_ms=${pre} (queue_wait_ms=${su['agent.startup.queue_wait_ms']} + session_ms=${su['agent.startup.session_ms']} + remainder ${pre - (su['agent.startup.queue_wait_ms'] as number) - (su['agent.startup.session_ms'] as number)})`);
    }
  });

  it('R10 M1 AC4: the live model-call table prints thinking_config and thinking_blocks together, labelled', () => {
    const rows = wallBlock(wall, 'C1'); const n = rawLines(traceOf('C1')[0]).filter((l) => l.event === 'agent.model_call.finish').length;
    // R10 launch prep (SCOPE-R10-thinking-parity): the R10 round now sends thinking {type:'adaptive'} on arm C, so the product's trace reports thinking_config=adaptive on every call; the
    // `none (no thinking field sent ...)` label is still proven against the unmodified-config fixture in r10-m1-wall.test.ts
    expect(n).toBeGreaterThan(0);
    expect(rows.filter((r) => r.includes('| thinking_config=adaptive | thinking_blocks=1 |'))).toHaveLength(n);
    expect(rows.filter((r) => r.includes('| thinking_config=none'))).toHaveLength(0);
  });
});

describe('R10 M1 AC6: the instrument still reproduces itself', () => {
  it.each(['--self-check', '--check-lib', '--check-oracle'])('R10 M1 AC6: drive.mjs %s exits 0', (flag) => {
    const r = run([flag], 300_000); expect(r.status, r.stdout.slice(-2000) + r.stderr).toBe(0);
  }, 320_000);

  it.each(['true', undefined])('dcf8b7da AC1: drive.mjs --check-lib exits 0 and passes every case, including the process-sweep case, with FORCE_COLOR=%s (true is what nx exports; undefined is a bare shell)', (forceColor) => {
    const r = run(['--check-lib'], 300_000, withColor(forceColor)); expect(r.status, r.stdout.slice(-2000) + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/lib self-test: PASS (\d+)\/\1\b/); expect(r.stdout).toContain('ok   sweep: kills an owned process and its descendant, leaves an unrelated process alone');
  }, 320_000);

  it.each(['gap', 'threads', 'blocking', 'surplus', 'tools', 'contamination', 'rt', 'evidence', 'all'])('R10 M1 AC6: the analyze CLI (subprocess) --section %s on the r9 goldens is byte-identical to the pre-change capture (all = that capture + the appended wall sections)', (s) => {
    const r = run(['analyze', 'R10', path.join(GOLDEN, 'r9-A1.bundle.json'), path.join(GOLDEN, 'r9-C1.bundle.json'), '--section', s]);
    expect(r.status, r.stderr).toBe(0);
    const base = fs.readFileSync(path.join(GOLDEN, 'm1-baseline', `analyze-r9-${s}.txt`), 'utf8');
    if (s === 'all') { const before = base.slice(0, -1); expect(r.stdout.startsWith(before)).toBe(true); expect(r.stdout.slice(before.length).startsWith('\n\n== WALL ATTRIBUTION A1 (A) ==\nn/a (native arm has no trace)')).toBe(true); } else expect(r.stdout).toBe(base);
  });
});
