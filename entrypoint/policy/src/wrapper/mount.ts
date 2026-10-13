import { ApiError } from '@adhd/apigen-base-errors';
import type { OutputPlugin, RunInput } from '@adhd/apigen-core-client';
import type { UsePlugin } from '@adhd/apigen-engine-runtime';
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
import { writeBakedIr } from './ir';
import { buildPolicyPackage } from './package';
import { prefixCommand, resolveCommandPrefix } from './prefix';
import { installAbortOnSignals } from './signals';
import { initPolicyTelemetry } from './telemetry';
import { tracingPlugin } from './tracing';
import { dispatchVerb } from './verbs/index';

/** Everything the mount needs from the outside; entry files pass none of it. */
export interface IPolicyMountDeps {
  /** Default `process.cwd()`, read ONCE here and passed down as data. */
  readonly cwd?: string;
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
function lazyCtx(deps: IPolicyMountDeps, cwd: string): () => IPolicyCtx {
  let env: ReturnType<typeof buildPolicyEnv> | undefined;
  let announced: string | undefined;
  return () => {
    env ??= buildPolicyEnv({ projectRoot: cwd });
    return createPolicyCtx(env, {
      cwd,
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

/** Failure reports (`verify`, `compile`) carry `ok:false` plus an `errors` list: exit 2 (D-05). Everything else keeps apigen's own code. */
function exitCodeForResult(result: unknown): number | undefined {
  if (result !== null && typeof result === 'object') {
    const report = result as { ok?: unknown; errors?: unknown };
    if (report.ok === false && Array.isArray(report.errors)) return 2;
  }
  return undefined;
}

/**
 * 1. `dispatchVerb(argv)`: when `argv[0]` is `run`, `serve` or `mcp-json` the
 *    verb runs and sets `process.exitCode`. 2. Otherwise apigen's CLI owns
 *    flags, validation, help and exit codes (`CLI_EXIT_CODE`). The hidden
 *    `ir-artifact --out <file>` subcommand is the build-time bake.
 */
export async function runPolicyCli(argv: readonly string[], deps: IPolicyMountDeps = {}): Promise<void> {
  if (argv[0] === 'ir-artifact') {
    const out = argv[argv.indexOf('--out') + 1];
    if (argv.indexOf('--out') < 0 || out === undefined) {
      throw new ApiError('invalid_argument', 'ir-artifact requires --out <file>');
    }
    await writeBakedIr(out);
    return;
  }
  initPolicyTelemetry('cli');
  const cwd = deps.cwd ?? process.cwd();
  const verb = await dispatchVerb(argv, {
    cwd,
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    signal: installAbortOnSignals(),
  });
  if (verb.handled) {
    process.exitCode = verb.exitCode ?? 0;
    return;
  }
  const { pkg, operations } = await buildPolicyPackage(lazyCtx(deps, cwd));
  await requireRun(cliPlugin)({
    packages: [pkg],
    operations,
    outputDir: '',
    options: {
      argv: prefixCommand(argv, resolveCommandPrefix(operations)),
      usePlugins: [tracingPlugin, ...(deps.extraUsePlugins ?? [])],
      exitCode: exitCodeForResult,
    },
    signal: new AbortController().signal,
  });
}

/** Stdio MCP server over the same operations. Explicit start only (VR-06). */
export async function startPolicyMcp(deps: IPolicyMountDeps & { signal: AbortSignal }): Promise<void> {
  initPolicyTelemetry('live-service');
  const cwd = deps.cwd ?? process.cwd();
  const { pkg, operations } = await buildPolicyPackage(lazyCtx(deps, cwd));
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
  deps: IPolicyMountDeps & { signal: AbortSignal; host: string; port: number }
): Promise<void> {
  if (!LOOPBACK_HOSTS.has(deps.host)) {
    throw new ApiError('invalid_argument', `adhd-policy-http binds loopback only; refusing host "${deps.host}"`);
  }
  initPolicyTelemetry('live-service');
  const cwd = deps.cwd ?? process.cwd();
  const { pkg, operations } = await buildPolicyPackage(lazyCtx(deps, cwd));
  await requireRun(apiFastifyPlugin)({
    packages: [pkg],
    operations,
    outputDir: '',
    options: {
      host: deps.host,
      port: deps.port,
      usePlugins: [tracingPlugin, ...(deps.extraUsePlugins ?? [])],
    },
    signal: deps.signal,
  });
}

