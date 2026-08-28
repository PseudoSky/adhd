// apigen-cli e2e — `ts-types` output target driven through the BUILT CLI the
// way a consumer does (SPEC §Test plan B). Default-running: no env gate.
//
// Spawns `node <built bin> list-types` + `generate --type ts-types` against the
// real fixture, asserts exit codes + emitted content, then esbuild-compiles
// every emitted file. Negative control: a mutated file with a bare `-`
// identifier splice must make the same transform REJECT — proving the compile
// check is not a no-op. `node --check` is never used (BUG-APIGEN-032 proved it
// permissive); `tsc` is never run by hand.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// esbuild is a devDependency of apigen-cli; a missing install must fail the
// import loudly (never silently skip the compile check).
import { transform } from 'esbuild';
import { liveTestTimeoutMs } from '../support/readiness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BUILT_BIN = path.join(REPO_ROOT, 'entrypoint', 'apigen-cli', 'dist', 'index.js');
const FIXTURE = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'src',
  'test',
  'fixtures',
  'ts-types-source.ts'
);

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the built bin and capture stdout/stderr + exit code (never `| grep`). */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BUILT_BIN, ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('apigen-cli ts-types output target (e2e, built bin)', () => {
  it('list-types lists ts-types as a generate-only target', async () => {
    const res = await runCli(['list-types']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ts-types');
    expect(res.stdout).toContain('(generate)');
  }, liveTestTimeoutMs(1));

  it('generate --type ts-types writes per-fn TS type files that esbuild-compile; union proven; negative control', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ts-types-'));
    const res = await runCli([
      'generate',
      '--source',
      FIXTURE,
      '--type',
      'ts-types',
      '--namespace',
      'demo-api',
      '--out-dir',
      tmpDir,
    ]);
    // Trust the exit code — never stdout. Surface captured stderr on failure.
    expect(
      res.code,
      `apigen generate (ts-types) failed with code ${res.code}\n--- stderr ---\n${res.stderr}\n--- stdout ---\n${res.stdout}`
    ).toBe(0);

    const readFile = (fn: string): string =>
      fs.readFileSync(path.join(tmpDir, 'demo-api', fn), 'utf8');

    // getUser: named interfaces for input + output; optional member survives.
    const getUser = readFile('getUser.ts');
    expect(getUser).toContain('export interface DemoApiGetUserInput {');
    expect(getUser).toContain('userId: string;');
    expect(getUser).toContain('export interface DemoApiGetUserOutput {');
    expect(getUser).toContain('id: string;');
    expect(getUser).toContain('name?: string | null;');

    // listUsers: enum param + array output.
    const listUsers = readFile('listUsers.ts');
    expect(listUsers).toContain("role: 'admin' | 'user';");
    expect(listUsers).toContain('export type DemoApiListUsersOutput = string[];');

    // runTask: the discriminated union (oneOf + discriminator, `_batch` shape)
    // extracted through the REAL extractor — named union, per-branch named
    // interfaces, discriminant retained, and never `any`/`unknown`.
    const runTask = readFile('runTask.ts');
    expect(runTask).toContain(
      'export type DemoApiRunTaskOutput = DemoApiRunTaskOutputText | DemoApiRunTaskOutputFile;'
    );
    expect(runTask).toContain('export interface DemoApiRunTaskOutputText {');
    expect(runTask).toContain("kind: 'text';");
    expect(runTask).toContain('content: string;');
    expect(runTask).toContain('export interface DemoApiRunTaskOutputFile {');
    expect(runTask).toContain("kind: 'file';");
    expect(runTask).toContain('path: string;');
    expect(runTask).toContain('sizeBytes: number;');
    expect(runTask).not.toContain('any');
    expect(runTask).not.toContain('unknown');

    // Compile check: every emitted .ts must transform as valid TS via esbuild.
    const emitted = fs
      .readdirSync(path.join(tmpDir, 'demo-api'))
      .filter((f) => f.endsWith('.ts'));
    expect(emitted.sort()).toEqual(['getUser.ts', 'listUsers.ts', 'runTask.ts']);
    for (const f of emitted) {
      await expect(
        transform(readFile(f), { loader: 'ts' }),
        `emitted ${f} must esbuild-transform as valid TS`
      ).resolves.toBeDefined();
    }

    // Negative control (teeth): a bare `-` splice into a sanitized type name
    // must make the same esbuild transform REJECT.
    const bad = getUser.replace('DemoApiGetUserInput', 'DemoApi-GetUserInput');
    expect(bad).not.toBe(getUser);
    await expect(transform(bad, { loader: 'ts' })).rejects.toThrow();
  }, liveTestTimeoutMs(2));
});
