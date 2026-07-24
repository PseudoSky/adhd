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
} from './client.js';
export type { BacklogCtx } from './client.js';

export { startBacklogServer, buildBacklogApigenPackage } from './server.js';
export type { StartOpts } from './server.js';

export { runBacklogCli, resolveCommandPrefix, prefixCommand } from './cli.js';
export type { RunBacklogCliOpts } from './cli.js';

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
  runBacklogCli().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
