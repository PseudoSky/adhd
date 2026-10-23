import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadParity, PARITY_DIR } from './load';

/**
 * Shared helpers of the R10 M1 tests (wall attribution read from the R10 trace signals). NOT a test file.
 *
 * `rawLines` / `bundleOf` take the RAW tracing-plugin JSONL (one flat JSON object per line, exactly as the sink writes it) and run it through the real `evidence.mjs` `buildBundle`.
 * `expectedPrestart` / `expectedTaskFacts` are the tests' OWN few-line joins over the raw records: they share no code with `analyze.mjs`, so a number the analysis prints can be compared
 * with a number computed independently from the same raw records.
 */
export type Raw = Record<string, string | number | boolean | undefined>;

export const GOLDEN = path.join(PARITY_DIR, 'golden', 'r10');
export const SYNTHETIC_TRACE = path.join(GOLDEN, 'r10-m1-synthetic-C1.trace.jsonl');
export const DRYRUN_TRACE = path.join(GOLDEN, 'r10-m1-dryrun-C1.trace.jsonl');
export const TRACE_FILE_NAME = 'agent-mcp.live-service-2026-10-13.jsonl';

export const parseLines = (text: string): Raw[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Raw);
export const rawLines = (file: string): Raw[] => parseLines(fs.readFileSync(file, 'utf8'));

const made: string[] = [];
/** Remove every temp run directory created by `bundleOf` (call from afterAll). */
export function cleanupRuns(): void { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); }

/** Write `lines` as the trace file of a fresh run directory and build the redacted evidence bundle of it with the real `buildBundle`. */
export async function bundleOf(lines: Raw[], arm = 'C') {
  const EV = await loadParity('evidence.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-m1-run-')); made.push(dir);
  fs.mkdirSync(path.join(dir, 'logs', 'trace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'trace', TRACE_FILE_NAME), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const bundle = EV.buildBundle(dir, { arm, record: { runId: `${arm}1`, arm, wallMs: 0 } }).bundle;
  return bundle;
}

/** Write a bundle to a temp .json file (the `analyze` CLI reads bundles by path) and return the path. */
export function writeBundle(bundle: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-m1-bundle-')); made.push(dir);
  const f = path.join(dir, 'bundle.json'); fs.writeFileSync(f, JSON.stringify(bundle)); return f;
}

const ms = (iso: string | number | boolean | undefined) => Date.parse(String(iso));

/** child_prestart_ms by the tests' own join: child `agent.task.start` ts minus the `agent.tool_call.start` ts whose call id is the dispatch's `call_id`. */
export function expectedPrestart(lines: Raw[], dispatch: Raw, childId: string): number {
  const call = lines.find((l) => l.event === 'agent.tool_call.start' && l['agent.tool.call_id'] === dispatch['agent.dispatch.call_id'] && l['agent.task_id'] === dispatch['agent.task_id']);
  const child = lines.find((l) => l.event === 'agent.task.start' && l['agent.task_id'] === childId);
  if (!call || !child) throw new Error(`fixture lacks the join for ${String(dispatch['agent.dispatch.call_id'])} -> ${childId}`);
  return ms(child.ts) - ms(call.ts);
}

/** Per-task facts straight from the raw records. */
export function expectedTaskFacts(lines: Raw[], task: string) {
  const fin = lines.find((l) => l.event === 'agent.task.finish' && l['agent.task_id'] === task);
  const su = lines.find((l) => l.event === 'agent.task.startup.finish' && l['agent.task_id'] === task);
  const queued = lines.filter((l) => l.event === 'agent.tool_call.start' && l['agent.task_id'] === task && typeof l['agent.tool.queued_ms'] === 'number').map((l) => l['agent.tool.queued_ms'] as number);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    wallMs: num(fin?.duration_ms), modelMs: num(fin?.['agent.task.model_ms']), toolMs: num(fin?.['agent.task.tool_ms']), idleMs: num(fin?.['agent.task.idle_ms']),
    toolsReadyMs: num(su?.['agent.startup.tools_ready_ms']), queuedSum: queued.length ? queued.reduce((a, b) => a + b, 0) : undefined,
  };
}

/** The raw-attribute -> bundle-field map of AC1. `get` receives the bundle and the raw record and returns the bundle value for THIS record (undefined when the bundle has no such record). */
type Bundle = { trace: { toolCalls: Record<string, unknown>[]; modelCalls: Record<string, unknown>[]; tasks: Record<string, unknown>[]; dispatches: Record<string, unknown>[] } };
export type AttrSpec = { attr: string; events: string[]; get: (b: Bundle, r: Raw) => unknown; want?: (raw: unknown) => unknown };

