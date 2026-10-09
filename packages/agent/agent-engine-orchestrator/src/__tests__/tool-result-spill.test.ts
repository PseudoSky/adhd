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
  capOrSpillToolResult,
  parseToolResultSpillTtlHours,
  removeTaskSpill,
  resolveToolResultSpill,
  sweepToolResultSpill,
  validateToolResultSpillDir,
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

  it('small caps bound the preview to the cap and never split a surrogate pair', () => {
    const emoji = '😀'.repeat(300); // 600 UTF-16 units
    const out = capOrSpillToolResult({ result: emoji, isError: false, maxChars: 101, spill: cfg(), taskId: 't', callId: 'c' });
    const preview = (out.result as string).split('\n').slice(1).join('\n').replace(/^Preview \(first \d+ chars\):\n/, '');
    expect(preview.length).toBeLessThanOrEqual(101);
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
    symlinkSync(victimDir, join(dir, 't'));
    const out = capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 't', callId: 'c' });
    expect(out.spilled).toBeUndefined();
    expect(readdirSync(victimDir)).toEqual([]);
  });

  it('removeTaskSpill removes exactly that task dir', () => {
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 'a', callId: 'c' });
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 'b', callId: 'c' });
    removeTaskSpill(dir, 'a');
    expect(readdirSync(dir)).toEqual(['b']);
    removeTaskSpill(dir, 'never-existed'); // no throw
  });

  it('sweep removes only task dirs older than the TTL and never follows a symlink child', () => {
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 'old', callId: 'c' });
    capOrSpillToolResult({ result: big(30_000), isError: false, maxChars: 100, spill: cfg(), taskId: 'fresh', callId: 'c' });
    const victim = join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    symlinkSync(victim, join(dir, 'link'));
    const past = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(join(dir, 'old'), past, past);
    // 'fresh' and the just-made symlink are younger than the TTL: only 'old' goes.
    expect(sweepToolResultSpill(dir, 24 * 3_600_000)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['fresh', 'link']);
    // A later "now" ages the symlink out: the LINK is unlinked, its target is untouched.
    sweepToolResultSpill(dir, 24 * 3_600_000, Date.now() + 25 * 3_600_000);
    expect(readdirSync(dir)).not.toContain('link');
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
    expect(sweepToolResultSpill(join(root, 'absent'), 1)).toBe(0);
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
