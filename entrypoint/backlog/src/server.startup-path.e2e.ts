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
 * ISOLATION (2026-09-26): the bin runs from a PRIVATE copy of `dist/`
 * (`createIsolatedDist`, under the gitignored `tmp/`), so the `api.ir.json`
 * renamed away and the `api.d.ts` mutated are this suite's OWN. It previously
 * renamed/mutated the SHARED in-tree `entrypoint/backlog/dist/`; because the
 * `finally` restore races a concurrent `vite build` (`emptyOutDir: true`) or nx
 * directory-output cache restore — which deletes the whole `dist/` dir — the
 * backup could vanish and the restore throw `ENOENT` (the red-gate defect),
 * and while the shared artifact was renamed away every sibling saw it missing.
 * The private copy is removed in `afterEach`, so a FAILING run still leaves the
 * shared build output untouched.
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
import {
  createIsolatedDist,
  type IsolatedDist,
} from './test/helpers/isolated-dist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIST = join(HERE, '..', 'dist');
const SHARED_INDEX = join(SHARED_DIST, 'index.js');
const SHARED_API_DTS = join(SHARED_DIST, 'api.d.ts');
const SHARED_API_IR = join(SHARED_DIST, 'api.ir.json');

/** Fail LOUDLY (never silently skip) if the built artifacts are missing. */
function assertBuilt(): void {
  for (const p of [SHARED_INDEX, SHARED_API_DTS, SHARED_API_IR]) {
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
let iso: IsolatedDist | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backlog-startup-path-e2e-'));
  probePath = join(root, 'tsmorph-probe.cjs');
  probeLog = join(root, 'probe.log');
  writeFileSync(probePath, PROBE_SOURCE);
  // Private dist copy — the artifact contract is exercised against THIS, never
  // the shared in-tree build output a concurrent build may wipe.
  iso = createIsolatedDist(SHARED_DIST, 'startup-path');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  iso?.cleanup();
  iso = undefined;
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
    const r = runIsolatedBin(iso!.indexPath, ['--help'], root, {
      extraEnv: probeEnv(),
      timeoutMs: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(probeLogText()).not.toContain('ts-morph');
  });

  it('NEGATIVE CONTROL: with api.ir.json removed, the same run DOES load ts-morph (fallback)', () => {
    assertBuilt();
    const backup = `${iso!.apiIrPath}.e2e-backup`;
    renameSync(iso!.apiIrPath, backup);
    try {
      const r = runIsolatedBin(iso!.indexPath, ['--help'], root, {
        extraEnv: probeEnv(),
        timeoutMs: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(probeLogText()).toContain('ts-morph');
    } finally {
      renameSync(backup, iso!.apiIrPath);
    }
  });

  it('STALE CONTROL: mutating api.d.ts invalidates the artifact, so the run loads ts-morph', () => {
    assertBuilt();
    const original = readFileSync(iso!.apiDtsPath, 'utf8');
    try {
      writeFileSync(iso!.apiDtsPath, `${original}\n// stale-source probe\n`);
      const r = runIsolatedBin(iso!.indexPath, ['--help'], root, {
        extraEnv: probeEnv(),
        timeoutMs: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(probeLogText()).toContain('ts-morph');
    } finally {
      writeFileSync(iso!.apiDtsPath, original);
    }
  });
});