const tool = (b: Bundle, r: Raw) => b.trace.toolCalls.find((c) => c.task === r['agent.task_id'] && c.callId === r['agent.tool.call_id']);
const task = (b: Bundle, r: Raw) => b.trace.tasks.find((c) => c.task === r['agent.task_id']);
const model = (b: Bundle, r: Raw) => b.trace.modelCalls.find((c) => c.task === r['agent.task_id'] && c.endMs === ms(r.ts));
const disp = (b: Bundle, r: Raw) => b.trace.dispatches.find((c) => c.task === r['agent.task_id'] && c.endMs === ms(r.ts) && c.callId === (r['agent.dispatch.call_id'] ?? null));
const startup = (b: Bundle, r: Raw) => (task(b, r)?.startup ?? undefined) as Record<string, unknown> | undefined;
export const ATTR_SPECS: AttrSpec[] = [
  { attr: 'agent.tool.concurrency_class', events: ['agent.tool_call.start'], get: (b, r) => tool(b, r)?.concurrencyClass },
  { attr: 'agent.tool.queued_ms', events: ['agent.tool_call.start'], get: (b, r) => tool(b, r)?.queuedMs },
  { attr: 'agent.model_call.thinking_config', events: ['agent.model_call.finish'], get: (b, r) => model(b, r)?.thinkingConfig },
  { attr: 'agent.model_call.thinking_blocks', events: ['agent.model_call.finish'], get: (b, r) => model(b, r)?.thinkingBlocks },
  { attr: 'agent.startup.tools_ready_ms', events: ['agent.task.startup.finish'], get: (b, r) => startup(b, r)?.toolsReadyMs },
  { attr: 'agent.startup.queue_wait_ms', events: ['agent.task.startup.finish'], get: (b, r) => startup(b, r)?.queueWaitMs },
  { attr: 'agent.startup.session_ms', events: ['agent.task.startup.finish'], get: (b, r) => startup(b, r)?.sessionMs },
  { attr: 'agent.dispatch.mode', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.mode },
  { attr: 'agent.dispatch.kind', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.kind },
  { attr: 'agent.dispatch.children', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.children },
  { attr: 'agent.dispatch.child_task_ids', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.childTaskIds, want: (raw) => String(raw).split(',') },
  { attr: 'agent.dispatch.parent_blocked_ms', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.parentBlockedMs },
  { attr: 'agent.dispatch.call_id', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.callId },
  { attr: 'agent.dispatch.wait_ms', events: ['agent.dispatch.finish'], get: (b, r) => disp(b, r)?.waitMs },
  { attr: 'agent.task.model_ms', events: ['agent.task.finish'], get: (b, r) => task(b, r)?.modelMs },
  { attr: 'agent.task.tool_ms', events: ['agent.task.finish'], get: (b, r) => task(b, r)?.toolMs },
  { attr: 'agent.task.idle_ms', events: ['agent.task.finish'], get: (b, r) => task(b, r)?.idleMs },
];

/**
 * AC1 checker: for EVERY raw record carrying one of the attributes (and every `agent.startup.mcp_connect_ms.<server>` key) compare the bundle's value with the raw one.
 * @returns per attribute: how many raw records carried it, and the mismatches (empty when the bundle holds every value).
 */
export function compareBundleToRaw(lines: Raw[], bundle: Bundle) {
  const out: Record<string, { seen: number; mismatches: string[] }> = {};
  const rec = (a: string) => (out[a] ??= { seen: 0, mismatches: [] });
  for (const s of ATTR_SPECS) {
    rec(s.attr);
    for (const r of lines.filter((l) => s.events.includes(String(l.event)) && l[s.attr] !== undefined)) {
      const e = rec(s.attr); e.seen++;
      const got = s.get(bundle, r); const want = s.want ? s.want(r[s.attr]) : r[s.attr];
      if (JSON.stringify(got) !== JSON.stringify(want)) e.mismatches.push(`${String(r.event)} task ${String(r['agent.task_id'])}: raw ${JSON.stringify(want)} bundle ${JSON.stringify(got)}`);
    }
  }
  for (const r of lines.filter((l) => l.event === 'agent.task.startup.finish')) {
    for (const k of Object.keys(r).filter((x) => x.startsWith('agent.startup.mcp_connect_ms.'))) {
      const e = rec('agent.startup.mcp_connect_ms.<server>'); e.seen++;
      const server = k.slice('agent.startup.mcp_connect_ms.'.length); const got = (startup(bundle, r)?.mcpConnectMs as Record<string, unknown> | undefined)?.[server];
      if (got !== r[k]) e.mismatches.push(`${k}: raw ${String(r[k])} bundle ${String(got)}`);
    }
  }
  return out;
}

/** One printed wall-attribution line of the table, keyed values (`key=value` cells split on ` | `). */
export function cells(line: string): string[] { return line.split(' | '); }
export function kv(line: string, key: string): string | undefined { return new RegExp(`(?:^|[ (])${key}=([^ |);]+)`).exec(line)?.[1]; }
/** The text of one bundle's wall section (the part after the header line). */
export function wallBlock(out: string, runId: string): string[] {
  const i = out.split('\n').findIndex((l) => l.startsWith(`== WALL ATTRIBUTION ${runId} (`));
  if (i < 0) throw new Error(`no wall section for ${runId}`);
  const rest = out.split('\n').slice(i + 1); const j = rest.findIndex((l) => l.startsWith('== '));
  return j < 0 ? rest : rest.slice(0, j);
}
