import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  captureGolden,
  assertParity,
} from '@adhd/apigen-engine-runtime/test-support';
import type {
  GoldenFixture,
  GoldenSnapshot,
  ParityDriver,
} from '@adhd/apigen-engine-runtime/test-support';

const execFileAsync = promisify(execFile);

// ───────────────────────────────────────────────────────────────────────────
// REAL-SUBPROCESS integration test — drives the actual `apigen` bin the way a
// consumer does (`apigen run --source <fixture> --type cli -- <command>
// <args>`), per AGENTS.md §7 "drive the real tools": no in-process shortcuts,
// no reaching inside the CLI's modules — a real child process, the real
// built dist, the real orchestrator/extractor/plugin-registry wiring.
//
// Proves the headline capability end-to-end: `--type cli` used to be
// rejected outright by `apigen run` ("Plugin cli does not support run
// mode") — now it dispatches a real command against a real (freshly
// extracted, from real TypeScript source) operation and returns the exact
// JSON a direct in-process call would.
//
// Argv delivery: DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001 (RESOLVED) — `apigen
// run`/`run-registry` now declare a trailing variadic argument
// (`entrypoint/apigen-cli/src/lib/commands/{run,run-registry}.ts`'s
// `.argument('[cliArgs...]')`), so the idiomatic native `-- <command> <args>`
// positional passthrough is accepted by Commander and threaded onto
// `RunInput.options['argv']` as a real `string[]` — see the "native `--`
// passthrough" test below. The original `--opt argv=<command line>` (a
// single shell-tokenized string — see `run.ts`'s `resolveArgv`/
// `tokenizeShellLike`) keeps working unchanged for back-compat (proven by
// every other test in this file, which still use it).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The bundled standalone CLI — spawned as `node <bundle> run …`, mirroring
 * `entrypoint/apigen-cli/src/test/serve.spec.ts`'s own real-subprocess
 * pattern. Build output is in-source ({projectRoot}/dist); walk up from this
 * test file until `entrypoint/apigen-cli/dist/index.js` exists.
 */
const cliPath = (() => {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'entrypoint/apigen-cli/dist/index.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '../../../../../entrypoint/apigen-cli/dist/index.js');
})();

