/*
 * guards: the evidence bundle built from a run misattributes threads, tools offered, delegation mode, tool timings or same-turn concurrency, reports thinking as present when the API omitted the text, lets a signature, key or page text into a bundle, or the leak scan stops flagging them.
 * tier: S (synthetic run directory under the OS temp dir, no process)
 * cites: PARITY-R10-prep AC3 (SCOPE-R10-prep, as titled in this file; no backlog uid appears in this file; filed under G9 bucket 003366c1-fef5-4b97-be06-bda8155d31a3).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * PARITY-R10-prep AC3 (SCOPE-R10-prep, owner: "properly implementing logging with the tracing module"): the evidence a run leaves behind, built from a SYNTHETIC run directory (wire capture + API log + tracing
 * plugin output + MCP call log) so every fact is known in advance: per-thread model output (thinking text, or the explicit "omitted" state), tools offered per request, delegation mode, tool timings and
 * same-turn concurrency, and a redaction that keeps signatures, page text and keys out of the bundle.
 */
const EV = await loadParity('evidence.mjs');
const AN = await loadParity('analyze.mjs');

const SIG1 = `FAKESIGNATURE${'Q'.repeat(150)}`;
const SIG2 = `FAKESIGNATURE${'R'.repeat(150)}`;
const PAGE = 'Example Domain secret page heading';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const sse = (blocks: Array<Record<string, unknown>>, usage = { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }) => {
  const lines = [`data: ${JSON.stringify({ type: 'message_start', message: { usage } })}`];
  blocks.forEach((b, index) => {
    const { _text, _thinking, _sig, _json, ...start } = b as Record<string, unknown>;
    lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index, content_block: start })}`);
    if (_text) lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: _text } })}`);
    if (_thinking) lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: _thinking } })}`);
    if (_sig) lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: _sig } })}`);
    if (_json) lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: _json } })}`);
  });
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })}`);
  return lines.join('\n');
};

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Build a run directory: parent thread (3 requests), one worker thread (1 request). */
function makeRun(opts: { thinkingText?: string; bg?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-evidence-'));
  roots.push(dir);
  for (const d of ['logs/wire', 'logs/api', 'logs/trace']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const parentTools = [{ name: 'agent-mcp__task' }, { name: 'shell' }, { name: 'Agent' }];
  const brief = [{ type: 'text', text: 'parent brief' }];
  const reqs = [
    { seq: 1, sha: 'sha1', t: 1000, body: { messages: [{ role: 'user', content: brief }], tools: parentTools, thinking: { type: 'adaptive' } },
      resp: sse([
        { type: 'thinking', thinking: '', _thinking: opts.thinkingText, _sig: SIG1 },
        { type: 'text', text: '', _text: `rate is ${PAGE}` },
        { type: 'tool_use', id: 'tu1', name: 'Agent', input: {}, _json: JSON.stringify({ run_in_background: opts.bg === true }) },
        { type: 'tool_use', id: 'tu2', name: 'shell', input: {}, _json: JSON.stringify({ cmd: 'ls' }) },
      ]) },
    { seq: 2, sha: 'sha2', t: 1500, body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'worker brief' }] }], tools: [{ name: 'shell' }] }, resp: sse([{ type: 'text', text: '', _text: 'done' }]) },
    { seq: 3, sha: 'sha3', t: 9000, body: { messages: [
      { role: 'user', content: [{ type: 'text', text: 'parent brief', cache_control: { type: 'ephemeral' } }] },   // cache_control moved: must not split the thread
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: SIG1 }, { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tu2', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'err', is_error: true }] },
    ], tools: parentTools, thinking: { type: 'adaptive' } }, resp: sse([{ type: 'thinking', thinking: '', _thinking: 'second thought', _sig: SIG2 }, { type: 'text', text: '', _text: 'fin' }]) },
  ];
  const wire = [{ type: 'session_start', ts: iso(0) }];
  for (const r of reqs) {
    wire.push({ type: 'raw_request', seq: r.seq, ts: iso(r.t), sha256: r.sha, body: r.body } as never);
    wire.push({ type: 'turn', seq: r.seq, ts: iso(r.t + 400), ms_first_byte: 100, ms_total: 400 } as never);
    wire.push({ type: 'raw_response', seq: r.seq, status: 200, bodyText: r.resp } as never);
  }
  fs.writeFileSync(path.join(dir, 'logs/wire/proxy-C-anthropic.jsonl'), wire.map((x) => JSON.stringify(x)).join('\n'));
  const api = [{ sha: 'sha1', task: 't-p', agent: 'r2-parent' }, { sha: 'sha2', task: 't-w', agent: 'worker' }, { sha: 'sha3', task: 't-p', agent: 'r2-parent' }]
    .map((a) => ({ event: 'http.request', body_sha256: a.sha, task_id: a.task, agent: a.agent }));
  fs.writeFileSync(path.join(dir, 'logs/api/a.jsonl'), api.map((x) => JSON.stringify(x)).join('\n'));
  const tr = (event: string, task: string, depth: number, extra: Record<string, unknown>) => ({ event, 'agent.task_id': task, 'agent.recursion_depth': depth, ...extra });
  const trace = [
    tr('agent.tool_call.finish', 't-p', 0, { ts: iso(8900), duration_ms: 7400, 'agent.tool.name': 'Agent', 'agent.tool.call_id': 'tu1' }),   // spans 1500..8900
    tr('agent.tool_call.finish', 't-p', 0, { ts: iso(3000), duration_ms: 1500, 'agent.tool.name': 'shell', 'agent.tool.call_id': 'tu2' }),   // spans 1500..3000: overlaps the Agent call
    tr('agent.model_call.finish', 't-p', 0, { ts: iso(1400), duration_ms: 400 }),
    tr('agent.task.finish', 't-w', 1, { ts: iso(2000), duration_ms: 500, 'agent.name': 'worker' }),
  ];
  fs.writeFileSync(path.join(dir, 'logs/trace/agent-mcp-live-service-2026-01-01.jsonl'), trace.map((x) => JSON.stringify(x)).join('\n'));
  fs.writeFileSync(path.join(dir, 'mcp-calls.json'), '[]');
  return dir;
}
const record = { runId: 'C1', arm: 'C', wallMs: 10, expected: { carrierRate: 9.5, heading: PAGE }, metrics: { phases: [] } };

