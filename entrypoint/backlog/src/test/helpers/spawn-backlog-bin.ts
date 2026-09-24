/**
 * spawn-backlog-bin.ts — the ONE canonical, correct-by-construction helper
 * for spawning the REAL BUILT `dist/index.js` in tests (STATE.md A15).
 *
 * Root cause this file exists to close: before this helper, every spec file
 * that needed to spawn the real bin hand-rolled its OWN `spawnSync`/`spawn`
 * wrapper with its OWN independently-chosen env vars. Correct isolation
 * (routing through `--namespace sandbox`, which mints a fresh `adhdRoot` AND
 * writes a real `config.yaml` forcing `embedding.enabled: false` — `cli.ts`'s
 * `--namespace sandbox` handling, SPEC.md §5c D8) depended entirely on each
 * file's author remembering to wire it correctly, every single time. That is
 * mechanically why the embedding leak recurred across 12+ files (8 in the
 * original sweep, `web-ui.spec.ts` found by profiling, `install.e2e.ts`
 * + `serve.singleton.spec.ts` + `serve.spec.ts` found by direct isolated-run
 * testing): a local variable literally named `adhdRoot` was minted
 * (`mkdtempSync`) and used only as the spawn's `cwd` — never passed as the
 * `ADHD_ROOT` env var or the `adhdRoot` option that actually redirects
 * config resolution. The name looked like isolation; it wasn't wired to
 * anything that provides it.
 *
 * Every function here ALWAYS routes through `--namespace sandbox` unless the
 * caller explicitly reaches for the `*Raw` variant, which exists ONLY for
 * the small number of tests that deliberately exercise the
 * `--namespace`/`sandbox-path` mechanism itself (or a raw, caller-controlled
 * env/HOME combination) — e.g. `cli.spec.ts`'s own `--namespace /
 * sandbox-path` describe block, and `cli-envelope.spec.ts`'s BUG-002 tests
 * that specifically probe `ADHD_BACKLOG_DATABASE_PATH` precedence. Using the
 * `Raw` variant anywhere else defeats the entire point of this file.
 *
 * Extracted and generalized from `cli.spec.ts`'s `runBin`/`runBinRaw`/
 * `mintSandbox`/`runInSandbox` (A13/A14 hardened this logic once already —
 * this file does not reinvent it), plus a new stdio-transport variant for
 * the tests that drive a real `@modelcontextprotocol/sdk` `Client` over
 * `StdioClientTransport` instead of a synchronous `spawnSync` round-trip
 * (`serve.spec.ts`, `serve.singleton.spec.ts`, `install.e2e.ts`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnTimeoutMs } from './spawn-timeout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/test/helpers/` -> package root -> `dist/index.js`. */
export const DIST_INDEX = join(HERE, '..', '..', '..', 'dist', 'index.js');

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The exact stderr line `cli.ts`'s `--namespace sandbox` prints when it
 * mints a FRESH sandbox root (i.e. no reusable `ADHD_ROOT` was supplied) —
 * parsed here so a caller can track and clean up whatever an invocation
 * actually minted, without reaching inside the spawned process.
 */
export function extractMintedSandboxRoot(stderr: string): string | undefined {
  const m = /--namespace sandbox: isolated store at (\S+)/.exec(stderr);
  return m?.[1];
}

/**
 * Spawns the REAL built `backlog` bin as a genuine child process, ALWAYS
 * with `--namespace sandbox` — never a bare, unisolated invocation.
 * `--namespace sandbox` alone (with no `cwd` override at all) fully isolates
 * every invocation via its own `adhdRoot` mechanism plus a real written
 * `config.yaml` forcing `embedding.enabled: false`, regardless of scope —
 * `cwd` is therefore irrelevant to store isolation and defaults to a neutral
 * `tmpdir()` (an explicit `cwd` override is accepted for the small number of
 * tests whose own behavior genuinely depends on the spawned process's cwd,
 * unrelated to backlog's own namespace/scope, e.g. `install-skill --scope
 * project`).
 *
 * To reuse the SAME sandboxed store across multiple calls within one test,
 * pass `ADHD_ROOT: <a previously minted adhdRoot>` in `extraEnv` (see
 * `mintBacklogSandbox`/`runInBacklogSandbox` below). `--namespace sandbox`
 * stays on every call either way, so `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001`'s
 * guard stays active throughout.
 *
 * `timeoutMs` bounds the child's wall-clock (default `spawnTimeoutMs()` —
 * see `spawn-timeout.ts`; it is generous so a load-starved host cannot turn a
 * successful command into an `ETIMEDOUT`, BACKLOG 345973b3). Pass an explicit
 * value only for a genuinely long-running invocation.
 */
