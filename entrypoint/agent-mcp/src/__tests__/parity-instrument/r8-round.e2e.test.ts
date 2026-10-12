import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PARITY_DIR } from './load';

/**
 * R8 (e2e lane, subprocess): `drive.mjs --dry-run --round R8` and `preflight.mjs --round R8` end to end against the REAL built agent-mcp, the instrument's fake
 * `claude` (which resolves the alias `haiku` to claude-haiku-5-5 and POSTs a request-shaped probe through ANTHROPIC_BASE_URL), the in-process fake Anthropic server and
 * the egress guard. No model, no network. The dry run writes only under an explicit tmp `--out`, so the real R8 output and ledger are never touched.
 *   R8-profile AC1  only arm B is planned, run and preflighted     R8-model AC3  requested alias -> resolved id, priced by the resolved id
 *   R8-effort AC2   effort high is carried on the wire             R8-capture AC1 the dry-run proxy forwarded to the local fake only
 */
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const PREFLIGHT = path.join(PARITY_DIR, 'preflight.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
let out = '';
beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'r8-dry-')); });
afterAll(() => { fs.rmSync(out, { recursive: true, force: true }); });

describe('R8 e2e', () => {
  it('AC1: preflight --round R8 exits 0 and probes ONLY arm B', () => {
    const r = spawnSync(process.execPath, [PREFLIGHT, '--round', 'R8'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n')));
    expect(j.ok).toBe(true);
    expect(j.legs.map((l: { arm: string }) => l.arm)).toEqual(['B']);
  }, 150_000);

  it('AC1: --print-plan --round R8 plans one run, B1, with the alias model, effort high and capture ON', () => {
    const r = spawnSync(process.execPath, [DRIVE, '--print-plan', '--round', 'R8'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 planned (profile arms B');
    expect(r.stdout).toMatch(/\n\s+1\. B1\n/);
    expect(r.stdout).not.toMatch(/\n\s+\d\. [AC]1\n/);
    expect(r.stdout).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
  }, 150_000);

  it('AC3: the dry run records requested haiku -> resolved claude-haiku-5-5, effort verified on the wire, and a wire log that only ever hit the local fake', () => {
    const ledgerFile = path.join(PARITY_DIR, 'ledger', 'R8.json'); const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
    const r = spawnSync(process.execPath, [DRIVE, '--dry-run', '--round', 'R8', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const runs = path.join(out, 'runs');
    expect(fs.readdirSync(runs)).toEqual(['B1']);   // only arm B ran
    const rec = JSON.parse(fs.readFileSync(path.join(runs, 'B1', 'record.json'), 'utf8'));
    expect(rec.harnessFailure).toBeUndefined();
    expect(rec.arm).toBe('B');
    expect(rec.model).toMatchObject({ requested: 'haiku', alias: true, resolved: ['claude-haiku-5-5'] });
    expect(rec.model.pricing[0]).toMatchObject({ model: 'claude-haiku-5-5', card: 'claude-haiku-5-5' });
    expect(rec.effort).toMatchObject({ requested: 'high', arm: 'B', status: 'verified' });
    expect(rec.effort.observed).toEqual(['high']);
    expect(rec.capture).toMatchObject({ on: true, arm: 'B' });
    // R8-capture AC1: every logged response came from the local fake (200), none from a real API (a real call to a keyless probe is a 401)
    const wire = path.join(runs, 'B1', 'logs', 'wire', 'proxy-B-anthropic.jsonl');
    const turns = fs.readFileSync(wire, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'turn');
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.status === 200)).toBe(true);
    expect(fs.readFileSync(wire, 'utf8')).not.toMatch(/cloudflare|cf-ray/i);
    // the real R8 ledger is untouched by a dry run
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);   // byte-identical, whatever the live round has since recorded
  }, 300_000);
});