describe('PARITY-R10-prep AC3: evidence bundle from a synthetic run', () => {
  it('AC3: threads are keyed by the first message TEXT (a moved cache_control does not split the parent); roles come from the trace depth / agent; tools offered are recorded per request', () => {
    const { bundle } = EV.buildBundle(makeRun(), { arm: 'C', record });
    expect(bundle.threads.map((t: { role: string }) => t.role)).toEqual(['parent', 'worker']);
    expect(bundle.requests.map((q: { seq: number; thread: string }) => q.seq)).toEqual([1, 2, 3]);
    const byThread = (th: string) => bundle.requests.filter((q: { thread: string }) => q.thread === th);
    expect(byThread(bundle.threads[0].id)).toHaveLength(2);
    expect(bundle.requests[0].tools).toEqual(['agent-mcp__task', 'shell', 'Agent']);
    expect(bundle.requests[1].tools).toEqual(['shell']);
    expect(bundle.requests[0].thinkingCfg).toEqual({ type: 'adaptive' });
    expect(bundle.requests[2].toolErrors).toBe(1);
    expect(bundle.requests[2].retryAfterError).toBe(true);
  });

  it('AC3: thinking is "omitted" (signature, no text) when the API returns no text, "text" with its length when it does; the signature itself is never in the bundle', () => {
    const { bundle } = EV.buildBundle(makeRun(), { arm: 'C', record });
    const th = (i: number) => bundle.requests[i].blocks.find((b: { type: string }) => b.type === 'thinking').thinking;
    expect(th(0)).toEqual({ chars: 0, signaturePresent: true, state: 'omitted' });
    expect(th(2)).toEqual({ chars: 'second thought'.length, signaturePresent: true, state: 'text' });
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('FAKESIGNATURE');
    expect(json).not.toContain('QQQQQQ');
    expect(json).not.toContain('second thought');   // thinking text is in evidence/threads.jsonl only
  });

  it('AC3: delegation mode: a run tool with run_in_background:true is background, otherwise sync; non-delegation tools carry no mode', () => {
    for (const bg of [false, true]) {
      const { bundle } = EV.buildBundle(makeRun({ bg }), { arm: 'C', record });
      const agent = bundle.requests[0].blocks.find((b: { name?: string }) => b.name === 'Agent');
      const shell = bundle.requests[0].blocks.find((b: { name?: string }) => b.name === 'shell');
      expect(agent.delegation).toBe(bg ? 'background' : 'sync');
      expect(shell.delegation).toBeUndefined();
    }
    expect(EV.delegationMode({ background: true })).toBe('background');
    expect(EV.delegationMode(undefined)).toBe('sync');
  });

  it('AC3: tool timings come from the tracing plugin spans, including same-turn concurrency (two calls of one turn whose spans overlap) and the parent blocking time', () => {
    const { bundle } = EV.buildBundle(makeRun(), { arm: 'C', record });
    expect(bundle.trace.available).toBe(true);
    expect(bundle.trace.toolCalls.map((c: { name: string; durMs: number }) => `${c.name}:${c.durMs}`).sort()).toEqual(['Agent:7400', 'shell:1500']);
    const rows = AN.blockingRows(bundle);
    const turn = rows.find((r: { calls: unknown[] }) => r.calls.length === 2);
    expect(turn.sameTurnConcurrent).toBe(true);
    expect(turn.spansOverlap).toBe(true);
    expect(turn.calls.find((c: { name: string }) => c.name === 'Agent').delegation).toBe('sync');
    expect(turn.calls.find((c: { name: string }) => c.name === 'Agent').traceMs).toBe(7400);
    expect(turn.gapMs).toBe(7600);   // the parent's request 1 response ends at 1400, its next request starts at 9000: it was blocked on the tool results in between
  });

  it('AC3: RT facts: a thinking block replayed byte-for-byte matches by signature in memory (counts only leave the builder); a mismatched replay is counted', () => {
    const { bundle } = EV.buildBundle(makeRun(), { arm: 'C', record });
    const parent = bundle.threads[0].id;
    expect(bundle.rt.thinking[parent]).toEqual({ emitted: 2, replayable: 1, replayedMatched: 1, replayedUnknown: 0 });
    expect(bundle.rt.http).toEqual({ total: 3, non200: 0 });
  });

  it('AC3: contamination probes: the carrier rate is found in the thread text with phase and channel, the span is boundary-exact', () => {
    const { bundle } = EV.buildBundle(makeRun(), { arm: 'C', record: { ...record, expected: { carrierRate: 9.5 } }, probes: { page: 'Example Domain' } });
    expect(bundle.contamination.matches.map((m: { channel: string; seq: number }) => `${m.channel}@${m.seq}`)).toEqual(['response.text@1']);
  });
});

