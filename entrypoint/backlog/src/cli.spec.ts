/**
 * cli.spec.ts — SPEC.md §7 DoD clause 3 (CLI variant). Per AGENTS.md
 * "Proving an MCP server works — drive the real tools, never a bypass" (the
 * identical principle applies to a CLI bin: drive the real, BUILT consumer
 * path, never an in-process bypass): every behavioral assertion below SPAWNS
 * the REAL BUILT `dist/index.js` as a genuine child process
 * (`process.execPath dist/index.js <args>`) — exactly how an installed
 * `backlog` bin is invoked — against a fresh, temp-scoped `.adhd` root
 * (`ADHD_BACKLOG_SCOPE=project` + a throwaway `cwd`), never the real
 * machine's global backlog graph. Mirrors `server.mcp.spec.ts`'s real-
 * subprocess pattern; this project's `test` target already
 * `dependsOn: ["build"]` so `dist/index.js` is always fresh.
 *
 * The one exception: `resolveCommandPrefix`/`prefixCommand` (the pure
 * namespace-prefixing helpers `runBacklogCli` uses to route a bare user
 * command like `get-item` onto the cli-output plugin's REAL, namespace-
 * qualified command table) get a direct unit-level check too — not because
 * unit-testing beats spawning, but because the whole point of these two
 * helpers is to encode an empirically-verified, otherwise-invisible fact
 * (the exact shape of the real command table — see the note below) as a
 * literal, load-bearing assertion that fails loudly the moment that fact
 * ever changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createItem, getItem } from './ops-v1.js'; // v1 ops: still real functions, used here ONLY for direct-store seeding — never mounted as CLI commands (AC-5).
import type { BacklogCtx } from './client.js';
import { buildBacklogEnv } from './env.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogApigenPackage } from './server.js';
import { resolveCommandPrefix, prefixCommand, resolveMountNamespaces, USE_PLUGINS } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built `backlog` bin as a genuine child process. Never imported. */
function runBin(args: string[], cwd: string, extraEnv: Record<string, string> = {}): SpawnResult {
  const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd,
    // `ADHD_BACKLOG_SCOPE=project` + a fresh, empty `cwd` with no ancestor
    // `.adhd` marker (a throwaway `mkdtempSync` dir) makes `@adhd/environment`
    // bootstrap the graph store fresh AT `cwd` — never the real machine's
    // global `~/.adhd/backlog` store. Confirmed empirically: a manual smoke
    // run of this exact shape (`cd <tmp> && ADHD_BACKLOG_SCOPE=project node
    // dist/index.js …`) left the real repo's `.adhd/` and the real global
    // `~/.adhd/backlog/` both untouched. `extraEnv` layers BUG-002's
    // `ADHD_BACKLOG_DATABASE_PATH` redirection probe on top.
    env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project', ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`spawn failed for ${DIST_INDEX} ${JSON.stringify(args)}: ${String(result.error)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Reads every telemetry event the spawned bins have written under a temp
 * `SOX_ECOSYSTEM_HOME` redirect (so the suite never touches the real machine
 * telemetry log), returning just the `event` name per record. The store
 * substrate emits `store_adapter.*` records ONLY when the real SQLite store is
 * actually opened+closed — so `store_adapter` events are the exact,
 * unambiguous marker DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 hinges on.
 */
function readTelemetryEvents(soxHome: string): string[] {
  const logsDir = join(soxHome, 'backlog', 'logs');
  if (!existsSync(logsDir)) return [];
  const events: string[] = [];
  for (const name of readdirSync(logsDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = readFileSync(join(logsDir, name), 'utf8').trim();
    if (!text) continue;
    for (const line of text.split('\n')) {
      const rec = JSON.parse(line) as { event?: string };
      if (typeof rec.event === 'string') events.push(rec.event);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Unit-level: resolveCommandPrefix / prefixCommand — the namespace-prefix
// question this package's task spec called out explicitly ("Confirm the
// exact behavior … and prove it with a test — do not assume").
//
// FINDING (not an assumption): the real internal command-table prefix is the
// single segment `['backlog']`. `server.ts`'s `extractClientOperations()`
// calls `extract({ …, dropFileSegment: true })`, so every operation's `path`
// is just `[exportSegment]` — no `client.d.ts`-derived file segment (that
// used to leak as `'client-d'` into every transport's name before
// BUG-BACKLOG-CANONICAL-NAMING-CLIENT-D-SEGMENT-001 was fixed by adding
// `ExtractOptions.dropFileSegment` to `@adhd/apigen-core-client`). Safe here
// specifically because every `client.ts` export is extracted from this ONE
// file — a genuine same-name collision across files would still be caught
// at extract time by `checkCollisions` (`@adhd/apigen-engine-naming`).
describe('resolveCommandPrefix / prefixCommand — namespace-prefix derivation (empirically verified, not assumed)', () => {
  it('resolveCommandPrefix derives the REAL single-segment internal prefix from live operations', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const prefix = resolveCommandPrefix(operations);
    expect(prefix).toEqual(['backlog']);
  });

  it('every client.ts operation shares the identical prefix (one source file, flat path ⇒ one uniform prefix)', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const actions = operations.filter((op) => op.kind === 'action');
    // AC-5 / AC-0's six-verb assertion: client.ts's mounted surface is EXACTLY
    // `get, query, create, update, relate, admin` — not ">10" (that pinned the
    // pre-consolidation v1 surface of ~20 flat verbs). A widened action count
    // here is real evidence of scope creep back onto client.ts's exported
    // surface (see client.ts's own doc comment on why a 7th export is a bug).
    expect(actions.length).toBe(6);
    const prefix = resolveCommandPrefix(actions);
    for (const op of actions) {
      expect(resolveCommandPrefix([op])).toEqual(prefix);
    }
  });

  it('prefixCommand prepends the real prefix to a BARE user command (what a human actually types)', () => {
    expect(prefixCommand(['get-item', '--repo', 'x', '--human-id', 'y'], ['backlog'], new Set())).toEqual([
      'backlog',
      'get-item',
      '--repo',
      'x',
      '--human-id',
      'y',
    ]);
  });

  it('prefixCommand is idempotent — an already-fully-prefixed argv is NEVER double-prefixed', () => {
    expect(prefixCommand(['backlog', 'get-item'], ['backlog'], new Set())).toEqual([
      'backlog',
      'get-item',
    ]);
  });

  it('prefixCommand leaves a leading --help/-h flag untouched (never shadows run()\'s own top-level --help short-circuit)', () => {
    expect(prefixCommand(['--help'], ['backlog'], new Set())).toEqual(['--help']);
    expect(prefixCommand(['-h'], ['backlog'], new Set())).toEqual(['-h']);
  });

  it('prefixCommand leaves empty argv untouched', () => {
    expect(prefixCommand([], ['backlog'], new Set())).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // resolveMountNamespaces — dynamic derivation from `usePlugins`, not a
  // hand-maintained list (fixing the "silently goes stale" architecture flaw
  // in the ORIGINAL `MOUNT_COMMAND_NAMESPACES` constant, BUG-BACKLOG-CLI-
  // BATCH-PREFIX-CLOBBER-001 follow-up).
  // ---------------------------------------------------------------------------

  it('resolveMountNamespaces derives "batch" from the REAL usePlugins array (batchPlugin), not a hardcoded string', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const reserved = resolveMountNamespaces(USE_PLUGINS, operations, 'backlog');
    expect(reserved.has('batch')).toBe(true);
  });

  // The "would go red if reverted" proof AGENTS.md §7 requires: this asserts
  // the reserved set is genuinely DERIVED from `usePlugins`, not a disguised
  // hardcoded string match — an EMPTY `usePlugins` array must yield an EMPTY
  // set (no mount plugin ⇒ nothing reserved), proving the previous test's
  // green result is contingent on `batchPlugin` actually being in the array.
  it('resolveMountNamespaces returns an EMPTY set for an empty usePlugins array — proves the derivation is dynamic, not hardcoded', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const reserved = resolveMountNamespaces([], operations, 'backlog');
    expect(reserved.size).toBe(0);
    expect(reserved.has('batch')).toBe(false);
  });

  // BUG-018: a top-level mount-plugin command (e.g. `@adhd/apigen-plugin-batch`'s
  // `_batch/action` → real CLI path `['batch', 'action']`) must NEVER be
  // backlog-prefixed — it is registered at the command table's top level,
  // sibling to `backlog`'s own namespace, not nested under it.
  it('prefixCommand leaves a reserved mount-namespace command (e.g. "batch action …") untouched — never backlog-prefixed (BUG-018)', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const reserved = resolveMountNamespaces(USE_PLUGINS, operations, 'backlog');
    expect(reserved.has('batch')).toBe(true);
    expect(
      prefixCommand(['batch', 'action', '--operation', 'backlog/create-item', '--items', '[]'], ['backlog'], reserved)
    ).toEqual(['batch', 'action', '--operation', 'backlog/create-item', '--items', '[]']);
  });

  it('prefixCommand still prefixes an ordinary bare client.ts command whose name happens to differ from any reserved namespace', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const reserved = resolveMountNamespaces(USE_PLUGINS, operations, 'backlog');
    expect(prefixCommand(['get-item', '--repo', 'x', '--human-id', 'y'], ['backlog'], reserved)).toEqual([
      'backlog',
      'get-item',
      '--repo',
      'x',
      '--human-id',
      'y',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration: real spawned `dist/index.js` bin, real temp-scoped SQLite
// store, no mocks anywhere.
// ---------------------------------------------------------------------------

describe('runBacklogCli — live CLI mount, real spawned dist/index.js bin, temp-scoped store', () => {
  let adhdRoot: string | undefined;

  afterEach(() => {
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    adhdRoot = undefined;
  });

  it('no args exits 0 and prints the live, namespace-prefixed command listing', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-noargs-'));
    const res = runBin([], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    // AC-5: the flat v1 verbs (`get-item`/`create-item`/`list-items`) are
    // retired from the mount; the live command table is the six v2 verbs.
    expect(res.stdout).toContain('backlog get');
    expect(res.stdout).toContain('backlog create');
    expect(res.stdout).toContain('backlog query');
  });

  it('--help exits 0 with the identical usage listing', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-'));
    const res = runBin(['--help'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('backlog get');
  });

  it('BUG-BACKLOG-001: --help and no-args surface the special-cased commands (install-skill/install/serve) that never enter the apigen command table', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-special-'));
    const help = runBin(['--help'], adhdRoot);
    expect(help.status, `stderr:\n${help.stderr}\nstdout:\n${help.stdout}`).toBe(0);
    expect(help.stdout).toContain('Special commands');
    expect(help.stdout).toContain('install-skill');
    expect(help.stdout).toContain('serve');

    const noArgs = runBin([], adhdRoot);
    expect(noArgs.status, `stderr:\n${noArgs.stderr}\nstdout:\n${noArgs.stdout}`).toBe(0);
    expect(noArgs.stdout).toContain('Special commands');
    expect(noArgs.stdout).toContain('install-skill');
  });

  it('--help and no-args NEVER create the backing SQLite store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)', () => {
    // The exact resolved path a real `--help`/no-args invocation would open,
    // computed the same way `runBacklogCli` does (buildBacklogEnv with the
    // identical scope/cwd/adhdRoot triple `runBin`'s spawned process sees via
    // ADHD_BACKLOG_SCOPE=project + cwd=adhdRoot) — never opened directly here.
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-eager-open-'));
    const expectedDbPath = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot }).files.db;
    expect(existsSync(expectedDbPath), 'sanity: no store should exist before the CLI ever runs').toBe(false);

    const noArgs = runBin([], adhdRoot);
    expect(noArgs.status, `stderr:\n${noArgs.stderr}`).toBe(0);
    expect(existsSync(expectedDbPath), 'a bare no-args invocation must not create the store').toBe(false);

    const help = runBin(['--help'], adhdRoot);
    expect(help.status, `stderr:\n${help.stderr}`).toBe(0);
    expect(existsSync(expectedDbPath), 'a --help invocation must not create the store').toBe(false);

    const unknown = runBin(['totally-bogus-command'], adhdRoot);
    expect(unknown.status).not.toBe(0);
    expect(existsSync(expectedDbPath), 'an unrecognized command must not create the store either — it never reaches a real function').toBe(false);

    // Sanity check the assertion itself has teeth: a command that DOES reach
    // a real function (`query`, on an empty/nonexistent store) MUST create
    // it — proving `expectedDbPath` is the right path and `existsSync` isn't
    // just trivially false for an unrelated reason.
    const real = runBin(['query', '--input', '{}'], adhdRoot);
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(existsSync(expectedDbPath), 'a real dispatched command must still open the store as before').toBe(true);
  });

  // DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 (re-opened 2026-08-20): the July
  // fix (lazy getCtx) closed `--help`/no-args/unknown-command, but `version`
  // is a REAL `hasCtx` client.ts action — dispatching it through the apigen
  // command table still called `createClient` → `getCtx()` and opened the real
  // SQLite store (emitting `store_adapter.turso.recursive_cte_probe_failed` +
  // `store_adapter.turso.close_tshm_reset`), even though `version` only reads
  // `package.json`. This test asserts the CLOSED state across telemetry AND
  // DB creation, with a real store command as the positive control so the
  // assertion provably has teeth.
  it('version, --help, no-args, and install-skill --help emit ZERO store-open telemetry records and never create the DB', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-no-store-open-'));
    const soxHome = join(adhdRoot, 'sox-ecosystem');
    const expectedDbPath = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot }).files.db;
    expect(existsSync(expectedDbPath), 'sanity: no store should exist before the CLI ever runs').toBe(false);

    // `version`/`--help`/bare/`install-skill --help` must all exit 0 AND stay
    // store-free. `install-skill --help` used to exit 1 (its parser rejected
    // `--help` as an unknown argument, on a raw stack trace) — fixed by
    // BUG-BACKLOG-INSTALLSKILL-UX-001, which made `--help` a usage request
    // like every other command here, not a parse error.
    const zeroExit = [
      ['version'],
      ['--help'],
      [],
      ['install-skill', '--help'],
    ] as const;
    for (const args of zeroExit) {
      const res = runBin([...args], adhdRoot, { SOX_ECOSYSTEM_HOME: soxHome });
      const label = args.length === 0 ? '(no args)' : args.join(' ');
      expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
      expect(readTelemetryEvents(soxHome), `"${label}" must emit zero store-open telemetry records`).toHaveLength(0);
      expect(existsSync(expectedDbPath), `"${label}" must not create the store`).toBe(false);
    }

    // Negative control / teeth: a real store command MUST emit store-open
    // telemetry records AND create the DB — proving the assertions above are
    // not trivially green because the telemetry sink or DB path never fires.
    const real = runBin(['query', '--input', '{}'], adhdRoot, { SOX_ECOSYSTEM_HOME: soxHome });
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(existsSync(expectedDbPath), 'a real dispatched command must open the store').toBe(true);
    const allEvents = readTelemetryEvents(soxHome);
    const storeEvents = allEvents.filter((e) => e.startsWith('store_adapter'));
    // DEBT-BACKLOG-CLI-STORE-OPEN-001 postmortem: this exact assertion once
    // failed against a stale worktree whose `node_modules/@adhd/sox-store-
    // adapter` (0.5.8) predated `pnpm-lock.yaml`'s pinned 0.7.0 — a
    // `node_modules` install-drift problem, not a source regression. The
    // bare `toBeGreaterThan(0)` message ("expected 0 to be greater than 0")
    // gave zero signal toward that; dump what was actually captured (or the
    // installed adapter version, if events came back empty) so the next
    // failure is diagnosable without a live debugging session.
    expect(
      storeEvents.length,
      storeEvents.length > 0
        ? 'a real store command must emit store-open telemetry records'
        : `a real store command must emit store-open telemetry records — got zero. ` +
          `All ${allEvents.length} captured event(s): ${JSON.stringify(allEvents)}. ` +
          `If this is unexpectedly zero, first suspect node_modules/dist drift ` +
          `(stale worktree install vs pnpm-lock.yaml's pinned @adhd/sox-store-adapter) ` +
          `before assuming a source regression.`,
    ).toBeGreaterThan(0);
  });

  // DEBT-BACKLOG-CLI-STORE-OPEN-001: `migration-status`/`set-migration-phase`
  // are `hasCtx` client.ts actions that only read/write the `migration.phase`
  // config cascade (`env.config.migration.phase`, and the GLOBAL layer's
  // `config.yaml` via `migration-admin.ts` for the write) — never the graph
  // store. But dispatching them through the apigen command table still called
  // `createClient` → `getCtx()` and opened the real SQLite store (emitting
  // `store_adapter.turso.recursive_cte_probe_failed` +
  // `store_adapter.turso.close_tshm_reset`), even though neither command ever
  // touches `ctx.store` — the same eager-open class the `version`
  // short-circuit above closes. This test asserts the CLOSED state across
  // telemetry AND DB creation for both commands, a durable write→re-read
  // round trip through TWO separate processes, byte-parity of the CLI-visible
  // result shape (configPath first), and error/exit parity
  // (invalid_argument → 2) — with a real store command as the positive
  // control so the assertions provably have teeth.
  //
  // `HOME` is redirected into the temp scope for every migration-phase
  // invocation: `set-migration-phase` persists to the GLOBAL layer's
  // `config.yaml` via `os.homedir()` (the `BacklogCtx.adhdRoot` test override
  // is never set by the real CLI path), so without the redirect the write
  // would land in the REAL machine-global `~/.adhd/backlog/production/
  // config.yaml` — the exact regression `migration-admin.spec.ts`'s negative
  // control was filed for.
  it('migration-status and set-migration-phase emit ZERO store-open telemetry records, never create the DB, and persist config durably (DEBT-BACKLOG-CLI-STORE-OPEN-001)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-no-store-open-migration-'));
    const soxHome = join(adhdRoot, 'sox-ecosystem');
    const expectedDbPath = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot }).files.db;
    expect(existsSync(expectedDbPath), 'sanity: no store should exist before the CLI ever runs').toBe(false);
    const migrationEnv = { SOX_ECOSYSTEM_HOME: soxHome, HOME: soxHome };

    // `migration-status` is store-free, exits 0, reports the live config value
    // (not-started on a fresh scope), and emits zero store-open telemetry.
    const status = runBin(['migration-status'], adhdRoot, migrationEnv);
    expect(status.status, `stderr:\n${status.stderr}\nstdout:\n${status.stdout}`).toBe(0);
    const statusBody = JSON.parse(status.stdout.trim()) as { phase: string; toolIsAuthoritative: boolean };
    expect(statusBody.phase).toBe('not-started');
    expect(statusBody.toolIsAuthoritative).toBe(false);
    expect(readTelemetryEvents(soxHome), 'migration-status must emit zero store-open telemetry records').toHaveLength(0);
    expect(existsSync(expectedDbPath), 'migration-status must not create the store').toBe(false);

    // `set-migration-phase` writes THROUGH to the global config.yaml (the
    // temp-HOME-redirected path), still store-free. The CLI-visible result
    // serializes configPath FIRST — the schema-order shape the apigen
    // dispatch produces (see `setBacklogMigrationPhase`'s doc comment).
    const set = runBin(['set-migration-phase', '--phase', 'phase-3'], adhdRoot, migrationEnv);
    expect(set.status, `stderr:\n${set.stderr}\nstdout:\n${set.stdout}`).toBe(0);
    const setBody = JSON.parse(set.stdout.trim()) as { configPath: string; phase: string; toolIsAuthoritative: boolean };
    expect(Object.keys(setBody)[0]).toBe('configPath');
    expect(setBody.phase).toBe('phase-3');
    expect(setBody.toolIsAuthoritative).toBe(true);
    expect(setBody.configPath.startsWith(soxHome), 'the config write must land under the temp HOME, never the real ~/.adhd').toBe(true);
    expect(readTelemetryEvents(soxHome), 'set-migration-phase must emit zero store-open telemetry records').toHaveLength(0);
    expect(existsSync(expectedDbPath), 'set-migration-phase must not create the store').toBe(false);

    // Durable read-back: a FRESH store-free migration-status process reads the
    // just-written phase purely from disk (Environment.config is a
    // point-in-time snapshot per process).
    const status2 = runBin(['migration-status'], adhdRoot, migrationEnv);
    expect(status2.status, `stderr:\n${status2.stderr}`).toBe(0);
    expect((JSON.parse(status2.stdout.trim()) as { phase: string }).phase).toBe('phase-3');
    expect(readTelemetryEvents(soxHome)).toHaveLength(0);
    expect(existsSync(expectedDbPath)).toBe(false);

    // Error/exit parity with the apigen dispatch (invalid_argument → exit 2,
    // error JSON as the LAST stderr line): bad enum, missing flag, missing
    // value, unknown flag — all still store-free.
    const badEnum = runBin(['set-migration-phase', '--phase', 'bogus'], adhdRoot, migrationEnv);
    expect(badEnum.status, `stderr:\n${badEnum.stderr}`).toBe(2);
    const badEnumLine = badEnum.stderr.trim().split('\n').pop() ?? '';
    expect((JSON.parse(badEnumLine) as { code: string }).code).toBe('invalid_argument');
    expect(readTelemetryEvents(soxHome)).toHaveLength(0);
    expect(existsSync(expectedDbPath)).toBe(false);

    const missingFlag = runBin(['set-migration-phase'], adhdRoot, migrationEnv);
    expect(missingFlag.status, `stderr:\n${missingFlag.stderr}`).toBe(2);
    expect(readTelemetryEvents(soxHome)).toHaveLength(0);
    expect(existsSync(expectedDbPath)).toBe(false);

    // `--help` shows the same usage line the apigen path renders, exit 0.
    const help = runBin(['set-migration-phase', '--help'], adhdRoot, migrationEnv);
    expect(help.status, `stderr:\n${help.stderr}\nstdout:\n${help.stdout}`).toBe(0);
    expect(help.stdout).toContain('backlog set-migration-phase');
    expect(readTelemetryEvents(soxHome)).toHaveLength(0);
    expect(existsSync(expectedDbPath)).toBe(false);

    // Negative control / teeth: a real store command MUST emit store-open
    // telemetry records AND create the DB — proving the assertions above are
    // not trivially green because the telemetry sink or DB path never fires.
    const real = runBin(['query', '--input', '{}'], adhdRoot, migrationEnv);
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(existsSync(expectedDbPath), 'a real dispatched command must open the store').toBe(true);
    const allEvents = readTelemetryEvents(soxHome);
    const storeEvents = allEvents.filter((e) => e.startsWith('store_adapter'));
    // See the identical assertion's comment above (line ~324) — zero here
    // most likely means installed-dependency drift (node_modules vs
    // pnpm-lock.yaml), not a source regression; dump events to make that
    // diagnosable without a live debugging session.
    expect(
      storeEvents.length,
      storeEvents.length > 0
        ? 'a real store command must emit store-open telemetry records'
        : `a real store command must emit store-open telemetry records — got zero. ` +
          `All ${allEvents.length} captured event(s): ${JSON.stringify(allEvents)}. ` +
          `If this is unexpectedly zero, first suspect node_modules/dist drift ` +
          `(stale worktree install vs pnpm-lock.yaml's pinned @adhd/sox-store-adapter) ` +
          `before assuming a source regression.`,
    ).toBeGreaterThan(0);
  });

  it('BUG-002: ADHD_BACKLOG_DATABASE_PATH redirects the store the bin opens — the env var wins over the scope-root fallback', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-dbpath-'));
    const redirectDb = join(adhdRoot, 'redirect', 'backlog.db');

    const res = runBin(['query', '--input', '{}'], adhdRoot, { ADHD_BACKLOG_DATABASE_PATH: redirectDb });
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);

    // The env-var path is the store the CLI actually opened…
    expect(existsSync(redirectDb), 'the ADHD_BACKLOG_DATABASE_PATH target must be the opened store').toBe(true);
    // …and the scope-root fallback must NOT have been created (pre-fix, this
    // test went red: the bin opened env.files.db and ignored the env var).
    const fallback = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot }).files.db;
    expect(existsSync(fallback), 'the scope-root fallback must not be created when the env var is set').toBe(false);
  });

  it('BUG-002 regression guard: with ADHD_BACKLOG_DATABASE_PATH unset, the bin still opens the scope-root fallback as before', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-dbpath-default-'));
    const fallback = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot }).files.db;
    expect(existsSync(fallback), 'sanity: no store should exist before the CLI runs').toBe(false);

    const res = runBin(['query', '--input', '{}'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(existsSync(fallback), 'unset env var ⇒ the scope-root fallback store is created, exactly as before BUG-002').toBe(true);
  });

  it('a PLAIN "get --input …" (bare, no manual namespace prefix) resolves — proves runBacklogCli prepends the namespace itself', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-getitem-'));
    const repo = 'PseudoSky/cli-test';

    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can
    // open it exclusively (identical pattern to server.spec.ts/
    // server.mcp.spec.ts's seeding).
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLI', title: 'via cli', body: 'x', repo }
    );
    await closeGraphBacklogStore(seedStore);

    // Deliberately BARE — no `backlog` prefix typed by the "user" here,
    // exactly like a real `backlog get …` invocation arrives at this
    // process as `process.argv.slice(2)`. `fields` explicitly asks for
    // `repo` — DEFAULT_GET_FIELDS omits it (model.ts), confirmed empirically
    // against the real built bin, so it must be requested to assert on it.
    const res = runBin(
      ['get', '--input', JSON.stringify({ humanId: seeded.item.humanId, repo, fields: ['humanId', 'title', 'repo'] })],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const body = JSON.parse(res.stdout.trim()) as { ok: boolean; data: { humanId: string; title: string; repo: string } };
    expect(body.ok).toBe(true);
    expect(body.data.humanId).toBe(seeded.item.humanId);
    expect(body.data.title).toBe('via cli');
    expect(body.data.repo).toBe(repo);
  });

  it('a fully-prefixed "backlog get …" ALSO resolves — proves prefixCommand is idempotent at the real dispatch, not just in the unit test', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-getitem-prefixed-'));
    const repo = 'PseudoSky/cli-test-prefixed';

    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLIPFX', title: 'via cli prefixed', body: 'x', repo }
    );
    await closeGraphBacklogStore(seedStore);

    const res = runBin(
      ['backlog', 'get', '--input', JSON.stringify({ humanId: seeded.item.humanId, repo })],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const body = JSON.parse(res.stdout.trim()) as { ok: boolean; data: { humanId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.humanId).toBe(seeded.item.humanId);
  });

  it('a full CLI round trip — "create --input <json>" then "get" — persists across TWO separate process invocations', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-roundtrip-'));
    const repo = 'PseudoSky/cli-roundtrip';

    const createRes = runBin(
      [
        'create',
        '--input',
        JSON.stringify({ item: { family: 'BUG-CLIRT', title: 'roundtrip', body: 'x', repo }, by: 'cli.spec' }),
      ],
      adhdRoot
    );
    expect(createRes.status, `stderr:\n${createRes.stderr}\nstdout:\n${createRes.stdout}`).toBe(0);
    const created = JSON.parse(createRes.stdout.trim()) as { ok: boolean; data: { humanId: string } };
    expect(created.ok).toBe(true);
    expect(created.data.humanId).toBe('BUG-CLIRT-001');

    const getRes = runBin(
      ['get', '--input', JSON.stringify({ humanId: created.data.humanId, repo })],
      adhdRoot
    );
    expect(getRes.status, `stderr:\n${getRes.stderr}\nstdout:\n${getRes.stdout}`).toBe(0);
    const got = JSON.parse(getRes.stdout.trim()) as { ok: boolean; data: { title: string } };
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('roundtrip');
  });

  it('"query" (view:list) returns the seeded item, filtered by repo', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-list-'));
    const repo = 'PseudoSky/cli-list-test';

    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLILIST', title: 'listed via cli', body: 'x', repo }
    );
    await closeGraphBacklogStore(seedStore);

    const res = runBin(['query', '--input', JSON.stringify({ filter: { repo } })], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const body = JSON.parse(res.stdout.trim()) as {
      ok: boolean;
      data: { view: string; items: Array<{ humanId: string; title: string }> };
      meta: { total: number; returned: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.view).toBe('list');
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.humanId).toBe(seeded.item.humanId);
    expect(body.data.items[0]?.title).toBe('listed via cli');
    expect(body.meta.total).toBe(1);
    expect(body.meta.returned).toBe(1);
  });

  it('an unknown command exits with CLI_EXIT_CODE.not_found (4), never 0', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-unknown-'));
    const res = runBin(['totally-bogus-command'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(4);
    // `reportFailure`'s final error JSON is always the LAST stderr line — a
    // failed command may also have a preceding pino log line (see the
    // bad-flag case below), so never assume stderr is a single JSON blob.
    const lastLine = res.stderr.trim().split('\n').pop() ?? '';
    const body = JSON.parse(lastLine) as { code: string; message: string };
    expect(body.code).toBe('not_found');
  });

  it('an unknown flag exits with CLI_EXIT_CODE.invalid_argument (2), never 0', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-badflag-'));
    const res = runBin(['get', '--this-flag-does-not-exist', 'x'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(2);
    const lastLine = res.stderr.trim().split('\n').pop() ?? '';
    const body = JSON.parse(lastLine) as { code: string; message: string };
    expect(body.code).toBe('invalid_argument');
  });

  // `install-skill` (MIGRATION.md §4.2) is special-cased in `runBacklogCli`
  // BEFORE the apigen package is even built — it needs no store at all, so a
  // real-binary proof matters here specifically to confirm the special-case
  // interception actually fires for the real spawned bin, not just the
  // in-process `installSkill()` unit tests (`install-skill.spec.ts`).
  // Deliberately `--scope project` ONLY — `--scope user` resolves the REAL
  // machine home directory with no override, so it is exercised exclusively
  // via `install-skill.spec.ts`'s `homeOverride`-isolated unit tests, never
  // through a real spawned process here.
  // Task A (FEAT-BACKLOG batch-CLI wiring) + BUG-018 (prefixCommand mount-
  // namespace clobber, fixed in the same change): `runBacklogCli` now wires
  // `usePlugins: [batchPlugin]` into `cliPlugin.run()`'s `options` (mirroring
  // `server.ts`'s MCP-transport wiring) AND `prefixCommand` skips prefixing a
  // top-level mount-plugin command (`MOUNT_COMMAND_NAMESPACES`). Reverting
  // EITHER half of that fix turns this test red: dropping `usePlugins`
  // resolves `batch action` as an unrecognized command (status 4, `not_found`
  // — matched `Unknown command: backlog batch action …` in manual repro);
  // dropping the `prefixCommand` reserved-namespace guard corrupts the argv
  // into `backlog batch action …`, which the real command table also has no
  // entry for — same `not_found` failure, just a different root cause. This
  // spec proves both halves together via the one thing that actually matters:
  // a real 2-item batch fan-out dispatched through the real spawned CLI bin,
  // reaching the REAL `createItem` (`client.ts`) via the REAL
  // `_batch/action` mount, over a real temp-scoped SQLite store — no mocks.
  it('"batch action --operation backlog/create --items […]" fans out via the real CLI to real client.ts create, and both items persist independently (BUG-018 / batch-CLI wiring)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-batch-'));
    const repo = 'PseudoSky/cli-batch-test';

    // Each batch item's `input` is the WHOLE `backlog_create` request shape
    // (`IBacklogCreateInput`: `{ item, by, duplicateAction? }`), confirmed
    // empirically against the real built bin — batch fans each item straight
    // into the named operation's own input, and `create`'s v2 input nests the
    // domain payload one level deeper than the retired v1 `create-item` did,
    // on a field named `item` (model.ts `IBacklogCreateInput.item` doc
    // comment — not `input`, which double-nested every call as a typo).
    const items = JSON.stringify([
      { input: { item: { family: 'BUG-CLIBATCH', title: 'batch one', body: 'x', repo }, by: 'cli.spec' } },
      { input: { item: { family: 'BUG-CLIBATCH', title: 'batch two', body: 'y', repo }, by: 'cli.spec' } },
    ]);
    const res = runBin(
      ['batch', 'action', '--operation', 'backlog/create', '--items', items, '--concurrency', '2', '--on-item-error', 'continue'],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);

    // Each batch item's `.value` is the WHOLE outcome envelope the real
    // `create()` returned (INTERFACE_v2 §7.1 — `create` reports failure in
    // the envelope rather than throwing, so a business failure still shows up
    // as `status: 'fulfilled'` with `value.ok === false`, confirmed
    // empirically) — never the bare v1 `{created, item}` shape.
    interface BatchItemResult {
      index: number;
      status: 'fulfilled' | 'rejected';
      value?: { ok: boolean; data?: { item: { humanId: string; title: string; repo: string }; created: boolean } };
      reason?: { message?: string; code?: string };
    }
    const results = JSON.parse(res.stdout.trim()) as BatchItemResult[];
    expect(results).toHaveLength(2);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[0]?.value?.ok).toBe(true);
    expect(results[0]?.value?.data?.created).toBe(true);
    expect(results[0]?.value?.data?.item.title).toBe('batch one');
    const firstHumanId = results[0]?.value?.data?.item.humanId;
    expect(firstHumanId).toBeTruthy();

    expect(results[1]?.status).toBe('fulfilled');
    expect(results[1]?.value?.ok).toBe(true);
    expect(results[1]?.value?.data?.created).toBe(true);
    expect(results[1]?.value?.data?.item.title).toBe('batch two');
    const secondHumanId = results[1]?.value?.data?.item.humanId;
    expect(secondHumanId).toBeTruthy();
    expect(secondHumanId).not.toBe(firstHumanId);

    // Follow-up REAL "get" (a separate process invocation, through the
    // ordinary `backlog`-prefixed command path) proves both batch-created
    // items are genuinely persisted in the store — not just echoed back in
    // the batch response.
    const get1 = runBin(['get', '--input', JSON.stringify({ humanId: firstHumanId, repo })], adhdRoot);
    expect(get1.status, `stderr:\n${get1.stderr}`).toBe(0);
    expect((JSON.parse(get1.stdout.trim()) as { data: { title: string } }).data.title).toBe('batch one');

    const get2 = runBin(['get', '--input', JSON.stringify({ humanId: secondHumanId, repo })], adhdRoot);
    expect(get2.status, `stderr:\n${get2.stderr}`).toBe(0);
    expect((JSON.parse(get2.stdout.trim()) as { data: { title: string } }).data.title).toBe('batch two');
  });

  it('an "operation" not in this mount\'s batchable set is rejected by the batch handler\'s own validation (proves the CLI mount is bound to the real backlog descriptor, not a stub)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-batch-badop-'));
    const res = runBin(['batch', 'action', '--operation', 'backlog/not-a-real-op', '--items', '[]'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).not.toBe(0);
    const lastLine = res.stderr.trim().split('\n').pop() ?? '';
    const body = JSON.parse(lastLine) as { code: string; message: string };
    expect(body.code).toBe('invalid_argument');
    expect(body.message).toContain('backlog/not-a-real-op');
  });

  // Task B: `client.ts`'s `version()` export is automatically extracted and
  // exposed as `backlog version` on every transport, with NO server.ts/cli.ts
  // changes needed beyond the export itself — this proves that over the
  // REAL, spawned, dev-built `dist/index.js` bin (the "DEV-BUILT" layout in
  // `server.ts`'s `backlogDistDir()` doc comment), reading the REAL
  // `package.json` at test time so this can never silently drift from it.
  it('"version" reports the REAL, currently-built package.json name/version — dev-dist layout (spawned dist/index.js bin)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-version-'));
    const res = runBin(['version'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as { name: string; version: string };
    const realPkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as { name: string; version: string };
    expect(parsed).toEqual({ name: realPkg.name, version: realPkg.version });
  });

  it('install-skill --host claude --scope project drops the packaged, currently-built SKILL.md under the given cwd — content-hash matches (MIGRATION.md §4.4 DoD)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-install-skill-'));
    const res = runBin(['install-skill', '--host', 'claude', '--scope', 'project'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const body = JSON.parse(res.stdout.trim()) as { installed: Array<{ host: string; scope: string; path: string }> };
    expect(body.installed).toHaveLength(1);
    const installedPath = body.installed[0].path;
    // `realpathSync` on both sides — on macOS, `/tmp`-family paths resolve
    // through a `/private` symlink, and the child process's own
    // `process.cwd()` (which `installSkill` uses for `--scope project`)
    // returns the FULLY RESOLVED path, while `adhdRoot` here is the
    // unresolved `mkdtempSync` path passed as `cwd` — a benign platform
    // quirk, not a real divergence (both point at the identical directory).
    expect(realpathSync(installedPath)).toBe(join(realpathSync(adhdRoot), '.claude', 'skills', 'backlog', 'SKILL.md'));
    expect(existsSync(installedPath)).toBe(true);
    const packagedSkillMd = readFileSync(join(HERE, '..', 'skill', 'SKILL.md'), 'utf8');
    expect(readFileSync(installedPath, 'utf8')).toBe(packagedSkillMd);
    // Never opened a real backlog store for this command (no `.adhd/backlog`
    // data dir created) — proving the special-case truly bypasses
    // `buildBacklogApigenPackage`/`getCtx` entirely, the same property
    // `DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001`'s own test proves for `--help`.
    expect(existsSync(join(adhdRoot, '.adhd', 'backlog'))).toBe(false);
  });

  // close-on-error regression: a command that OPENS the store and then FAILS
  // (cross-repo get-item → BacklogItemNotFoundError, thrown AFTER ctx/store
  // creation) must still close the store in `runBacklogCli`'s finally — the
  // BL-512 TRUNCATE guarantee (adapter close checkpoints + truncates the -wal
  // to ~0 bytes) must hold on the ERROR path too, not just the happy path.
  //
  // RED-to-GREEN discriminator: this test FAILS if the finally close in
  // `cli.ts`'s `runBacklogCli` is deleted ENTIRELY — the -wal stays large
  // (measured 284 KB with the close deleted) because the adapter never got its
  // close(), so the WAL-truncation assertion below trips. It does NOT fail
  // because close() itself throws — a close() that throws is exactly what
  // `closeGraphBacklogStoreSafe` swallows so it can never mask the command
  // outcome, and this test's exit-1 assertion would still pass either way.
  //
  // NOTE the deliberately CROSS-REPO lookup: a humanId that exists in NO repo
  // returns `null` from getItem (exit 0 — no failure, no exercise of the
  // error path); only a humanId found in a DIFFERENT repo throws
  // BacklogItemNotFoundError (getItem → getItemNode → buildNotFoundError →
  // foundInRepos.length > 0 → throw), which is the exact "opens the store,
  // then fails" shape this regression needs. `--help`/`install`/`serve` never
  // open the store and are deliberately NOT used here.
  it('a command that OPENS the store then fails still closes it in the finally (WAL truncated, store reopens cleanly)', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-close-on-error-'));
    const repo = 'PseudoSky/cli-close-on-error';

    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can open
    // it exclusively (identical pattern to the get-item tests above).
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const dbPath = seedEnv.files.db;
    const seedStore = await openGraphBacklogStore(dbPath);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLCLOSE', title: 'close on error', body: 'x', repo }
    );
    await closeGraphBacklogStore(seedStore);

    // Cross-repo get: the humanId EXISTS but under `repo`, not the queried
    // repo — reports `item_not_found` (exit 1) AFTER the store opened.
    const res = runBin(
      ['get', '--input', JSON.stringify({ humanId: seeded.item.humanId, repo: 'PseudoSky/other-repo' })],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(1);

    // BL-512 TRUNCATE guarantee on the ERROR path: a proper close checkpoints
    // and truncates the -wal to ~0 bytes (absent or < 4096). A skipped close
    // leaves it growing (measured 284 KB with the finally close deleted).
    const walPath = dbPath + '-wal';
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(
      walSize,
      `-wal must be truncated after a failing command (was ${walSize} bytes) — the finally close did not run`
    ).toBeLessThan(4096);

    // The store must reopen cleanly in THIS process and still read the seeded
    // data — proving the failed command's close left a healthy, consistent db.
    const reopened = await openGraphBacklogStore(dbPath);
    try {
      const got = await getItem({ store: reopened, env: seedEnv }, repo, seeded.item.humanId);
      expect(got?.humanId).toBe(seeded.item.humanId);
      expect(got?.title).toBe('close on error');
    } finally {
      await closeGraphBacklogStore(reopened);
    }
  });
});
