// Entrypoint: @adhd/backlog
//
// Public barrel. Re-exports every mounted operation (for a Node consumer, or a
// test, that wants to call them in-process), `startBacklogServer` (the HTTP/MCP
// host entry) and `runBacklogCli` (the CLI transport). All three transports
// mount live via apigen from ONE operation descriptor set -- there is no
// codegen step and no per-transport operation definition. See SPEC.md /
// DESIGN.md for the full contract.
//
// This file is ALSO the `adhd-backlog` bin (`package.json` `bin: {
// "adhd-backlog": "./dist/index.js" }` -- the bare `backlog` key collided with
// an unrelated public npm package) -- see the entry-guard at the bottom.
import { realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initTelemetry } from '@adhd/sox-telemetry';
import { runBacklogCli, stripSandboxFlag } from './cli.js';

// The mounted surface: nine issue verbs (SPEC 6.3), `lookup` (3a), and the
// four registry CRUD verbs (3a). `server.ts` extracts `dist/api.d.ts`, so THIS
// list and the mounted tool set are the same list by construction -- a verb
// cannot be exported here and missing from a transport, or vice versa.
export {
  get,
  query,
  lookup,
  create,
  update,
  transition,
  claim,
  relate,
  move,
  upsertProject,
  upsertComponent,
  upsertLocation,
  rmLocation,
  delete,
} from './api.js';
export type { BacklogCtx } from './api.js';

// The response envelope every verb returns, plus its closed error-code union
// and the exit codes a CLI host keys off.
export * from './envelope.js';

export {
  startBacklogServer,
  buildBacklogApigenPackage,
  resolveExpectedMcpToolNames,
} from './server.js';
export type { StartOpts } from './server.js';

export {
  runBacklogCli,
  resolveCommandPrefix,
  prefixCommand,
  stripSandboxFlag,
} from './cli.js';
export type { RunBacklogCliOpts } from './cli.js';

// `search`'s argv translation (see search-shortcut.ts). NOT a mount-surface
// widening: `server.ts` extracts `api.ts`, never this barrel, so exporting it
// here keeps it unit-testable without adding an extra apigen operation.
export {
  buildSearchArgv,
  SEARCH_FLAGS,
  SEARCH_HELP,
} from './search-shortcut.js';
export type { SearchShortcutOutcome } from './search-shortcut.js';

export { installSkill, runInstallSkillCommand } from './install-skill.js';
export type {
  InstallSkillResult,
  SkillHost,
  SkillScope,
} from './install-skill.js';

export { runServeCommand } from './serve.js';
export type { RunServeCommandOpts } from './serve.js';

export {
  buildBacklogEnv,
  resolveBacklogScope,
  resolveBacklogDbPath,
  suggestClaimantIdentity,
  backlogEnvironmentSpec,
} from './env.js';
export type { BacklogConfig, BuildBacklogEnvOptions } from './env.js';

export {
  openGraphBacklogStore,
  closeGraphBacklogStore,
} from './store/graph-backlog-store.js';
export type { GraphBacklogStore } from './store/graph-backlog-store.js';

export { readBacklogVersionInfo } from './version-info.js';

