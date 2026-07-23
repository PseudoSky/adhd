// Entrypoint: @adhd/backlog
//
// Public barrel — re-exports every `client.ts` operation (for a Node
// consumer, or a test, that wants to call them in-process) and
// `startBacklogServer` (the CLI/host entry — mounts live via apigen, no
// codegen). See SPEC.md / DESIGN.md for the full contract.

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
  renderItemsToMarkdown,
  toImportItems,
} from './markdown.js';
export type { ParsedImportItem, ParsedMarkdownItem } from './markdown.js';

export * from './model.js';
