/**
 * R2.AC5-AC7 (50e21ed9 AC2, 0ba70e47 AC1, 90758419 AC2) + R0.AC4/AC7/AC8 refusals - e2e lane (ADR-0009).
 *
 * Drives the REAL driver CLI (`parity/drive.mjs`) as an operator does, in an isolated cwd with a fake HOME, and a `claude` shim first on PATH that
 * appends to a file whenever it is executed (the zero-spawn proof):
 *   - `preflight` (zero model calls): exits 0, prints a JSON verdict whose legs are DERIVED from the declared web surface (R3: no instrument-added
 *     path), every unprobeable leg is NOT_PROBEABLE, and a receipt with the identity fields is written (R2.AC5, AC6);
 *   - `--live --yes` is REFUSED with exit 3 by the first red gate, the tracked ledger is byte-identical, and the shim was never executed (R2.AC7,
 *     R0.AC4, R0.AC7, R0.AC8): once for an unapproved round (ledger gate), once for an approved round whose scenario changed without a LOG entry
 *     (scope gate, which runs before preflight and pacing).
 *
 * NOT covered here, and why (blocked by R3, reported to the dispatcher):
 *   - R2.AC11/AC12 (GREEN against a local parentProxy stub; negative control stripping MCP_SHELL_CHILD_ENV_ALLOWLIST) and the red-PREFLIGHT leg of
 *     R2.AC7 need a probeable leg. R3 removed curl and the instrument-added srt domain, and no arm ships a zero-model fetch tool (WEB_SURFACE.*.probe is
 *     unset), so there is nothing real to probe; adding one back would re-introduce the instrument-added path R3 forbids.
 *   - R2.AC13 (missing srt/uvx fails loudly in beforeAll) applies once a leg launches the shell stack; nothing here launches srt or uvx.
 * The unit table (preflight.test.mjs, implementer 2) covers every verdict code with a mocked SDK.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DRIVER = path.join(PACKAGE_ROOT, 'parity', 'drive.mjs');
const LEDGER_DIR = path.join(PACKAGE_ROOT, 'parity', 'ledger');
const TMP = path.join(REPO_ROOT, 'tmp', 'agent-mcp', `parity-preflight-e2e-${process.pid}`);
// Synthetic rounds far above any real one, so no real round sits between them (previousScenarioSha takes the highest lower round).
const R_PREV = 'R9001';
const R_UNAPPROVED = 'R9002';
const R_SCOPE = 'R9003';
const R_PREFLIGHT = 'R9004';
const ROUND_TMP = (round: string): string => path.join(REPO_ROOT, 'tmp', 'agent-mcp', 'parity', round);
const ledgerFile = (round: string): string => path.join(LEDGER_DIR, `${round}.json`);

let cwd: string;
let home: string;
let shimDir: string;
let shimLog: string;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [DRIVER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: home, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

const createdLedgers: string[] = [];
function writeLedger(round: string, body: Record<string, unknown>): void {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(ledgerFile(round), JSON.stringify({ round, cap: 3, approvedBy: '', extraRunReason: '', runs: [], judgeCalls: [], scenarioSha: '', scopeChanges: [], armOrder: [], startedAt: null, armA: null, ...body }, null, 2) + '\n');
  createdLedgers.push(ledgerFile(round));
}

beforeAll(() => {
  cwd = path.join(TMP, 'cwd');
  home = path.join(TMP, 'home');
  shimDir = path.join(TMP, 'shim');
  shimLog = path.join(TMP, 'claude-shim.log');
  for (const d of [cwd, home, shimDir]) fs.mkdirSync(d, { recursive: true });
  // A `claude` that records every execution. If any gate leaks past a refusal, this file appears.
  fs.writeFileSync(path.join(shimDir, 'claude'), `#!/bin/sh\necho "claude $@" >> "${shimLog}"\nexit 1\n`, { mode: 0o755 });
  if (!fs.existsSync(DRIVER)) throw new Error(`driver missing: ${DRIVER}`);
});

afterAll(() => {
  // Bounded cleanup of exactly what this suite created: its tmp dir, the four synthetic ledgers and the receipt dirs of its two synthetic rounds.
  for (const f of createdLedgers) fs.rmSync(f, { force: true });
  for (const r of [R_PREV, R_UNAPPROVED, R_SCOPE, R_PREFLIGHT]) fs.rmSync(ROUND_TMP(r), { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('parity preflight and live refusals (R2.AC5-AC7, R0.AC4/AC7/AC8)', () => {
  it('preflight: exit 0, legs derived from the declared surface are NOT_PROBEABLE, receipt carries the identity fields', () => {
    const r = run(['preflight', '--round', R_PREFLIGHT]);
    expect(r.status, r.stderr).toBe(0);
    const verdict = JSON.parse(r.stdout) as { ok: boolean; exitCode: number; legs: Array<{ arm: string; code: string; probeable: boolean }> };
    expect(verdict.ok).toBe(true);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.legs.map((l) => [l.arm, l.code, l.probeable])).toEqual([
      ['A', 'NOT_PROBEABLE', false],
      ['B', 'NOT_PROBEABLE', false],
      ['C', 'NOT_PROBEABLE', false],
    ]);
    const receipt = JSON.parse(fs.readFileSync(path.join(ROUND_TMP(R_PREFLIGHT), 'preflight-receipt.json'), 'utf8')) as Record<string, unknown>;
    for (const k of ['at', 'targetUrl', 'marker', 'agentMcpDistSha', 'nativeToolingVersion', 'srtVersion', 'policySha', 'legs']) expect(receipt).toHaveProperty(k);
    expect(receipt.targetUrl).toBe('https://example.com');
    expect(receipt.marker).toBe('<title>Example Domain</title>');
    expect(typeof receipt.agentMcpDistSha).toBe('string'); // the built dist exists, so the sha is real, not null
    expect(fs.existsSync(shimLog)).toBe(false);
  });

  it('--live --yes on an unapproved round: exit 3 by the ledger gate, ledger byte-identical, claude never executed (R0.AC4, R2.AC7)', () => {
    writeLedger(R_UNAPPROVED, { approvedBy: '' });
    const before = fs.readFileSync(ledgerFile(R_UNAPPROVED));
    const r = run(['--live', '--yes', '--round', R_UNAPPROVED]);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/gate ledger: RED/);
    expect(r.stderr).toMatch(/LIVE REFUSED by gate ledger/);
    expect(Buffer.compare(fs.readFileSync(ledgerFile(R_UNAPPROVED)), before)).toBe(0);
    expect(fs.existsSync(shimLog)).toBe(false);
  });

  it('--live --yes on an approved round whose scenario changed with no LOG entry: exit 3 by the scope gate, ledger byte-identical, claude never executed (R0.AC7, R0.AC8, R2.AC7)', () => {
    writeLedger(R_PREV, { scenarioSha: 'deadbeef-previous-round-scenario' });
    writeLedger(R_SCOPE, { approvedBy: '"approved by the e2e: synthetic round, refusal expected"', scopeChanges: [] });
    const before = fs.readFileSync(ledgerFile(R_SCOPE));
    const r = run(['--live', '--yes', '--round', R_SCOPE]);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/gate ledger: GREEN/);
    expect(r.stderr).toMatch(/gate scope: RED .*scenarioSha changed/);
    expect(r.stderr).toMatch(/LIVE REFUSED by gate scope/);
    expect(Buffer.compare(fs.readFileSync(ledgerFile(R_SCOPE)), before)).toBe(0);
    expect(fs.existsSync(shimLog)).toBe(false);
  });

  it('--round is validated: a path-shaped round is a usage error (exit 2) and writes nothing', () => {
    const r = run(['preflight', '--round', '../escape']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--round must match/);
    expect(fs.existsSync(path.join(REPO_ROOT, 'tmp', 'agent-mcp', 'parity', '..', 'escape'))).toBe(false);
  });
});