// ---------------------------------------------------------------------------
// `bin` entry-guard — replicates `entrypoint/apigen-cli/src/index.ts`'s
// proven bin mechanism (shebang via a rollup `output.banner`, `bin: {
// backlog: "./dist/index.js" }` in `package.json`), adapted for the one way
// this package differs from apigen-cli: apigen-cli's `index.ts` IS the whole
// CLI and unconditionally calls `program.parseAsync()` at import time,
// because that package is CLI-only. `@adhd/backlog`'s `index.ts` is ALSO the
// public library barrel — `src/test/fixtures/mcp-stdio-entry.js` (and any
// other Node consumer) does `require('@adhd/backlog')` / `require(distIndexPath)`
// and calls `startBacklogServer`/`runBacklogCli` programmatically — so
// running the CLI unconditionally on import would hijack every such
// consumer's stdout/exit code. This guard makes `dist/index.js` dual-purpose:
// do nothing when merely imported, run the CLI only when THIS file is
// itself the process's executed entry point.
//
// This is Node's own documented "no `require.main` in ESM" idiom
// (https://nodejs.org/api/esm.html#no-require-main) — NOT the simpler
// `import.meta.url === pathToFileURL(process.argv[1]).href` (no
// `realpathSync`), which breaks under exactly the invocation shape this
// package's `bin` guarantees: pnpm (and npm) ALWAYS install a package's
// `bin` as a SYMLINK (`node_modules/.bin/backlog` -> the real
// `.../@adhd/backlog/dist/index.js`). Node resolves symlinks (realpath) for
// the executing module's own `import.meta.url`/`__filename` by default, but
// leaves `process.argv[1]` as the RAW, unresolved invocation path — so
// comparing the (already-resolved) `import.meta.url` against an
// UN-resolved `argv[1]` silently never matches when invoked through the
// symlinked bin. Resolving `argv[1]` with `realpathSync` first closes that
// gap. (`import.meta.url` itself is already realpath'd — confirmed via this
// same file's `server.ts`, which already relies on `import.meta.url`
// resolving correctly from both `dist/index.js`, the rollup CJS output where
// it's shimmed as `pathToFileURL(__filename).href`, and `dist/index.mjs`.)
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  // Telemetry composition root — the ONLY initTelemetry() call in this process.
  // Every telemetry record emitted by the store substrate (@adhd/sox-store-
  // adapter + @adhd/sox-graph-store dist emitters: retry, engine-guard, turso
  // reconnect, graph-store heal) is stamped with the service/role configured
  // here. Without it, the runtime falls back to role:'harness', logSink:'none'
  // and silently drops every record (one-shot BL-404-style stderr warning).
  //
  // Runs only in this bin-entry branch, so library importers of this barrel
  // (tests, `src/test/fixtures/mcp-stdio-entry.js`, in-process consumers) never
  // trigger it. It also covers `serve`: that subcommand is dispatched from
  // inside `runBacklogCli()` (`cli.ts`), same process, same bin — there is no
  // separate serve entry to initialise.
  //
  // The runtime is NOT memoised: a second initTelemetry() would close this
  // sink and open a fresh one, silently rotating the JSONL file. This is the
  // single call site, so it fires exactly once per process by construction.
  //
  // The default file-sink dir is ~/.adhd/sox-ecosystem/backlog/logs
  // (ecosystemHome()/service/logs, BL-353 §5.1 role-qualified component).
  // Failure is non-fatal by design — telemetry must never take the CLI down.
  //
  // BUG-BACKLOG-SANDBOX-TELEMETRY-001: this call fires BEFORE `runBacklogCli`
  // ever parses argv, so it used to write its file sink to the real
  // `~/.adhd/sox-ecosystem/backlog/logs` unconditionally — even under
  // `--sandbox`, defeating that flag's whole "never touches the real
  // production tree" guarantee (caught by `cli.spec.ts`'s "--sandbox
  // diverts the store away from the (fake) production HOME entirely, and
  // never creates anything under it": a real `create` invocation left
  // `<fakeProdHome>/.adhd/sox-ecosystem/backlog/logs/*.jsonl` behind even
  // though the STORE itself was correctly isolated). `--sandbox` is
  // recognized here the same way `cli.ts`'s own `stripSandboxFlag` does —
  // this file peeks at it ONLY to redirect telemetry's `logDir`; the actual
  // flag-stripping/dispatch still happens exactly once, inside
  // `runBacklogCli` below.
  const { sandbox } = stripSandboxFlag(process.argv.slice(2));
  const sandboxLogDir = sandbox
    ? mkdtempSync(join(tmpdir(), 'backlog-sandbox-logs-'))
    : undefined;
  try {
    initTelemetry({
      service: 'backlog',
      role: 'cli',
      logSink: 'file',
      ...(sandboxLogDir !== undefined ? { logDir: sandboxLogDir } : {}),
    });
  } catch (err) {
    console.error(
      `[sox-telemetry] WARNING: initTelemetry failed (${
        err instanceof Error ? err.message : String(err)
      }); telemetry records will be silently dropped this process`
    );
  }
  runBacklogCli().catch((err) => {
    console.error(
      err instanceof Error ? err.stack ?? err.message : String(err)
    );
    process.exitCode = 1;
  });
}
