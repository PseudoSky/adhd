// Entrypoint: @adhd/backlog
//
// Public barrel — re-exports every `client.ts` operation (for a Node
// consumer, or a test, that wants to call them in-process),
// `startBacklogServer` (HTTP/MCP host entry), and `runBacklogCli` (the third,
// CLI transport). All three mount live via apigen — no codegen. See SPEC.md /
// DESIGN.md for the full contract.
//
// This file is ALSO the `backlog` bin (`package.json` `bin: { backlog:
// "./dist/index.js" }`) — see the entry-guard at the bottom.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initTelemetry } from '@adhd/sox-telemetry';
import { runBacklogCli } from './cli.js';

export {
  addCitation,
  addDependency,
  appendNote,
  archiveResolved,
  assignItem,
  attachToPlan,
  auditTrail,
  blockers,
  claimItem,
  createItem,
  dependencyGraph,
  exportJson,
  getItem,
  importFromMarkdown,
  linkRelated,
  listItems,
  mergeItems,
  migrationStatus,
  readyItems,
  releaseClaim,
  removeDependency,
  renderToMarkdown,
  renewClaim,
  resolveItem,
  setMigrationPhase,
  setPriority,
  softDeleteItem,
  spotlight,
  splitItem,
  staleClaims,
  startWork,
  stats,
  supersedeItem,
  topoOrder,
  transitionStatus,
  updateItem,
  version,
} from './client.js';
export type { BacklogCtx, BacklogVersionInfo } from './client.js';

export { startBacklogServer, buildBacklogApigenPackage } from './server.js';
export type { StartOpts } from './server.js';

export { runBacklogCli, resolveCommandPrefix, prefixCommand } from './cli.js';
export type { RunBacklogCliOpts } from './cli.js';

export { installSkill, runInstallSkillCommand } from './install-skill.js';
export type { InstallSkillResult, SkillHost, SkillScope } from './install-skill.js';

export { runServeCommand } from './serve.js';
export type { RunServeCommandOpts } from './serve.js';

export { buildBacklogEnv, resolveBacklogScope, suggestClaimantIdentity, backlogEnvironmentSpec } from './env.js';
export type { BacklogConfig, BuildBacklogEnvOptions } from './env.js';

export { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
export type { GraphBacklogStore } from './store/graph-backlog-store.js';

export {
  buildChangelogSection,
  classifyStatus,
  detectPriority,
  detectStatus,
  normalizeLegacyStatus,
  parseBacklogMarkdown,
  parseBacklogMarkdownWithDiagnostics,
  renderItemsToMarkdown,
  toImportItems,
} from './markdown.js';
export type { ParsedImportItem, ParsedMarkdownItem, ParseWithDiagnosticsResult } from './markdown.js';

export * from './model.js';

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
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
  try {
    initTelemetry({ service: 'backlog', role: 'cli', logSink: 'file' });
  } catch (err) {
    console.error(
      `[sox-telemetry] WARNING: initTelemetry failed (${
        err instanceof Error ? err.message : String(err)
      }); telemetry records will be silently dropped this process`,
    );
  }
  runBacklogCli().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
