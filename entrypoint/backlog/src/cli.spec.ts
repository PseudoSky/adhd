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
 * command like `get` onto the cli-output plugin's REAL, namespace-
 * qualified command table) get a direct unit-level check too — not because
 * unit-testing beats spawning, but because the whole point of these two
 * helpers is to encode an empirically-verified, otherwise-invisible fact
 * (the exact shape of the real command table — see the note below) as a
 * literal, load-bearing assertion that fails loudly the moment that fact
 * ever changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIssue } from './write/create-issue.js';
import { getIssue } from './query/get.js';
import { seedProject } from './test/helpers/open-test-issue-store.js';
import type { BacklogCtx } from './api.js';
import { buildBacklogEnv } from './env.js';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
} from './store/graph-backlog-store.js';
import { buildBacklogApigenPackage } from './server.js';
import {
  resolveCommandPrefix,
  prefixCommand,
  resolveMountNamespaces,
  USE_PLUGINS,
} from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built `backlog` bin as a genuine child process. Never imported. */
function runBin(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): SpawnResult {
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
    throw new Error(
      `spawn failed for ${DIST_INDEX} ${JSON.stringify(args)}: ${String(
        result.error
      )}`
    );
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Reads every telemetry event the spawned bins have written under a temp
 * `SOX_ECOSYSTEM_HOME` redirect (so the suite never touches the real machine
 * telemetry log), returning just the `event` name per record. The store
 * substrate emits `store_adapter.*` records ONLY when the real backing store
 * is actually opened+closed — so `store_adapter` events are the exact,
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

/**
 * Seeds exactly one project (via `seedProject`) plus one issue under it
 * (via `createIssue`), opening/closing a real `GraphBacklogStore` against
 * `dbPath` directly — never through the spawned CLI — so the seeded data is
 * on disk BEFORE a CLI subprocess ever owns the file (the subprocess's own
 * store open must never race a still-open seeding handle). Returns the
 * issue's `uid` and the project's `uid` (usable directly as `create`'s
 * `project` input, since that field resolves a uid or a name).
 */
async function seedIssue(
  dbPath: string,
  projectName: string,
  title: string,
  body: string
): Promise<{ uid: string; projectUid: string }> {
  const store = await openGraphBacklogStore(dbPath);
  try {
    const { projectUid } = await seedProject(store, projectName);
    // `duplicateAction: 'force'` bypasses the pre-write similarity scan's
    // suppression — this harness seeds short, near-empty bodies across
    // several tests, which can otherwise trip the scan's own dedupe
    // threshold against an unrelated sibling item and suppress the write
    // entirely (`{created:false, reason:'duplicate-suppressed'}`).
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body,
      by: 'cli.spec',
      duplicateAction: 'force',
    });
    if (!created.uid) throw new Error('createIssue did not mint a uid');
    return { uid: created.uid, projectUid };
  } finally {
    await closeGraphBacklogStore(store);
  }
}

// ---------------------------------------------------------------------------
// Unit-level: resolveCommandPrefix / prefixCommand — the namespace-prefix
// question this package's task spec called out explicitly ("Confirm the
// exact behavior … and prove it with a test — do not assume").
//
// FINDING (not an assumption): the real internal command-table prefix is the
// single segment `['backlog']`. `server.ts`'s `extractApiOperations()` calls
// `extract({ …, dropFileSegment: true })`, so every operation's `path` is
// just `[exportSegment]` — no `api.d.ts`-derived file segment (that used to
// leak as `'api-d'` into every transport's name before
// BUG-BACKLOG-CANONICAL-NAMING-CLIENT-D-SEGMENT-001 was fixed by adding
// `ExtractOptions.dropFileSegment` to `@adhd/apigen-core-client`). Safe here
// specifically because every `api.ts` export is extracted from this ONE
// file — a genuine same-name collision across files would still be caught
// at extract time by `checkCollisions` (`@adhd/apigen-engine-naming`).
describe('resolveCommandPrefix / prefixCommand — namespace-prefix derivation (empirically verified, not assumed)', () => {
  it('resolveCommandPrefix derives the REAL single-segment internal prefix from live operations', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const prefix = resolveCommandPrefix(operations);
    expect(prefix).toEqual(['backlog']);
  });

  it('every api.ts operation shares the identical prefix (one source file, flat path ⇒ one uniform prefix)', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const actions = operations.filter((op) => op.kind === 'action');
    // The mounted surface is EXACTLY api.ts's fourteen exported verbs (`get`,
    // `query`, `lookup`, `create`, `update`, `transition`, `claim`, `relate`,
    // `move`, `upsertProject`, `upsertComponent`, `upsertLocation`,
    // `rmLocation`, `delete`) — asserted as an exact count, not a loose
    // lower bound, so a widened action count here is real evidence of scope
    // creep onto api.ts's exported surface (see api.ts's own doc comment on
    // why the exported surface IS the mounted surface).
    expect(actions.length).toBe(14);
    const prefix = resolveCommandPrefix(actions);
    for (const op of actions) {
      expect(resolveCommandPrefix([op])).toEqual(prefix);
    }
  });

  it('prefixCommand prepends the real prefix to a BARE user command (what a human actually types)', () => {
    expect(
      prefixCommand(['get', '--input', '{}'], ['backlog'], new Set())
    ).toEqual(['backlog', 'get', '--input', '{}']);
  });

  it('prefixCommand is idempotent — an already-fully-prefixed argv is NEVER double-prefixed', () => {
    expect(prefixCommand(['backlog', 'get'], ['backlog'], new Set())).toEqual([
      'backlog',
      'get',
    ]);
  });

  it("prefixCommand leaves a leading --help/-h flag untouched (never shadows run()'s own top-level --help short-circuit)", () => {
    expect(prefixCommand(['--help'], ['backlog'], new Set())).toEqual([
      '--help',
    ]);
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
      prefixCommand(
        ['batch', 'action', '--operation', 'backlog/create', '--items', '[]'],
        ['backlog'],
        reserved
      )
    ).toEqual([
      'batch',
      'action',
      '--operation',
      'backlog/create',
      '--items',
      '[]',
    ]);
  });

  it('prefixCommand still prefixes an ordinary bare api.ts command whose name happens to differ from any reserved namespace', async () => {
    const { operations } = await buildBacklogApigenPackage({} as BacklogCtx);
    const reserved = resolveMountNamespaces(USE_PLUGINS, operations, 'backlog');
    expect(
      prefixCommand(['get', '--input', '{}'], ['backlog'], reserved)
    ).toEqual(['backlog', 'get', '--input', '{}']);
  });
});

