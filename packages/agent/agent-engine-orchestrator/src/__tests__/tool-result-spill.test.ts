/**
 * tool-result-spill.test.ts — plan 9ed453c1 / backlog 3ad735bb, bucket BK9 (optional spill-to-file mode).
 * Unit tests (real fs under the repo's gitignored `tmp/`, no process/network). The proof through the
 * real orchestrator + real stdio MCP server is entrypoint/agent-mcp's `tool-result-spill.e2e.test.ts`; the
 * proof under the REAL srt sandbox is `srt-policy-bk9.e2e.test.ts`.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capToolResult } from '../engine/tool-result-cap.js';
import {
  SPILL_PREVIEW_CHARS,
  SPILL_ROOT_MARKER,
  SPILL_TASK_MARKER,
  assertToolResultSpillDirUsable,
  capOrSpillToolResult,
  parseToolResultSpillTtlHours,
  removeTaskSpill,
  resolveToolResultSpill,
  sweepToolResultSpill,
  validateToolResultSpillDir,
  writeToolResultSpillFile,
  type ToolResultSpillConfig,
} from '../engine/tool-result-spill.js';

const SCRATCH = join(fileURLToPath(new URL('../../../../../', import.meta.url)), 'tmp', 'agent-engine-orchestrator');

let root = '';
let dir = '';
const cfg = (over: Partial<ToolResultSpillConfig> = {}): ToolResultSpillConfig => ({
  enabled: true,
  dir,
  ttlMs: 3_600_000,
  ...over,
});
const mode = (p: string): number => lstatSync(p).mode & 0o777;
/** Backdate a task dir's marker, files and the dir itself by `hours` (what a spill that long ago looked like). */
const age = (taskDir: string, hours: number): void => {
  const past = new Date(Date.now() - hours * 3_600_000);
  for (const n of readdirSync(taskDir)) utimesSync(join(taskDir, n), past, past);
  utimesSync(taskDir, past, past);
};
const spillOnce = (taskId: string, callId: string, text: string = big(30_000)) =>
  capOrSpillToolResult({ result: text, isError: false, maxChars: 100, spill: cfg(), taskId, callId });