export function runBacklogBin(
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd: string = tmpdir(),
  timeoutMs: number = spawnTimeoutMs()
): SpawnResult & { sandboxRoot?: string } {
  const result = spawnSync(
    process.execPath,
    [DIST_INDEX, '--namespace', 'sandbox', ...args],
    {
      cwd,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      timeout: timeoutMs,
    }
  );
  if (result.error) {
    throw new Error(
      `spawn failed for ${DIST_INDEX} ${JSON.stringify(args)}: ${String(
        result.error
      )}`
    );
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    sandboxRoot: extractMintedSandboxRoot(result.stderr ?? ''),
  };
}

/**
 * Spawns the real bin the same way `runBacklogBin` does but WITHOUT forcing
 * `--namespace sandbox` — for the small number of tests that deliberately
 * exercise the `--namespace`/`sandbox-path` mechanism itself, or a raw,
 * caller-controlled `HOME`/scope combination, where auto-injecting
 * `--namespace sandbox` would defeat the point of the test. Prefer
 * `runBacklogBin` unless you are one of those tests.
 */
export function runBacklogBinRaw(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs: number = spawnTimeoutMs()
): SpawnResult {
  const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) throw new Error(`spawn failed: ${String(result.error)}`);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** The JSON body `sandbox-path` reports (store-free, never opens the DB). */
export interface SandboxPathBody {
  adhdRoot?: string;
  namespace: string;
  dbPath: string;
  embeddingEnabled: boolean;
}

export type SandboxHandle = SandboxPathBody & { adhdRoot: string };

/**
 * Mints (or, if `reuseAdhdRoot` is given via `extraEnv.ADHD_ROOT`,
 * re-resolves) one `--namespace sandbox` store via the store-free
 * `sandbox-path` diagnostic: call `sandbox-path` ONCE to learn the isolated
 * root + effective `dbPath`, then thread that same `adhdRoot` through every
 * subsequent `runBacklogBin`/`runInBacklogSandbox` call in the test so all
 * calls land in the SAME store — never re-parsing paths out of ad hoc
 * `buildBacklogEnv` calls duplicating the tool's own resolution logic.
 */
export function mintBacklogSandbox(
  extraEnv: Record<string, string> = {}
): SandboxHandle {
  const res = runBacklogBin(['sandbox-path'], extraEnv);
  if (res.status !== 0) {
    throw new Error(
      `sandbox-path failed (status ${res.status})\nstderr:\n${res.stderr}`
    );
  }
  const body = JSON.parse(
    res.stdout.trim().split('\n').pop() ?? '{}'
  ) as SandboxPathBody;
  if (!body.adhdRoot) {
    throw new Error(`sandbox-path did not report adhdRoot: ${res.stdout}`);
  }
  return body as SandboxHandle;
}

/** Runs a real command AGAINST the given minted sandbox (reuses its `adhdRoot`). */
export function runInBacklogSandbox(
  sandbox: { adhdRoot: string },
  args: string[],
  extraEnv: Record<string, string> = {}
): SpawnResult {
  return runBacklogBin(args, { ADHD_ROOT: sandbox.adhdRoot, ...extraEnv });
}

/** `process.execPath`/`args`/`cwd`/`env` shape a `StdioClientTransport` constructor accepts. */
export interface StdioSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * Builds the `StdioClientTransport` constructor options for driving the
 * real built bin as an MCP stdio server AGAINST a minted `--namespace
 * sandbox` store (see `mintBacklogSandbox`) — the stdio-client analogue of
 * `runInBacklogSandbox` for the tests that drive a real
 * `@modelcontextprotocol/sdk` `Client` (`serve.spec.ts`,
 * `serve.singleton.spec.ts`, `install.e2e.ts`) instead of a synchronous
 * `spawnSync` round-trip. `tailArgs` is everything after the bin path itself
 * (e.g. `['serve', '--transport', 'mcp']`) — `--namespace sandbox` is always
 * injected before it, and `ADHD_ROOT` is always pinned to the minted
 * sandbox's root, so the spawned server opens the SAME isolated store any
 * seeding done via `sandbox.adhdRoot` (e.g. through `buildBacklogEnv({
 * adhdRoot: sandbox.adhdRoot, namespace: 'sandbox', ... })`) already wrote
 * to.
 */
export function stdioSpawnOptionsForSandbox(
  sandbox: { adhdRoot: string },
  tailArgs: string[],
  extraEnv: Record<string, string> = {}
): StdioSpawnOptions {
  return {
    command: process.execPath,
    args: [DIST_INDEX, '--namespace', 'sandbox', ...tailArgs],
    cwd: tmpdir(),
    env: {
      ...(process.env as Record<string, string>),
      ADHD_ROOT: sandbox.adhdRoot,
      ...extraEnv,
    },
  };
}

/**
 * `true` iff `p` looks like one of this tool's own sandbox tmpdirs — mirrors
 * `cli.ts`'s own `looksLikeOwnSandboxDir` check, exposed here purely so test
 * assertions about sandbox-root shape don't duplicate the pattern
 * independently.
 */
export function looksLikeOwnSandboxDir(p: string): boolean {
  return p.includes(`${sep}backlog-sandbox-`);
}