// ---------------------------------------------------------------------------
// Integration: real spawned `dist/index.js` bin, real temp-scoped backing
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
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    // The mounted command table lists every one of api.ts's live verbs —
    // not a hand-maintained subset.
    expect(res.stdout).toContain('backlog get');
    expect(res.stdout).toContain('backlog create');
    expect(res.stdout).toContain('backlog query');
  });

  it('--help exits 0 with the identical usage listing', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-'));
    const res = runBin(['--help'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    expect(res.stdout).toContain('backlog get');
  });

  it('BUG-BACKLOG-BATCH-DISCOVERABILITY-001: a per-verb --help surfaces `batch action` as a "see also"', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-batch-hint-'));
    const help = runBin(['backlog', 'create', '--help'], adhdRoot);
    expect(help.status, `stderr:\n${help.stderr}`).toBe(0);
    expect(help.stdout).toContain('batch action');
  });

  it('the batch-action hint does not appear on the bare top-level --help or on `batch action --help` itself', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-batch-hint-neg-'));
    const topHelp = runBin(['--help'], adhdRoot);
    // top-level help already lists `batch action` in the command table itself —
    // assert the SEE-ALSO sentence specifically is absent, not the bare substring.
    expect(topHelp.stdout).not.toContain('See also: `adhd-backlog batch action`');
    const batchHelp = runBin(['batch', 'action', '--help'], adhdRoot);
    expect(batchHelp.stdout).not.toContain('See also: `adhd-backlog batch action`');
  });

  it('BUG-BACKLOG-001: --help and no-args surface the special-cased commands (install-skill/install/serve) that never enter the apigen command table', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-help-special-'));
    const help = runBin(['--help'], adhdRoot);
    expect(
      help.status,
      `stderr:\n${help.stderr}\nstdout:\n${help.stdout}`
    ).toBe(0);
    expect(help.stdout).toContain('Special commands');
    expect(help.stdout).toContain('install-skill');
    expect(help.stdout).toContain('serve');

    const noArgs = runBin([], adhdRoot);
    expect(
      noArgs.status,
      `stderr:\n${noArgs.stderr}\nstdout:\n${noArgs.stdout}`
    ).toBe(0);
    expect(noArgs.stdout).toContain('Special commands');
    expect(noArgs.stdout).toContain('install-skill');
  });

  it('--help and no-args NEVER create the backing store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)', () => {
    // The exact resolved path a real `--help`/no-args invocation would open,
    // computed the same way `runBacklogCli` does (buildBacklogEnv with the
    // identical scope/cwd/adhdRoot triple `runBin`'s spawned process sees via
    // ADHD_BACKLOG_SCOPE=project + cwd=adhdRoot) — never opened directly here.
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-eager-open-'));
    const expectedDbPath = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    }).files.db;
    expect(
      existsSync(expectedDbPath),
      'sanity: no store should exist before the CLI ever runs'
    ).toBe(false);

    const noArgs = runBin([], adhdRoot);
    expect(noArgs.status, `stderr:\n${noArgs.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a bare no-args invocation must not create the store'
    ).toBe(false);

    const help = runBin(['--help'], adhdRoot);
    expect(help.status, `stderr:\n${help.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a --help invocation must not create the store'
    ).toBe(false);

    const unknown = runBin(['totally-bogus-command'], adhdRoot);
    expect(unknown.status).not.toBe(0);
    expect(
      existsSync(expectedDbPath),
      'an unrecognized command must not create the store either — it never reaches a real function'
    ).toBe(false);

    // Sanity check the assertion itself has teeth: a command that DOES reach
    // a real function (`query`, on an empty/nonexistent store) MUST create
    // it — proving `expectedDbPath` is the right path and `existsSync` isn't
    // just trivially false for an unrelated reason.
    const real = runBin(['query', '--input', '{}'], adhdRoot);
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a real dispatched command must still open the store as before'
    ).toBe(true);
  });

  // DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 (re-opened 2026-08-20): the July
  // fix (lazy getCtx) closed `--help`/no-args/unknown-command, but `version`
  // is a REAL `hasCtx` api.ts action — dispatching it through the apigen
  // command table still called `createClient` → `getCtx()` and opened the
  // real backing store (emitting `store_adapter.turso.recursive_cte_probe_failed`
  // + `store_adapter.turso.close_tshm_reset`), even though `version` only
  // reads `package.json`. This test asserts the CLOSED state across
  // telemetry AND DB creation, with a real store command as the positive
  // control so the assertion provably has teeth.
  it('version, --help, no-args, and install-skill --help emit ZERO store-open telemetry records and never create the DB', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-no-store-open-'));
    const soxHome = join(adhdRoot, 'sox-ecosystem');
    const expectedDbPath = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    }).files.db;
    expect(
      existsSync(expectedDbPath),
      'sanity: no store should exist before the CLI ever runs'
    ).toBe(false);

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
      expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
        0
      );
      expect(
        readTelemetryEvents(soxHome),
        `"${label}" must emit zero store-open telemetry records`
      ).toHaveLength(0);
      expect(
        existsSync(expectedDbPath),
        `"${label}" must not create the store`
      ).toBe(false);
    }

    // Negative control / teeth: a real store command MUST emit store-open
    // telemetry records AND create the DB — proving the assertions above are
    // not trivially green because the telemetry sink or DB path never fires.
    const real = runBin(['query', '--input', '{}'], adhdRoot, {
      SOX_ECOSYSTEM_HOME: soxHome,
    });
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a real dispatched command must open the store'
    ).toBe(true);
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
            `All ${allEvents.length} captured event(s): ${JSON.stringify(
              allEvents
            )}. ` +
            `If this is unexpectedly zero, first suspect node_modules/dist drift ` +
            `(stale worktree install vs pnpm-lock.yaml's pinned @adhd/sox-store-adapter) ` +
            `before assuming a source regression.`
    ).toBeGreaterThan(0);
  });

  it('BUG-002: ADHD_BACKLOG_DATABASE_PATH redirects the store the bin opens — the env var wins over the scope-root fallback', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-dbpath-'));
    const redirectDb = join(adhdRoot, 'redirect', 'backlog.db');

    const res = runBin(['query', '--input', '{}'], adhdRoot, {
      ADHD_BACKLOG_DATABASE_PATH: redirectDb,
    });
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );

    // The env-var path is the store the CLI actually opened…
    expect(
      existsSync(redirectDb),
      'the ADHD_BACKLOG_DATABASE_PATH target must be the opened store'
    ).toBe(true);
    // …and the scope-root fallback must NOT have been created (pre-fix, this
    // test went red: the bin opened env.files.db and ignored the env var).
    const fallback = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    }).files.db;
    expect(
      existsSync(fallback),
      'the scope-root fallback must not be created when the env var is set'
    ).toBe(false);
  });

  it('BUG-002 regression guard: with ADHD_BACKLOG_DATABASE_PATH unset, the bin still opens the scope-root fallback as before', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-dbpath-default-'));
    const fallback = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    }).files.db;
    expect(
      existsSync(fallback),
      'sanity: no store should exist before the CLI runs'
    ).toBe(false);

    const res = runBin(['query', '--input', '{}'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    expect(
      existsSync(fallback),
      'unset env var ⇒ the scope-root fallback store is created, exactly as before BUG-002'
    ).toBe(true);
  });

  it('a PLAIN "get --input …" (bare, no manual namespace prefix) resolves — proves runBacklogCli prepends the namespace itself', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-getitem-'));

    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can
    // open it exclusively (identical pattern to server.spec.ts/
    // server.mcp.spec.ts's seeding).
    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const seeded = await seedIssue(
      seedEnv.files.db,
      'PseudoSky/cli-test',
      'via cli',
      'x'
    );

    // Deliberately BARE — no `backlog` prefix typed by the "user" here,
    // exactly like a real `backlog get …` invocation arrives at this
    // process as `process.argv.slice(2)`. The default card projection
    // already includes `uid`/`title`, so no explicit `fields` is needed to
    // assert on either.
    const res = runBin(
      ['get', '--input', JSON.stringify({ uid: seeded.uid })],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(res.stdout.trim()) as {
      ok: boolean;
      data: { uid: string; title: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.uid).toBe(seeded.uid);
    expect(body.data.title).toBe('via cli');
  });

  it('a fully-prefixed "backlog get …" ALSO resolves — proves prefixCommand is idempotent at the real dispatch, not just in the unit test', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-getitem-prefixed-'));

    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const seeded = await seedIssue(
      seedEnv.files.db,
      'PseudoSky/cli-test-prefixed',
      'via cli prefixed',
      'x'
    );

    const res = runBin(
      ['backlog', 'get', '--input', JSON.stringify({ uid: seeded.uid })],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(res.stdout.trim()) as {
      ok: boolean;
      data: { uid: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.uid).toBe(seeded.uid);
  });

  it('a full CLI round trip — "create --input <json>" then "get" — persists across TWO separate process invocations', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-roundtrip-'));
    const project = 'PseudoSky/cli-roundtrip';

    const upsert = runBin(
      [
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      adhdRoot
    );
    expect(
      upsert.status,
      `stderr:\n${upsert.stderr}\nstdout:\n${upsert.stdout}`
    ).toBe(0);

    const createRes = runBin(
      [
        'create',
        '--input',
        JSON.stringify({
          title: 'roundtrip',
          body: 'x',
          project,
          by: 'cli.spec',
        }),
      ],
      adhdRoot
    );
    expect(
      createRes.status,
      `stderr:\n${createRes.stderr}\nstdout:\n${createRes.stdout}`
    ).toBe(0);
    const created = JSON.parse(createRes.stdout.trim()) as {
      ok: boolean;
      data: { uid: string };
    };
    expect(created.ok).toBe(true);
    expect(created.data.uid).toBeTruthy();

    const getRes = runBin(
      ['get', '--input', JSON.stringify({ uid: created.data.uid })],
      adhdRoot
    );
    expect(
      getRes.status,
      `stderr:\n${getRes.stderr}\nstdout:\n${getRes.stdout}`
    ).toBe(0);
    const got = JSON.parse(getRes.stdout.trim()) as {
      ok: boolean;
      data: { uid: string; title: string };
    };
    expect(got.ok).toBe(true);
    expect(got.data.uid).toBe(created.data.uid);
    expect(got.data.title).toBe('roundtrip');
  });

  it('"query" (view:list) returns the seeded item, filtered by project', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-list-'));

    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const seeded = await seedIssue(
      seedEnv.files.db,
      'PseudoSky/cli-list-test',
      'listed via cli',
      'x'
    );

    const res = runBin(
      [
        'query',
        '--input',
        JSON.stringify({ filter: { project: seeded.projectUid } }),
      ],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(res.stdout.trim()) as {
      ok: boolean;
      data: { view: string; items: Array<{ uid: string; title: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.view).toBe('list');
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.uid).toBe(seeded.uid);
    expect(body.data.items[0]?.title).toBe('listed via cli');
  });

  it('an unknown command exits with CLI_EXIT_CODE.not_found (4), never 0', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-unknown-'));
    const res = runBin(['totally-bogus-command'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      4
    );
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
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      2
    );
    const lastLine = res.stderr.trim().split('\n').pop() ?? '';
    const body = JSON.parse(lastLine) as { code: string; message: string };
    expect(body.code).toBe('invalid_argument');
  });

  // `install-skill` is special-cased in `runBacklogCli` BEFORE the apigen
  // package is even built — it needs no store at all, so a real-binary proof
  // matters here specifically to confirm the special-case interception
  // actually fires for the real spawned bin, not just the in-process
  // `installSkill()` unit tests (`install-skill.spec.ts`). Deliberately
  // `--scope project` ONLY — `--scope user` resolves the REAL machine home
  // directory with no override, so it is exercised exclusively via
  // `install-skill.spec.ts`'s `homeOverride`-isolated unit tests, never
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
  // reaching the REAL `createIssue` (`write/create-issue.ts`, via `api.ts`'s
  // `create`) via the REAL `_batch/action` mount, over a real temp-scoped
  // backing store — no mocks.
  it('"batch action --input {operation,items,…}" fans out via the real CLI to real api.ts create, and both items persist independently (BUG-018 / batch-CLI wiring)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-batch-'));
    const project = 'PseudoSky/cli-batch-test';

    const upsert = runBin(
      [
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      adhdRoot
    );
    expect(upsert.status, `stderr:\n${upsert.stderr}`).toBe(0);

    // BUG-APIGEN-CLI-002: a `_batch/<kind>` mount presents to every transport
    // (HTTP, CLI, MCP) as ONE JSON blob — `--input <json>` carries the whole
    // `{operation, items, concurrency, onItemError}` control-plane object,
    // mirroring every other apigen-mounted verb's single-object CLI
    // convention. There is no per-field `--operation`/`--items`/
    // `--concurrency`/`--on-item-error` flag surface (confirmed empirically
    // against the real built bin, and by `apigen-cli`'s own
    // `batch-plugin-cli-live-dispatch.spec.ts`). Each batch item's `input`
    // is the WHOLE `create` request shape (`ICreateIssueInput`), confirmed
    // empirically against the real built bin — batch fans each item straight
    // into the named operation's own input. `duplicateAction: 'force'` on
    // each item bypasses the pre-write similarity scan — these two items'
    // near-empty bodies ("x"/"y") are close enough to trip its dedupe
    // threshold against each other, which would otherwise suppress one of
    // them and defeat the "both items persist independently" assertion
    // below.
    const res = runBin(
      [
        'batch',
        'action',
        '--input',
        JSON.stringify({
          operation: 'backlog/create',
          items: [
            {
              input: {
                title: 'batch one',
                body: 'x',
                project,
                by: 'cli.spec',
                duplicateAction: 'force',
              },
            },
            {
              input: {
                title: 'batch two',
                body: 'y',
                project,
                by: 'cli.spec',
                duplicateAction: 'force',
              },
            },
          ],
          concurrency: 2,
          onItemError: 'continue',
        }),
      ],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );

    // Each batch item's `.value` is the WHOLE outcome envelope the real
    // `create()` returned (`create` reports failure in the envelope rather
    // than throwing, so a business failure still shows up as `status:
    // 'fulfilled'` with `value.ok === false`, confirmed empirically).
    interface BatchItemResult {
      index: number;
      status: 'fulfilled' | 'rejected';
      value?: {
        ok: boolean;
        data?: { item?: { uid: string; title: string }; created: boolean };
      };
      reason?: { message?: string; code?: string };
    }
    const results = JSON.parse(res.stdout.trim()) as BatchItemResult[];
    expect(results).toHaveLength(2);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[0]?.value?.ok).toBe(true);
    expect(results[0]?.value?.data?.created).toBe(true);
    expect(results[0]?.value?.data?.item?.title).toBe('batch one');
    const firstUid = results[0]?.value?.data?.item?.uid;
    expect(firstUid).toBeTruthy();

    expect(results[1]?.status).toBe('fulfilled');
    expect(results[1]?.value?.ok).toBe(true);
    expect(results[1]?.value?.data?.created).toBe(true);
    expect(results[1]?.value?.data?.item?.title).toBe('batch two');
    const secondUid = results[1]?.value?.data?.item?.uid;
    expect(secondUid).toBeTruthy();
    expect(secondUid).not.toBe(firstUid);

    // Follow-up REAL "get" (a separate process invocation, through the
    // ordinary `backlog`-prefixed command path) proves both batch-created
    // items are genuinely persisted in the store — not just echoed back in
    // the batch response.
    const get1 = runBin(
      ['get', '--input', JSON.stringify({ uid: firstUid })],
      adhdRoot
    );
    expect(get1.status, `stderr:\n${get1.stderr}`).toBe(0);
    expect(
      (JSON.parse(get1.stdout.trim()) as { data: { title: string } }).data.title
    ).toBe('batch one');

    const get2 = runBin(
      ['get', '--input', JSON.stringify({ uid: secondUid })],
      adhdRoot
    );
    expect(get2.status, `stderr:\n${get2.stderr}`).toBe(0);
    expect(
      (JSON.parse(get2.stdout.trim()) as { data: { title: string } }).data.title
    ).toBe('batch two');
  });

  it('an "operation" not in this mount\'s batchable set is rejected by the batch handler\'s own validation (proves the CLI mount is bound to the real backlog descriptor, not a stub)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-batch-badop-'));
    const res = runBin(
      [
        'batch',
        'action',
        '--input',
        JSON.stringify({ operation: 'backlog/not-a-real-op', items: [] }),
      ],
      adhdRoot
    );
    expect(
      res.status,
      `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`
    ).not.toBe(0);
    const lastLine = res.stderr.trim().split('\n').pop() ?? '';
    const body = JSON.parse(lastLine) as { code: string; message: string };
    expect(body.code).toBe('invalid_argument');
    expect(body.message).toContain('backlog/not-a-real-op');
  });

  // Task B: `api.ts`'s `version()` export is automatically extracted and
  // exposed as `backlog version` on every transport, with NO server.ts/cli.ts
  // changes needed beyond the export itself — this proves that over the
  // REAL, spawned, dev-built `dist/index.js` bin (the "DEV-BUILT" layout in
  // `server.ts`'s `backlogDistDir()` doc comment), reading the REAL
  // `package.json` at test time so this can never silently drift from it.
  it('"version" reports the REAL, currently-built package.json name/version — dev-dist layout (spawned dist/index.js bin)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-version-'));
    const res = runBin(['version'], adhdRoot);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const parsed = JSON.parse(res.stdout.trim()) as {
      name: string;
      version: string;
    };
    const realPkg = JSON.parse(
      readFileSync(join(HERE, '..', 'package.json'), 'utf8')
    ) as { name: string; version: string };
    expect(parsed).toEqual({ name: realPkg.name, version: realPkg.version });
  });

  it('install-skill --host claude --scope project drops the packaged, currently-built SKILL.md under the given cwd — content-hash matches', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-install-skill-'));
    const res = runBin(
      ['install-skill', '--host', 'claude', '--scope', 'project'],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(res.stdout.trim()) as {
      installed: Array<{ host: string; scope: string; path: string }>;
    };
    expect(body.installed).toHaveLength(1);
    const installedPath = body.installed[0].path;
    // `realpathSync` on both sides — on macOS, `/tmp`-family paths resolve
    // through a `/private` symlink, and the child process's own
    // `process.cwd()` (which `installSkill` uses for `--scope project`)
    // returns the FULLY RESOLVED path, while `adhdRoot` here is the
    // unresolved `mkdtempSync` path passed as `cwd` — a benign platform
    // quirk, not a real divergence (both point at the identical directory).
    expect(realpathSync(installedPath)).toBe(
      join(realpathSync(adhdRoot), '.claude', 'skills', 'backlog', 'SKILL.md')
    );
    expect(existsSync(installedPath)).toBe(true);
    const packagedSkillMd = readFileSync(
      join(HERE, '..', 'skill', 'SKILL.md'),
      'utf8'
    );
    expect(readFileSync(installedPath, 'utf8')).toBe(packagedSkillMd);
    // Never opened a real backlog store for this command (no `.adhd/backlog`
    // data dir created) — proving the special-case truly bypasses
    // `buildBacklogApigenPackage`/`getCtx` entirely, the same property
    // `DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001`'s own test proves for `--help`.
    expect(existsSync(join(adhdRoot, '.adhd', 'backlog'))).toBe(false);
  });

  // close-on-error regression: a command that OPENS the store and then FAILS
  // (`get` on an unknown `uid` → IssueNotFoundError, thrown AFTER ctx/store
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
  // A `uid` that resolves to no live node throws `IssueNotFoundError` (§6.1)
  // — mapped to `item_not_found` (exit 1) AFTER the store has already
  // opened, which is the exact "opens the store, then fails" shape this
  // regression needs. `--help`/`install`/`serve` never open the store and
  // are deliberately NOT used here.
  it('a command that OPENS the store then fails still closes it in the finally (WAL truncated, store reopens cleanly)', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-close-on-error-'));

    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can open
    // it exclusively (identical pattern to the get-item tests above). Seeding
    // at least one issue ensures the schema (and some WAL activity) already
    // exists, so the truncation assertion below is meaningful.
    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const dbPath = seedEnv.files.db;
    const seeded = await seedIssue(
      dbPath,
      'PseudoSky/cli-close-on-error',
      'close on error',
      'x'
    );

    // A uid that does not exist: `IssueNotFoundError` → `item_not_found`
    // (exit 1) AFTER the store opened.
    const res = runBin(
      ['get', '--input', JSON.stringify({ uid: 'sox_issue_does_not_exist' })],
      adhdRoot
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      1
    );

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
      const got = await getIssue(reopened.graph, { uid: seeded.uid });
      expect(got.uid).toBe(seeded.uid);
      expect(got.title).toBe('close on error');
    } finally {
      await closeGraphBacklogStore(reopened);
    }
  });
});

