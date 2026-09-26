/**
 * server.startup-path.e2e.ts — the PRIMARY TEETH for the bake-at-build design
 * (design doc Revision 3). Proves the consumer-visible outcome the CRITICAL
 * backlog item is about: a real `backlog --help` on a built package does NOT
 * load ts-morph, because it reads the baked `dist/api.ir.json` instead of
 * extracting.
 *
 * HOW it is proven (a real host-observable signal, not a proxy):
 *  - The built `dist/index.js` is spawned exactly as a consumer runs it, under
 *    an isolated HOME/cwd (the shared `runIsolatedBin` helper), with a CJS
 *    module-load probe injected via `NODE_OPTIONS=--require <probe.cjs>`. The
 *    probe patches `Module._load` and appends to a log the moment anything
 *    requires `ts-morph`. Nothing in the test reaches inside the server.
 *
 * NEGATIVE CONTROL: rename `api.ir.json` away → the SAME run MUST log
 * ts-morph (the fallback extraction consults it). This is what gives the
 * baked-path assertion teeth: a probe that could never fire would make the
 * "no ts-morph" assertion meaningless.
 *
 * STALE CONTROL: mutate a byte of `api.d.ts` → the artifact's source-hash gate
 * refuses it → the SAME run MUST log ts-morph. Proves "never serve stale",
 * end-to-end, not just at the unit level.
 *
 * Any `dist/` file this test renames/mutates is restored in a `finally`, so a
 * FAILING run still leaves the shared build output exactly as it found it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const API_DTS = join(HERE, '..', 'dist', 'api.d.ts');
const API_IR = join(HERE, '..', 'dist', 'api.ir.json');

/** Fail LOUDLY (never silently skip) if the built artifacts are missing. */
function assertBuilt(): void {
  for (const p of [DIST_INDEX, API_DTS, API_IR]) {
    expect(
      (() => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      })(),
      `built artifact missing — run "nx build backlog" first: ${p}`
    ).toBe(true);
  }
}

const PROBE_SOURCE = `
const Module = require('module');
const fs = require('fs');
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'ts-morph' || request.startsWith('ts-morph/')) {
    fs.appendFileSync(process.env.PROBE_LOG, 'ts-morph\\n');
  }
  return orig.apply(this, arguments);
};
`;

let root: string;
let probePath: string;
let probeLog: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backlog-startup-path-e2e-'));
  probePath = join(root, 'tsmorph-probe.cjs');
  probeLog = join(root, 'probe.log');
  writeFileSync(probePath, PROBE_SOURCE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function probeEnv(): Record<string, string> {
  return { NODE_OPTIONS: `--require ${probePath}`, PROBE_LOG: probeLog };
}

function probeLogText(): string {
  try {
    return readFileSync(probeLog, 'utf8');
  } catch {
    return '';
  }
}

describe('server startup path — baked artifact vs. live extraction (design doc Revision 3)', () => {
  it('BAKED: `--help` reads api.ir.json and never loads ts-morph', () => {
    assertBuilt();
    const r = runIsolatedBin(DIST_INDEX, ['--help'], root, {
      extraEnv: probeEnv(),
      timeoutMs: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(probeLogText()).not.toContain('ts-morph');
  });

  it('NEGATIVE CONTROL: with api.ir.json removed, the same run DOES load ts-morph (fallback)', () => {
    assertBuilt();
    const backup = `${API_IR}.e2e-backup`;
    renameSync(API_IR, backup);
    try {
      const r = runIsolatedBin(DIST_INDEX, ['--help'], root, {
        extraEnv: probeEnv(),
        timeoutMs: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(probeLogText()).toContain('ts-morph');
    } finally {
      renameSync(backup, API_IR);
    }
  });

  it('STALE CONTROL: mutating api.d.ts invalidates the artifact, so the run loads ts-morph', () => {
    assertBuilt();
    const original = readFileSync(API_DTS, 'utf8');
    try {
      writeFileSync(API_DTS, `${original}\n// stale-source probe\n`);
      const r = runIsolatedBin(DIST_INDEX, ['--help'], root, {
        extraEnv: probeEnv(),
        timeoutMs: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(probeLogText()).toContain('ts-morph');
    } finally {
      writeFileSync(API_DTS, original);
    }
  });
});
