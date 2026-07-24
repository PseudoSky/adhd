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
 * (the exact shape of the real command table, INCLUDING the `client-d`
 * file-segment — see the note below) as a literal, load-bearing assertion
 * that fails loudly the moment that fact ever changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createItem } from './client.js';
import type { BacklogCtx } from './client.js';
import { buildBacklogEnv } from './env.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogApigenPackage } from './server.js';
import { resolveCommandPrefix, prefixCommand } from './cli.js';

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
// FINDING (not an assumption): the real internal command-table prefix is
// TWO segments, `['backlog', 'client-d']`, NOT the single `['backlog']`
// segment a naive reading of "the extraction namespace is 'backlog'" would
// suggest. `@adhd/apigen-core-client`'s `extract()` unconditionally builds
// every operation's `path` as `[fileSegment, exportSegment]`
// (`extract.ts`: `const opPath: Segment[] = [fileSeg, exportSeg]`), and
// `fileSegment` is derived from the EXTRACTED file's own name
// (`normalizeFileName('client.d.ts')` → `'client-d'`). `server.ts`'s
// `extractClientOperations()` always points extraction at the BUILT
// `client.d.ts` (a deliberate workaround for a separate apigen bug — see
// that function's own doc comment), so this file-segment is unavoidable
// today. `@adhd/apigen-plugin-cli-output`'s `buildCommandTable()` is the
// ONLY transport that consults `project(op).cli.path` (namespace + full
// `path`, i.e. INCLUDING the file segment) for its routing keys — HTTP
// (`apigen-plugin-api-fastify`) and MCP (`apigen-plugin-mcp`) also happen to
// use the canonical projector post-BUG-BACKLOG-CANONICAL-NAMING-CLIENT-D-
// SEGMENT-001 (see BACKLOG.md), so `/backlog/client-d/get-item` and
// `backlog_client_d_get_item` leak the same segment on those transports too
// — but the CLI is the only transport where THIS package controls the
// user-facing surface (a human types the argv), so `runBacklogCli` hides it.
describe('resolveCommandPrefix / prefixCommand — namespace-prefix derivation (empirically verified, not assumed)', () => {
  it('resolveCommandPrefix derives the REAL two-segment internal prefix from live operations', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const prefix = resolveCommandPrefix(operations);
    expect(prefix).toEqual(['backlog', 'client-d']);
  });

  it('every client.ts operation shares the identical prefix (one source file ⇒ one uniform file-segment)', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const actions = operations.filter((op) => op.kind === 'action');
    expect(actions.length).toBeGreaterThan(10); // sanity: client.ts exports many operations
    const prefix = resolveCommandPrefix(actions);
    for (const op of actions) {
      expect(resolveCommandPrefix([op])).toEqual(prefix);
    }
  });

  it('prefixCommand prepends the real prefix to a BARE user command (what a human actually types)', () => {
    expect(prefixCommand(['get-item', '--repo', 'x', '--human-id', 'y'], ['backlog', 'client-d'])).toEqual([
      'backlog',
      'client-d',
      'get-item',
      '--repo',
      'x',
      '--human-id',
      'y',
    ]);
  });

  it('prefixCommand is idempotent — an already-fully-prefixed argv is NEVER double-prefixed', () => {
    expect(prefixCommand(['backlog', 'client-d', 'get-item'], ['backlog', 'client-d'])).toEqual([
      'backlog',
      'client-d',
      'get-item',
    ]);
  });

  it('prefixCommand leaves a leading --help/-h flag untouched (never shadows run()\'s own top-level --help short-circuit)', () => {
    expect(prefixCommand(['--help'], ['backlog', 'client-d'])).toEqual(['--help']);
    expect(prefixCommand(['-h'], ['backlog', 'client-d'])).toEqual(['-h']);
  });

  it('prefixCommand leaves empty argv untouched', () => {
    expect(prefixCommand([], ['backlog', 'client-d'])).toEqual([]);
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
    expect(res.stdout).toContain('backlog client-d get-item');
    expect(res.stdout).toContain('backlog client-d create-item');
    expect(res.stdout).toContain('backlog client-d list-items');
  });

  it('--help exits 0 with the identical usage listing', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-'));
    const res = runBin(['--help'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('backlog client-d get-item');
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

    // Deliberately BARE — no `backlog`/`client-d` prefix typed by the
    // "user" here, exactly like a real `backlog get-item …` invocation
    // arrives at this process as `process.argv.slice(2)`.
    const res = runBin(['get-item', '--repo', repo, '--human-id', seeded.item.humanId], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as { humanId: string; title: string; repo: string };
    expect(parsed.humanId).toBe(seeded.item.humanId);
    expect(parsed.title).toBe('via cli');
    expect(parsed.repo).toBe(repo);
  });

  it('a fully-prefixed "backlog client-d get-item …" ALSO resolves — proves prefixCommand is idempotent at the real dispatch, not just in the unit test', async () => {
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

    const res = runBin(['backlog', 'client-d', 'get-item', '--repo', repo, '--human-id', seeded.item.humanId], adhdRoot);
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
});
