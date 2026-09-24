/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `cli.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `cli.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: cli", () => {
  it.todo("mocked: resolveCommandPrefix derives the REAL single-segment internal prefix from live operations");
  it.todo("mocked: every api.ts operation shares the identical prefix (one source file, flat path ⇒ one uniform prefix)");
  it.todo("mocked: prefixCommand prepends the real prefix to a BARE user command (what a human actually types)");
  it.todo("mocked: prefixCommand is idempotent — an already-fully-prefixed argv is NEVER double-prefixed");
  it.todo("mocked: prefixCommand leaves a leading --help/-h flag untouched (never shadows run()'s own top-level --help short-circuit)");
  it.todo("mocked: prefixCommand leaves empty argv untouched");
  it.todo("mocked: resolveMountNamespaces derives \"batch\" from the REAL usePlugins array (batchPlugin), not a hardcoded string");
  it.todo("mocked: resolveMountNamespaces returns an EMPTY set for an empty usePlugins array — proves the derivation is dynamic, not hardcoded");
  it.todo("mocked: prefixCommand leaves a reserved mount-namespace command (e.g. \"batch action …\") untouched — never backlog-prefixed (BUG-018)");
  it.todo("mocked: prefixCommand still prefixes an ordinary bare api.ts command whose name happens to differ from any reserved namespace");
  it.todo("mocked: no args exits 0 and prints the live, namespace-prefixed command listing");
  it.todo("mocked: --help exits 0 with the identical usage listing");
  it.todo("mocked: BUG-BACKLOG-BATCH-DISCOVERABILITY-001: a per-verb --help surfaces `batch action` as a \"see also\"");
  it.todo("mocked: the batch-action hint does not appear on the bare top-level --help or on `batch action --help` itself");
  it.todo("mocked: BUG-BACKLOG-001: --help and no-args surface the special-cased commands (install-skill/install/serve) that never enter the apigen command table");
  it.todo("mocked: --help and no-args NEVER create the backing store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)");
  it.todo("mocked: version, --help, no-args, and install-skill --help never create the DB (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)");
  it.todo("mocked: BUG-002: ADHD_BACKLOG_DATABASE_PATH redirects the store the bin opens — the env var wins over the scope-root fallback");
  it.todo("mocked: BUG-002 regression guard: with ADHD_BACKLOG_DATABASE_PATH unset, the bin still opens the scope-root fallback as before");
  it.todo("mocked: a PLAIN \"get --input …\" (bare, no manual namespace prefix) resolves — proves runBacklogCli prepends the namespace itself");
  it.todo("mocked: a fully-prefixed \"backlog get …\" ALSO resolves — proves prefixCommand is idempotent at the real dispatch, not just in the unit test");
  it.todo("mocked: a full CLI round trip — \"create --input <json>\" then \"get\" — persists across TWO separate process invocations");
  it.todo("mocked: \"query\" (view:list) returns the seeded item, filtered by project");
  it.todo("mocked: an unknown command exits with CLI_EXIT_CODE.not_found (4), never 0");
  it.todo("mocked: an unknown flag exits with CLI_EXIT_CODE.invalid_argument (2), never 0");
  it.todo("mocked: \"batch action --input {operation,items,…}\" fans out via the real CLI to real api.ts create, and both items persist independently (BUG-018 / batch-CLI wiring)");
  it.todo("mocked: an \"operation\" not in this mount\\'s batchable set is rejected by the batch handler\\'s own validation (proves the CLI mount is bound to the real backlog descriptor, not a stub)");
  it.todo("mocked: \"version\" reports the REAL, currently-built package.json name/version — dev-dist layout (spawned dist/index.js bin)");
  it.todo("mocked: install-skill --host claude --scope project drops the packaged, currently-built SKILL.md under the given cwd — content-hash matches");
  it.todo("mocked: a command that OPENS the store then fails still closes it in the finally (WAL truncated, store reopens cleanly)");
  it.todo("mocked: sandbox-path with no --namespace reports the real, un-isolated \"production\" path — store-free, exits 0");
  it.todo("mocked: --namespace sandbox diverts the store away from the (fake) production HOME entirely, and never creates anything under it");
  it.todo("mocked: --namespace sandbox resolves through the explicit \"sandbox\" namespace in a REAL spawned child, even with an unrelated stray env var leaked into the parent");
  it.todo("mocked: BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001: an already-set ADHD_ROOT (not one of this tool\\'s own sandbox dirs) no longer silently defeats --namespace sandbox");
  it.todo("mocked: BUG-BACKLOG-SANDBOX-TELEMETRY-001: a real create under --namespace sandbox leaves no telemetry file under the (fake) production HOME");
  it.todo("mocked: D8: a stray pre-existing config.yaml with embedding.enabled:true at the sandbox root is overwritten, not left alone");
  it.todo("mocked: D3: an unrecognized --namespace value exits 2 with invalid_argument naming all three valid values");
  it.todo("mocked: D3: a near-miss typo suggests the closest valid --namespace value (\"did you mean\")");
  it.todo("mocked: D1: a bare trailing --namespace with no value exits 2 with invalid_argument naming \"namespace\"");
  it.todo("mocked: D1: --namespace= (empty value) exits 2 with invalid_argument naming \"namespace\"");
  it.todo("mocked: D1: --namespace=sandbox produces the identical namespace/dbPath as --namespace sandbox");
  it.todo("mocked: D1: --namespace test --namespace sandbox (conflicting values) exits 2 naming both distinct values");
  it.todo("mocked: D1: --namespace sandbox --namespace sandbox (same value twice) is NOT rejected as conflicting");
  it.todo("mocked: D2: an explicit --namespace production round-trips a real create/get, identically to the omitted-flag default");
  it.todo("mocked: --namespace sandbox serve isolates a real create/get round trip away from the (fake) production HOME, over real HTTP");
  it.todo("mocked: finds a real seeded item by natural-language text and returns the standard envelope");
  it.todo("mocked: PARITY: `search \"<text>\" --limit N --status open` is byte-identical to the equivalent `query --input`");
  it.todo("mocked: PARITY: `--anchor` reaches view:\"similar\" — identical envelope AND the identical refusal on a store with no embedding backend");
  it.todo("mocked: a rejected invocation exits 2 with the invalid_argument envelope on STDERR, and never opens the store");
  it.todo("mocked: `search --help` exits 0, prints usage, and never opens the store");
  it.todo("mocked: the top-level --help advertises `search` alongside the other special commands");
  it.todo("mocked: §6.6 guard: adding `search` did NOT widen the mounted command surface");
});
