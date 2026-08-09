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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createItem } from './client.js';
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
function runBin(args: string[], cwd: string): SpawnResult {
  const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd,
    // `ADHD_BACKLOG_SCOPE=project` + a fresh, empty `cwd` with no ancestor
    // `.adhd` marker (a throwaway `mkdtempSync` dir) makes `@adhd/environment`
    // bootstrap the graph store fresh AT `cwd` — never the real machine's
    // global `~/.adhd/backlog` store. Confirmed empirically: a manual smoke
    // run of this exact shape (`cd <tmp> && ADHD_BACKLOG_SCOPE=project node
    // dist/index.js …`) left the real repo's `.adhd/` and the real global
    // `~/.adhd/backlog/` both untouched.
    env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`spawn failed for ${DIST_INDEX} ${JSON.stringify(args)}: ${String(result.error)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
    expect(actions.length).toBeGreaterThan(10); // sanity: client.ts exports many operations
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
    expect(res.stdout).toContain('backlog get-item');
    expect(res.stdout).toContain('backlog create-item');
    expect(res.stdout).toContain('backlog list-items');
  });

  it('--help exits 0 with the identical usage listing', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-'));
    const res = runBin(['--help'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('backlog get-item');
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
    // a real function (`list-items`, on an empty/nonexistent store) MUST
    // create it — proving `expectedDbPath` is the right path and `existsSync`
    // isn't just trivially false for an unrelated reason.
    const real = runBin(['list-items', '--filter', '{}'], adhdRoot);
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(existsSync(expectedDbPath), 'a real dispatched command must still open the store as before').toBe(true);
  });

  it('a PLAIN "get-item --repo … --human-id …" (bare, no manual namespace prefix) resolves — proves runBacklogCli prepends the namespace itself', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-getitem-'));
    const repo = 'PseudoSky/cli-test';

    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can
    // open it exclusively (identical pattern to server.spec.ts/
    // server.mcp.spec.ts's seeding).
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLI', title: 'via cli', body: 'x', repo }
    );
    closeGraphBacklogStore(seedStore);

    // Deliberately BARE — no `backlog` prefix typed by the "user" here,
    // exactly like a real `backlog get-item …` invocation arrives at this
    // process as `process.argv.slice(2)`.
    const res = runBin(['get-item', '--repo', repo, '--human-id', seeded.item.humanId], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as { humanId: string; title: string; repo: string };
    expect(parsed.humanId).toBe(seeded.item.humanId);
    expect(parsed.title).toBe('via cli');
    expect(parsed.repo).toBe(repo);
  });

  it('a fully-prefixed "backlog get-item …" ALSO resolves — proves prefixCommand is idempotent at the real dispatch, not just in the unit test', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-getitem-prefixed-'));
    const repo = 'PseudoSky/cli-test-prefixed';

    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLIPFX', title: 'via cli prefixed', body: 'x', repo }
    );
    closeGraphBacklogStore(seedStore);

    const res = runBin(['backlog', 'get-item', '--repo', repo, '--human-id', seeded.item.humanId], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as { humanId: string };
    expect(parsed.humanId).toBe(seeded.item.humanId);
  });

  it('a full CLI round trip — "create-item --input <json>" then "get-item" — persists across TWO separate process invocations', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-roundtrip-'));
    const repo = 'PseudoSky/cli-roundtrip';

    const createRes = runBin(
      ['create-item', '--input', JSON.stringify({ family: 'BUG-CLIRT', title: 'roundtrip', body: 'x', repo })],
      adhdRoot
    );
    expect(createRes.status, `stderr:\n${createRes.stderr}\nstdout:\n${createRes.stdout}`).toBe(0);
    const created = JSON.parse(createRes.stdout.trim()) as { item: { humanId: string } };
    expect(created.item.humanId).toBe('BUG-CLIRT-001');

    const getRes = runBin(['get-item', '--repo', repo, '--human-id', created.item.humanId], adhdRoot);
    expect(getRes.status, `stderr:\n${getRes.stderr}\nstdout:\n${getRes.stdout}`).toBe(0);
    const got = JSON.parse(getRes.stdout.trim()) as { title: string };
    expect(got.title).toBe('roundtrip');
  });

  it('"list-items" returns the seeded item', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-list-'));
    const repo = 'PseudoSky/cli-list-test';

    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      { family: 'BUG-CLILIST', title: 'listed via cli', body: 'x', repo }
    );
    closeGraphBacklogStore(seedStore);

    const res = runBin(['list-items', '--filter', JSON.stringify({ repo })], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as Array<{ humanId: string; title: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.humanId).toBe(seeded.item.humanId);
    expect(parsed[0]?.title).toBe('listed via cli');
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
    const res = runBin(['get-item', '--this-flag-does-not-exist', 'x'], adhdRoot);
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
  it('"batch action --operation backlog/create-item --items […]" fans out via the real CLI to real client.ts createItem, and both items persist independently (BUG-018 / batch-CLI wiring)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-batch-'));
    const repo = 'PseudoSky/cli-batch-test';

    const items = JSON.stringify([
      { input: { family: 'BUG-CLIBATCH', title: 'batch one', body: 'x', repo } },
      { input: { family: 'BUG-CLIBATCH', title: 'batch two', body: 'y', repo } },
    ]);
    const res = runBin(
      ['batch', 'action', '--operation', 'backlog/create-item', '--items', items, '--concurrency', '2', '--on-item-error', 'continue'],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);

    interface BatchItemResult {
      index: number;
      status: 'fulfilled' | 'rejected';
      value?: { item: { humanId: string; title: string; repo: string }; created: boolean };
      reason?: { message?: string; code?: string };
    }
    const results = JSON.parse(res.stdout.trim()) as BatchItemResult[];
    expect(results).toHaveLength(2);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[0]?.value?.created).toBe(true);
    expect(results[0]?.value?.item.title).toBe('batch one');
    const firstHumanId = results[0]?.value?.item.humanId;
    expect(firstHumanId).toBeTruthy();

    expect(results[1]?.status).toBe('fulfilled');
    expect(results[1]?.value?.created).toBe(true);
    expect(results[1]?.value?.item.title).toBe('batch two');
    const secondHumanId = results[1]?.value?.item.humanId;
    expect(secondHumanId).toBeTruthy();
    expect(secondHumanId).not.toBe(firstHumanId);

    // Follow-up REAL "get-item" (a separate process invocation, through the
    // ordinary `backlog`-prefixed command path) proves both batch-created
    // items are genuinely persisted in the store — not just echoed back in
    // the batch response.
    const get1 = runBin(['get-item', '--repo', repo, '--human-id', firstHumanId as string], adhdRoot);
    expect(get1.status, `stderr:\n${get1.stderr}`).toBe(0);
    expect((JSON.parse(get1.stdout.trim()) as { title: string }).title).toBe('batch one');

    const get2 = runBin(['get-item', '--repo', repo, '--human-id', secondHumanId as string], adhdRoot);
    expect(get2.status, `stderr:\n${get2.stderr}`).toBe(0);
    expect((JSON.parse(get2.stdout.trim()) as { title: string }).title).toBe('batch two');
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
});
