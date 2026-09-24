/**
 * cli.spec.ts — SPEC.md §7 DoD clause 3 (CLI variant). Per AGENTS.md
 * "Proving an MCP server works — drive the real tools, never a bypass" (the
 * identical principle applies to a CLI bin: drive the real, BUILT consumer
 * path, never an in-process bypass): every behavioral assertion below SPAWNS
 * the REAL BUILT `dist/index.js` as a genuine child process
 * (`process.execPath dist/index.js <args>`) — exactly how an installed
 * `backlog` bin is invoked — against a fresh, `--namespace sandbox`-isolated
 * store (SPEC.md §5c's real `namespace: 'sandbox'` mechanism), never the
 * real machine's global backlog graph. Mirrors `server.mcp.spec.ts`'s
 * real-subprocess pattern; this project's `test` target already
 * `dependsOn: ["build"]` so `dist/index.js` is always fresh.
 *
 * STATE.md A13: `runBin` previously isolated ONLY the DATA root
 * (`ADHD_BACKLOG_SCOPE=project` + a fresh throwaway `cwd`), never CONFIG
 * resolution — `@adhd/environment`'s `config-resolver.ts` reads all four
 * config layers (system/global/project/local) UNCONDITIONALLY regardless of
 * `activeScope`, so the GLOBAL layer still resolved to this machine's real
 * `~/.adhd/backlog/production/config.yaml` (`embedding.enabled: true`),
 * silently paying a real ~1.2s ONNX/fastembed model load on every spawn.
 * `--namespace sandbox` mints its own `adhdRoot`, resolves under the
 * `sandbox` namespace segment, AND writes a real `config.yaml` there with
 * `embedding.enabled: false` (D8) — `namespace` IS baked into every resolved
 * root (system/global/project) by `@adhd/environment`'s `resolveRoots()`, so
 * the GLOBAL config layer resolves to a namespace-specific path that
 * DELIBERATELY has `embedding.enabled: false` written to it before any
 * command runs, with zero hand-maintained env-var overrides.
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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
// STATE.md A15: every real-spawn-bin test file in this package routes
// through this ONE canonical, correct-by-construction helper — never a
// hand-rolled `spawnSync` wrapper with its own independently-chosen env
// vars (that divergence is the exact, mechanical root cause the embedding
// leak kept recurring under). `runBin`/`runBinRaw` below are re-exports
// (not reimplementations) of this file's own A13/A14-hardened logic, kept
// under their original names so none of this file's ~90 call sites need to
// change. (A6: `mintBacklogSandbox`/`runInBacklogSandbox` were imported
// here too but never called from this file — dead re-exports left over from
// A13-PIVOT's scaffolding, per STATE.md A14's own disclosure; removed.)
import {
  DIST_INDEX,
  runBacklogBin as runBin,
  runBacklogBinRaw as runBinRaw,
  extractMintedSandboxRoot,
  type SpawnResult,
  type SandboxPathBody,
} from './test/helpers/spawn-backlog-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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
    // The mounted surface is EXACTLY api.ts's seventeen exported verbs
    // (`get`, `query`, `priorityMatrix`, `partOfRollup`, `openCurve`,
    // `lookup`, `create`, `update`, `transition`, `claim`, `relate`, `move`,
    // `upsertProject`, `upsertComponent`, `upsertLocation`, `rmLocation`,
    // `delete`) — asserted as an exact count, not a loose lower bound, so a
    // widened action count here is real evidence of scope creep onto api.ts's
    // exported surface (see api.ts's own doc comment on why the exported
    // surface IS the mounted surface).
    expect(actions.length).toBe(17);
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

  // A14 (STATE.md "Perf work — profiler confirms A13 is a NET REGRESSION as
  // landed"): `--namespace sandbox` mints a brand-new `adhdRoot` per
  // invocation, and `BUG-BACKLOG-SANDBOX-IRCACHE-LEAK-001`'s pre-existing,
  // deliberately-unchanged fix keys the apigen extract-stage IR cache to
  // that `adhdRoot` — so a fresh mint on (almost) every one of this
  // describe block's ~18 `it()`s was a guaranteed cold ts-morph/schema-
  // generation re-extraction each time (measured ~7.5-9s cold vs ~0.3-0.5s
  // warm, a ~26x per-invocation difference — see STATE.md for the real
  // flame-graph evidence). Most tests below have NO precondition on the
  // store being empty/nonexistent (they identify their own data by a
  // freshly-generated `uid` or a uniquely-named project, which is real
  // DATA isolation regardless of whether the filesystem ROOT is shared),
  // so they now reuse ONE `sharedRoot` minted once via `beforeAll`, letting
  // the IR cache warm on the first real invocation and stay warm for every
  // subsequent test in this block. The small minority of tests that
  // genuinely assert "this store must not exist yet" (or "this directory
  // must not have been created") keep their own dedicated, fresh
  // `mkdtempSync` root — sharing would make those specific assertions wrong,
  // not just slow.
  let sharedRoot: string;

  beforeAll(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-shared-'));
  });

  afterAll(() => {
    rmSync(sharedRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    adhdRoot = undefined;
  });

  it('no args exits 0 and prints the live, namespace-prefixed command listing', () => {
    const res = runBin([], { ADHD_ROOT: sharedRoot });
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
    const res = runBin(['--help'], { ADHD_ROOT: sharedRoot });
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    expect(res.stdout).toContain('backlog get');
  });

  it('BUG-BACKLOG-BATCH-DISCOVERABILITY-001: a per-verb --help surfaces `batch action` as a "see also"', () => {
    const help = runBin(['backlog', 'create', '--help'], { ADHD_ROOT: sharedRoot });
    expect(help.status, `stderr:\n${help.stderr}`).toBe(0);
    expect(help.stdout).toContain('batch action');
  });

  it('the batch-action hint does not appear on the bare top-level --help or on `batch action --help` itself', () => {
    const topHelp = runBin(['--help'], { ADHD_ROOT: sharedRoot });
    // top-level help already lists `batch action` in the command table itself —
    // assert the SEE-ALSO sentence specifically is absent, not the bare substring.
    expect(topHelp.stdout).not.toContain('See also: `adhd-backlog batch action`');
    const batchHelp = runBin(['batch', 'action', '--help'], { ADHD_ROOT: sharedRoot });
    expect(batchHelp.stdout).not.toContain('See also: `adhd-backlog batch action`');
  });

  it('BUG-BACKLOG-001: --help and no-args surface the special-cased commands (install-skill/install/serve) that never enter the apigen command table', () => {
    const help = runBin(['--help'], { ADHD_ROOT: sharedRoot });
    expect(
      help.status,
      `stderr:\n${help.stderr}\nstdout:\n${help.stdout}`
    ).toBe(0);
    expect(help.stdout).toContain('Special commands');
    expect(help.stdout).toContain('install-skill');
    expect(help.stdout).toContain('serve');

    const noArgs = runBin([], { ADHD_ROOT: sharedRoot });
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
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-eager-open-'));
    const expectedDbPath = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' }).files.db;
    expect(
      existsSync(expectedDbPath),
      'sanity: no store should exist before the CLI ever runs'
    ).toBe(false);

    const noArgs = runBin([], { ADHD_ROOT: adhdRoot });
    expect(noArgs.status, `stderr:\n${noArgs.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a bare no-args invocation must not create the store'
    ).toBe(false);

    const help = runBin(['--help'], { ADHD_ROOT: adhdRoot });
    expect(help.status, `stderr:\n${help.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a --help invocation must not create the store'
    ).toBe(false);

    const unknown = runBin(['totally-bogus-command'], { ADHD_ROOT: adhdRoot });
    expect(unknown.status).not.toBe(0);
    expect(
      existsSync(expectedDbPath),
      'an unrecognized command must not create the store either — it never reaches a real function'
    ).toBe(false);

    // Sanity check the assertion itself has teeth: a command that DOES reach
    // a real function (`query`, on an empty/nonexistent store) MUST create
    // it — proving `expectedDbPath` is the right path and `existsSync` isn't
    // just trivially false for an unrelated reason.
    const real = runBin(['query', '--input', '{}'], { ADHD_ROOT: adhdRoot });
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
  // real backing store, even though `version` only reads `package.json`.
  //
  // NOTE (A13/SPEC.md §5c): this test previously ALSO asserted on
  // telemetry event counts via a caller-supplied `SOX_ECOSYSTEM_HOME`
  // override. That signal is no longer usable now that every spawn in this
  // file forces `--namespace sandbox`: `index.ts`'s bin-entry guard
  // unconditionally redirects the telemetry file sink to its OWN freshly
  // minted, unobservable `backlog-sandbox-logs-*` tmpdir whenever the
  // namespace is `sandbox` (BUG-BACKLOG-SANDBOX-TELEMETRY-001's fix,
  // deliberately unchanged by SPEC.md §5c — see D5's guarantee table), which
  // wins over any `SOX_ECOSYSTEM_HOME` the caller sets. Asserting on
  // telemetry counts here would be vacuous (zero events either way — no
  // teeth) rather than a real signal, so this test now proves store-open
  // exclusively via the load-bearing, already-teeth-bearing `existsSync`
  // assertions below (each with an explicit sanity/negative-control pair —
  // AGENTS.md §7). `BUG-BACKLOG-SANDBOX-TELEMETRY-001` itself keeps its own
  // dedicated re-run in the `--namespace / sandbox-path` describe block
  // below.
  it('version, --help, no-args, and install-skill --help never create the DB (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-no-store-open-'));
    const expectedDbPath = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' }).files.db;
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
      const res = runBin([...args], { ADHD_ROOT: adhdRoot });
      const label = args.length === 0 ? '(no args)' : args.join(' ');
      expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
        0
      );
      expect(
        existsSync(expectedDbPath),
        `"${label}" must not create the store`
      ).toBe(false);
    }

    // Negative control / teeth: a real store command MUST create the DB —
    // proving the assertions above are not trivially green because the DB
    // path never fires.
    const real = runBin(['query', '--input', '{}'], { ADHD_ROOT: adhdRoot });
    expect(real.status, `stderr:\n${real.stderr}`).toBe(0);
    expect(
      existsSync(expectedDbPath),
      'a real dispatched command must open the store'
    ).toBe(true);
  });

  it('BUG-002: ADHD_BACKLOG_DATABASE_PATH redirects the store the bin opens — the env var wins over the scope-root fallback', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-dbpath-'));
    const redirectDb = join(adhdRoot, 'redirect', 'backlog.db');

    const res = runBin(['query', '--input', '{}'], { ADHD_ROOT: adhdRoot, 
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
    const fallback = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' }).files.db;
    expect(
      existsSync(fallback),
      'the scope-root fallback must not be created when the env var is set'
    ).toBe(false);
  });

  it('BUG-002 regression guard: with ADHD_BACKLOG_DATABASE_PATH unset, the bin still opens the scope-root fallback as before', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-dbpath-default-'));
    const fallback = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' }).files.db;
    expect(
      existsSync(fallback),
      'sanity: no store should exist before the CLI runs'
    ).toBe(false);

    const res = runBin(['query', '--input', '{}'], { ADHD_ROOT: adhdRoot });
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    expect(
      existsSync(fallback),
      'unset env var ⇒ the scope-root fallback store is created, exactly as before BUG-002'
    ).toBe(true);
  });

  it('a PLAIN "get --input …" (bare, no manual namespace prefix) resolves — proves runBacklogCli prepends the namespace itself', async () => {
    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can
    // open it exclusively (identical pattern to server.spec.ts/
    // server.mcp.spec.ts's seeding).
    const seedEnv = buildBacklogEnv({ adhdRoot: sharedRoot, namespace: 'sandbox' });
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
      { ADHD_ROOT: sharedRoot }
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
    const seedEnv = buildBacklogEnv({ adhdRoot: sharedRoot, namespace: 'sandbox' });
    seedEnv.ensureDirs();
    const seeded = await seedIssue(
      seedEnv.files.db,
      'PseudoSky/cli-test-prefixed',
      'via cli prefixed',
      'x'
    );

    const res = runBin(
      ['backlog', 'get', '--input', JSON.stringify({ uid: seeded.uid })],
      { ADHD_ROOT: sharedRoot }
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
    const project = 'PseudoSky/cli-roundtrip';

    const upsert = runBin(
      [
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      { ADHD_ROOT: sharedRoot }
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
      { ADHD_ROOT: sharedRoot }
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
      { ADHD_ROOT: sharedRoot }
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
    const seedEnv = buildBacklogEnv({ adhdRoot: sharedRoot, namespace: 'sandbox' });
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
      { ADHD_ROOT: sharedRoot }
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
    const res = runBin(['totally-bogus-command'], { ADHD_ROOT: sharedRoot });
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
    const res = runBin(['get', '--this-flag-does-not-exist', 'x'], { ADHD_ROOT: sharedRoot });
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
    const project = 'PseudoSky/cli-batch-test';

    const upsert = runBin(
      [
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      { ADHD_ROOT: sharedRoot }
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
      { ADHD_ROOT: sharedRoot }
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
      { ADHD_ROOT: sharedRoot }
    );
    expect(get1.status, `stderr:\n${get1.stderr}`).toBe(0);
    expect(
      (JSON.parse(get1.stdout.trim()) as { data: { title: string } }).data.title
    ).toBe('batch one');

    const get2 = runBin(
      ['get', '--input', JSON.stringify({ uid: secondUid })],
      { ADHD_ROOT: sharedRoot }
    );
    expect(get2.status, `stderr:\n${get2.stderr}`).toBe(0);
    expect(
      (JSON.parse(get2.stdout.trim()) as { data: { title: string } }).data.title
    ).toBe('batch two');
  });

  it('an "operation" not in this mount\'s batchable set is rejected by the batch handler\'s own validation (proves the CLI mount is bound to the real backlog descriptor, not a stub)', () => {
    const res = runBin(
      [
        'batch',
        'action',
        '--input',
        JSON.stringify({ operation: 'backlog/not-a-real-op', items: [] }),
      ],
      { ADHD_ROOT: sharedRoot }
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
    const res = runBin(['version'], { ADHD_ROOT: sharedRoot });
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
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-install-skill-'));
    // Explicit `cwd` override (3rd arg): `install-skill --scope project`'s own
    // `--scope` flag (unrelated to backlog's `--namespace`) resolves against
    // the spawned process's real `process.cwd()`, so this test's assertion
    // that the skill lands under `adhdRoot` requires the child to actually
    // run WITH `adhdRoot` as its cwd — `runBin`'s default `cwd: tmpdir()`
    // would otherwise install into an unrelated directory.
    const res = runBin(
      ['install-skill', '--host', 'claude', '--scope', 'project'],
      { ADHD_ROOT: adhdRoot },
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
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-close-on-error-'));

    // Seed real data through a real store BEFORE the CLI subprocess owns the
    // file — then close it so the subprocess's own GraphBacklogStore can open
    // it exclusively (identical pattern to the get-item tests above). Seeding
    // at least one issue ensures the schema (and some WAL activity) already
    // exists, so the truncation assertion below is meaningful.
    const seedEnv = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' });
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
      { ADHD_ROOT: adhdRoot }
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

describe('--namespace / sandbox-path — SPEC.md §5c: the CLI must never default straight to the live production store', () => {
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
   *  machine's home", so this test can prove `--namespace sandbox` diverts
   *  away from it without ever touching the real `~/.adhd`. */
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

  /** The lastEnvelope helper for a raw `errorEnvelope` printed to stdout by
   *  `runBacklogCli`'s own D1/D3 validation short-circuits (never opens the
   *  apigen command table, so this is a plain `console.log`, not stderr). */
  function lastStdoutJson(res: SpawnResult): {
    ok: boolean;
    error?: { code: string; message: string };
  } {
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}');
  }

  it('sandbox-path with no --namespace reports the real, un-isolated "production" path — store-free, exits 0', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-sandbox-prodhome-'));
    const res = runGlobalScoped(['sandbox-path'], fakeProdHome);
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    const body = JSON.parse(
      res.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    expect(body.namespace).toBe('production');
    expect(
      body.dbPath.startsWith(fakeProdHome),
      `expected the real prod path to live under ${fakeProdHome}, got ${body.dbPath}`
    ).toBe(true);
    // Store-free: reporting the path must never actually open/create it.
    expect(existsSync(body.dbPath)).toBe(false);
    // The real, un-isolated production path resolves through this machine's
    // REAL global config.yaml, which (per STATE.md) genuinely has
    // `embedding.enabled: true` today — not asserted here on purpose (that
    // truth belongs to the real machine's config, not this test's fixture,
    // and could legitimately change); the point of this test is store-free +
    // the correct un-isolated path, covered above.
  });

  it('--namespace sandbox diverts the store away from the (fake) production HOME entirely, and never creates anything under it', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-sandbox-prodhome-'));
    const pathRes = runGlobalScoped(
      ['--namespace', 'sandbox', 'sandbox-path'],
      fakeProdHome
    );
    expect(pathRes.status, `stderr:\n${pathRes.stderr}`).toBe(0);
    const body = JSON.parse(
      pathRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    expect(body.namespace).toBe('sandbox');
    expect(
      body.adhdRoot,
      '--namespace sandbox must report where it isolated to'
    ).toBeTruthy();
    const adhdRoot = body.adhdRoot as string;
    sandboxDirs.push(adhdRoot);
    expect(
      body.dbPath.startsWith(fakeProdHome),
      `--namespace sandbox must NEVER resolve into the (fake) production HOME — got ${body.dbPath}`
    ).toBe(false);
    expect(
      body.dbPath.startsWith(adhdRoot),
      'the sandboxed db path must live under the reported sandbox root'
    ).toBe(true);
    // D6: the structural, non-timing proof this store's resolved config
    // genuinely has embeddings off — real spawn, real fake `~/.adhd` on this
    // machine (whose REAL global config has embedding.enabled: true today,
    // per STATE.md), so this only passes if D8's written config.yaml
    // actually wins.
    expect(
      body.embeddingEnabled,
      'D8: a --namespace sandbox invocation must resolve embedding.enabled: false, deliberately, even though this machine\'s real production config has it true'
    ).toBe(false);

    // Drive a REAL write (`create`) under --namespace sandbox, then prove the
    // fake production HOME's `.adhd` tree was never created at all — the
    // strongest possible proof an isolation flag that "looks like isolation
    // but isn't" (advisor's own stated trap) is not what shipped here.
    //
    // `--namespace sandbox` alone mints a FRESH random tmpdir on every
    // invocation (`cli.ts`'s own doc comment: "NOT auto-deleted — a caller
    // may want to re-run further commands against the SAME sandbox by
    // passing ADHD_ROOT=<printed path> explicitly on a later invocation"),
    // so reusing THIS test's own first-call `adhdRoot` requires passing that
    // env var explicitly, exactly as the CLI's printed message instructs —
    // BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001 (now fixed in
    // `runBacklogCli`) is what makes this actually take effect. `project`
    // must exist before `create` will accept it (§1/§6.1 — never minted by
    // `create` itself), so this seeds it via a real `upsert-project` call
    // against the SAME reused sandbox first.
    const project = 'PseudoSky/sandbox-test';
    const upsertRes = runGlobalScoped(
      [
        '--namespace',
        'sandbox',
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      fakeProdHome,
      { ADHD_ROOT: adhdRoot }
    );
    expect(
      upsertRes.status,
      `stderr:\n${upsertRes.stderr}\nstdout:\n${upsertRes.stdout}`
    ).toBe(0);

    const createRes = runGlobalScoped(
      [
        '--namespace',
        'sandbox',
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
      { ADHD_ROOT: adhdRoot }
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
      `--namespace sandbox wrote into the (fake) production HOME at ${prodAdhdDir} — isolation failed`
    ).toBe(false);
    // And the write really did land in the sandbox: the sandboxed db file exists.
    expect(
      existsSync(body.dbPath),
      'the sandboxed db must actually have been created by the create above'
    ).toBe(true);

    // Test plan item 1(d): the wall-clock proof, alongside the structural
    // proof above (never the sole assertion — a slow CI box must not fail a
    // correct build). `sandbox-path` alone should land well inside the ~52ms
    // fast-path band, generously bounded.
    const t0 = Date.now();
    const timingRes = runGlobalScoped(
      ['--namespace', 'sandbox', 'sandbox-path'],
      fakeProdHome,
      { ADHD_ROOT: adhdRoot }
    );
    const elapsedMs = Date.now() - t0;
    expect(timingRes.status, `stderr:\n${timingRes.stderr}`).toBe(0);
    expect(
      elapsedMs,
      `--namespace sandbox sandbox-path took ${elapsedMs}ms — expected the fast (~52ms-class) path, not the ~1213ms embedding-load band`
    ).toBeLessThan(1000);
  });

  // Real-consumer proof: a REAL spawned child process, driven exactly like
  // "diverts..." above, but asserting specifically on the `namespace` field
  // `sandbox-path`'s own JSON payload reports — proving, via the child's own
  // observable behavior (never by reaching into its internals), that
  // `--namespace sandbox` resolved through the explicit `'sandbox'`
  // namespace, never `'test'` (D4: they are separate, non-aliased
  // namespaces) or `'production'`. A stray env var
  // (`ADHD_BACKLOG_LOG_LEVEL`) is set in THIS (parent) test process's own
  // env before spawning, standing in for exactly the kind of leaked ambient
  // state that caused real confusion this session — proving the child
  // process does not somehow inherit its way into resolving the wrong
  // namespace via some other ambient channel.
  it('--namespace sandbox resolves through the explicit "sandbox" namespace in a REAL spawned child, even with an unrelated stray env var leaked into the parent', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-fakeprod-namespace-'));
    const prevStray = process.env['ADHD_BACKLOG_LOG_LEVEL'];
    try {
      process.env['ADHD_BACKLOG_LOG_LEVEL'] = 'debug';
      const res = runGlobalScoped(
        ['--namespace', 'sandbox', 'sandbox-path'],
        fakeProdHome
      );
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
      const body = JSON.parse(
        res.stdout.trim().split('\n').pop() ?? '{}'
      ) as SandboxPathBody;
      sandboxDirs.push(body.adhdRoot as string);
      expect(body.namespace).toBe('sandbox');
      expect(
        body.dbPath.includes(`${sep}backlog${sep}sandbox${sep}`),
        `expected the sandboxed dbPath to resolve under the "sandbox" namespace segment, got ${body.dbPath}`
      ).toBe(true);
      expect(
        body.dbPath.includes(`${sep}backlog${sep}test${sep}`),
        `--namespace sandbox must NEVER resolve under the "test" namespace segment — got ${body.dbPath}`
      ).toBe(false);
      expect(
        body.dbPath.includes(`${sep}backlog${sep}production${sep}`),
        `--namespace sandbox must NEVER resolve under the "production" namespace segment — got ${body.dbPath}`
      ).toBe(false);
    } finally {
      if (prevStray === undefined) delete process.env['ADHD_BACKLOG_LOG_LEVEL'];
      else process.env['ADHD_BACKLOG_LOG_LEVEL'] = prevStray;
    }
  });

  // Closes BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001's exact reported scenario:
  // an ADHD_ROOT already set to a real (non-sandbox) directory in the
  // calling environment BEFORE `--namespace sandbox` runs. Prior to the fix
  // this silently defeated `--sandbox` outright (no banner, exit 0, write
  // landed in that ADHD_ROOT). The existing `looksLikeOwnSandboxDir` guard
  // already covers the ADHD_ROOT-swap half; this test additionally proves
  // the SECOND, independent structural layer this change adds: even a
  // caller-controlled `namespace` this test explicitly does NOT set still
  // resolves to the isolated `'sandbox'` namespace once `--namespace
  // sandbox` is passed, never `'production'` — so the bypass class is
  // closed by TWO independent mechanisms, not one.
  it('BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001: an already-set ADHD_ROOT (not one of this tool\'s own sandbox dirs) no longer silently defeats --namespace sandbox', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-fakeprod-bypass-'));
    // Deliberately NOT prefixed `backlog-sandbox-` — a real, unrelated
    // directory a caller happened to have ADHD_ROOT pointed at, the exact
    // scenario the bug report describes; must NOT be mistaken for one of
    // this tool's own sandbox tmpdirs by `looksLikeOwnSandboxDir`.
    const alreadySetRoot = mkdtempSync(
      join(tmpdir(), 'backlog-caller-preexisting-root-')
    );
    sandboxDirs.push(alreadySetRoot);
    try {
      const res = runGlobalScoped(
        ['--namespace', 'sandbox', 'sandbox-path'],
        fakeProdHome,
        { ADHD_ROOT: alreadySetRoot }
      );
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
      const body = JSON.parse(
        res.stdout.trim().split('\n').pop() ?? '{}'
      ) as SandboxPathBody;
      sandboxDirs.push(body.adhdRoot as string);
      // The pre-existing guard: a freshly-minted sandbox dir, NOT the caller's
      // already-set (non-sandbox) ADHD_ROOT.
      expect(body.adhdRoot).not.toBe(alreadySetRoot);
      expect(
        body.dbPath.startsWith(alreadySetRoot),
        `--namespace sandbox must never resolve into a pre-existing, non-sandbox ADHD_ROOT — got ${body.dbPath}`
      ).toBe(false);
      // The new, independent layer this change adds: namespace is 'sandbox'
      // regardless.
      expect(body.namespace).toBe('sandbox');
    } finally {
      rmSync(alreadySetRoot, { recursive: true, force: true });
    }
  });

  // BUG-BACKLOG-SANDBOX-TELEMETRY-001, re-keyed off `--namespace sandbox`: a
  // real `create` under the sandbox namespace must leave NO `*.jsonl` file
  // under the real (faked-`HOME`-for-the-test)
  // `~/.adhd/sox-ecosystem/backlog/logs`.
  it('BUG-BACKLOG-SANDBOX-TELEMETRY-001: a real create under --namespace sandbox leaves no telemetry file under the (fake) production HOME', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-fakeprod-telemetry-'));
    const pathRes = runGlobalScoped(
      ['--namespace', 'sandbox', 'sandbox-path'],
      fakeProdHome
    );
    expect(pathRes.status, `stderr:\n${pathRes.stderr}`).toBe(0);
    const body = JSON.parse(
      pathRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    sandboxDirs.push(body.adhdRoot as string);

    const project = 'PseudoSky/sandbox-telemetry-test';
    const upsertRes = runGlobalScoped(
      [
        '--namespace',
        'sandbox',
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      fakeProdHome,
      { ADHD_ROOT: body.adhdRoot as string }
    );
    expect(upsertRes.status, `stderr:\n${upsertRes.stderr}`).toBe(0);

    const createRes = runGlobalScoped(
      [
        '--namespace',
        'sandbox',
        'create',
        '--input',
        JSON.stringify({
          title: 'telemetry sandboxed',
          body: 'x',
          project,
          by: 'cli.spec',
          duplicateAction: 'force',
        }),
      ],
      fakeProdHome,
      { ADHD_ROOT: body.adhdRoot as string }
    );
    expect(createRes.status, `stderr:\n${createRes.stderr}`).toBe(0);

    const prodSoxHome = join(fakeProdHome, '.adhd', 'sox-ecosystem');
    const events = readTelemetryEvents(prodSoxHome);
    expect(
      events,
      `--namespace sandbox must never write telemetry under the (fake) production HOME — found events: ${JSON.stringify(events)}`
    ).toHaveLength(0);
  });

  // D8's own negative control — the actual proof that closes the
  // accidental-vs-deliberate gap (test plan item 2). Pre-plants a real
  // `config.yaml` with `embedding.enabled: true` at the exact path D8's own
  // write targets, reuses that SAME sandbox-shaped root via `ADHD_ROOT`, and
  // asserts D8's write genuinely overwrote it.
  it('D8: a stray pre-existing config.yaml with embedding.enabled:true at the sandbox root is overwritten, not left alone', () => {
    // Minted via the SAME naming pattern `looksLikeOwnSandboxDir` checks for
    // — a root created any other way is rejected by that guard (fresh mint),
    // which would make the pre-planted file below unreachable.
    const ownSandboxRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-'));
    sandboxDirs.push(ownSandboxRoot);
    const sandboxConfigDir = join(ownSandboxRoot, 'backlog', 'sandbox');
    mkdirSync(sandboxConfigDir, { recursive: true });
    writeFileSync(
      join(sandboxConfigDir, 'config.yaml'),
      'embedding:\n  enabled: true\n'
    );

    const res = runBinRaw(
      ['--namespace', 'sandbox', 'sandbox-path'],
      tmpdir(),
      { ADHD_ROOT: ownSandboxRoot }
    );
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    const body = JSON.parse(
      res.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    expect(body.adhdRoot).toBe(ownSandboxRoot);
    expect(
      body.embeddingEnabled,
      'D8\'s write must overwrite a stray pre-existing config.yaml — a planted embedding.enabled:true must not survive'
    ).toBe(false);
  });

  // D3: an unrecognized `--namespace` value is rejected BEFORE dispatch, with
  // the same invalid_argument envelope shape every other CLI failure uses.
  it('D3: an unrecognized --namespace value exits 2 with invalid_argument naming all three valid values', () => {
    const res = runBinRaw(['--namespace', 'bogus', 'sandbox-path'], tmpdir());
    expect(res.status).toBe(2);
    const body = lastStdoutJson(res);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('invalid_argument');
    expect(body.error?.message).toContain('"production"');
    expect(body.error?.message).toContain('"test"');
    expect(body.error?.message).toContain('"sandbox"');
  });

  it('D3: a near-miss typo suggests the closest valid --namespace value ("did you mean")', () => {
    const res = runBinRaw(
      ['--namespace', 'sandboxx', 'sandbox-path'],
      tmpdir()
    );
    expect(res.status).toBe(2);
    const body = lastStdoutJson(res);
    expect(body.error?.code).toBe('invalid_argument');
    expect(body.error?.message).toContain('did you mean');
    expect(body.error?.message).toContain('"sandbox"');
  });

  // D6 negative control for D3 itself, per the test plan's item 6: temporarily
  // remove the validation guard and confirm the test above goes RED. This is
  // documented here as a manual verification step (reverting `cli.ts`'s
  // `backlogEnvironmentSpec.namespaces?.includes(...)` check and re-running
  // this file) rather than an automated mutation test — see this task's
  // final report for the manual confirmation.

  // D1: a bare trailing `--namespace` (no value) and `--namespace=` (empty
  // value) both reject with a clear "value is required" message, never
  // silently falling back to the default.
  it('D1: a bare trailing --namespace with no value exits 2 with invalid_argument naming "namespace"', () => {
    const res = runBinRaw(['sandbox-path', '--namespace'], tmpdir());
    expect(res.status).toBe(2);
    const body = lastStdoutJson(res);
    expect(body.error?.code).toBe('invalid_argument');
    expect(body.error?.message).toContain('namespace');
    expect(body.error?.message.toLowerCase()).toContain('required');
  });

  it('D1: --namespace= (empty value) exits 2 with invalid_argument naming "namespace"', () => {
    const res = runBinRaw(['--namespace=', 'sandbox-path'], tmpdir());
    expect(res.status).toBe(2);
    const body = lastStdoutJson(res);
    expect(body.error?.code).toBe('invalid_argument');
    expect(body.error?.message).toContain('namespace');
  });

  // D1: both accepted flag spellings produce the identical effective
  // namespace/dbPath.
  it('D1: --namespace=sandbox produces the identical namespace/dbPath as --namespace sandbox', () => {
    const eq = runBinRaw(['--namespace=sandbox', 'sandbox-path'], tmpdir());
    expect(eq.status, `stderr:\n${eq.stderr}`).toBe(0);
    const eqBody = JSON.parse(
      eq.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    sandboxDirs.push(eqBody.adhdRoot as string);
    expect(eqBody.namespace).toBe('sandbox');
    expect(eqBody.embeddingEnabled).toBe(false);
  });

  // D1: conflicting repeated `--namespace` values are rejected; the SAME
  // value repeated twice is idempotent, not a conflict.
  it('D1: --namespace test --namespace sandbox (conflicting values) exits 2 naming both distinct values', () => {
    const res = runBinRaw(
      ['--namespace', 'test', '--namespace', 'sandbox', 'sandbox-path'],
      tmpdir()
    );
    expect(res.status).toBe(2);
    const body = lastStdoutJson(res);
    expect(body.error?.code).toBe('invalid_argument');
    expect(body.error?.message).toContain('"test"');
    expect(body.error?.message).toContain('"sandbox"');
    // The verb's own argv must never have seen a leaked, un-stripped second
    // `--namespace` token — proven negatively: the cli-output plugin's own
    // generic "unknown option"/flag-table error never fires; only this
    // flag's clean envelope does (asserted above via `error.code`).
  });

  it('D1: --namespace sandbox --namespace sandbox (same value twice) is NOT rejected as conflicting', () => {
    const res = runBinRaw(
      ['--namespace', 'sandbox', '--namespace', 'sandbox', 'sandbox-path'],
      tmpdir()
    );
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    const body = JSON.parse(
      res.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    sandboxDirs.push(body.adhdRoot as string);
    expect(body.namespace).toBe('sandbox');
  });

  // D2/test plan item 4: an EXPLICIT, non-default `--namespace production`
  // still reaches a real store correctly — proving explicit `'production'`
  // is not silently treated differently from the default. Isolated via the
  // same `HOME`-redirect `runGlobalScoped` uses for every other test in this
  // block (never the real machine's `~/.adhd`).
  it('D2: an explicit --namespace production round-trips a real create/get, identically to the omitted-flag default', () => {
    fakeProdHome = mkdtempSync(join(tmpdir(), 'backlog-fakeprod-explicit-prod-'));
    const defaultRes = runGlobalScoped(['sandbox-path'], fakeProdHome);
    expect(defaultRes.status, `stderr:\n${defaultRes.stderr}`).toBe(0);
    const defaultBody = JSON.parse(
      defaultRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;

    const explicitRes = runGlobalScoped(
      ['--namespace', 'production', 'sandbox-path'],
      fakeProdHome
    );
    expect(explicitRes.status, `stderr:\n${explicitRes.stderr}`).toBe(0);
    const explicitBody = JSON.parse(
      explicitRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as SandboxPathBody;
    expect(explicitBody.namespace).toBe('production');
    expect(explicitBody.dbPath).toBe(defaultBody.dbPath);

    const project = 'PseudoSky/explicit-production-test';
    const upsertRes = runGlobalScoped(
      [
        '--namespace',
        'production',
        'upsert-project',
        '--input',
        JSON.stringify({ name: project, by: 'cli.spec' }),
      ],
      fakeProdHome
    );
    expect(upsertRes.status, `stderr:\n${upsertRes.stderr}`).toBe(0);

    const createRes = runGlobalScoped(
      [
        '--namespace',
        'production',
        'create',
        '--input',
        JSON.stringify({
          title: 'explicit production',
          body: 'x',
          project,
          by: 'cli.spec',
          duplicateAction: 'force',
        }),
      ],
      fakeProdHome
    );
    expect(createRes.status, `stderr:\n${createRes.stderr}`).toBe(0);
    const created = JSON.parse(
      createRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as { ok: boolean; data: { uid: string } };
    expect(created.ok).toBe(true);

    const getRes = runGlobalScoped(
      [
        '--namespace',
        'production',
        'get',
        '--input',
        JSON.stringify({ uid: created.data.uid }),
      ],
      fakeProdHome
    );
    expect(getRes.status, `stderr:\n${getRes.stderr}`).toBe(0);
    const got = JSON.parse(
      getRes.stdout.trim().split('\n').pop() ?? '{}'
    ) as { ok: boolean; data: { uid: string; title: string } };
    expect(got.ok).toBe(true);
    expect(got.data.uid).toBe(created.data.uid);
    expect(got.data.title).toBe('explicit production');
  });

  // Test plan item 9: `--namespace sandbox serve` startup — A10's
  // `RunServeCommandOpts`/`StartOpts` threading and D8's config write must
  // both reach the long-lived server lifecycle, not just the one-shot CLI
  // dispatch path. Proven via a real HTTP round trip against the spawned
  // `serve` subprocess's own mounted surface (`/_meta/openapi` for
  // readiness — the real, existing endpoint `server.spec.ts` already
  // establishes; `/backlog/<verb>` POST for the write/read), never a raw
  // file peek and never an invented health endpoint.
  it('--namespace sandbox serve isolates a real create/get round trip away from the (fake) production HOME, over real HTTP', async () => {
    const { spawn } = await import('node:child_process');
    const home = mkdtempSync(join(tmpdir(), 'backlog-fakeprod-serve-'));
    fakeProdHome = home;
    const port = 34000 + Math.floor(Math.random() * 5000);
    const child = spawn(
      process.execPath,
      [
        DIST_INDEX,
        '--namespace',
        'sandbox',
        'serve',
        '--transport',
        'http',
        '--port',
        String(port),
      ],
      { cwd: home, env: { ...process.env, HOME: home } }
    );
    let sandboxRoot: string | undefined;
    let stderrBuf = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      sandboxRoot ??= extractMintedSandboxRoot(stderrBuf);
    });
    try {
      // Bounded readiness poll against the real, existing OpenAPI endpoint —
      // never a bare `sleep`.
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/_meta/openapi`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // server not up yet — keep polling
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(
        ready,
        `serve never became ready on port ${port}; stderr so far:\n${stderrBuf}`
      ).toBe(true);
      expect(
        sandboxRoot,
        `expected --namespace sandbox serve to print its minted sandbox root; stderr:\n${stderrBuf}`
      ).toBeTruthy();
      if (sandboxRoot) sandboxDirs.push(sandboxRoot);

      const project = 'PseudoSky/serve-sandbox-test';
      const upsertRes = await fetch(
        `http://127.0.0.1:${port}/backlog/upsert-project`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: { input: { name: project, by: 'cli.spec' } } }),
        }
      );
      expect(upsertRes.status).toBe(200);

      const createRes = await fetch(`http://127.0.0.1:${port}/backlog/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: {
            input: {
              title: 'serve sandboxed',
              body: 'x',
              project,
              by: 'cli.spec',
              duplicateAction: 'force',
            },
          },
        }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as {
        ok: boolean;
        data: { uid: string };
      };
      expect(created.ok).toBe(true);

      const getRes = await fetch(`http://127.0.0.1:${port}/backlog/get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { input: { uid: created.data.uid } } }),
      });
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as {
        ok: boolean;
        data: { uid: string; title: string };
      };
      expect(got.ok).toBe(true);
      expect(got.data.title).toBe('serve sandboxed');

      // The strongest isolation proof: the fake production HOME's `.adhd`
      // tree was never created by this real write.
      expect(existsSync(join(home, '.adhd'))).toBe(false);
    } finally {
      child.kill('SIGTERM');
    }
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
// `--namespace sandbox` (SPEC.md §5c, D8) writes a real `config.yaml` with
// `embedding.enabled: false` at every sandboxed invocation's resolved root —
// so the FTS fallback branch is pinned WITHOUT any hand-maintained
// `ADHD_BACKLOG_EMBEDDING_ENABLED=false` override (removed entirely below;
// its removal is itself the proof `--namespace sandbox` alone is sufficient,
// per this task's own DoD). A fresh sandbox store's vector space would be
// EMPTY regardless — leaving embeddings on would mean paying an ONNX model
// load per spawn to exercise the same `filter.grep` path anyway
// (`compileTextQuery` routes to grep whenever the space is not readable —
// BUG-045); D8 makes that branch explicit and the run deterministic.
describe('backlog search — natural-language shortcut (real spawned bin)', () => {
  let adhdRoot: string | undefined;
  const SEARCH_PROJECT = 'PseudoSky/search-shortcut-test';

  // A14 — same shared-root rationale as the `runBacklogCli` describe block
  // above: most tests here identify their own seeded items by `uid`, so
  // they share ONE warm-IR-cache root; the two tests that assert "the store
  // must not exist yet" keep their own dedicated fresh mint.
  let sharedRoot: string;

  beforeAll(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-search-shared-'));
  });

  afterAll(() => {
    rmSync(sharedRoot, { recursive: true, force: true });
  });

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
      { ADHD_ROOT: root }
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
      { ADHD_ROOT: root }
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
    const uid = seed(
      sharedRoot,
      'Publish gate trips intermittently under machine load',
      'The release publish gate reports a spurious failure.'
    );
    seed(
      sharedRoot,
      'Unrelated: storybook theme tokens drift between builds',
      'Nothing to do with publishing.'
    );

    const res = runBin(
      ['search', 'publish gate', '--limit', '5'],
      { ADHD_ROOT: sharedRoot }
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
    seed(
      sharedRoot,
      'Publish gate trips intermittently under machine load',
      'The release publish gate reports a spurious failure.'
    );
    seed(
      sharedRoot,
      'Second publish gate observation from a different run',
      'Also about the publish gate.'
    );

    const viaShortcut = runBin(
      ['search', 'publish gate', '--limit', '2', '--status', 'open'],
      { ADHD_ROOT: sharedRoot }
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
      { ADHD_ROOT: sharedRoot }
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
    const uid = seed(
      sharedRoot,
      'Anchor seed item for similarity',
      'Body text for the anchor probe.'
    );

    const viaShortcut = runBin(
      ['search', '--anchor', uid, '--limit', '3'],
      { ADHD_ROOT: sharedRoot }
    );
    const viaQuery = runBin(
      [
        'query',
        '--input',
        JSON.stringify({ limit: 3, view: 'similar', filter: { anchor: uid } }),
      ],
      { ADHD_ROOT: sharedRoot }
    );
    expect(viaShortcut.status).toBe(viaQuery.status);
    expect(envelope(viaShortcut)).toBe(envelope(viaQuery));
    // Teeth. Unlike the text form, `--anchor` has NO keyword fallback: it is a
    // pure semantic input, so with a real sandbox store (D8's written
    // `embedding.enabled: false`, no vector backend injected at all) BOTH
    // sides must refuse identically — asserting that explicitly is what stops
    // this from being two identical blank answers proving nothing. It also
    // pins the translation's real payload: a shortcut that quietly dropped
    // `--anchor` would produce a plain list, exit 0, and silently pass a bare
    // envelope-equality check. Confirmed empirically against the real built
    // bin: with no embedding backend at all, the refusal is a
    // validation-level `invalid_argument` ("semantic search is not
    // configured for this store"), not the configured-but-empty-vector-space
    // `rag_not_configured` case.
    const body = JSON.parse(envelope(viaShortcut)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('invalid_argument');
    expect(viaShortcut.status).not.toBe(0);
  });

  it('a rejected invocation exits 2 with the invalid_argument envelope on STDERR, and never opens the store', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-search-reject-'));
    const expectedDbPath = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' }).files.db;
    expect(
      existsSync(expectedDbPath),
      'sanity: no store should exist before the CLI ever runs'
    ).toBe(false);

    const res = runBin(['search', 'x', '--limitt', '5'], { ADHD_ROOT: adhdRoot });
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
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-cli-search-help-'));
    const expectedDbPath = buildBacklogEnv({ adhdRoot, namespace: 'sandbox' }).files.db;

    const res = runBin(['search', '--help'], { ADHD_ROOT: adhdRoot });
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain('backlog search');
    expect(res.stdout).toContain('--anchor');
    expect(
      existsSync(expectedDbPath),
      'search --help must not create the store'
    ).toBe(false);
  });

  it('the top-level --help advertises `search` alongside the other special commands', () => {
    const help = runBin(['--help'], { ADHD_ROOT: sharedRoot });
    expect(help.status).toBe(0);
    // The distinctive line, not the bare word `search` — which appears in
    // enough unrelated help prose that asserting it could never fail.
    expect(help.stdout).toContain('search "<query>" [flags]');
  });

  it('§6.6 guard: adding `search` did NOT widen the mounted command surface', () => {
    // The whole reason `search` is an argv translation and not an `api.ts`
    // export. A `search` line in the live table means the translation was
    // quietly replaced by an operation.
    const listing = runBin([], { ADHD_ROOT: sharedRoot });
    expect(listing.status).toBe(0);
    expect(listing.stdout).not.toContain('backlog search');
  });
});
