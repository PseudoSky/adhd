import { homedir } from 'node:os';
import { ApiError } from '@adhd/apigen-base-errors';
import type { OutputPlugin, RunInput } from '@adhd/apigen-core-client';
import { createLogger, type UsePlugin } from '@adhd/apigen-engine-runtime';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { cliPlugin } from '@adhd/apigen-plugin-cli-output';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import {
  buildPolicyEnv,
  createPolicyCtx,
  type IAuditSink,
  type IPolicyCtx,
  type IRuntimeProvider,
} from '@adhd/policy-core-client';
import { HTTP_PORT_ENV_VAR, parseHttpPort } from './http-port';
import { runIrArtifact } from './ir-artifact';
import { LOG_LEVEL_ENV_VAR, resolveLogLevel } from './log-level';
import { buildPolicyPackage } from './package';
import { prefixCommand, resolveCommandPrefix } from './prefix';
import { installAbortOnSignals } from './signals';
import { initPolicyTelemetry } from './telemetry';
import { tracingPlugin } from './tracing';
import { dispatchVerb, VERB_NAMES } from './verbs/index';

/** Everything the mount needs from the outside; entry files pass none of it. */
export interface IPolicyMountDeps {
  /** Default `process.cwd()`, read ONCE here and passed down as data. */
  readonly cwd?: string;
  /** Default `process.env`; read once at this boundary and passed down as data. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The user's home directory: the walk-up ceiling for project policy discovery. Default `os.homedir()`. */
  readonly home?: string;
  readonly ports?: { runtime?: IRuntimeProvider; audit?: IAuditSink };
  /** Extra `--use` plugins (tests); entry files pass none. */
  readonly extraUsePlugins?: readonly UsePlugin[];
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

function requireRun(plugin: OutputPlugin): (input: RunInput) => Promise<void> {
  if (!plugin.run) {
    throw new Error(`@adhd/policy: apigen plugin "${plugin.id}" declares no run() - cannot mount live`);
  }
  return plugin.run;
}

/**
 * A lazy ctx thunk: the environment and the ctx are built only when a command
 * actually dispatches, so `--help`, an unknown command and argument errors
 * read no policy file. The context is built fresh per dispatch (file sources
 * are re-read on every call).
 */
function lazyCtx(deps: IPolicyMountDeps, cwd: string, home: string): () => IPolicyCtx {
  let env: ReturnType<typeof buildPolicyEnv> | undefined;
  let announced: string | undefined;
  return () => {
    env ??= buildPolicyEnv({ projectRoot: cwd });
    return createPolicyCtx(env, {
      cwd,
      stopAt: home,
      ...(deps.ports ?? {}),
      // D-12: the policy source is announced on stderr (`policy: <path or built-in>`), once per distinct source.
      onSource: (label) => {
        if (label === announced) return;
        announced = label;
        process.stderr.write(`${label}\n`);
      },
    });
  };
}

/**
 * Failure reports carry `ok:false`: `verify` / `compile` with an `errors` list
 * and `doctor` with its `checks` list. Both exit 2 (D-05). Everything else keeps
 * apigen's own code.
 */
function exitCodeForResult(result: unknown): number | undefined {
  if (result !== null && typeof result === 'object') {
    const report = result as { ok?: unknown; errors?: unknown; checks?: unknown };
    if (report.ok === false && (Array.isArray(report.errors) || Array.isArray(report.checks))) return 2;
  }
  return undefined;
}

/**
 * 1. `dispatchVerb(argv)`: when `argv[0]` is `run`, `serve` or `mcp-json` the
 *    verb runs and sets `process.exitCode`. 2. Otherwise apigen's CLI owns
 *    flags, validation, help and exit codes (`CLI_EXIT_CODE`). The hidden
 *    `ir-artifact --out <file>` subcommand is the build-time bake (`--out` must
 *    resolve under this package's `dist/`; failures exit through `CLI_EXIT_CODE`).
 */
export async function runPolicyCli(argv: readonly string[], deps: IPolicyMountDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const stderr = (text: string): void => void process.stderr.write(text);
  if (argv[0] === 'ir-artifact') {
    process.exitCode = await runIrArtifact(argv.slice(1), { cwd, stderr });
    return;
  }
  initPolicyTelemetry('cli');
  const home = deps.home ?? homedir();
  const isVerb = (VERB_NAMES as readonly string[]).includes(argv[0] ?? '');
  const verb = await dispatchVerb(argv, {
    cwd,
    home,
    env,
    stdout: (text) => void process.stdout.write(text),
    stderr,
    // Abort-on-signal handlers are installed only for the verbs that own a child process; an apigen command keeps default signal behaviour.
    ...(isVerb ? { signal: installAbortOnSignals() } : {}),
  });
  if (verb.handled) {
    process.exitCode = verb.exitCode ?? 0;
    return;
  }
  const { pkg, operations } = await buildPolicyPackage(lazyCtx({ ...deps, env }, cwd, home));
  await requireRun(cliPlugin)({
    packages: [pkg],
    operations,
    outputDir: '',
    options: {
      argv: prefixCommand(argv, resolveCommandPrefix(operations)),
      usePlugins: [tracingPlugin, ...(deps.extraUsePlugins ?? [])],
      exitCode: exitCodeForResult,
    },
    logger: createLogger({ level: resolveLogLevel(env[LOG_LEVEL_ENV_VAR]) }),
    signal: new AbortController().signal,
  });
}

/** Stdio MCP server over the same operations. Explicit start only (VR-06). */
export async function startPolicyMcp(deps: IPolicyMountDeps & { signal: AbortSignal }): Promise<void> {
  initPolicyTelemetry('live-service');
  const cwd = deps.cwd ?? process.cwd();
  const { pkg, operations } = await buildPolicyPackage(lazyCtx(deps, cwd, deps.home ?? homedir()));
  await requireRun(mcpPlugin)({
    packages: [pkg],
    operations,
    outputDir: '',
    options: { transport: 'stdio', usePlugins: [tracingPlugin, ...(deps.extraUsePlugins ?? [])] },
    signal: deps.signal,
  });
}

/** HTTP server on loopback only. A non-loopback `host` is refused with `invalid_argument`. */
export async function startPolicyHttp(
  deps: IPolicyMountDeps & { signal: AbortSignal; host: string; port?: number }
): Promise<void> {
  if (!LOOPBACK_HOSTS.has(deps.host)) {
    throw new ApiError('invalid_argument', `adhd-policy-http binds loopback only; refusing host "${deps.host}"`);
  }
  const port = deps.port ?? parseHttpPort((deps.env ?? process.env)[HTTP_PORT_ENV_VAR]);
  initPolicyTelemetry('live-service');
  const cwd = deps.cwd ?? process.cwd();
  const { pkg, operations } = await buildPolicyPackage(lazyCtx(deps, cwd, deps.home ?? homedir()));
  await requireRun(apiFastifyPlugin)({
    packages: [pkg],
    operations,
    outputDir: '',
    options: {
      host: deps.host,
      port,
      usePlugins: [tracingPlugin, ...(deps.extraUsePlugins ?? [])],
    },
    signal: deps.signal,
  });
}

