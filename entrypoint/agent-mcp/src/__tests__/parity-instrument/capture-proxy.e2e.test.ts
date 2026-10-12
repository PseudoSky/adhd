import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PARITY_DIR } from './load';

/**
 * R6B-proxy (e2e lane, subprocess): `drive.mjs --dry-run --capture` end to end against the REAL built agent-mcp and the instrument's fakes
 * (fake `claude`, in-process fake Anthropic server, egress guard on). No model, no network. Proves the consumer path: the C server env
 * (ANTHROPIC_BASE_URL) really reaches the Anthropic SDK inside the spawned agent-mcp, the request lands in the proxy, is forwarded to the fake,
 * and is logged; the record carries the capture facts; wire-diff reads the logs; and without --capture nothing is captured. Owns round R96.
 *   AC4 wiring + record   AC5 wire-diff CLI   AC6 default OFF leaves the run unchanged
 */
const DRIVE = path.join(PARITY_DIR, 'drive.mjs');
const WIRE_DIFF = path.join(PARITY_DIR, 'wire-diff.mjs');
const REPO = path.resolve(PARITY_DIR, '..', '..', '..');
const ROUND_ON = 'R96'; const ROUND_OFF = 'R95';
const OUT = (round: string) => path.join(REPO, 'tmp', 'agent-mcp', 'parity', round);
const WORK = (round: string) => path.join(os.tmpdir(), 'adhd-agent-mcp-parity', round);
const clean = () => { for (const r of [ROUND_ON, ROUND_OFF]) { fs.rmSync(OUT(r), { recursive: true, force: true }); fs.rmSync(WORK(r), { recursive: true, force: true }); } };
// beforeAll too: the driver resumes finished records, so a stale round dir from an interrupted run would make the dry-run a no-op.
beforeAll(clean); afterAll(clean);

const records = (round: string) => { const dir = path.join(OUT(round), 'dry', 'out', 'runs'); return Object.fromEntries(fs.readdirSync(dir).map((d) => [d, JSON.parse(fs.readFileSync(path.join(dir, d, 'record.json'), 'utf8'))])); };
const runDir = (round: string, id: string) => path.join(OUT(round), 'dry', 'out', 'runs', id);

describe('R6B-proxy e2e', () => {
  it('AC4: --dry-run --capture routes arm C through the proxy into logs/wire and records the capture facts', () => {
    const r = spawnSync(process.execPath, [DRIVE, '--dry-run', '--capture', '--round', ROUND_ON], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const recs = records(ROUND_ON);
    const c = Object.values(recs).find((x: any) => x.arm === 'C') as any;
    expect(c.harnessFailure).toBeUndefined();
    expect(c.capture).toMatchObject({ on: true, arm: 'C' });
    expect(c.capture.baseUrlEnv).toEqual(['ANTHROPIC_BASE_URL', 'ADHD_AGENT_OPENAI_BASE_URL', 'ADHD_AGENT_DEEPSEEK_BASE_URL']);
    expect(c.capture.proxyOverheadP50Ms.sseFirstChunkMs).toEqual(expect.any(Number));
    expect(c.config.capture).toMatch(/wire capture ON/);
    const file = path.join(runDir(ROUND_ON, c.runId), 'logs', 'wire', 'proxy-C-anthropic.jsonl');
    const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const reqs = ev.filter((e) => e.type === 'raw_request');
    expect(reqs.length, 'the server SDK request must have landed at the proxy').toBeGreaterThan(0);
    expect(reqs[0].path).toBe('/v1/messages');
    expect(Array.isArray(reqs[0].body.messages)).toBe(true);
    expect(ev.some((e) => e.type === 'turn' && e.status === 200)).toBe(true);
    // never a credential: the dry-run secret travels in a header and must be absent from the log
    expect(fs.readFileSync(file, 'utf8')).not.toContain('dry-run-not-a-secret');
    // A and B in a dry run spawn the fake claude, which makes no HTTP: their env is still wired (unit-proven), their logs are simply empty or absent.
    for (const x of Object.values(recs).filter((y: any) => y.arm !== 'C') as any[]) expect(x.capture).toMatchObject({ on: true });

    // AC5: the offline reader runs on the run directory
    const wd = spawnSync(process.execPath, [WIRE_DIFF, runDir(ROUND_ON, c.runId)], { encoding: 'utf8' });
    expect(wd.status, wd.stderr).toBe(0);
    expect(wd.stdout).toContain('== arm C');
    expect(wd.stdout).toContain('delta of first requests');
    expect(spawnSync(process.execPath, [WIRE_DIFF], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [WIRE_DIFF, path.join(os.tmpdir(), 'r6b-no-such-dir')], { encoding: 'utf8' }).status).toBe(1);
  }, 300_000);

  it('AC6: without --capture nothing is captured (no logs/wire, no record.capture) and the dry-run is unchanged', () => {
    const r = spawnSync(process.execPath, [DRIVE, '--dry-run', '--round', ROUND_OFF], { cwd: REPO, encoding: 'utf8', timeout: 240_000, env: { ...process.env, PARITY_CAPTURE: '' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const rec of Object.values(records(ROUND_OFF)) as any[]) {
      expect(rec.capture).toBeUndefined();
      expect(rec.config).not.toHaveProperty('capture');
      expect(fs.existsSync(path.join(runDir(ROUND_OFF, rec.runId), 'logs', 'wire'))).toBe(false);
    }
  }, 300_000);
});
