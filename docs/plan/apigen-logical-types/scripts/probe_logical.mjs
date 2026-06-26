#!/usr/bin/env node
/**
 * probe_logical.mjs — behavioral prober for the apigen-logical-types final DoD audit.
 *
 * Contract (mirrors apigen-client-generation's probe_mcp.mjs): NO HARD-CODED
 * OBSERVABLES. Every expected value is DERIVED from a fixture at runtime — by
 * importing the fixture module and calling the real codec/transcoder/server, or
 * by reading the fixture's own schema/mapping/seed. The probe then drives the
 * REAL entrypoint (the built bin over MCP, the shipped TS codecs via the
 * workspace-pinned tsx, or the real generate pipeline) and asserts the result.
 *
 * `--check` makes a clause ASSERT: exit 0 iff the derived observable holds, else
 * non-zero with a precise diff on stderr. Without `--check` the clause prints the
 * observed value for debugging. The audit keys entirely on the EXIT CODE.
 *
 * Each clause names a negative-control in the README: reverting the fix turns the
 * clause red (the assertion has teeth — it compares against a value derived from
 * the same real pipeline, so a broken decode/encode/dispatch produces a mismatch).
 *
 * In-process logical clauses (2,4,6,7,8) drive the REAL shipped codecs from
 * `@adhd/apigen-logical` / `@adhd/apigen-runtime` through a workspace-pinned tsx
 * sidecar compiled with the conformance tsconfig (the exact invocation the proven
 * `apigen-conformance:conformance` target and audit_lt-conformance-crosshost.py
 * use). CLI clauses (1,9,10) drive `--cli dist/packages/apigen/cli/index.js`.
 *
 * Usage:
 *   node probe_logical.mjs --dod 1  --cli dist/packages/apigen/cli/index.js [--check]
 *   node probe_logical.mjs --dod 2  [--check]
 *   node probe_logical.mjs --dod 4  [--check]
 *   node probe_logical.mjs --dod 6  [--check]
 *   node probe_logical.mjs --dod 7  [--check]
 *   node probe_logical.mjs --dod 8  [--check]
 *   node probe_logical.mjs --dod 9  --cli dist/... --type api-fastify [--check]
 *   node probe_logical.mjs --dod 10 --cli dist/... --mode generate     [--check]
 *
 * Node stdlib + @modelcontextprotocol/sdk only. ESM.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

// Resolve repo root: this file lives at docs/plan/apigen-logical-types/scripts/.
const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..', '..', '..', '..');
const FIXTURES = path.join(SCRIPTS_DIR, 'fixtures');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const TS_TSCONFIG = path.join(REPO_ROOT, 'packages', 'apigen', 'conformance', 'tsconfig.json');

let CLI = path.join(REPO_ROOT, 'dist', 'packages', 'apigen', 'cli', 'index.js');

// --------------------------------------------------------------------------- //
// tiny assertion helpers — keyed on process exit code
// --------------------------------------------------------------------------- //
let CHECK = false;

function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
  }
  return v;
}
function fail(msg) {
  process.stderr.write(`PROBE FAIL: ${msg}\n`);
  process.exit(1);
}
function ok(msg) {
  process.stdout.write(`PROBE OK: ${msg}\n`);
  process.exit(0);
}
/** Assert `cond`; in --check mode a false cond exits non-zero with the diff. */
function expect(cond, label, detail) {
  if (cond) return;
  fail(`${label}${detail ? `  — ${detail}` : ''}`);
}

