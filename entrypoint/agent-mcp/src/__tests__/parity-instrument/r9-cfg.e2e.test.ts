/*
 * guards: the real drive.mjs entrypoint invokes `claude` at all (a /usage read in particular), accepts an invalid model configuration instead of
 *   exiting 2 naming the key (touching the ledger), or `--print-plan --round R9` stops showing the resolved model and source per arm.
 * tier: P (e2e lane, ADR-0009: spawns drive.mjs with a spy claude first on PATH)
 * gap: This cannot be observed at tier S because "claude was never invoked" and the exit code are only observable on a real drive.mjs
 *   process with a spy binary on PATH.
 * cites: PARITY-R9-cfg AC1, AC4, AC7 as named in this file; no backlog uid is named in the file.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { PARITY_DIR } from './load';

/**
 * PARITY-R9-cfg (e2e lane, subprocess): the real `drive.mjs` entrypoint, run the way an operator runs it, with a spy `claude` first on PATH and passed as --claude.
 * No model call and no live run: every case here either exits before any gate or runs the zero-model self-check. The spy logs its argv and exits 99 on /usage, so any
 * invocation of `claude` at all (and a usage-window read in particular) is a failure.
 *   AC1 `--self-check` exits 0 and never invokes `claude`; the spy itself fails on /usage (teeth)
 *   AC4 an invalid configuration is refused with exit 2 naming the key, for --print-plan and --live --yes, ledger byte-identical, `claude` never invoked
 *   AC7 `--print-plan --round R9` through the CLI shows the resolved models with their sources
 */
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const LEDGER_R9 = path.join(PARITY_DIR, 'ledger', 'R9.json');
const cleanup: string[] = [];
const mk = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); cleanup.push(d); return d; };
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });
const md5 = (f: string) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

function spyClaude() {
  const dir = mk('r9cfg-e2e-spy-');
  const bin = path.join(dir, 'claude');
  const log = path.join(dir, 'spy.log');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nfor a in "$@"; do [ "$a" = "/usage" ] && exit 99; done\nexit 1\n`, { mode: 0o755 });
  return { dir, bin, log, invoked: () => fs.existsSync(log) };
}
/** The process environment with every PARITY_* variable removed (the capture switch included), the spy dir first on PATH, plus `extra`. */
const envWith = (spyDir: string, extra: Record<string, string> = {}) => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PARITY_')) e[k] = v;
  e.PATH = `${spyDir}${path.delimiter}${e.PATH ?? ''}`;
  return { ...e, ...extra };
};
const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [DRIVE, ...args], { env, encoding: 'utf8', timeout: 240000, cwd: os.tmpdir() });

describe('PARITY-R9-cfg e2e', () => {
  it('PARITY-R9-cfg AC1: `drive.mjs --self-check` exits 0 with a spy `claude` first on PATH and never invokes it (no /usage call)', () => {
    const spy = spyClaude();
    const r = run(['--self-check', '--claude', spy.bin], envWith(spy.dir));
    expect(r.status, r.stdout.slice(-800) + r.stderr.slice(-800)).toBe(0);
    expect(r.stdout).toMatch(/PARITY-R9-cfg AC1/);
    expect(spy.invoked()).toBe(false);
  });

  it('PARITY-R9-cfg AC1 teeth: the spy really fails on /usage, so a harness that called it would be caught', () => {
    const spy = spyClaude();
    const r = spawnSync(spy.bin, ['-p', '/usage'], { encoding: 'utf8' });
    expect(r.status).toBe(99);
    expect(spy.invoked()).toBe(true);
  });

  it('PARITY-R9-cfg AC4: the CLI refuses an invalid configuration with exit 2 and names the key, for --print-plan and for --live --yes, with the ledger byte-identical and `claude` never invoked', () => {
    const spy = spyClaude();
    const before = md5(LEDGER_R9);
    const plan = run(['--print-plan', '--round', 'R9'], envWith(spy.dir, { PARITY_MODEL: 'claude-opus-4-1' }));
    expect(plan.status).toBe(2);
    expect(plan.stderr).toMatch(/CONFIG REFUSED/);
    expect(plan.stderr).toMatch(/env PARITY_MODEL: .*opus/);
    const live = run(['--live', '--yes', '--round', 'R9', '--claude', spy.bin], envWith(spy.dir, { PARITY_MODEL_C: 'haiku' }));
    expect(live.status).toBe(2);
    expect(live.stderr).toMatch(/CONFIG REFUSED/);
    expect(live.stderr).toMatch(/env PARITY_MODEL_C: .*alias/);
    expect(live.stdout + live.stderr).not.toMatch(/gate (ledger|scope)|LIVE plan/);
    const unknown = run(['--print-plan', '--round', 'R9'], envWith(spy.dir, { PARITY_MODEL_D: 'claude-haiku-5-5' }));
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/env PARITY_MODEL_D: unknown group variable/);
    expect(md5(LEDGER_R9)).toBe(before);
    expect(spy.invoked()).toBe(false);
  });

  it('PARITY-R9-cfg AC7: `--print-plan --round R9` exits 0 and prints the resolved model per arm and the judge with its source, the native flag and provider.model', () => {
    const spy = spyClaude();
    const r = run(['--print-plan', '--round', 'R9'], envWith(spy.dir));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/arm A: provider claude-cli {2}model claude-haiku-5-5 {2}source json/);
    expect(r.stdout).toMatch(/arm C: provider anthropic {2}model claude-haiku-5-5 {2}source json/);
    expect(r.stdout).toMatch(/judge: provider anthropic {2}model claude-haiku-5-5 {2}source json/);
    expect(r.stdout).toMatch(/--model claude-haiku-5-5/);
    const over = run(['--print-plan', '--round', 'R9'], envWith(spy.dir, { PARITY_MODEL_A: 'claude-haiku-4-5' }));
    expect(over.status, over.stderr).toBe(0);
    expect(over.stdout).toMatch(/arm A: .*model claude-haiku-4-5 {2}source env \(PARITY_MODEL_A\)/);
    expect(over.stdout).toMatch(/--model claude-haiku-4-5/);
    expect(over.stdout).toMatch(/equal-model guard \(before any spend\): REFUSES/);
    expect(spy.invoked()).toBe(false);
  });
});