const big = (n: number): string =>
  Array.from({ length: Math.ceil(n / 10) }, (_, i) => `L${String(i).padStart(8, '0')}\n`)
    .join('')
    .slice(0, n);

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, 'spill-'));
  dir = join(root, 'tool-results');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('9ed453c1 BK9 AC9.1 default off: byte-identical to the cap', () => {
  it.each([
    ['spill undefined', undefined],
    ['spill disabled', { enabled: false, dir: '/nonexistent/never-touched', ttlMs: 1 }],
  ])('%s: outcome deep-equals capToolResult and nothing is written', (_n, spill) => {
    const text = big(50_000);
    const out = capOrSpillToolResult({ result: text, isError: false, maxChars: 20_000, spill, taskId: 't', callId: 'c' });
    expect(out).toEqual(capToolResult(text, false, 20_000));
    expect(out.spilled).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('enabled but UNDER the cap: untouched, same reference, no file', () => {
    const small = 'x'.repeat(100);
    const out = capOrSpillToolResult({ result: small, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c' });
    expect(out.result).toBe(small);
    expect(out.truncated).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('enabled with cap 0 (disabled cap): never spills', () => {
    const text = big(50_000);
    const out = capOrSpillToolResult({ result: text, isError: false, maxChars: 0, spill: cfg(), taskId: 't', callId: 'c' });
    expect(out.result).toBe(text);
    expect(out.spilled).toBeUndefined();
  });
});

describe('9ed453c1 BK9 AC9.2 enabled: stub with path+size+preview; file holds the exact full text', () => {
  it('string result', () => {
    const text = big(50_000);
    const out = capOrSpillToolResult({ result: text, isError: false, maxChars: 20_000, spill: cfg(), taskId: 'task-1', callId: 'call-1' });
    expect(out.spilled).toBe(true);
    expect(out.spillPath).toBe(join(dir, 'task-1', 'call-1.txt'));
    expect(readFileSync(out.spillPath as string, 'utf8')).toBe(text);
    const stub = out.result as string;
    expect(stub).toContain(out.spillPath);
    expect(stub).toContain('50000 chars');
    expect(stub).toContain(`sed -n 'A,Bp' '${out.spillPath}'`);
    expect(stub).toContain(text.slice(0, SPILL_PREVIEW_CHARS));
    expect(stub).not.toContain(text.slice(0, SPILL_PREVIEW_CHARS + 50));
    expect(stub.length).toBeLessThan(SPILL_PREVIEW_CHARS + 600);
    expect(out.originalChars).toBe(50_000);
    expect(out.truncated).toBe(true);
  });

  it('a generic object result is spilled as its JSON serialization (what telemetry measures)', () => {
    const obj = { rows: [big(30_000)] };
    const out = capOrSpillToolResult({ result: obj, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c' });
    expect(readFileSync(out.spillPath as string, 'utf8')).toBe(JSON.stringify(obj));
    expect(out.originalChars).toBe(JSON.stringify(obj).length);
  });

  it('an MCP text-content array is spilled as real lines (so sed ranges work); originalChars stays the JSON length', () => {
    const body = big(30_000);
    const obj = [{ type: 'text', text: body }];
    const out = capOrSpillToolResult({ result: obj, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c' });
    expect(readFileSync(out.spillPath as string, 'utf8')).toBe(body);
    expect(out.originalChars).toBe(JSON.stringify(obj).length);
    expect(out.result as string).toContain('30000 chars');
  });

  it('a content array with a non-text block falls back to JSON (nothing is dropped)', () => {
    const obj = [{ type: 'text', text: big(30_000) }, { type: 'image', data: 'AAAA' }];
    const out = capOrSpillToolResult({ result: obj, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c' });
    expect(readFileSync(out.spillPath as string, 'utf8')).toBe(JSON.stringify(obj));
  });

  it('line 1000 of a 100k-char result is retrievable from the spill file named by the stub', () => {
    const text = big(100_000);
    const out = capOrSpillToolResult({ result: text, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c' });
    const lines = readFileSync(out.spillPath as string, 'utf8').split('\n');
    expect(lines[999]).toBe('L00000999');
  });

  it.each([350, 351, 352, 353])('cap %i: the whole stub fits the cap and the preview never splits a surrogate pair', (cap) => {
    const emoji = '😀'.repeat(300); // 600 UTF-16 units
    const out = capOrSpillToolResult({ result: emoji, isError: false, maxChars: cap, spill: cfg(), taskId: 't', callId: 'c' });
    const stub = out.result as string;
    expect(stub.length).toBeLessThanOrEqual(cap);
    const preview = stub.split('\n').slice(1).join('\n').replace(/^Preview \(first \d+ chars\):\n/, '');
    expect(preview.length).toBeGreaterThan(0);
    const last = preview.charCodeAt(preview.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('hostile ids cannot escape the spill dir', () => {
    const out = capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: '../../evil', callId: '..' });
    expect((out.spillPath as string).startsWith(dir)).toBe(true);
    expect(readdirSync(root)).toEqual(['tool-results']);
  });
});

describe('9ed453c1 BK9 AC9.3 unwritable / failed spill falls back to the cap, never throws', () => {
  it('dir path blocked by a regular file -> head+tail cap + reporter called', () => {
    writeFileSync(dir, 'i am a file');
    const errors: unknown[] = [];
    const text = big(50_000);
    const out = capOrSpillToolResult({
      result: text, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c', onSpillError: (e) => errors.push(e),
    });
    expect(out).toEqual(capToolResult(text, false, 20_000));
    expect(out.spilled).toBeUndefined();
    expect(String(out.result)).toMatch(/\[tool result truncated: showing first 15000 and last 5000 of 50000 chars/);
    expect(errors).toHaveLength(1);
  });

  it('a symlinked spill dir is refused (not followed) and the cap is used', () => {
    const victim = join(root, 'victim');
    mkdirSync(victim);
    symlinkSync(victim, dir);
    const out = capOrSpillToolResult({ result: big(50_000), isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c' });
    expect(out.spilled).toBeUndefined();
    expect(readdirSync(victim)).toEqual([]);
  });

  it('a throwing reporter does not break the fallback', () => {
    writeFileSync(dir, 'blocked');
    const out = capOrSpillToolResult({
      result: big(50_000), isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c',
      onSpillError: () => {
        throw new Error('reporter exploded');
      },
    });
    expect(String(out.result)).toContain('[tool result truncated');
  });
});

describe('9ed453c1 BK9 AC9.5 permissions, symlinks, cleanup', () => {
  it('dirs are 0700 and the file is 0600 even under a permissive umask', () => {
    const prev = process.umask(0o000);
    try {
      const out = capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 't', callId: 'c' });
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(dir, 't'))).toBe(0o700);
      expect(mode(out.spillPath as string)).toBe(0o600);
    } finally {
      process.umask(prev);
    }
  });

  it('a pre-existing too-wide dir is tightened to 0700', () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 't', callId: 'c' });
    expect(mode(dir)).toBe(0o700);
  });

  it('a symlink planted at the target file name is NOT followed: the victim is untouched and the target becomes a regular 0600 file', () => {
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'SECRET');
    mkdirSync(join(dir, 't'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, SPILL_ROOT_MARKER), ''); // a spill-claimed dir (the planted entries below are the attack)
    symlinkSync(victim, join(dir, 't', 'c.txt'));
    const text = big(30_000);
    const out = capOrSpillToolResult({ result: text, isError: false, maxChars: 100, spill: cfg(), taskId: 't', callId: 'c' });
    expect(out.spilled).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('SECRET');
    const st = lstatSync(out.spillPath as string);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(out.spillPath as string, 'utf8')).toBe(text);
  });

  it('a symlink planted at the TASK dir name is refused (cap fallback), victim untouched', () => {
    const victimDir = join(root, 'victim-dir');
    mkdirSync(victimDir);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, SPILL_ROOT_MARKER), '');
    symlinkSync(victimDir, join(dir, 't'));
    const out = capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 't', callId: 'c' });
    expect(out.spilled).toBeUndefined();
    expect(readdirSync(victimDir)).toEqual([]);
  });

  it('removeTaskSpill removes exactly that task dir', () => {
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 'a', callId: 'c' });
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 'b', callId: 'c' });
    removeTaskSpill(dir, 'a');
    expect(readdirSync(dir).sort()).toEqual([SPILL_ROOT_MARKER, 'b']);
    removeTaskSpill(dir, 'never-existed'); // no throw
  });

  it('sweep removes only spill-created task dirs older than the TTL; a symlink child is neither followed nor removed', () => {
    spillOnce('old', 'c');
    spillOnce('fresh', 'c');
    const victim = join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    symlinkSync(victim, join(dir, 'link'));
    age(join(dir, 'old'), 48);
    expect(sweepToolResultSpill(dir, 24 * 3_600_000)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([SPILL_ROOT_MARKER, 'fresh', 'link']);
    // Even far in the future the foreign symlink survives and its target is untouched.
    sweepToolResultSpill(dir, 24 * 3_600_000, Date.now() + 100 * 3_600_000);
    expect(readdirSync(dir)).toContain('link');
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
    expect(sweepToolResultSpill(join(root, 'absent'), 1)).toBe(0);
  });
});

describe('9ed453c1 BLIND F1 only spill-created entries are ever removed; foreign dirs are refused', () => {
  const foreignTree = (base: string): void => {
    mkdirSync(join(base, 'projects', 'deep'), { recursive: true });
    writeFileSync(join(base, 'projects', 'deep', 'precious.txt'), 'precious');
    writeFileSync(join(base, 'notes.txt'), 'notes');
    const past = new Date(Date.now() - 1000 * 3_600_000);
    for (const p of [join(base, 'projects', 'deep'), join(base, 'projects'), join(base, 'notes.txt')]) utimesSync(p, past, past);
  };

  it('a non-empty unclaimed dir full of old foreign entries survives a sweep untouched', () => {
    mkdirSync(dir);
    foreignTree(dir);
    expect(sweepToolResultSpill(dir, 3_600_000)).toBe(0);
    expect(readFileSync(join(dir, 'projects', 'deep', 'precious.txt'), 'utf8')).toBe('precious');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('notes');
  });

  it('in a claimed dir, old foreign dirs/files (no task marker) survive while an old spill task dir goes', () => {
    spillOnce('mine', 'c');
    foreignTree(dir);
    age(join(dir, 'mine'), 1000);
    expect(sweepToolResultSpill(dir, 3_600_000)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([SPILL_ROOT_MARKER, 'notes.txt', 'projects']);
    expect(readFileSync(join(dir, 'projects', 'deep', 'precious.txt'), 'utf8')).toBe('precious');
  });

  it('a non-empty foreign dir is refused with a clear error at config resolution and at the first spill; nothing is written or removed', () => {
    mkdirSync(dir);
    foreignTree(dir);
    expect(() => resolveToolResultSpill(cfg())).toThrow(/not empty and was not created by the tool-result spill/);
    expect(() => assertToolResultSpillDirUsable(dir)).toThrow(RangeError);
    expect(() => writeToolResultSpillFile(dir, 't', 'c', 'x')).toThrow(/refusing to use or sweep it/);
    const errors: unknown[] = [];
    const text = big(50_000);
    const out = capOrSpillToolResult({
      result: text, isError: false, maxChars: 20_000, spill: cfg(), taskId: 't', callId: 'c', onSpillError: (e) => errors.push(e),
    });
    expect(out.spilled).toBeUndefined();
    expect(out).toEqual(capToolResult(text, false, 20_000));
    expect(String(errors[0])).toMatch(/not empty and was not created/);
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'projects']);
  });

  it('absent, empty and claimed dirs are usable', () => {
    expect(() => assertToolResultSpillDirUsable(dir)).not.toThrow();
    mkdirSync(dir);
    expect(() => resolveToolResultSpill(cfg())).not.toThrow();
    spillOnce('t', 'c');
    expect(existsSync(join(dir, SPILL_ROOT_MARKER))).toBe(true);
    expect(() => resolveToolResultSpill(cfg())).not.toThrow();
  });

  it('removeTaskSpill refuses a foreign dir that merely shares the name', () => {
    spillOnce('a', 'c');
    mkdirSync(join(dir, 'theirs'));
    writeFileSync(join(dir, 'theirs', 'x.txt'), 'x');
    removeTaskSpill(dir, 'theirs');
    expect(existsSync(join(dir, 'theirs', 'x.txt'))).toBe(true);
    removeTaskSpill(dir, 'a');
    expect(existsSync(join(dir, 'a'))).toBe(false);
  });
});

describe('9ed453c1 BLIND F2 TTL runs from the last spill in the task', () => {
  const TTL = 24 * 3_600_000;
  it('a task that spilled once, ran past the TTL, then spilled again keeps its FIRST file', () => {
    const first = spillOnce('long', 'call-1').spillPath as string;
    age(join(dir, 'long'), 48); // 48h later the first spill looks 48h old...
    const second = spillOnce('long', 'call-2').spillPath as string; // ...but the task spills again now
    expect(sweepToolResultSpill(dir, TTL)).toBe(0);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('control: a task with no further spill past the TTL is swept', () => {
    const first = spillOnce('idle', 'call-1').spillPath as string;
    age(join(dir, 'idle'), 48);
    expect(sweepToolResultSpill(dir, TTL)).toBe(1);
    expect(existsSync(first)).toBe(false);
  });

  it('a stale marker does not condemn a task whose newest file is recent', () => {
    spillOnce('t', 'call-1');
    utimesSync(join(dir, 't', SPILL_TASK_MARKER), new Date(0), new Date(0));
    utimesSync(join(dir, 't'), new Date(0), new Date(0));
    expect(sweepToolResultSpill(dir, TTL)).toBe(0);
  });

  it('every spill refreshes the task marker', () => {
    spillOnce('t', 'call-1');
    const marker = join(dir, 't', SPILL_TASK_MARKER);
    utimesSync(marker, new Date(0), new Date(0));
    spillOnce('t', 'call-2');
    expect(lstatSync(marker).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('9ed453c1 BLIND F3 distinct ids never share a spill path', () => {
  it('two raw ids that sanitize identically both keep their content (tasks and calls)', () => {
    const a = capOrSpillToolResult({ result: 'A'.repeat(500), isError: false, maxChars: 100, spill: cfg(), taskId: 'a/b', callId: 'x y' });
    const b = capOrSpillToolResult({ result: 'B'.repeat(500), isError: false, maxChars: 100, spill: cfg(), taskId: 'a:b', callId: 'x?y' });
    expect(a.spillPath).not.toBe(b.spillPath);
    expect(readFileSync(a.spillPath as string, 'utf8')).toBe('A'.repeat(500));
    expect(readFileSync(b.spillPath as string, 'utf8')).toBe('B'.repeat(500));
  });

  it('two ids that differ only past the 128-char truncation stay distinct', () => {
    const long = 'z'.repeat(200);
    const a = spillOnce('t', `${long}1`, 'A'.repeat(500));
    const b = spillOnce('t', `${long}2`, 'B'.repeat(500));
    expect(readFileSync(a.spillPath as string, 'utf8')).toBe('A'.repeat(500));
    expect(readFileSync(b.spillPath as string, 'utf8')).toBe('B'.repeat(500));
  });

  it('a safe id is used verbatim and cannot equal a mangled name', () => {
    expect(spillOnce('task-1', 'call-1').spillPath).toBe(join(dir, 'task-1', 'call-1.txt'));
    expect(spillOnce('t', 'a b').spillPath).toMatch(/a_b~[0-9a-f]{16}\.txt$/);
    expect(spillOnce('t', 'a_b').spillPath).toBe(join(dir, 't', 'a_b.txt'));
  });

  it('an id that is a marker name cannot clobber a marker', () => {
    const out = spillOnce(SPILL_ROOT_MARKER, SPILL_TASK_MARKER);
    expect(out.spilled).toBe(true);
    expect(lstatSync(join(dir, SPILL_ROOT_MARKER)).isFile()).toBe(true);
  });

  it('the same call id spilled twice never overwrites the first file', () => {
    const first = spillOnce('t', 'c', 'FIRST'.repeat(100));
    const second = spillOnce('t', 'c', 'SECOND'.repeat(100));
    expect(second.spillPath).not.toBe(first.spillPath);
    expect(readFileSync(first.spillPath as string, 'utf8')).toBe('FIRST'.repeat(100));
    expect(readFileSync(second.spillPath as string, 'utf8')).toBe('SECOND'.repeat(100));
  });
});

describe('9ed453c1 BLIND F5 the whole stub honours the cap', () => {
  it.each([300, 301, 350, 500, 1_000, 2_000, 2_500, 5_000, 20_000])('cap %i: stub length <= cap', (cap) => {
    const text = big(60_000);
    const out = capOrSpillToolResult({ result: text, isError: false, maxChars: cap, spill: cfg(), taskId: 't', callId: `c${cap}` });
    expect(out.spilled).toBe(true);
    expect((out.result as string).length).toBeLessThanOrEqual(cap);
    expect(readFileSync(out.spillPath as string, 'utf8')).toBe(text);
  });

  it('every cap from 300 to 20000 (sampled by prime stride) fits, and the preview fills the budget', () => {
    const text = big(60_000);
    for (let cap = 300; cap <= 20_000; cap += 97) {
      const out = capOrSpillToolResult({ result: text, isError: false, maxChars: cap, spill: cfg(), taskId: 't', callId: `s${cap}` });
      const stub = out.result as string;
      expect(stub.length).toBeLessThanOrEqual(cap);
      if (cap < 2_000) expect(cap - stub.length).toBeLessThan(5); // digit-count slack only
    }
  });

  it('the stub names the path exactly once', () => {
    const out = spillOnce('t', 'c');
    expect((out.result as string).split(out.spillPath as string).length - 1).toBe(1);
  });
});

describe('9ed453c1 BK9 AC9.6 config validation fails loud', () => {
  it.each([
    ['relative', 'tool-results'],
    ['dot-relative', './x'],
    ['empty', ''],
    ['whitespace', '   '],
    ['dotdot', '/tmp/a/../b'],
    ['NUL', '/tmp/a\0b'],
    ['non-string', 42],
    ['undefined', undefined],
  ])('rejects %s dir', (_n, v) => {
    expect(() => validateToolResultSpillDir(v)).toThrow(RangeError);
    expect(() => validateToolResultSpillDir(v)).toThrow(/agent\.toolResult\.spill\.dir/);
  });

  it('accepts an absolute path unchanged', () => {
    expect(validateToolResultSpillDir('/var/tmp/spill')).toBe('/var/tmp/spill');
  });

  it('resolveToolResultSpill: undefined when absent/disabled; validates the dir when enabled', () => {
    expect(resolveToolResultSpill(undefined)).toBeUndefined();
    expect(resolveToolResultSpill(cfg({ enabled: false, dir: 'relative' }))).toBeUndefined();
    expect(() => resolveToolResultSpill(cfg({ dir: 'relative' }))).toThrow(RangeError);
    expect(resolveToolResultSpill(cfg())).toEqual(cfg());
  });

  it.each([['0', false], ['-1', false], ['1.5', false], ['abc', false], ['', false], ['24', true], [24, true]])(
    'ttlHours %j valid=%s',
    (v, ok) => {
      if (ok) expect(parseToolResultSpillTtlHours(v)).toBe(Number(v));
      else expect(() => parseToolResultSpillTtlHours(v)).toThrow(RangeError);
    }
  );
});
