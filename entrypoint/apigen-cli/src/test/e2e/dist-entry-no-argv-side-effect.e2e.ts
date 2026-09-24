// Regression test for BUG-APIGEN-CLI-VERIFY-DIST-LOAD-ARGV-001.
//
// Real-world trigger: `nx run apigen-cli:verify-dist-load` (and any other
// consumer that merely `require()`s/`import()`s the built `dist/index.js` /
// `dist/index.mjs` — e.g. a future library consumer, or the verify-dist-load
// harness's own load probe) unconditionally ran `program.parseAsync()` at
// **import time**, because apigen-cli's `index.ts` called it as the last
// top-level statement with no entry-point guard. `parseAsync()` reads
// `process.argv` and dispatches to a commander subcommand (or prints a
// "unknown command" error and — via commander's default `exitOverride`
// behavior — can call `process.exit`) using whatever ambient argv the HOST
// process happened to be started with, not the CLI's own. Any ambient argv
// token that isn't a valid apigen subcommand corrupts the load with
// commander's error output and a non-zero exit, entirely independent of the
// module doing the importing.
//
// The fix (src/index.ts) adds Node's documented "no `require.main` in ESM"
// entry-point guard (see entrypoint/backlog/src/index.ts:119 and
// entrypoint/agent-mcp/src/index.ts for the same pattern already proven in
// this repo): `program.parseAsync()` only runs when `import.meta.url` —
// which Node always resolves through symlinks — matches the REALPATH of
// `process.argv[1]`. Because pnpm/npm always install a package's `bin` as a
// symlink (`node_modules/.bin/apigen -> .../dist/index.js`), comparing
// against the raw (unresolved) `argv[1]` would silently never match through
// that symlink, which is why the guard resolves it via `realpathSync` first.
//
// This MUST run against the BUILT dist artifact as a real `node` child
// process (no in-process import, no tsx/vitest transform in the loop) —
// that is the exact runtime path the bug lives in. A vitest test that merely
// `import()`s the TS source in-process would never observe the ambient-argv
// side effect, because vitest's own process argv never collides with a
// commander subcommand name and because the module-execution timing differs
// from a real bare `node dist/index.js` load.

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BUILT_BIN_CJS = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'dist',
  'index.js'
);
const BUILT_BIN_ESM = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'dist',
  'index.mjs'
);

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `node -e <script>`, capturing exit code + stdio without throwing on a non-zero exit. */
async function runNodeEval(
  script: string,
  extraArgs: string[] = []
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['-e', script, '--', ...extraArgs],
      { cwd: REPO_ROOT }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Run `node <file> [...args]` directly (this file IS the process entry point). */
async function runNodeFile(
  file: string,
  args: string[]
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      file,
      ...args,
    ], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('dist entry point: no argv-parsing side effect on mere require()/import()', () => {
  it(
    'require()ing the built CJS entry with ambient argv does NOT dispatch to commander',
    async () => {
      // `-- someRandomArg` appends an ambient argv token AFTER the script,
      // landing in process.argv the same way an unrelated caller's argv would.
      // Pre-fix, the unconditional `program.parseAsync()` reads this same
      // process.argv, fails to match 'someRandomArg' to any registered
      // subcommand, and commander reports an error / exits non-zero.
      const script = `require(${JSON.stringify(BUILT_BIN_CJS)});`;
      const result = await runNodeEval(script, ['someRandomArg']);

      expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout.toLowerCase()).not.toContain('unknown command');
      expect(result.stderr.toLowerCase()).not.toContain('unknown command');
    },
    30_000
  );

  it(
    'dynamically import()ing the built ESM entry does not throw or dispatch',
    async () => {
      const script = `import(${JSON.stringify(pathToUrl(BUILT_BIN_ESM))}).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });`;
      const result = await runNodeEval(script);

      expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout.toLowerCase()).not.toContain('unknown command');
      expect(result.stderr.toLowerCase()).not.toContain('unknown command');
    },
    30_000
  );

  it(
    'invoking the built bin directly as the real process entry point still works (--version)',
    async () => {
      // This IS the shape a real consumer uses: `node dist/index.js --version`.
      // The guard must NOT break this — argv[1] resolves (via realpathSync) to
      // this same file's own import.meta.url, so parseAsync() must still run.
      const result = await runNodeFile(BUILT_BIN_CJS, ['--version']);

      expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
      // src/index.ts: new Command().name('apigen').version('0.1.0') — commander
      // prints exactly the configured version string for `--version`.
      expect(result.stdout.trim()).toBe('0.1.0');
    },
    30_000
  );
});

function pathToUrl(p: string): string {
  // file:// URL, forward-slash normalized for cross-platform safety.
  return 'file://' + p.split(path.sep).join('/');
}