describe('[cli-output.run.live] apigen run --type cli — real subprocess, real built bin', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeFixture(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-cli-run-'));
    const file = path.join(tmpDir, 'index.ts');
    fs.writeFileSync(
      file,
      [
        `export function getItem(id: string, includeArchived?: boolean) {`,
        `  return { id, title: \`Item \${id}\`, includeArchived: includeArchived ?? false };`,
        `}`,
        `export function listItems(tags?: string[]) {`,
        `  return tags ?? ['default'];`,
        `}`,
      ].join('\n')
    );
    return file;
  }

  it(
    'accepts --type cli for run (previously rejected as generate-only) and dispatches a real command',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath} — run "nx build apigen-cli" first`).toBe(true);
      const fixture = writeFixture();

      const { stdout, stderr } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        // §9.1-style extension for the run() argv delivery — see module doc.
        '--opt',
        'argv=fixture index get-item --id 42',
      ]);

      // Real extraction really ran (log line from the real orchestrator).
      expect(stderr).toContain('extracted 2 operations');
      // The plugin's run() printed exactly the direct-call result as JSON —
      // ground truth computed independently, not copy-pasted from the fn.
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '42',
        title: 'Item 42',
        includeArchived: false,
      });
    }
  );

  it(
    'accepts a native `-- <command> <args>` positional passthrough (DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001) — no --opt argv= needed',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath} — run "nx build apigen-cli" first`).toBe(true);
      const fixture = writeFixture();

      const { stdout, stderr } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        '--',
        'fixture',
        'index',
        'get-item',
        '--id',
        '42',
      ]);

      // Real extraction really ran (log line from the real orchestrator).
      expect(stderr).toContain('extracted 2 operations');
      // Ground truth computed independently — same expectation as the
      // --opt argv= variant above, proving the two delivery paths are
      // equivalent end-to-end.
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '42',
        title: 'Item 42',
        includeArchived: false,
      });
    }
  );

  it(
    'native `--` passthrough takes precedence over a stale --opt argv= when both are supplied',
    { timeout: 30000 },
    async () => {
      const fixture = writeFixture();

      const { stdout } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        '--opt',
        // Deliberately WRONG id via the old delivery path — if this won, the
        // result below would be `{ id: '999', ... }` instead.
        'argv=fixture index get-item --id 999',
        '--',
        'fixture',
        'index',
        'get-item',
        '--id',
        '42',
      ]);
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '42',
        title: 'Item 42',
        includeArchived: false,
      });
    }
  );

  it(
    'a validation failure (missing required --id) exits non-zero with the ApiError CLI_EXIT_CODE (2), never crashes',
    { timeout: 30000 },
    async () => {
      expect(fs.existsSync(cliPath)).toBe(true);
      const fixture = writeFixture();

      await expect(
        execFileAsync('node', [
          cliPath,
          'run',
          '--source',
          fixture,
          '--type',
          'cli',
          '--namespace',
          'fixture',
          '--opt',
          'argv=fixture index get-item',
        ])
      ).rejects.toMatchObject({
        code: 2, // CLI_EXIT_CODE.invalid_argument
        stderr: expect.stringContaining('invalid_argument'),
      });
    }
  );

  it(
    'a JSON-typed (array) param round-trips through a real command line',
    { timeout: 30000 },
    async () => {
      const fixture = writeFixture();
      const { stdout } = await execFileAsync('node', [
        cliPath,
        'run',
        '--source',
        fixture,
        '--type',
        'cli',
        '--namespace',
        'fixture',
        '--opt',
        'argv=fixture index list-items --tags ["a","b"]',
      ]);
      expect(JSON.parse(stdout.trim())).toEqual(['a', 'b']);
    }
  );

  it(
    '[contrast] a real generate-only plugin (jsonschema) still cannot run — proves the acceptance is specific to cli, not a global relaxation',
    { timeout: 30000 },
    async () => {
      const fixture = writeFixture();
      await expect(
        execFileAsync('node', [
          cliPath,
          'run',
          '--source',
          fixture,
          '--type',
          'jsonschema',
          '--namespace',
          'fixture',
        ])
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('does not support run mode'),
      });
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// [fastify-parity]-equivalent — cli-adapter TransportAdapter/OpPlan
// golden-snapshot parity gate ([def:parity-gate], docs/plan/apigen-serve-
// core/contexts/_shared.md).
//
// Real-consumer-protocol driver: a REAL spawned `node <harness>` child
// process ([def:real-consumer-protocol] — "CLI → a spawned child process,
// argv in, stdout + exit-code out"), never an in-process function call. The
// harness is a small, self-contained, dependency-free wrapper script that
// `require()`s the REAL BUILT `@adhd/apigen-plugin-cli-output` dist and calls
// `run(input)` — this is the SECOND of cli-output's own two documented real
// usage modes (`run.ts`'s `resolveArgv` doc comment: "a programmatic
// `@adhd/apigen-core-client` consumer (`cliPlugin.run({ options: { argv:
// [...] } })`) should pass directly" / "when this plugin's `run()` IS the
// whole process (a small dedicated wrapper script), the process's argv
// already *is* the command line") — not a test-only bypass.
//
// Why not drive this through the full `apigen run --type cli` pipeline (like
// the tests above)? Two reasons:
//   1. §9.1 envelope binding (`x-apigen-envelope`) has NO real production
//      producer today — `EnvelopeCapability` is declared on the v2 `Plugin`
//      interface (`apigen-core-client/src/lib/plugin.ts`) but is never read
//      by the orchestrator/compose-schemas pipeline (confirmed by grep: zero
//      call sites outside type declarations and hand-built test fixtures).
//      There is today no `--use` plugin that could make a REAL extraction
//      produce a session/envelope-bearing schema. This is a genuine gap —
//      filed as BACKLOG DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001 (see
//      final report). The [cli-adapter.7] F2 env-var-fallback fixture and the
//      session-envelope fixture therefore construct their `ComposedSchemas`
//      by hand (exactly as the pre-existing, protected `run.spec.ts` already
//      does in-process) and drive them through the real `run()` boundary via
//      a spawned process instead.
//   2. Builtin `--use` plugins shipped today (`health`, `logger`, `openapi`)
//      contribute no `layer`/`mount` capability that's minimal enough to
//      assert against deterministically; the dod.11 `--use` capability proof
//      below uses a small inline `UsePlugin` object (duck-typed against
//      `@adhd/apigen-engine-runtime`'s `UsePlugin` shape — no class,
//      no import) instead of pulling in a real plugin package as a new
//      cli-output devDependency.
//
// [dod.9] (`BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001`,
// inv:out-of-scope-bugs): grepped for this bug ID across the entire
// cli-output package (lib/ + test/) — ZERO references. Confirmed by reading
// the bug's actual site: `entrypoint/apigen-cli/src/lib/commands/serve.ts`'s
// front HTTP proxy forwards a client-facing `/<namespace>/<op>` URL verbatim
// to a spawned api-fastify CHILD process assuming a flat single-segment HTTP
// route. `cli-output` has no HTTP routes, no front proxy, and is never a
// `serve` front/child pair — this bug's mechanism (HTTP route double-
// segmenting across a proxy hop) has no CLI-transport analogue, so there is
// no fixture to pin here. Reported explicitly in this state's final report
// rather than fabricating an inapplicable fixture.
// ═══════════════════════════════════════════════════════════════════════════

/** Absolute path to the REAL BUILT cli-output dist — the harness's only import. */
const cliOutputDistPath = path.join(__dirname, '../../dist/index.js');

/** One captured invocation of the harness process. */
interface CliParityOutput {
  stdout: string;
  stderr: string;
  code: number;
}

/** Fixture input: the argv fed to the harness (after its own script path) + optional env overrides. */
interface CliParityInput {
  argv: string[];
  env?: Record<string, string>;
}

/**
 * The harness script content — a dependency-free CommonJS wrapper mirroring
 * cli-output's own documented "small dedicated wrapper script" usage mode.
 * Hardcodes a fixed `RunInput` (packages/operations covering every fixture
 * class below) and calls the REAL `run()` from the built dist with
 * `options.argv` OMITTED so `resolveArgv` falls back to the harness
 * process's own `process.argv.slice(2)` — i.e. the argv this test passes to
 * `node <harness> <argv...>` IS the command line, exactly like a real
 * end-user invocation.
 *
 * `HARNESS_USE_PLUGINS=1` (read from the environment, not argv, so it never
 * collides with a fixture's own flags) additionally registers a minimal,
 * inline `--use` plugin exercising BOTH the `layer` capability (wraps every
 * object result with `_layered: true`) and the `mount` capability (adds a
 * `meta ping` command) — proving dod.11's new cli `--use` support end-to-end
 * without a real external plugin dependency.
 */
function harnessSource(distPath: string): string {
  return `
'use strict';
const { run } = require(${JSON.stringify(distPath)});

// Duck-typed ApiError — cross-realm-safe per @adhd/apigen-base-errors'
// isApiError() doc comment (structural check: name/code/toJSON), so a
// harness-local class is indistinguishable from the "real" one to run.ts.
class FakeApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function seg(raw, words) {
  return { raw, words: words || [raw] };
}
function op(id, nsRaw, nsWords, nameRaw, nameWords, schema, opts) {
  opts = opts || {};
  return {
    id: id,
    host: 'ts',
    namespace: seg(nsRaw, nsWords),
    path: [seg(nameRaw, nameWords)],
    kind: 'action',
    async: false,
    streaming: !!opts.streaming,
    safe: !!(schema['x-apigen-safe']),
    input: schema.input,
    output: schema.output,
    envelope: {},
    typeText: null,
  };
}

// ---------------------------------------------------------------------------
// Fixture domain functions
// ---------------------------------------------------------------------------
function getItem(id, includeArchived) {
  return { id: id, title: 'Item ' + id, includeArchived: includeArchived === undefined ? false : includeArchived };
}
function deleteItem(id) {
  return { deleted: true, id: id };
}
function listItems(tags) {
  return tags === undefined ? ['default'] : tags;
}
function whoAmI() {
  return { ok: true };
}
function boom() {
  throw new FakeApiError('not_found', 'no such thing');
}
function streamNums() {
  throw new Error('streamNums must never be called — a streaming:true op is rejected before dispatch');
}

// ---------------------------------------------------------------------------
// Fixture schemas (ComposedSchemas)
// ---------------------------------------------------------------------------
const schemas = {
  getItem: {
    input: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'string' }, includeArchived: { type: 'boolean' } }, required: ['id'] } }, required: ['data'] },
    output: { type: 'object' },
    'x-apigen-safe': true,
  },
  deleteItem: {
    input: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }, required: ['data'] },
    output: { type: 'object' },
    'x-apigen-safe': false,
  },
  listItems: {
    input: { type: 'object', properties: { data: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: [] } }, required: ['data'] },
    output: { type: 'array' },
    'x-apigen-safe': true,
  },
  whoAmI: {
    input: { type: 'object', properties: { session: { type: 'string' }, data: { type: 'object', properties: {}, required: [] } }, required: ['session', 'data'] },
    output: { type: 'object' },
    'x-apigen-envelope': { session: 'auth' },
    'x-apigen-safe': true,
  },
  boom: {
    input: { type: 'object', properties: { data: { type: 'object', properties: {}, required: [] } }, required: ['data'] },
    output: { type: 'object' },
    'x-apigen-safe': true,
  },
  streamNums: {
    input: { type: 'object', properties: { data: { type: 'object', properties: {}, required: [] } }, required: ['data'] },
    output: {},
    'x-apigen-safe': true,
  },
};

const operations = [
  op('harness/get-item', 'harness', ['harness'], 'getItem', ['get', 'item'], schemas.getItem),
  op('harness/delete-item', 'harness', ['harness'], 'deleteItem', ['delete', 'item'], schemas.deleteItem),
  op('harness/list-items', 'harness', ['harness'], 'listItems', ['list', 'items'], schemas.listItems),
  op('harness/who-am-i', 'harness', ['harness'], 'whoAmI', ['who', 'am', 'i'], schemas.whoAmI),
  op('harness/boom', 'harness', ['harness'], 'boom', ['boom'], schemas.boom),
  op('harness/stream-nums', 'harness', ['harness'], 'streamNums', ['stream', 'nums'], schemas.streamNums, { streaming: true }),
];

const packages = [
  {
    id: 'harness',
    schemas: schemas,
    importPath: '@test/harness',
    fns: { getItem: getItem, deleteItem: deleteItem, listItems: listItems, whoAmI: whoAmI, boom: boom, streamNums: streamNums },
  },
];

// No-op logger (duck-typed against pino's Logger surface run.ts actually
// calls: .info()/.error()) — deterministic stdout/stderr for the golden
// snapshot; a real pino instance would emit non-deterministic
// time/pid/hostname fields on every line.
const silentLogger = { info: function () {}, error: function () {}, warn: function () {}, debug: function () {} };

// dod.11 proof plugin — a minimal, inline UsePlugin (duck-typed, no import)
// exercising BOTH the layer and mount capabilities.
const options = {};
if (process.env.HARNESS_USE_PLUGINS === '1') {
  options.usePlugins = [
    {
      id: 'harness-test-plugin',
      capabilities: {
        layer: {
          layer: async function (call, next) {
            const result = await next();
            if (result && typeof result === 'object') {
              return Object.assign({}, result, { _layered: true });
            }
            return result;
          },
        },
        mount: {
          operations: function () {
            return [
              {
                id: 'meta/ping',
                host: 'ts',
                namespace: seg('meta', ['meta']),
                path: [seg('ping', ['ping'])],
                kind: 'query',
                async: false,
                streaming: false,
                safe: true,
                input: { type: 'object', properties: {}, required: [] },
                output: { type: 'object' },
                envelope: {},
                typeText: null,
                handler: async function () {
                  return { pong: true };
                },
              },
            ];
          },
        },
      },
    },
  ];
}

run({
  packages: packages,
  operations: operations,
  outputDir: '/tmp/out',
  options: options,
  logger: silentLogger,
}).catch(function (err) {
  process.stderr.write('harness crashed: ' + (err && err.stack || err) + '\\n');
  process.exitCode = 1;
});
`;
}

describe('[cli-parity] TransportAdapter/OpPlan golden-snapshot parity gate', () => {
  let harnessPath: string;
  let harnessDir: string;

  beforeAll(() => {
    expect(
      fs.existsSync(cliOutputDistPath),
      `built cli-output dist not found at ${cliOutputDistPath} — run "nx build apigen-plugin-cli-output" first`
    ).toBe(true);
    harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-cli-parity-'));
    harnessPath = path.join(harnessDir, 'harness.cjs');
    fs.writeFileSync(harnessPath, harnessSource(cliOutputDistPath));
  });

  afterAll(() => {
    if (harnessDir && fs.existsSync(harnessDir)) {
      fs.rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  function invokeHarness(input: CliParityInput): Promise<CliParityOutput> {
    return new Promise((resolve) => {
      execFile(
        'node',
        [harnessPath, ...input.argv],
        { env: { ...process.env, ...(input.env ?? {}) }, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) {
            const rawCode = (err as unknown as { code?: unknown }).code;
            code = typeof rawCode === 'number' ? rawCode : 1;
          }
          resolve({ stdout, stderr, code });
        }
      );
    });
  }

  const driver: ParityDriver<CliParityInput, CliParityOutput> = {
    invoke: (fixture) => invokeHarness(fixture.input),
  };

  // The byte-identical fixture set — [cli-adapter.3]/[cli-adapter.4]/
  // [cli-adapter.7]. Covers safe/unsafe dispatch, JSON-typed params, boolean
  // negation, §9.1 session envelope via BOTH flag and env-var fallback (F2),
  // validation failure, a thrown domain ApiError, unknown flag/command, and
  // the full + per-command --help listing text (flag-edge + help path).
  const parityFixtures: ReadonlyArray<GoldenFixture<CliParityInput>> = [
    { name: 'safe-scalar', input: { argv: ['harness', 'get-item', '--id', '42'] } },
    { name: 'unsafe-mutating', input: { argv: ['harness', 'delete-item', '--id', '9'] } },
    { name: 'json-array-param', input: { argv: ['harness', 'list-items', '--tags', '["a","b"]'] } },
    { name: 'boolean-flag-on', input: { argv: ['harness', 'get-item', '--id', '1', '--include-archived'] } },
    { name: 'boolean-flag-negated', input: { argv: ['harness', 'get-item', '--id', '1', '--no-include-archived'] } },
    { name: 'session-envelope-flag', input: { argv: ['harness', 'who-am-i', '--auth-session', 'tok-abc'] } },
    {
      // [cli-adapter.7] F2 — env-var fallback: the flag is OMITTED; OpPlan's
      // cliFlags[...].envVar → parseArgs' env-var fallback must satisfy it.
      name: 'session-envelope-env-fallback',
      input: { argv: ['harness', 'who-am-i'], env: { APIGEN_AUTH_SESSION: 'from-env-golden' } },
    },
    { name: 'validation-failure-missing-required', input: { argv: ['harness', 'get-item'] } },
    { name: 'domain-apierror', input: { argv: ['harness', 'boom'] } },
    { name: 'invalid-json-value', input: { argv: ['harness', 'list-items', '--tags', 'not-json'] } },
    { name: 'unknown-flag', input: { argv: ['harness', 'get-item', '--id', '1', '--bogus'] } },
    { name: 'unknown-command', input: { argv: ['harness', 'nope'] } },
    { name: 'help-listing-empty-argv', input: { argv: [] } },
    { name: 'help-flag', input: { argv: ['--help'] } },
    { name: 'per-command-help', input: { argv: ['harness', 'get-item', '--help'] } },
  ];

  const GOLDEN_PATH = path.join(__dirname, 'golden', 'cli.snapshot.json');

  // [cli-adapter.3]/[cli-adapter.4] — the parity gate itself. Recapture
  // through the (post-migration) adapter-based `run()` and assert
  // deep-equality vs the committed pre-migration golden snapshot. Regenerate
  // the golden with APIGEN_CAPTURE_GOLDEN=1 (mirrors the fastify-adapter
  // convention) — captured ONCE, BEFORE cli-output's `run.ts` migrated onto
  // `TransportAdapter`/`OpPlan`, against the real pre-migration build.
  it('recapture deep-equals the committed golden snapshot', { timeout: 60000 }, async () => {
    const recapture = await captureGolden(driver, parityFixtures);

    if (process.env['APIGEN_CAPTURE_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(recapture, null, 2) + '\n');
      return;
    }

    if (!fs.existsSync(GOLDEN_PATH)) {
      throw new Error(
        `[cli-parity] golden snapshot missing at ${GOLDEN_PATH} — regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.`
      );
    }
    const committed = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenSnapshot<CliParityOutput>;
    assertParity(committed, recapture);
  });

  // [fix:streaming-wired] TEETH — a `streaming:true` op is explicitly
  // REJECTED, never silently `JSON.stringify`'d into `{}`. This is a flagged,
  // reviewed behavior CHANGE from the pre-migration cli-output (which had no
  // streaming awareness at all), so it is NOT part of the byte-identical
  // golden above — proven here directly against the real spawned process.
  it('a streaming:true command is rejected as invalid_argument, the target fn is never called', async () => {
    const { stdout, stderr, code } = await invokeHarness({ argv: ['harness', 'stream-nums'] });
    expect(stdout.trim()).toBe('');
    expect(code).toBe(2); // CLI_EXIT_CODE.invalid_argument
    const body = JSON.parse(stderr.trim().split('\n').pop() as string);
    expect(body.code).toBe('invalid_argument');
    expect(body.message).toContain('streaming');
    // streamNums() throws synchronously if ever invoked (see harness source)
    // — a non-'streaming' failure message / a crash would prove it ran.
  });

  // dod.11 — the `--use` capability decision proof: BOTH `layer` (wraps
  // every dispatch's object result) and `mount` (adds a new dispatchable
  // command) work end-to-end through the real spawned process, for a
  // SOURCE op as well as the newly-mounted one ([fix:mount-through-layers]
  // applied to cli, mirroring the fastify reference adapter).
  describe('[cli-adapter.6] dod.11 — --use layer + mount capability (new)', () => {
    it('a --use layer wraps a SOURCE op\'s result', async () => {
      const { stdout, code } = await invokeHarness({
        argv: ['harness', 'get-item', '--id', '7'],
        env: { HARNESS_USE_PLUGINS: '1' },
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        id: '7',
        title: 'Item 7',
        includeArchived: false,
        _layered: true,
      });
    });

    it('a --use mount op ("meta ping") is a real dispatchable command, ALSO wrapped by the layer', async () => {
      const { stdout, code } = await invokeHarness({
        argv: ['meta', 'ping'],
        env: { HARNESS_USE_PLUGINS: '1' },
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ pong: true, _layered: true });
    });

    it('[negative control] the mount command does NOT exist without --use loaded', async () => {
      const { code, stderr } = await invokeHarness({ argv: ['meta', 'ping'] });
      expect(code).toBe(4); // CLI_EXIT_CODE.not_found
      expect(JSON.parse(stderr.trim().split('\n').pop() as string).code).toBe('not_found');
    });
  });
});