describe('--sandbox / sandbox-path — P5-cli-serve-transport: the CLI must never default straight to the live production store', () => {
  let fakeProdHome: string | undefined;
  let sandboxDirs: string[] = [];

  afterEach(() => {
    if (fakeProdHome) rmSync(fakeProdHome, { recursive: true, force: true });
    fakeProdHome = undefined;
    for (const dir of sandboxDirs)
      rmSync(dir, { recursive: true, force: true });
    sandboxDirs = [];
  });

  /** Spawns the real bin with NO `ADHD_BACKLOG_SCOPE` override — i.e. the
   *  default `global` scope every real, un-flagged invocation actually uses
   *  — with `HOME` redirected to a throwaway dir standing in for "the real
   *  machine's home", so this test can prove `--sandbox` diverts away from
   *  it without ever touching the real `~/.adhd`. */
  function runGlobalScoped(
    args: string[],
    home: string,
    extraEnv: Record<string, string> = {}
  ): SpawnResult {
    const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error) throw new Error(`spawn failed: ${String(result.error)}`);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it('sandbox-path (no --sandbox) reports the real, un-isolated production path — store-free, exits 0', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-sandbox-prodhome-'));
    const res = runGlobalScoped(['sandbox-path'], fakeProdHome);
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    const body = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as {
      sandbox: boolean;
      dbPath: string;
    };
    expect(body.sandbox).toBe(false);
    expect(
      body.dbPath.startsWith(fakeProdHome),
      `expected the real prod path to live under ${fakeProdHome}, got ${body.dbPath}`
    ).toBe(true);
    // Store-free: reporting the path must never actually open/create it.
    expect(existsSync(body.dbPath)).toBe(false);
  });

  it('--sandbox diverts the store away from the (fake) production HOME entirely, and never creates anything under it', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-sandbox-prodhome-'));
    const pathRes = runGlobalScoped(
      ['--sandbox', 'sandbox-path'],
      fakeProdHome
    );
    expect(pathRes.status, `stderr:\n${pathRes.stderr}`).toBe(0);
    const body = JSON.parse(
      pathRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as {
      sandbox: boolean;
      adhdRoot: string;
      dbPath: string;
    };
    expect(body.sandbox).toBe(true);
    expect(
      body.adhdRoot,
      '--sandbox must report where it isolated to'
    ).toBeTruthy();
    sandboxDirs.push(body.adhdRoot);
    expect(
      body.dbPath.startsWith(fakeProdHome),
      `--sandbox must NEVER resolve into the (fake) production HOME — got ${body.dbPath}`
    ).toBe(false);
    expect(
      body.dbPath.startsWith(body.adhdRoot),
      'the sandboxed db path must live under the reported sandbox root'
    ).toBe(true);

    // Drive a REAL write (`create`) under --sandbox, then prove the fake
    // production HOME's `.adhd` tree was never created at all — the
    // strongest possible proof an isolation flag that "looks like isolation
    // but isn't" (advisor's own stated trap) is not what shipped here.
    //
    // `--sandbox` alone mints a FRESH random tmpdir on every invocation
    // (`cli.ts`'s own doc comment: "NOT auto-deleted — a caller may want to
    // re-run further commands against the SAME sandbox by passing
    // ADHD_ROOT=<printed path> explicitly on a later invocation"), so
    // reusing THIS test's own first-call `body.adhdRoot` requires passing
    // that env var explicitly, exactly as the CLI's printed message
    // instructs — BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001 (now fixed in
    // `runBacklogCli`) is what makes this actually take effect. `project`
    // must exist before `create` will accept it (§1/§6.1 — never minted by
    // `create` itself), so this seeds it via a real `upsert-project` call
    // against the SAME reused sandbox first.
    const project = 'PseudoSky/sandbox-test';
    const upsertRes = runGlobalScoped(
      [
        '--sandbox',
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      fakeProdHome,
      { ADHD_ROOT: body.adhdRoot }
    );
    expect(
      upsertRes.status,
      `stderr:\n${upsertRes.stderr}\nstdout:\n${upsertRes.stdout}`
    ).toBe(0);

    const createRes = runGlobalScoped(
      [
        '--sandbox',
        'create',
        '--input',
        JSON.stringify({
          title: 'sandboxed',
          body: 'x',
          project,
          by: 'cli.spec',
          duplicateAction: 'force',
        }),
      ],
      fakeProdHome,
      { ADHD_ROOT: body.adhdRoot }
    );
    expect(
      createRes.status,
      `stderr:\n${createRes.stderr}\nstdout:\n${createRes.stdout}`
    ).toBe(0);
    const created = JSON.parse(
      createRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as { ok: boolean; data: { uid: string } };
    expect(created.ok).toBe(true);

    const prodAdhdDir = join(fakeProdHome, '.adhd');
    expect(
      existsSync(prodAdhdDir),
      `--sandbox wrote into the (fake) production HOME at ${prodAdhdDir} — isolation failed`
    ).toBe(false);
    // And the write really did land in the sandbox: the sandboxed db file exists.
    expect(
      existsSync(body.dbPath),
      'the sandboxed db must actually have been created by the create above'
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `backlog search "<text>" [flags]` — the argv translation onto the mounted
// `query` verb (search-shortcut.ts). Driven through the REAL spawned bin, the
// way a human runs it. The load-bearing assertion is PARITY: `search` must
// produce the byte-identical envelope and exit code the equivalent
// `query --input` produces, because that equivalence is the entire contract —
// a translation that answers differently from the thing it translates to is a
// second implementation, which is exactly what this shortcut exists not to be.
//
// `ADHD_BACKLOG_EMBEDDING_ENABLED=false` pins the FTS fallback branch: the
// machine-wide config now enables embeddings globally, and a fresh sandbox
// store's vector space is EMPTY, so leaving it on would mean paying an ONNX
// model load per spawn to exercise the same `filter.grep` path anyway
// (`compileTextQuery` routes to grep whenever the space is not readable —
// BUG-045). Pinning it makes the branch explicit and the run deterministic.
describe('backlog search — natural-language shortcut (real spawned bin)', () => {
  let adhdRoot: string | undefined;
  const NO_EMBED = { ADHD_BACKLOG_EMBEDDING_ENABLED: 'false' };
  const SEARCH_PROJECT = 'PseudoSky/search-shortcut-test';

  afterEach(() => {
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    adhdRoot = undefined;
  });

  /**
   * Seeds one real item through the real `create` command, returning its
   * `uid`. `upsert-project` is idempotent (a repeat call against an existing
   * project is a no-op merge), so calling it once per seed keeps this
   * helper simple without needing a separate one-time setup step per test.
   */
  function seed(root: string, title: string, body: string): string {
    const upsert = runBin(
      [
        'upsert-project',
        '--input',
        JSON.stringify({ name: SEARCH_PROJECT, by: 'cli.spec' }),
      ],
      root,
      NO_EMBED
    );
    expect(
      upsert.status,
      `project seed failed\nstderr:\n${upsert.stderr}`
    ).toBe(0);

    const res = runBin(
      [
        'create',
        '--input',
        JSON.stringify({
          title,
          body,
          project: SEARCH_PROJECT,
          by: 'cli.spec',
          duplicateAction: 'force',
        }),
      ],
      root,
      NO_EMBED
    );
    expect(
      res.status,
      `seed failed\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`
    ).toBe(0);
    const created = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as {
      ok: boolean;
      data: { uid: string };
    };
    expect(created.ok).toBe(true);
    return created.data.uid;
  }

  /** The last stdout line — the JSON envelope every command prints (BUG-APIGEN-015 shape). */
  function envelope(res: SpawnResult): string {
    return res.stdout.trim().split('\n').pop() ?? '';
  }

  // `text` is now a first-class `IIssueQueryInput` field (query/types.ts),
  // routed to `filter.semantic`/`filter.grep` once, in `queryIssues`
  // (query/query.ts's `resolveTextInput`) — so the positional (non-`--anchor`)
  // form of `search` is reachable end-to-end again.
  it('finds a real seeded item by natural-language text and returns the standard envelope', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-'));
    const uid = seed(
      adhdRoot,
      'Publish gate trips intermittently under machine load',
      'The release publish gate reports a spurious failure.'
    );
    seed(
      adhdRoot,
      'Unrelated: storybook theme tokens drift between builds',
      'Nothing to do with publishing.'
    );

    const res = runBin(
      ['search', 'publish gate', '--limit', '5'],
      adhdRoot,
      NO_EMBED
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(envelope(res)) as {
      ok: boolean;
      data: { view: string; items: { uid: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.view).toBe('list');
    expect(body.data.items.map((i) => i.uid)).toContain(uid);
  });

  it('PARITY: `search "<text>" --limit N --status open` is byte-identical to the equivalent `query --input`', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-parity-'));
    seed(
      adhdRoot,
      'Publish gate trips intermittently under machine load',
      'The release publish gate reports a spurious failure.'
    );
    seed(
      adhdRoot,
      'Second publish gate observation from a different run',
      'Also about the publish gate.'
    );

    const viaShortcut = runBin(
      ['search', 'publish gate', '--limit', '2', '--status', 'open'],
      adhdRoot,
      NO_EMBED
    );
    const viaQuery = runBin(
      [
        'query',
        '--input',
        JSON.stringify({
          limit: 2,
          text: 'publish gate',
          filter: { status: 'open' },
        }),
      ],
      adhdRoot,
      NO_EMBED
    );
    expect(viaShortcut.status, `stderr:\n${viaShortcut.stderr}`).toBe(0);
    expect(viaShortcut.status).toBe(viaQuery.status);
    expect(envelope(viaShortcut)).toBe(envelope(viaQuery));
    // Teeth: the parity assertion is only meaningful if the envelope actually
    // carries results — two identical empty answers would prove nothing.
    const body = JSON.parse(envelope(viaShortcut)) as {
      data: { items: unknown[] };
    };
    expect(body.data.items.length).toBeGreaterThan(0);
  });

  it('PARITY: `--anchor` reaches view:"similar" — identical envelope AND the identical refusal on a store with no embedding backend', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-anchor-'));
    const uid = seed(
      adhdRoot,
      'Anchor seed item for similarity',
      'Body text for the anchor probe.'
    );

    const viaShortcut = runBin(
      ['search', '--anchor', uid, '--limit', '3'],
      adhdRoot,
      NO_EMBED
    );
    const viaQuery = runBin(
      [
        'query',
        '--input',
        JSON.stringify({ limit: 3, view: 'similar', filter: { anchor: uid } }),
      ],
      adhdRoot,
      NO_EMBED
    );
    expect(viaShortcut.status).toBe(viaQuery.status);
    expect(envelope(viaShortcut)).toBe(envelope(viaQuery));
    // Teeth. Unlike the text form, `--anchor` has NO keyword fallback: it is a
    // pure semantic input, so with `ADHD_BACKLOG_EMBEDDING_ENABLED=false` (no
    // vector backend injected at all) BOTH sides must refuse identically —
    // asserting that explicitly is what stops this from being two identical
    // blank answers proving nothing. It also pins the translation's real
    // payload: a shortcut that quietly dropped `--anchor` would produce a
    // plain list, exit 0, and silently pass a bare envelope-equality check.
    // Confirmed empirically against the real built bin: with no embedding
    // backend at all, the refusal is a validation-level `invalid_argument`
    // ("semantic search is not configured for this store"), not the
    // configured-but-empty-vector-space `rag_not_configured` case.
    const body = JSON.parse(envelope(viaShortcut)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('invalid_argument');
    expect(viaShortcut.status).not.toBe(0);
  });

  it('a rejected invocation exits 2 with the invalid_argument envelope on STDERR, and never opens the store', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-reject-'));
    const expectedDbPath = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    }).files.db;
    expect(
      existsSync(expectedDbPath),
      'sanity: no store should exist before the CLI ever runs'
    ).toBe(false);

    const res = runBin(['search', 'x', '--limitt', '5'], adhdRoot, NO_EMBED);
    // CLI_EXIT_CODE['invalid_argument'] — the same code the apigen path uses.
    expect(res.status).toBe(2);
    const err = JSON.parse(res.stderr.trim().split('\n').pop() ?? '{}') as {
      code: string;
      message: string;
    };
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('Unknown option: --limitt');
    expect(
      existsSync(expectedDbPath),
      'a rejected search must be resolved before the store is ever opened'
    ).toBe(false);
  });

  it('`search --help` exits 0, prints usage, and never opens the store', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-help-'));
    const expectedDbPath = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    }).files.db;

    const res = runBin(['search', '--help'], adhdRoot, NO_EMBED);
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain('backlog search');
    expect(res.stdout).toContain('--anchor');
    expect(
      existsSync(expectedDbPath),
      'search --help must not create the store'
    ).toBe(false);
  });

  it('the top-level --help advertises `search` alongside the other special commands', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-advertised-'));
    const help = runBin(['--help'], adhdRoot, NO_EMBED);
    expect(help.status).toBe(0);
    // The distinctive line, not the bare word `search` — which appears in
    // enough unrelated help prose that asserting it could never fail.
    expect(help.stdout).toContain('search "<query>" [flags]');
  });

  it('§6.6 guard: adding `search` did NOT widen the mounted command surface', () => {
    // The whole reason `search` is an argv translation and not an `api.ts`
    // export. A `search` line in the live table means the translation was
    // quietly replaced by an operation.
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-cli-search-surface-'));
    const listing = runBin([], adhdRoot, NO_EMBED);
    expect(listing.status).toBe(0);
    expect(listing.stdout).not.toContain('backlog search');
  });
});
