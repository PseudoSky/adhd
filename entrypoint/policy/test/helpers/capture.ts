import { afterAll, beforeAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runPolicyCli, type IPolicyMountDeps } from '../../src/wrapper/mount';
import { runEntry } from '../../src/wrapper/run-entry';
import { WORKSPACE_YAML, writePolicy } from './fixtures';
import { removeScratchRootIfEmpty, SCRATCH_ROOT, withTmpDir } from './tmp';

/** What one in-process CLI run produced. */
export interface ICliResult {
  /** The exit code the run left behind (`process.exitCode`, 0 when never set). */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const STDOUT_METHODS = ['log', 'info', 'debug'] as const;
const STDERR_METHODS = ['error', 'warn'] as const;

/**
 * Runs the real `adhd-policy` command line in this process, the way
 * `src/entry/cli.ts` does (`runEntry(() => runPolicyCli(argv))`), so an error
 * thrown outside apigen's own handling maps to the same exit code the bin
 * gives it. `process.stdout.write`, `process.stderr.write`, `console.*` (which
 * the apigen cli plugin prints through) and `process.exitCode` are captured and
 * ALWAYS restored in `finally`. Nothing is mocked: the real apigen cli plugin,
 * the real client and the real policy files on disk are exercised.
 *
 * `deps.env` defaults to `{ADHD_POLICY_LOG_LEVEL: 'silent'}` (the apigen logger writes straight to fd 2, which an in-process run cannot capture); callers that rely on policy
 * discovery pass `cwd` and `home` (the walk-up ceiling) explicitly.
 */
export async function runCli(argv: readonly string[], deps: IPolicyMountDeps = {}): Promise<ICliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const realWrite = { out: process.stdout.write, err: process.stderr.write };
  const realConsole = new Map<string, unknown>();
  const realExitCode = process.exitCode;
  const render = (args: unknown[]): string => `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  const text = (chunk: string | Uint8Array): string => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  const target = console as unknown as Record<string, unknown>;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => (stdout.push(text(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => (stderr.push(text(chunk)), true)) as typeof process.stderr.write;
  for (const name of STDOUT_METHODS) {
    realConsole.set(name, target[name]);
    target[name] = (...args: unknown[]): void => void stdout.push(render(args));
  }
  for (const name of STDERR_METHODS) {
    realConsole.set(name, target[name]);
    target[name] = (...args: unknown[]): void => void stderr.push(render(args));
  }
  try {
    // Silent by default so a failing command does not spray the logger's own stderr record into the test output; specs that care pass their own level.
    const env = { ADHD_POLICY_LOG_LEVEL: 'silent', ...(deps.env ?? {}) };
    await runEntry(() => runPolicyCli(argv, { ...deps, env }));
    const code = process.exitCode;
    return { exitCode: typeof code === 'number' ? code : Number(code ?? 0), stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = realWrite.out;
    process.stderr.write = realWrite.err;
    for (const [name, original] of realConsole) target[name] = original;
    process.exitCode = realExitCode;
  }
}

/**
 * Registers hooks that send the CLI's telemetry log files to
 * `tmp/policy/telemetry-<pid>` (via `SOX_ECOSYSTEM_HOME`) for the spec file that
 * calls it, and remove that directory afterwards. Without it the first CLI run
 * would write under the user's home directory.
 */
export function useScratchTelemetry(): void {
  const previous = process.env['SOX_ECOSYSTEM_HOME'];
  const dir = join(SCRATCH_ROOT, `telemetry-${process.pid}`);
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    process.env['SOX_ECOSYSTEM_HOME'] = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
    else process.env['SOX_ECOSYSTEM_HOME'] = previous;
    await rm(dir, { recursive: true, force: true });
    await removeScratchRootIfEmpty();
  });
}

/** Parses the single JSON document a command printed on stdout. */
export function parseJson<T = Record<string, unknown>>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

const WARMED = Symbol.for('adhd-policy.test.cli-warmed');

/**
 * Pays the cold cost of the first in-process CLI run (lazy module loads and one-time runtime assembly, about a second
 * on a loaded machine) at collection time, so no test or hook carries it. Runs `verify` against a good policy with
 * telemetry off, once per process (a `vi.resetModules()` re-import does not repeat it), and touches nothing outside
 * `tmp/policy`.
 */
export async function warmCli(): Promise<void> {
  const flags = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (flags[WARMED] === true) return;
  flags[WARMED] = true;
  await withTmpDir('warm-cli', async (dir) => {
    await writePolicy(dir, WORKSPACE_YAML);
    await runCli(['verify'], { cwd: dir, home: dir, env: { ADHD_POLICY_TELEMETRY: 'off' } });
  });
}

await warmCli();
