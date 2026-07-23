import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ───────────────────────────────────────────────────────────────────────────
// REAL-SUBPROCESS integration test — drives the actual `apigen` bin the way a
// consumer does (`apigen run --source <fixture> --type cli -- <command>
// <args>`), per AGENTS.md §7 "drive the real tools": no in-process shortcuts,
// no reaching inside the CLI's modules — a real child process, the real
// built dist, the real orchestrator/extractor/plugin-registry wiring.
//
// Proves the headline capability end-to-end: `--type cli` used to be
// rejected outright by `apigen run` ("Plugin cli does not support run
// mode") — now it dispatches a real command against a real (freshly
// extracted, from real TypeScript source) operation and returns the exact
// JSON a direct in-process call would.
//
// Argv delivery: DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001 (RESOLVED) — `apigen
// run`/`run-registry` now declare a trailing variadic argument
// (`entrypoint/apigen-cli/src/lib/commands/{run,run-registry}.ts`'s
// `.argument('[cliArgs...]')`), so the idiomatic native `-- <command> <args>`
// positional passthrough is accepted by Commander and threaded onto
// `RunInput.options['argv']` as a real `string[]` — see the "native `--`
// passthrough" test below. The original `--opt argv=<command line>` (a
// single shell-tokenized string — see `run.ts`'s `resolveArgv`/
// `tokenizeShellLike`) keeps working unchanged for back-compat (proven by
// every other test in this file, which still use it).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The bundled standalone CLI — spawned as `node <bundle> run …`, mirroring
 * `entrypoint/apigen-cli/src/test/serve.spec.ts`'s own real-subprocess
 * pattern. Build output is in-source ({projectRoot}/dist); walk up from this
 * test file until `entrypoint/apigen-cli/dist/index.js` exists.
 */
const cliPath = (() => {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'entrypoint/apigen-cli/dist/index.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '../../../../../entrypoint/apigen-cli/dist/index.js');
})();

describe('[cli-output.run.live] apigen run --type cli — real subprocess, real built bin', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeFixture(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-cli-run-'));
    const file = path.join(tmpDir, 'index.ts');
    fs.writeFileSync(
      file,
      [
        `export function getItem(id: string, includeArchived?: boolean) {`,
        `  return { id, title: \`Item \${id}\`, includeArchived: includeArchived ?? false };`,
        `}`,
        `export function listItems(tags?: string[]) {`,
        `  return tags ?? ['default'];`,
        `}`,
      ].join('\n')
    );
    return file;
  }

  it(
    'accepts --type cli for run (previously rejected as generate-only) and dispatches a real command',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath} — run "nx build apigen-cli" first`).toBe(true);
      const fixture = writeFixture();

      const { stdout, stderr } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        // §9.1-style extension for the run() argv delivery — see module doc.
        '--opt',
        'argv=fixture index get-item --id 42',
      ]);

      // Real extraction really ran (log line from the real orchestrator).
      expect(stderr).toContain('extracted 2 operations');
      // The plugin's run() printed exactly the direct-call result as JSON —
      // ground truth computed independently, not copy-pasted from the fn.
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '42',
        title: 'Item 42',
        includeArchived: false,
      });
    }
  );

  it(
    'accepts a native `-- <command> <args>` positional passthrough (DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001) — no --opt argv= needed',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath} — run "nx build apigen-cli" first`).toBe(true);
      const fixture = writeFixture();

      const { stdout, stderr } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        '--',
        'fixture',
        'index',
        'get-item',
        '--id',
        '42',
      ]);

      // Real extraction really ran (log line from the real orchestrator).
      expect(stderr).toContain('extracted 2 operations');
      // Ground truth computed independently — same expectation as the
      // --opt argv= variant above, proving the two delivery paths are
      // equivalent end-to-end.
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '42',
        title: 'Item 42',
        includeArchived: false,
      });
    }
  );

  it(
    'native `--` passthrough takes precedence over a stale --opt argv= when both are supplied',
    { timeout: 30000 },
    async () => {
      const fixture = writeFixture();

      const { stdout } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        '--opt',
        // Deliberately WRONG id via the old delivery path — if this won, the
        // result below would be `{ id: '999', ... }` instead.
        'argv=fixture index get-item --id 999',
        '--',
        'fixture',
        'index',
        'get-item',
        '--id',
        '42',
      ]);
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '42',
        title: 'Item 42',
        includeArchived: false,
      });
    }
  );

  it(
    'a validation failure (missing required --id) exits non-zero with the ApiError CLI_EXIT_CODE (2), never crashes',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath)).toBe(true);
      const fixture = writeFixture();

      await expect(
        execFileAsync('node', [
          cliPath,
          'run',
          '--source',
          fixture,
          '--type',
          'cli',
          '--namespace',
          'fixture',
          '--opt',
          'argv=fixture index get-item',
        ])
      ).rejects.toMatchObject({
        code: 2, // CLI_EXIT_CODE.invalid_argument
        stderr: expect.stringContaining('invalid_argument'),
      });
    }
  );

  it(
    'a JSON-typed (array) param round-trips through a real command line',
    { timeout: 30000 },
    async () => {
      const fixture = writeFixture();
      const { stdout } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        '--opt',
        'argv=fixture index list-items --tags ["a","b"]',
      ]);
      expect(JSON.parse(stdout.trim())).toEqual(['a', 'b']);
    }
  );

  it(
    '[contrast] a real generate-only plugin (jsonschema) still cannot run — proves the acceptance is specific to cli, not a global relaxation',
    { timeout: 30000 },
    async () => {
      const fixture = writeFixture();
      await expect(
        execFileAsync('node', [
          cliPath,
          'run',
          '--source',
          fixture,
          '--type',
          'jsonschema',
          '--namespace',
          'fixture',
        ])
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('does not support run mode'),
      });
    }
  );
});