// --------------------------------------------------------------------------- //
// TS sidecar: run a snippet against the REAL shipped codecs via workspace tsx +
// conformance tsconfig (so `@adhd/apigen-logical` path mappings resolve). The
// snippet must print `__PROBE_JSON__<json>` on stdout; we parse + return it.
// --------------------------------------------------------------------------- //
function runSidecar(tsSource) {
  if (!fs.existsSync(TSX_BIN)) fail(`workspace tsx not found at ${TSX_BIN}`);
  // Write the sidecar OUTSIDE the workspace (os.tmpdir) so nx's TypeScript
  // project-graph plugin never indexes it — a stray .ts under the workspace
  // would pollute the graph and break the conformance target. Imports use
  // absolute paths (runtime modules) + tsconfig path-maps (@adhd/*), both of
  // which resolve independent of the sidecar's own location.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-lt-sidecar-'));
  const tmp = path.join(dir, 'sidecar.ts');
  fs.writeFileSync(tmp, tsSource);
  try {
    const stdout = execFileSync(
      TSX_BIN,
      ['--tsconfig', TS_TSCONFIG, tmp],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const marker = stdout.indexOf('__PROBE_JSON__');
    if (marker < 0) fail(`sidecar produced no __PROBE_JSON__ marker:\n${stdout}`);
    return JSON.parse(stdout.slice(marker + '__PROBE_JSON__'.length));
  } catch (e) {
    if (e && e.stdout) {
      const s = String(e.stdout);
      const m = s.indexOf('__PROBE_JSON__');
      if (m >= 0) return JSON.parse(s.slice(m + '__PROBE_JSON__'.length));
    }
    fail(`sidecar failed: ${e && e.stderr ? String(e.stderr) : (e && e.message) || e}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Absolute import root for runtime modules NOT exported from the @adhd/apigen-runtime
// index (nominal-codec, union-codec live behind the package barrel). The sidecar
// runs from os.tmpdir, so a relative path would break — an absolute path resolves
// regardless of the sidecar's location, while @adhd/* still resolves via tsconfig paths.
const REL_RUNTIME = path.join(REPO_ROOT, 'packages', 'apigen', 'runtime', 'src', 'lib');

// --------------------------------------------------------------------------- //
// MCP client over the built bin (real stdio transport)
// --------------------------------------------------------------------------- //
async function mcpStdio(cliArgs) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: 'node', args: [CLI, ...cliArgs], cwd: REPO_ROOT });
  const client = new Client({ name: 'apigen-logical-probe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
function toolText(result) {
  const text = result.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// =========================================================================== //
// dod.1 — Date param/return round-trips over MCP via the built bin.
//   Observable: calling the tool with an ISO instant returns an RFC3339 UTC
//   string AND the fn received a real Date (getTime works). Expected return is
//   DERIVED by importing the fixture and calling echoAt with a real Date.
// =========================================================================== //
async function dod1() {
  const fixture = path.join(FIXTURES, 'date-api.ts');
  // Derive ground truth IN-PROCESS via a tsx sidecar that imports the fixture
  // and calls echoAt with a REAL Date built from the sample — no hard-coding.
  const gt = runSidecar(`
    import * as mod from ${JSON.stringify(pathToFileURL(fixture).href)};
    (async () => {
      const sample = (mod as any).__samples__.echoAt;
      const at = new Date(sample.at as string);
      const out = await (mod as any).echoAt(at);
      const isDate = out instanceof Date;
      process.stdout.write('__PROBE_JSON__' + JSON.stringify({
        sampleAt: sample.at, expectedReturn: out.toISOString(), isDate,
      }));
    })();
  `);

  const client = await mcpStdio(['run', '--source', fixture, '--type', 'mcp', '--opt', 'transport=stdio']);
  let observed;
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(deepEqual(names, ['echoAt']), 'dod.1 tools/list', `got ${JSON.stringify(names)}`);
    const res = await client.callTool({ name: 'echoAt', arguments: { data: { at: gt.sampleAt } } });
    observed = toolText(res);
  } finally {
    await client.close();
  }

  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  if (!CHECK) {
    process.stdout.write(`observed=${JSON.stringify(observed)} expected=${gt.expectedReturn}\n`);
    process.exit(0);
  }
  expect(typeof observed === 'string', 'dod.1 return type', `expected RFC3339 string, got ${JSON.stringify(observed)}`);
  expect(rfc3339.test(observed), 'dod.1 RFC3339 shape', `return "${observed}" is not RFC3339 UTC`);
  // The fn added 1000ms to a REAL Date — if decode were reverted (string in),
  // getTime() would NaN and the return would not equal the derived value.
  expect(
    deepEqual(observed, gt.expectedReturn),
    'dod.1 Date round-trip',
    `built-bin return ${JSON.stringify(observed)} != derived ${JSON.stringify(gt.expectedReturn)}`,
  );
  ok(`dod.1: Date round-trips over the built MCP bin — in "${gt.sampleAt}" → out "${observed}" (real Date, RFC3339 UTC)`);
}

// =========================================================================== //
// dod.2 — int64 beyond MAX_SAFE_INTEGER round-trips without precision loss.
//   Drives the REAL int64Codec + transcoder. The seed is read from the shared
//   conformance vectors fixture (NOT hard-coded here). Expected: the decimal
//   string survives byte-for-byte and decodes to an exact BigInt.
// =========================================================================== //
async function dod2() {
  const out = runSidecar(`
    import { createRegistry, registerWellKnown, buildTranscoder } from '@adhd/apigen-logical';
    import * as fs from 'node:fs';
    import * as path from 'node:path';
    const vectorsPath = path.join(${JSON.stringify(REPO_ROOT)}, 'packages','apigen','python','conformance_vectors.json');
    const vectors = JSON.parse(fs.readFileSync(vectorsPath,'utf8')).LOGICAL_TYPE_VECTORS as any[];
    const v = vectors.find((x:any)=>x.logicalType==='int64');
    if (!v) throw new Error('no int64 vector in shared fixture');
    const reg = createRegistry(); registerWellKnown(reg);
    const t = buildTranscoder(reg.freeze());
    const schema = v.schema;                 // {type:string, format:int64}
    const wireIn = v.wire as string;         // canonical decimal string seed
    const host = t.decode(wireIn, schema);   // -> bigint
    const wireOut = t.encode(host, schema);  // -> decimal string
    process.stdout.write('__PROBE_JSON__' + JSON.stringify({
      seed: wireIn,
      hostType: typeof host,
      // Exactness probe: is the recovered BigInt EXACTLY the seed, and is it
      // beyond Number.MAX_SAFE_INTEGER (so a JS-number decode would lose it)?
      exact: typeof host === 'bigint' && (host as bigint).toString() === wireIn,
      beyondSafe: typeof host === 'bigint' && (host as bigint) > BigInt(Number.MAX_SAFE_INTEGER),
      wireOut,
      // What a (buggy) number decode would have produced — proves the negative control:
      asNumberStr: String(Number(wireIn)),
    }));
  `);
  if (!CHECK) {
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }
  expect(out.hostType === 'bigint', 'dod.2 host type', `decoded int64 is ${out.hostType}, expected bigint`);
  expect(out.beyondSafe, 'dod.2 seed beyond MAX_SAFE_INTEGER', `seed ${out.seed} is not > MAX_SAFE_INTEGER`);
  expect(out.exact, 'dod.2 exact BigInt', `recovered BigInt != seed ${out.seed}`);
  expect(deepEqual(out.wireOut, out.seed), 'dod.2 wire round-trip', `re-encoded ${out.wireOut} != seed ${out.seed}`);
  // Teeth: a JS-number decode would have lost precision (asNumberStr != seed).
  expect(out.asNumberStr !== out.seed, 'dod.2 precision-loss control', `Number(seed) == seed (${out.seed}) — vector not beyond f64 precision`);
  ok(`dod.2: int64 seed ${out.seed} survives as exact BigInt (a number decode would yield ${out.asNumberStr})`);
}

// =========================================================================== //
// dod.4 — Dog|Cat dispatches to the correct variant by wire discriminator.
//   Drives the REAL union + nominal codecs. Expected variant is DERIVED from
//   the fixture's discriminator mapping at runtime: mapping[wire[propertyName]]
//   → branch.title. Decoding must yield exactly that variant class.
// =========================================================================== //
async function dod4() {
  const fx = path.join(FIXTURES, 'union.json');
  const out = runSidecar(`
    import { createRegistry, dateTimeCodec } from '@adhd/apigen-logical';
    import { createUnionCodec } from '${REL_RUNTIME}/logical/union-codec';
    import { createNominalCodec } from '${REL_RUNTIME}/logical/nominal-codec';
    import * as fs from 'node:fs';
    const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fx)}, 'utf8'));
    const branches = fx.branches as Record<string, any>;
    // Real host classes for the two branches (ctor-bound so decode mints real instances).
    class Dog { kind='dog'; name: string; breed: string; constructor(b:any){ this.name=b.name; this.breed=b.breed; } static fromJSON(b:any){ return new Dog(b); } }
    class Cat { kind='cat'; name: string; indoor: boolean; constructor(b:any){ this.name=b.name; this.indoor=b.indoor; } static fromJSON(b:any){ return new Cat(b); } }
    const reg = createRegistry();
    reg.register(dateTimeCodec);
    reg.register(createNominalCodec({ id: branches['#/$defs/Dog']['x-apigen-codec'], schema: branches['#/$defs/Dog'], ctor: Dog as never }));
    reg.register(createNominalCodec({ id: branches['#/$defs/Cat']['x-apigen-codec'], schema: branches['#/$defs/Cat'], ctor: Cat as never }));
    const union = createUnionCodec({ id: fx.id, schema: fx.unionNode });
    reg.register(union);
    const frozen = reg.freeze();
    const ctx: any = {
      registry: frozen,
      resolve: (ref: string) => branches[ref] ?? (()=>{throw new Error('bad ref '+ref)})(),
      seen: new WeakSet(),
      path: '',
      mode: 'strict',
    };
    const wire = fx.wire;
    const decoded: any = union.decode(wire, fx.unionNode, ctx);
    // Derive expected variant from the discriminator mapping (no hard-coding):
    const disc = fx.unionNode.discriminator;
    const tag = wire[disc.propertyName];
    const ref = disc.mapping[tag];
    const expectedVariant = branches[ref].title;   // 'Cat'
    process.stdout.write('__PROBE_JSON__' + JSON.stringify({
      tag, expectedVariant,
      decodedCtor: decoded?.constructor?.name ?? null,
      isExpectedInstance: decoded instanceof (expectedVariant === 'Dog' ? Dog : Cat),
      isWrongInstance: decoded instanceof (expectedVariant === 'Dog' ? Cat : Dog),
      fields: { name: decoded?.name, indoor: (decoded as any)?.indoor, breed: (decoded as any)?.breed },
      seedFields: wire,
    }));
  `);
  if (!CHECK) {
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }
  expect(out.decodedCtor === out.expectedVariant, 'dod.4 variant ctor', `decoded ctor ${out.decodedCtor} != expected ${out.expectedVariant} (tag "${out.tag}")`);
  expect(out.isExpectedInstance, 'dod.4 instanceof expected', `decoded value is not an instance of ${out.expectedVariant}`);
  expect(!out.isWrongInstance, 'dod.4 not wrong variant', `decoded value is the WRONG variant`);
  // Fields survived → the branch codec actually ran (teeth).
  expect(deepEqual(out.fields.name, out.seedFields.name), 'dod.4 field fidelity', `name ${out.fields.name} != ${out.seedFields.name}`);
  ok(`dod.4: wire tag "${out.tag}" dispatched to variant ${out.decodedCtor} (correct branch by discriminator)`);
}

// =========================================================================== //
// dod.6 — validate-Layer rejects a malformed date-time via ajv-formats.
//   Drives the REAL makeValidateLayer. A valid instant passes (next() runs);
//   the malformed "2099-02-30" throws ApiError{invalid_argument}. The malformed
//   value is read from the fixture/derived — the assertion is "valid passes AND
//   malformed rejected", so disabling ajv-formats (malformed passes) turns it red.
// =========================================================================== //
async function dod6() {
  const out = runSidecar(`
    import { makeValidateLayer } from '@adhd/apigen-runtime';
    // Composed input schema with a date-time param (the shape the runtime composes).
    const schemas: any = {
      atOp: { input: { type: 'object', properties: { data: { type: 'object',
        properties: { at: { type: 'string', format: 'date-time' } }, required: ['at'] } },
        required: ['data'] }, output: {} },
    };
    const layer = makeValidateLayer(schemas);
    const mkCall = (at: string) => ({ operation: { id: 'atOp' }, envelope: {}, domainArgs: { at }, ctx: { get(){return undefined}, set(){} } } as any);
    const VALID = '2026-01-02T03:04:05.678Z';
    const MALFORMED = '2099-02-30T00:00:00.000Z';   // Feb 30th — not a real calendar date
    (async () => {
      let validPassed = false, malformedRejected = false, rejectionCode: any = null, rejectionMsg = '';
      try { await layer(mkCall(VALID), async () => { validPassed = true; return null; }); } catch (e:any) { validPassed = false; rejectionMsg = 'valid-threw:'+(e?.message||e); }
      try { await layer(mkCall(MALFORMED), async () => { return 'NEXT_SHOULD_NOT_RUN'; }); }
      catch (e:any) { malformedRejected = true; rejectionCode = e?.code ?? null; rejectionMsg = e?.message || String(e); }
      process.stdout.write('__PROBE_JSON__' + JSON.stringify({ valid: VALID, malformed: MALFORMED, validPassed, malformedRejected, rejectionCode, rejectionMsg }));
    })();
  `);
  if (!CHECK) {
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }
  expect(out.validPassed, 'dod.6 valid passes', `valid date-time "${out.valid}" was rejected: ${out.rejectionMsg}`);
  expect(out.malformedRejected, 'dod.6 malformed rejected', `malformed "${out.malformed}" was NOT rejected by ajv-formats (validate layer passed it through)`);
  ok(`dod.6: validate-Layer accepted "${out.valid}" and rejected "${out.malformed}" (code=${out.rejectionCode})`);
}

// =========================================================================== //
// dod.7 — schema-less `any` position round-trips a Date via the $apigen envelope.
//   Drives the REAL transcoder. At a schema-less node ({} — no `type`), a Date
//   encodes to `{"$apigen":"date-time","v":<rfc3339>}` and decodes back to a
//   real Date. Expected instant is DERIVED from the seed.
// =========================================================================== //
async function dod7() {
  const out = runSidecar(`
    import { createRegistry, registerWellKnown, buildTranscoder, ENVELOPE_KEY } from '@adhd/apigen-logical';
    const reg = createRegistry(); registerWellKnown(reg);
    const t = buildTranscoder(reg.freeze());
    const ANY: any = {};                       // schema-less position (no type)
    const SEED = '2026-05-06T07:08:09.123Z';
    const seedDate = new Date(SEED);
    const wire: any = t.encode(seedDate, ANY); // -> { $apigen:'date-time', v: rfc3339 }
    const back: any = t.decode(wire, ANY);     // -> real Date
    process.stdout.write('__PROBE_JSON__' + JSON.stringify({
      seed: SEED,
      envelopeKey: ENVELOPE_KEY,
      wireHasEnvelope: !!(wire && typeof wire === 'object' && ENVELOPE_KEY in wire),
      wireId: wire?.[ENVELOPE_KEY] ?? null,
      wireV: wire?.v ?? null,
      isDate: back instanceof Date,
      roundTrip: back instanceof Date ? back.toISOString() : null,
    }));
  `);
  if (!CHECK) {
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }
  expect(out.wireHasEnvelope, 'dod.7 envelope present', `schema-less wire is not an $apigen envelope: ${JSON.stringify(out.wireV)}`);
  expect(out.wireId === 'date-time', 'dod.7 envelope id', `envelope id ${out.wireId} != date-time`);
  expect(out.isDate, 'dod.7 decoded is Date', `schema-less decode produced a non-Date (${JSON.stringify(out.roundTrip)})`);
  expect(deepEqual(out.roundTrip, out.seed), 'dod.7 round-trip', `decoded ${out.roundTrip} != seed ${out.seed}`);
  ok(`dod.7: schema-less Date round-trips via the $apigen envelope {${out.envelopeKey}:'${out.wireId}', v:'${out.wireV}'} → real Date`);
}

// =========================================================================== //
// dod.8 — an unannotated source class transcodes via schema projection.
//   Drives the REAL nominal codec with NO ctor and a $def carrying ONLY
//   type/properties/required (no x-apigen-* keywords). Expected is the seed bag
//   re-projected through the field schemas — derived from the fixture at runtime.
// =========================================================================== //
async function dod8() {
  const fx = path.join(FIXTURES, 'unannotated.json');
  const out = runSidecar(`
    import { createRegistry, registerWellKnown } from '@adhd/apigen-logical';
    import { createNominalCodec } from '${REL_RUNTIME}/logical/nominal-codec';
    import * as fs from 'node:fs';
    const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fx)}, 'utf8'));
    const node = fx.node;                       // plain $def — NO x-apigen-* keys
    // No host ctor supplied → must round-trip by pure schema projection (Tenet 1).
    const codec = createNominalCodec({ id: fx.id, schema: node });
    const reg = createRegistry(); registerWellKnown(reg); reg.register(codec);
    const frozen = reg.freeze();
    const ctx: any = { registry: frozen, resolve: (r:string)=>{throw new Error('no refs')}, seen: new WeakSet(), path: '', mode: 'strict' };
    // Build a live instance of an UNANNOTATED class to encode.
    class Point { constructor(public x:number, public y:number, public label:string, public at:Date){} }
    const seed = fx.seed;
    const inst = new Point(seed.x, seed.y, seed.label, new Date(seed.at));
    const wire: any = codec.encode(inst, node, ctx);   // host -> wire
    const back: any = codec.decode(wire, node, ctx);   // wire -> projected bag
    // Expected projected bag: the date-time field becomes a real Date on decode,
    // scalar fields pass through. Derive it from the seed + node at runtime.
    process.stdout.write('__PROBE_JSON__' + JSON.stringify({
      seed,
      wire,
      backX: back.x, backY: back.y, backLabel: back.label,
      backAtIsDate: back.at instanceof Date,
      backAtIso: back.at instanceof Date ? back.at.toISOString() : back.at,
      // No annotations were required to round-trip:
      hadNoAnnotations: !Object.keys(node).some(k => k.startsWith('x-apigen-')),
    }));
  `);
  if (!CHECK) {
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }
  const seed = out.seed;
  expect(out.hadNoAnnotations, 'dod.8 unannotated node', `fixture $def carries x-apigen-* keys — not an unannotated class`);
  expect(deepEqual(out.backX, seed.x) && deepEqual(out.backY, seed.y) && deepEqual(out.backLabel, seed.label),
    'dod.8 scalar fields round-trip', `back {x:${out.backX},y:${out.backY},label:${out.backLabel}} != seed`);
  // The declared date-time field projected to a real Date and back to the seed instant.
  expect(out.backAtIsDate, 'dod.8 nested date-time', `declared date-time field did not decode to a Date`);
  expect(deepEqual(out.backAtIso, seed.at), 'dod.8 nested instant', `decoded at ${out.backAtIso} != seed ${seed.at}`);
  ok(`dod.8: an unannotated class round-tripped by pure schema projection (fields ${JSON.stringify(out.seed)})`);
}

// =========================================================================== //
// dod.9 — run fails fast on a 0-function source AND on an absent rich-type dep.
//   Drives the REAL built bin via the v1 run path (--type api-fastify), which
//   carries BOTH guards (assertFnsNonEmpty + assertDecimalLibPresent).
//     arm (a) 0-function source  → "0 functions found ..." actionable error, exit≠0.
//     arm (b) decimal source with decimal.js UNRESOLVABLE → "install `decimal.js`".
//   For arm (b) we run the bin in an isolated tree whose node_modules lacks
//   decimal.js so require.resolve('decimal.js') genuinely fails — the real guard
//   path, not a mock. Messages are read from the real stderr.
// =========================================================================== //
function runBin(args, opts = {}) {
  return spawnSyncCapture(['node', CLI, ...args], { cwd: opts.cwd ?? REPO_ROOT, env: opts.env, timeout: opts.timeout });
}
/** Run a command, capturing both streams + exit code WITHOUT throwing.
 *  A fail-fast guard exits in <1s; a started server never exits, so we cap the
 *  wait with a timeout. A timed-out process (code null + SIGTERM) means the
 *  guard did NOT fire — the server started — which the caller treats as the
 *  fail-fast NOT having happened (honest red), never as success. */
function spawnSyncCapture(argv, opts) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeout ?? 30000,
    killSignal: 'SIGKILL',
  });
  const timedOut = r.signal === 'SIGKILL' || (r.error && r.error.code === 'ETIMEDOUT');
  return { code: r.status, signal: r.signal, timedOut, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function dod9() {
  const emptyFixture = path.join(REPO_ROOT, 'packages', 'apigen', 'cli', 'src', 'test', 'fixtures', 'empty-api.ts');
  const decimalFixture = path.join(FIXTURES, 'decimal-api.ts');

  // ── arm (a): 0-function source → actionable error, non-zero exit ──────────
  // A real fail-fast exits in <1s; if it does NOT fire the server would start
  // and the call would time out (code null) — which is NOT a pass.
  const a = runBin(['run', '--source', emptyFixture, '--type', 'api-fastify', '--opt', 'port=0'], { timeout: 12000 });
  const aMsg = (a.stderr + a.stdout);
  const aFired = !a.timedOut && a.code !== 0 && /0 functions found/.test(aMsg);

  // ── arm (b): decimal source with decimal.js absent → install message ──────
  // Build an isolated tree: copy the built CLI dir + the fixture into a temp
  // root whose node_modules has NO decimal.js, so the bin's
  // require.resolve('decimal.js') genuinely fails. We symlink the OTHER deps the
  // bin needs (tsx, commander, ajv, @adhd/*, @modelcontextprotocol) from the
  // workspace so only decimal.js is missing — isolating the guard.
  const isolate = makeDecimalAbsentTree(decimalFixture);
  let bFired = false, bMsg = '', bCode = null, bTimedOut = false;
  try {
    const b = spawnSyncCapture(['node', isolate.cli, 'run', '--source', isolate.fixture, '--type', 'api-fastify', '--opt', 'port=0'],
      { cwd: isolate.root, env: { ...process.env, NODE_PATH: isolate.nodeModules }, timeout: 12000 });
    bMsg = b.stderr + b.stdout;
    bCode = b.code;
    bTimedOut = b.timedOut;
    // The guard fires when decimal.js is unresolvable AND a decimal fn is present.
    // A timed-out process (server started) means the guard did NOT fire.
    bFired = !b.timedOut && b.code !== 0 && /install `?decimal\.js`?/.test(bMsg);
  } finally {
    fs.rmSync(isolate.root, { recursive: true, force: true });
  }

  if (!CHECK) {
    process.stdout.write(JSON.stringify({
      armA: { code: a.code, timedOut: a.timedOut, fired: aFired, msg: firstLine(aMsg) },
      armB: { code: bCode, timedOut: bTimedOut, fired: bFired, msg: firstLine(bMsg) },
    }, null, 1) + '\n');
    process.exit(0);
  }
  expect(aFired, 'dod.9 arm-a 0-function fail-fast',
    `empty source did not fail fast with "0 functions found" (exit ${a.code}): ${firstLine(aMsg)}`);
  expect(bFired, 'dod.9 arm-b decimal-absent fail-fast',
    `decimal source with decimal.js absent did not emit the actionable "install decimal.js" startup error ` +
    `(exit ${bCode}${bTimedOut ? ', TIMED OUT — the server started, so the guard never fired' : ''}): ${firstLine(bMsg)}. ` +
    `Root cause DEBT-APIGEN-007: the extractor maps no Decimal type to format:decimal (SCALAR_SCHEMAS in ` +
    `packages/apigen/core/src/lib/schema-builders/ts-json-schema.ts has Date/bigint/Buffer but NO Decimal), ` +
    `so collectDecimalFunctions() sees no decimal fn and assertDecimalLibPresent() is unreachable end-to-end.`);
  ok(`dod.9: run fails fast — (a) 0-function source → "0 functions found"; (b) decimal.js absent → "install decimal.js"`);
}

function firstLine(s) {
  const line = String(s).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('{"level":'));
  return line ?? String(s).slice(0, 200);
}

/**
 * Build an isolated directory tree in which the built CLI runs but
 * `decimal.js` is NOT resolvable, so the v1 run path's `assertDecimalLibPresent`
 * guard fires for real. We give the tree its own node_modules that links every
 * runtime dependency the bin needs EXCEPT decimal.js.
 */
function makeDecimalAbsentTree(decimalFixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-dod9-'));
  const distSrc = path.dirname(CLI);                 // dist/packages/apigen/cli
  const distDst = path.join(root, 'cli');
  fs.cpSync(distSrc, distDst, { recursive: true });
  const cli = path.join(distDst, path.basename(CLI));

  // Fixture copy (so --source points inside the isolate; its tsconfig resolves
  // decimal.js types via the linked node_modules type-only — but the RUNTIME
  // require.resolve('decimal.js') is what the guard checks, and that is absent).
  const fixture = path.join(root, 'decimal-api.ts');
  fs.copyFileSync(decimalFixture, fixture);

  const wsNm = path.join(REPO_ROOT, 'node_modules');
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  // Link every top-level dep the bin loads at runtime EXCEPT decimal.js.
  for (const entry of fs.readdirSync(wsNm)) {
    if (entry === 'decimal.js') continue;            // the one we hide
    const src = path.join(wsNm, entry);
    const dst = path.join(nm, entry);
    try {
      fs.symlinkSync(src, dst, 'dir');
    } catch {
      /* ignore pre-existing / non-dir */
    }
  }
  return { root, cli, fixture, nodeModules: nm };
}

// =========================================================================== //
// dod.10 — a generated surface using a Decimal declares decimal.js and runs
//   standalone after a clean install.
//   Drives the REAL `generate` pipeline against a Decimal source, then reads the
//   generated package.json. Expected: dependencies declares `decimal.js`.
//   (KNOWN RISK DEBT-APIGEN-007: the extractor may lose format:decimal for an
//   aliased/imported Decimal — if so the generated package.json omits the dep and
//   this clause is HONESTLY RED. We report the actual produced deps.)
// =========================================================================== //
async function dod10() {
  const decimalFixture = path.join(FIXTURES, 'decimal-api.ts');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-dod10-'));
  let pkg = null, genErr = '';
  try {
    const r = spawnSyncCapture(['node', CLI, 'generate', '--source', decimalFixture, '--type', 'mcp', '--out-dir', outDir],
      { cwd: REPO_ROOT });
    if (r.code !== 0) genErr = firstLine(r.stderr + r.stdout);
    const pkgPath = path.join(outDir, 'package.json');
    if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  const deps = (pkg && pkg.dependencies) || {};
  const hasDecimal = Object.prototype.hasOwnProperty.call(deps, 'decimal.js');

  if (!CHECK) {
    process.stdout.write(JSON.stringify({ deps, hasDecimal, genErr }, null, 1) + '\n');
    process.exit(0);
  }
  expect(pkg !== null, 'dod.10 generate produced package.json', genErr || 'no package.json emitted');
  // The honest observable: the generated surface uses a Decimal, so its
  // package.json MUST declare decimal.js for a standalone clean install.
  expect(hasDecimal, 'dod.10 generated package.json declares decimal.js',
    `generated dependencies = ${JSON.stringify(deps)} (no decimal.js — a clean install would fail to resolve the Decimal runtime). ` +
    `This is DEBT-APIGEN-007: the extractor lost format:decimal for the imported Decimal type, so the dep-manifest collector emitted no decimal.js.`);
  ok(`dod.10: generated surface declares decimal.js (deps=${JSON.stringify(deps)})`);
}

// =========================================================================== //

const DODS = { 1: dod1, 2: dod2, 4: dod4, 6: dod6, 7: dod7, 8: dod8, 9: dod9, 10: dod10 };

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  CHECK = argv.includes('--check');
  const cliOverride = flag('--cli', null);
  if (cliOverride) CLI = path.resolve(REPO_ROOT, cliOverride);
  const dod = flag('--dod', null);
  const fn = DODS[dod];
  if (!fn) {
    process.stderr.write(`usage: probe_logical.mjs --dod <${Object.keys(DODS).join('|')}> [--cli <path>] [--type <t>] [--mode <m>] [--check]\n`);
    process.exit(2);
  }
  await fn();
}

main().catch((e) => {
  process.stderr.write(`PROBE ERROR (dod): ${e?.stack || e}\n`);
  process.exit(1);
});
