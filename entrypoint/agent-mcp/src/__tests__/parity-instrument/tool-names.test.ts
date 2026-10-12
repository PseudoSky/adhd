import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from './load';

/**
 * I-toolname: "tool names should not be inconsistent". The model sees one tool under three spellings (arm A native built-ins, arm B `mcp__server__tool`, arm C
 * `server__tool`, and in C the model sometimes drops the prefix: bare `shell_execute`). The instrument keys per-tool counts on ONE canonical identity and keeps the
 * raw spelling visible (`bareNameCalls`, `rawNames`) so the product defect stays measurable. Pure, no model call. The evidence is the committed fixture
 * parity/golden/r8/tool-names.json (names, kinds and advertised sets extracted from the saved R8 A1/B1/C1 runs by `drive.mjs --rederive-tools --emit-fixture`).
 */
const L = await loadParity('lib.mjs');
const D = await loadParity('drive.mjs');
type Row = { id: string; advertised: string[]; calls: { name: string; server: boolean; depth: number }[] };
const FIX = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden', 'r8', 'tool-names.json'), 'utf8')) as Record<string, { arm: string; tasks: Row[] }>;
const ADV = ['shell__shell_execute', 'fs__read_text_file', 'agent-mcp__task', 'web_fetch', 'web_search'];
const call = (name: string, extra: object = {}) => ({ name, input: { n: Math.random() }, isError: false, resultText: 'x', ...extra });

describe('I-toolname AC1: one canonical key per tool, raw spelling kept visible', () => {
  it('shell_execute, shell__shell_execute and mcp__shell__shell_execute share one byTool key; bareNameCalls counts the dropped prefix', () => {
    const m = L.callMetrics([call('shell_execute'), call('shell__shell_execute'), call('mcp__shell__shell_execute')], { advertisedTools: ADV });
    expect(m.byTool).toEqual({ shell__shell_execute: 3 });
    expect(m.bareNameCalls).toBe(1);
    expect(m.rawNames).toEqual({ shell_execute: 1, shell__shell_execute: 1, mcp__shell__shell_execute: 1 });
  });

  it('negative control: without an advertised list the bare name is NOT guessed (own key, counted unresolved), and an ambiguous bare name stays bare', () => {
    const blind = L.callMetrics([call('shell_execute'), call('shell__shell_execute')], {});
    expect(blind.byTool).toEqual({ shell_execute: 1, shell__shell_execute: 1 });
    expect(blind.unresolvedBare).toBe(1);
    const amb = L.callMetrics([call('read_file')], { advertisedTools: ['fs__read_file', 'other__read_file'] });
    expect(amb.byTool).toEqual({ read_file: 1 });
    expect(amb.bareNameCalls).toBe(1);
  });

  it('the Anthropic server tool web_fetch maps to the logical web tool, keeps its raw kind visible and is not a "bare" defect', () => {
    const m = L.callMetrics([call('web_fetch', { server: true }), call('mcp__web__web_fetch')], { advertisedTools: ADV });
    expect(m.byTool).toEqual({ web__web_fetch: 2 });
    expect(m.serverToolCalls).toBe(1);
    expect(m.bareNameCalls).toBe(0);
    expect(m.rawNames.web_fetch).toBe(1);
  });
});

describe('I-toolname AC2: native built-ins are unchanged', () => {
  it.each(['Bash', 'Read', 'Edit', 'Write', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Glob', 'Grep'])('%s keeps its name with or without an advertised list', (n) => {
    expect(L.canonicalToolName(n, ADV)).toBe(n);
    expect(L.canonicalToolName(n, [])).toBe(n);
    expect(L.toolNameFacts(n, ADV).bare).toBe(false);
  });
});

describe('I-toolname AC3: every R8-advertised tool has a non-"other" category in drive.mjs', () => {
  const advertised = [...new Set(Object.values(FIX).flatMap((r) => r.tasks.flatMap((t) => t.advertised)))];
  const called = [...new Set(Object.values(FIX).flatMap((r) => r.tasks.flatMap((t) => t.calls.map((c) => c.name))))];

  it('derives the advertised set from the saved runs (A init tools, B init tools, C request tools), not a hand-typed list', () => {
    expect(advertised.length).toBeGreaterThanOrEqual(60);
    expect(advertised).toEqual(expect.arrayContaining(['CronCreate', 'mcp__shell__shell_execute', 'shell__shell_execute', 'web_fetch', 'agent-mcp__result', 'fs__create_directory']));
  });

  it('no advertised or called tool lands in "other"; result is its own "collect" bucket so dispatch stays comparable across arms', () => {
    expect([...advertised, ...called].filter((n) => D.categoryOf(n) === 'other')).toEqual([]);
    expect([D.categoryOf('agent-mcp__result'), D.categoryOf('mcp__agent-mcp__result'), D.categoryOf('fs__create_directory')]).toEqual(['collect', 'collect', 'write']);
  });

  it('negative control and the used buckets: an unknown tool is still "other"; Agent/task stay dispatch, shell spellings stay shell', () => {
    expect(D.categoryOf('definitely_not_a_tool')).toBe('other');
    expect([D.categoryOf('Agent'), D.categoryOf('agent-mcp__task'), D.categoryOf('shell_execute'), D.categoryOf('mcp__shell__shell_execute'), D.categoryOf('web_fetch')]).toEqual(['dispatch', 'dispatch', 'shell', 'shell', 'web']);
  });
});

describe('I-toolname AC4: re-derivation over the saved R8 runs', () => {
  it('C1: the shell tool is ONE key with 13 calls, 9 of them bare; the bare spelling is still counted, not normalised away', () => {
    const c = L.toolCountsOf(FIX.C1.tasks);
    expect(c.byTool.shell__shell_execute).toBe(13);
    expect(c.bareNameByTool).toEqual({ shell__shell_execute: 9 });
    expect(c.rawNames.shell_execute).toBe(9);
    expect(c.rawNames.shell__shell_execute).toBe(4);
    expect(Object.keys(c.byTool)).not.toContain('shell_execute');
    expect([c.total, c.unresolvedBare, c.serverToolCalls, c.byTool.web__web_fetch]).toEqual([54, 0, 6, 6]);
  });

  it('A1 and B1 never drop a prefix (bareNameCalls 0), and their shell tools are one key each (A Bash 13, B shell__shell_execute 12, parent+workers)', () => {
    expect(L.toolCountsOf(FIX.A1.tasks).bareNameCalls).toBe(0);
    expect(L.toolCountsOf(FIX.B1.tasks).bareNameCalls).toBe(0);
    expect(L.toolCountsOf(FIX.A1.tasks).byTool.Bash).toBe(13);
    expect(L.toolCountsOf(FIX.B1.tasks).byTool.shell__shell_execute).toBe(12);
  });

  it('per-tool totals of the three arms are only comparable by category: every arm resolves entirely into non-"other" categories', () => {
    for (const id of ['A1', 'B1', 'C1']) expect(L.toolCountsOf(FIX[id].tasks).byCategory.other).toBeUndefined();
  });
});