describe('PARITY-R10-prep AC3: redaction and the leak scan', () => {
  it('AC3: writeEvidence writes the redacted bundle and the full per-thread file: thinking text only in threads.jsonl, no signature in either, leak scan clean', () => {
    const dir = makeRun();
    const s = EV.writeEvidence({ runDir: dir, arm: 'C', record });
    const bundleText = fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8');
    const threads = fs.readFileSync(path.join(dir, 'evidence', 'threads.jsonl'), 'utf8');
    expect(bundleText).not.toContain(PAGE.split(' ')[0] + ' ' + PAGE.split(' ')[1]);   // the page text (also the record's heading) is not in the bundle
    expect(bundleText).not.toContain('FAKESIGNATURE');
    expect(threads).not.toContain('FAKESIGNATURE');
    expect(threads).toContain('second thought');   // the full output file holds the thinking text when the API returned it
    expect(s.leakScan.ok).toBe(true);
    expect(s.thinking).toMatchObject({ blocks: 2, omitted: 1, withText: 1, note: null });
    expect(s.delegation).toEqual({ sync: 1 });
    expect(s.trace).toEqual({ toolCalls: 2, modelCalls: 1 });
  });

  it('AC3: when every thinking block is signature-only the summary says the text is omitted by the API (no conclusion from absence)', () => {
    const dir = makeRun();
    // drop the one block that carries text
    const wireFile = path.join(dir, 'logs/wire/proxy-C-anthropic.jsonl');
    fs.writeFileSync(wireFile, fs.readFileSync(wireFile, 'utf8').replace(/second thought/g, ''));
    const s = EV.writeEvidence({ runDir: dir, arm: 'C', record });
    expect(s.thinking.omitted).toBe(2);
    expect(s.thinking.note).toContain('omitted by the API');
  });

  it('AC3 negative control: the leak scan flags signatures, key shapes, long opaque runs and forbidden page text, and reports counts only', () => {
    expect(EV.leakScan('clean text').ok).toBe(true);
    const bad = EV.leakScan(`a ${SIG1} b sk-ant-${'x'.repeat(40)} c ${'Z'.repeat(130)} d ${PAGE}`, { forbidden: [PAGE] });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.kinds)).toEqual(expect.arrayContaining(['fake_signature', 'signature_like_run', 'forbidden_text']));
    expect(JSON.stringify(bad)).not.toContain('xxxx');
  });
});
