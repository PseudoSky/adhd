#!/usr/bin/env node
/**
 * bin/cli.ts — hand-written FALLBACK CLI, authorized by the cli milestone's
 * own fallback clause: "if the cli-output plugin cannot express a required
 * command shape, record the exact gap ... and hand-write a thin commander
 * wrapper over the SAME api.ts — the api.ts surface is the contract either
 * way."
 *
 * WHY THIS EXISTS (BACKLOG-destined — see the cli milestone completion
 * report; not filed here per scope): `npx nx run dispatch-cli:generate-cli`
 * (the apigen `cli-output` plugin, `@adhd/apigen-nx:generate`) DOES work —
 * BUG-APIGEN-CLI-001 (hyphenated-dir namespace identifiers) is fixed, and
 * the generated CLI correctly lists all 7 commands and `eligible`/`status`
 * (whose types never reach `@modelcontextprotocol/sdk`) run correctly. But
 * `validate`/`snapshot`/`optimize`/`run`/`calibrate` — whose signatures
 * transitively reach `@adhd/dispatch-orchestrator`'s `AgentMcpRunner`
 * (import chain: core.ts -> dispatch-orchestrator -> `@modelcontextprotocol/
 * sdk`, which uses zod internally) — crash at runtime:
 *   `Error: [apigen-logical] $ref "#/definitions/boolean" cannot be resolved
 *   in run-mode without a descriptor root.`
 * (also seen for "#/definitions/number"). This is a genuine apigen-core /
 * apigen-logical bug (zod-derived type declarations reachable via the
 * source file's transitive module graph corrupt ts-json-schema-generator's
 * shared "definitions" registry for UNRELATED primitive types, and
 * apigen-logical's runmode `encodeNode` doesn't resolve the resulting
 * cross-file `$ref`s) — NOT the cli-output plugin (packages/apigen/plugins/
 * cli, the only apigen package this milestone is authorized to fix), and
 * well outside this milestone's scope to root-cause/fix.
 *
 * This file sidesteps the broken schema/dispatch() layer entirely by
 * calling `../src/api.ts` DIRECTLY — no ajv, no logical-type transcoding
 * (none of this package's types use a `format`-tagged logical type, so
 * nothing is lost). The generated CLI (`generate-cli` target) stays wired
 * per the milestone spec and remains useful signal (it proves the
 * identifier fix + 2/7 commands end-to-end); THIS file is the one actually
 * spawned by the smoke test and meant for real use today.
 *
 * A genuine upside of hand-writing this file: unlike apigen's cli-output
 * plugin (presence-only boolean flags, no negation), Commander's native
 * `--no-<flag>` support lets `run` express BOTH `dryRun: true` (default)
 * AND `dryRun: false` (the real, paid `AgentMcpRunner` path) — a capability
 * the generated CLI could not have offered even once the apigen-core bug
 * above is fixed.
 */
import { Command } from 'commander';
import { validate, snapshot, optimize, eligible, status, run, calibrate } from '../src/api.js';

const program = new Command().name('dispatch-cli').version('0.0.1');

function printAndExit(result: unknown): void {
  console.log(JSON.stringify(result));
}

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

program
  .command('validate')
  .description("validate a plan dag.json against @adhd/dispatch-spec's structural validator")
  .requiredOption('--dag-path <path>', "path to the plan's dag.json")
  .action(async (opts: { dagPath: string }) => {
    try {
      printAndExit(await validate(opts.dagPath));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('snapshot')
  .description('compute a fresh DagSnapshot (cold-start B/context-window defaults)')
  .requiredOption('--dag-path <path>', "path to the plan's dag.json")
  .action(async (opts: { dagPath: string }) => {
    try {
      printAndExit(await snapshot(opts.dagPath));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('optimize')
  .description('compute the next batch of DispatchUnits the greedy optimizer would pack')
  .requiredOption('--dag-path <path>', "path to the plan's dag.json")
  .action(async (opts: { dagPath: string }) => {
    try {
      printAndExit(await optimize(opts.dagPath));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('eligible')
  .description('list milestone slugs eligible for dispatch right now')
  .requiredOption('--dag-path <path>', "path to the plan's dag.json")
  .action(async (opts: { dagPath: string }) => {
    try {
      printAndExit(await eligible(opts.dagPath));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('status')
  .description('per-milestone { status, loggedOperationIds, tokensEstimated, tokensActual }')
  .requiredOption('--dag-path <path>', "path to the plan's dag.json")
  .action(async (opts: { dagPath: string }) => {
    try {
      printAndExit(await status(opts.dagPath));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('run')
  .description('run exactly one @adhd/dispatch-orchestrator scheduling cycle')
  .requiredOption('--dag-path <path>', "path to the plan's dag.json")
  .option('--no-dry-run', 'PAID BOUNDARY: fire real, billed model calls via a real AgentMcpRunner (npx -y @adhd/agent-mcp) instead of MockAgentRunner')
  .action(async (opts: { dagPath: string; dryRun: boolean }) => {
    try {
      printAndExit(await run(opts.dagPath, opts.dryRun));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('calibrate')
  .description('PAID BOUNDARY: fire a null-task dispatch to measure baseline per-tier token cost ("B")')
  .requiredOption('--model-tier <tier>', 'one of Haiku | Sonnet | Opus')
  .action(async (opts: { modelTier: string }) => {
    try {
      printAndExit(await calibrate(opts.modelTier));
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
