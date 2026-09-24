/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `orchestrator.e2e.ts`.
 *
 * Resource lane: cpu — it runs real ts-morph extraction over fixtures (~40s of pure CPU).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `orchestrator.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: orchestrator', () => {
  it.todo("mocked: detectLang returns \"ts\" for .ts extension");
  it.todo("mocked: detectLang returns \"ts\" for .tsx / .mts / .cts extensions");
  it.todo("mocked: detectLang throws for unsupported extensions");
  it.todo("mocked: mergeOperations flattens two per-source arrays into a single list");
  it.todo("mocked: buildDescriptor extracts operations from two sources and merges into one descriptor");
  it.todo("mocked: orchestrateGenerate calls plugin.generate with packages from both sources");
  it.todo("mocked: checkCollisions does NOT throw when all operations have distinct projections");
  it.todo("mocked: checkCollisions throws CollisionDetectedError when two ops share an MCP target");
  it.todo("mocked: the thrown CollisionDetectedError carries collision details");
  it.todo("mocked: parseOverrides extracts http.verb.<id>=GET from --opt pairs");
  it.todo("mocked: parseOverrides returns empty config for irrelevant --opt pairs");
  it.todo("mocked: projection config overrides verb from POST to GET for a specific op id without altering safe");
  it.todo("mocked: loadOverrideConfig reads a config file and merges with CLI overrides (CLI wins)");
  it.todo("mocked: loadOverrideConfig returns CLI overrides unchanged when no config file exists");
  it.todo("mocked: buildDescriptor passes the override config through to collision check without error");
  it.todo("mocked: buildDescriptor packageSchemas carry format:decimal for a default-imported Decimal source");
  it.todo("mocked: orchestrateGenerate: collectDepsFromPackageSchemas returns decimal.js for a default-import Decimal source");
  it.todo("mocked: [verb-hoist.1] zero-param and all-primitive-param functions auto-hoist: x-apigen-safe:true, no override needed");
  it.todo("mocked: [verb-hoist.2] object- and array-typed params do NOT auto-hoist: x-apigen-safe:false");
  it.todo("mocked: [verb-hoist.3] the shared httpVerb() resolves GET for auto-hoisted fns and POST for complex-param fns, with no override");
  it.todo("mocked: [verb-hoist.4] a manual --opt http.verb.<id>=POST override still wins over the auto-hoisted x-apigen-safe:true");
  it.todo("mocked: [verb-hoist.5] end-to-end: orchestrateGenerate against a real HTTP-shaped fake plugin sees x-apigen-safe:true in the packageSchemas it receives for the auto-hoisted fn");
  it.todo("mocked: opMatchesExportMode: \"named\" matches a plain [file, name] path, not a default-object path");
  it.todo("mocked: opMatchesExportMode: \"default\" matches only path=[file,\"default\",key], not a plain named path");
  it.todo("mocked: opMatchesExportMode: \"named-object\" matches only the requested object name");
  it.todo("mocked: buildDescriptor: --export default scopes packageSchemas to ONLY the default object, excluding the named helper");
  it.todo("mocked: buildDescriptor: omitted --export (named mode) scopes packageSchemas to ONLY the named helper, excluding the default object");
  it.todo("mocked: buildDescriptor: an absent exportMode applies no scoping (registry callers unaffected)");
  it.todo("mocked: buildDescriptor throws a clear error when two sources resolve to the same namespace, instead of silently dropping one");
  it.todo("mocked: buildDescriptor succeeds and merges both sources when namespaces are distinct (negative control)");
  it.todo("mocked: MISS (no usePluginObjects passed): buildDescriptor behaves byte-identically to the plugin-free call (A.3)");
  it.todo("mocked: a plugin declaring extractLayer is actually invoked around the REAL extraction, driven end-to-end through buildDescriptor");
  it.todo("mocked: a short-circuiting extractLayer plugin (never calls next) prevents the real extractor from running for that source");
  it.todo("mocked: TODO: add a live model end-to-end test here");
});
