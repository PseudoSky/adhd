import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { PARITY_DIR } from './load';

/**
 * R5-harness (e2e lane, subprocess): drives `drive.mjs main` through its real CLI up to and including the instrument's fake-claude dry-run shim.
 * No real model call: --dry-run uses the in-process fake Anthropic server and a fake `claude`, with the egress guard on. Runs in the e2e lane
 * (subprocess), unflagged. Owns round R97; cleans its tmp/ output and OS-temp work dirs.
 *   AC1 (R6-prep AC1) the default `--dry-run` (the exact path live runs share) completes: exit 0, no harnessFailure, no aborted record, work dir under os.tmpdir()
 *   AC2 an explicit in-repo --out is rejected by the ancestor-leak guard (exit 1, harnessFailure names the leak)
 */
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
const ROUND = 'R97';
const OUT_DEFAULT = path.join(REPO, 'tmp', 'agent-mcp', 'parity', ROUND);
const WORK = path.join(os.tmpdir(), 'adhd-agent-mcp-parity', ROUND);

afterAll(() => { fs.rmSync(OUT_DEFAULT, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }); });

const records = (dir: string) => fs.readdirSync(dir).map((d) => JSON.parse(fs.readFileSync(path.join(dir, d, 'record.json'), 'utf8')));

describe('R5-harness e2e', () => {
  it('AC1: default --dry-run through main exits 0 with the work dir outside the repo', () => {
    const r = spawnSync(process.execPath, [DRIVE, '--dry-run', '--round', ROUND], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const recs = records(path.join(OUT_DEFAULT, 'dry', 'out', 'runs'));
    expect(recs.length).toBe(3);
    for (const rec of recs) { expect(rec.harnessFailure).toBeUndefined(); expect(rec.aborted).toBeUndefined(); }
    // R6-prep AC2: every agent-mcp (B/C) run records the egress mode the server actually provisioned; the product default is open.
    for (const rec of recs.filter((x) => x.arm !== 'A')) { expect(rec.shellEgress?.mode, JSON.stringify(rec.shellEgress)).toBe('open'); expect(rec.config.shellAllow).toMatch(/product default/); }
    // R6-prep AC1: assignWorkDir (drive.mjs) gives every attempt a never-used dir `work/<runId>-a<N>` (N = prior ledger entries + 1, bumped past dirs on disk).
    // A dry-run has no ledger entries, so A1's first attempt is `A1-a1`; assert the contract (suffix pattern, repo present), not a hardcoded legacy name.
    const attemptDirs = fs.readdirSync(path.join(WORK, 'work')).filter((d) => /^A1-a[1-9]\d*$/.test(d));
    expect(attemptDirs.length, fs.readdirSync(path.join(WORK, 'work')).join(',')).toBeGreaterThan(0);
    expect(attemptDirs.some((d) => fs.existsSync(path.join(WORK, 'work', d, 'repo')))).toBe(true);
    expect(fs.existsSync(path.join(WORK, 'work', 'A1', 'repo')), 'legacy un-suffixed dir must not be used').toBe(false);
  }, 300_000);

  it('AC2: an explicit in-repo --out is still rejected loudly', () => {
    const out = path.join(OUT_DEFAULT, 'explicit-out');
    const r = spawnSync(process.execPath, [DRIVE, '--dry-run', '--round', ROUND, '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
    expect(r.status).toBe(1);
    const recs = records(path.join(out, 'runs'));
    expect(recs.length).toBeGreaterThan(0);
    expect(String(recs[0].harnessFailure)).toMatch(/fixture directory sits under agent-instruction\/repo files/);
  }, 300_000);
});
