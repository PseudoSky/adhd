/**
 * gate-workspace-root.spec.ts — regression test for
 * BUG-APIGEN-CONFORMANCE-GATE-DIRNAME-LEAK-001.
 *
 * `gate.ts`'s `main()` used to resolve its workspace-root search start with
 * `typeof __dirname !== 'undefined' ? __dirname : process.cwd()`. Under a
 * real ESM loader `__dirname` is undefined (Node never defines it in genuine
 * ESM — the identifier is simply absent, so `typeof` silently reports
 * `'undefined'`), so the fallback silently substituted `process.cwd()` for
 * "this module's own directory". Those are NOT the same thing: cwd only
 * happens to equal the workspace root when the process is launched from
 * there. Invoked from anywhere else (a consumer's install, a subdirectory,
 * a CI runner with a different working directory) it silently resolved the
 * WRONG root.
 *
 * Vitest's own vite-node transform injects a real per-module `__dirname`
 * shim (confirmed: `typeof __dirname` reports `'string'` inside a vitest
 * test even though vitest runs true ESM under the hood), and `tsx`
 * transpiles to CJS by default in this repo (no root `"type": "module"`),
 * so BOTH of this repo's own dev tools mask the bug — neither can be used
 * to prove it. Proving it requires a genuine, unmodified `node` process
 * running real ESM with zero loader/bundler shims, exactly the class of
 * proof `entrypoint/apigen-cli/src/test/e2e/dist-entry-no-argv-side-effect.spec.ts`
 * already established for the sibling `__dirname`/`import.meta` bug class in
 * this repo. This test bundles `gate.ts` with `esbuild` (a real, always-
 * present transitive dependency of this package's own `vite` toolchain —
 * every `nx build`/`nx test` in this repo already depends on esbuild being
 * installed) to a self-contained ESM artifact and runs it with a bare `node`
 * child process from several different working directories.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const GATE_SRC = path.join(PACKAGE_ROOT, 'src', 'lib', 'gate.ts');
const ESBUILD_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');

// Scratch dir lives under the canonical `tmp/` root (repo convention), but
// module resolution for the bundle's externalized `@adhd/*` bare specifiers
// only works when the importing file is reachable, via node_modules
// walk-up, to this PACKAGE's own (pnpm-nested) node_modules — so the
// scratch dir gets a symlink into it rather than living inside the package.
const SCRATCH_DIR = path.join(REPO_ROOT, 'tmp', 'apigen-engine-conformance');
const BUNDLE_PATH = path.join(SCRATCH_DIR, 'gate-bundle.mjs');
const SCRATCH_NODE_MODULES = path.join(SCRATCH_DIR, 'node_modules');
const PROBE_PATH = path.join(SCRATCH_DIR, 'probe.mjs');

const PROBE_SOURCE = `
import { findWorkspaceRoot, resolveModuleDir } from ${JSON.stringify(
  'file://' + BUNDLE_PATH.split(path.sep).join('/')
)};

const moduleDir = resolveModuleDir();
const workspaceRoot = findWorkspaceRoot(moduleDir);

console.log(JSON.stringify({ cwd: process.cwd(), moduleDir, workspaceRoot }));
`;

interface ProbeResult {
  cwd: string;
  moduleDir: string;
  workspaceRoot: string;
}

/** Run the probe script as a genuine `node` child process from `cwd`. */
async function runProbeFrom(cwd: string): Promise<ProbeResult> {
  fs.mkdirSync(cwd, { recursive: true });
  const { stdout } = await execFileAsync(process.execPath, [PROBE_PATH], {
    cwd,
  });
  return JSON.parse(stdout.trim()) as ProbeResult;
}

describe('gate.ts workspace-root resolution is cwd-independent (BUG-APIGEN-CONFORMANCE-GATE-DIRNAME-LEAK-001)', () => {
  let farCwd: string;
  let noAncestorNxJsonCwd: string;

  beforeAll(async () => {
    if (!fs.existsSync(ESBUILD_BIN)) {
      throw new Error(
        `esbuild binary not found at ${ESBUILD_BIN} — this test requires the ` +
          `repo's real toolchain to be installed (pnpm install at ${REPO_ROOT}); ` +
          `it must fail loudly, not skip.`
      );
    }

    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    fs.rmSync(SCRATCH_NODE_MODULES, { force: true });
    fs.symlinkSync(
      path.join(PACKAGE_ROOT, 'node_modules'),
      SCRATCH_NODE_MODULES,
      'dir'
    );

    // Bundle the REAL gate.ts source (this test exercises the actual
    // shipped code, not a hand-copied mirror of it) into a self-contained
    // ESM artifact. @adhd/* stays external (resolved at runtime via the
    // symlinked node_modules above); only node: builtins are external too.
    await execFileAsync(ESBUILD_BIN, [
      GATE_SRC,
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--external:@adhd/*',
      '--external:node:*',
      `--outfile=${BUNDLE_PATH}`,
    ]);

    fs.writeFileSync(PROBE_PATH, PROBE_SOURCE);

    farCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-root-probe-'));
    noAncestorNxJsonCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gate-root-probe-noanc-')
    );
  }, 60_000);

  afterAll(() => {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    if (farCwd) fs.rmSync(farCwd, { recursive: true, force: true });
    if (noAncestorNxJsonCwd) {
      fs.rmSync(noAncestorNxJsonCwd, { recursive: true, force: true });
    }
  });

  it(
    'resolves the true workspace root when invoked from the repo root',
    async () => {
      const result = await runProbeFrom(REPO_ROOT);
      expect(fs.realpathSync(result.workspaceRoot)).toBe(
        fs.realpathSync(REPO_ROOT)
      );
    },
    30_000
  );

  it(
    'resolves the SAME true workspace root when invoked from an unrelated cwd ' +
      '(e.g. os.tmpdir()) — this is the exact shape a consumer install or a ' +
      'differently-cwd-ed CI runner exercises',
    async () => {
      const fromRoot = await runProbeFrom(REPO_ROOT);
      const fromFar = await runProbeFrom(farCwd);

      expect(fs.realpathSync(fromFar.moduleDir)).toBe(
        fs.realpathSync(fromRoot.moduleDir)
      );
      expect(fs.realpathSync(fromFar.workspaceRoot)).toBe(
        fs.realpathSync(REPO_ROOT)
      );
    },
    30_000
  );

  it(
    'resolves the true workspace root even from a cwd with NO nx.json in any ' +
      'ancestor directory (the case the pre-fix cwd fallback got flat wrong: ' +
      'it silently returned the unrelated cwd itself)',
    async () => {
      const result = await runProbeFrom(noAncestorNxJsonCwd);
      expect(fs.realpathSync(result.workspaceRoot)).toBe(
        fs.realpathSync(REPO_ROOT)
      );
      expect(result.workspaceRoot).not.toBe(noAncestorNxJsonCwd);
    },
    30_000
  );
});
