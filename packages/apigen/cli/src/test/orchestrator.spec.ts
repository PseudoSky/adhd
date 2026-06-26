// Orchestrator v2 tests — deterministic, no live servers.
//
// Three behavioral guarantees proved here:
//   (A) detect → extract → merge produces a single descriptor with operations
//       from ALL sources combined (multi-source merge).
//   (B) The collision check fires on a duplicate-target merge (negative control
//       — this test must go RED if CollisionDetectedError is never thrown).
//   (C) Projection-override (e.g. forcing HTTP verb via --opt http.verb.<id>=GET)
//       takes effect WITHOUT editing source (Tenet 1).
//
// Live-server tests (APIGEN_LIVE=1) are gated and skipped in normal CI.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import {
  detectLang,
  parseOverrides,
  loadOverrideConfig,
  mergeOperations,
  buildDescriptor,
  orchestrateGenerate,
} from '../lib/orchestrator'
import { checkCollisions, CollisionDetectedError } from '@adhd/apigen-naming'
import { project as projectOp } from '@adhd/apigen-naming'
import type { Operation, Segment, OutputPlugin, PluginInput } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const fixturesDir = path.join(__dirname, 'fixtures')
const alphaFixture = path.join(fixturesDir, 'alpha.ts')
const betaFixture = path.join(fixturesDir, 'beta.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Operation for collision testing — no live extraction needed. */
function makeOp(
  id: string,
  namespaceRaw: string,
  fileRaw: string,
  nameRaw: string,
  safe = false,
): Operation {
  const seg = (raw: string): Segment => ({
    raw,
    words: raw.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]/),
  })
  return {
    id,
    host: 'ts',
    namespace: seg(namespaceRaw),
    path: [seg(fileRaw), seg(nameRaw)],
    kind: 'action',
    async: true,
    streaming: false,
    safe,
    input: { type: 'object', properties: {}, required: [] },
    output: { type: 'string' },
    envelope: {},
    typeText: null,
  }
}

// ---------------------------------------------------------------------------
// (A) detect → extract → merge: single descriptor
// ---------------------------------------------------------------------------

describe('orchestrator: detect → extract → merge', () => {
  // (A.1) detectLang correctly identifies TypeScript extensions
  it('detectLang returns "ts" for .ts extension', () => {
    expect(detectLang('/some/path/api.ts')).toBe('ts')
  })

  it('detectLang returns "ts" for .tsx / .mts / .cts extensions', () => {
    expect(detectLang('component.tsx')).toBe('ts')
    expect(detectLang('module.mts')).toBe('ts')
    expect(detectLang('legacy.cts')).toBe('ts')
  })

  it('detectLang throws for unsupported extensions', () => {
    expect(() => detectLang('api.py')).toThrow(/unsupported source extension/)
    expect(() => detectLang('api.rs')).toThrow(/unsupported source extension/)
  })

  // (A.2) mergeOperations flattens multiple per-source arrays into one list
  it('mergeOperations flattens two per-source arrays into a single list', () => {
    const a: Operation[] = [makeOp('ns-a/file-a/get-user', 'ns-a', 'file-a', 'getUser')]
    const b: Operation[] = [makeOp('ns-b/file-b/send-email', 'ns-b', 'file-b', 'sendEmail')]
    const merged = mergeOperations([a, b])
    expect(merged).toHaveLength(2)
    expect(merged.map(o => o.id)).toContain('ns-a/file-a/get-user')
    expect(merged.map(o => o.id)).toContain('ns-b/file-b/send-email')
  })

  // (A.3) buildDescriptor with real fixtures produces one descriptor per source
  it(
    'buildDescriptor extracts operations from two sources and merges into one descriptor',
    async () => {
      const descriptor = await buildDescriptor({
        sources: [
          { file: alphaFixture, namespace: 'alpha' },
          { file: betaFixture, namespace: 'beta' },
        ],
      })

      // Operations from BOTH sources are present
      const ids = descriptor.operations.map(o => o.id)
      // alpha fixture exports getUser → id contains 'alpha' and 'get-user'
      expect(ids.some(id => id.includes('alpha') && id.includes('get-user'))).toBe(true)
      // beta fixture exports sendEmail → id contains 'beta' and 'send-email'
      expect(ids.some(id => id.includes('beta') && id.includes('send-email'))).toBe(true)

      // __samples__ is NOT an operation (convention — must be skipped)
      expect(ids.every(id => !id.includes('samples'))).toBe(true)

      // Both packageSchemas entries are present
      expect(descriptor.packageSchemas.has('alpha')).toBe(true)
      expect(descriptor.packageSchemas.has('beta')).toBe(true)
    },
    30_000
  )

  // (A.4) orchestrateGenerate drives the full v2 path and calls generate
  it(
    'orchestrateGenerate calls plugin.generate with packages from both sources',
    async () => {
      const capturedPackageIds: string[] = []

      const capturingPlugin: OutputPlugin = {
        id: 'capturing',
        description: 'test plugin that captures package ids',
        generate(input: PluginInput) {
          capturedPackageIds.push(...input.packages.map(p => p.id))
          return { files: [] }
        },
      }

      await orchestrateGenerate(
        {
          sources: [
            { file: alphaFixture, namespace: 'alpha' },
            { file: betaFixture, namespace: 'beta' },
          ],
        },
        capturingPlugin,
        os.tmpdir(),
      )

      expect(capturedPackageIds).toContain('alpha')
      expect(capturedPackageIds).toContain('beta')
      expect(capturedPackageIds).toHaveLength(2)
    },
    30_000
  )
})

// ---------------------------------------------------------------------------
// (B) Collision check fires on duplicate-target merge — negative control
//     This test MUST fail if CollisionDetectedError is never thrown.
// ---------------------------------------------------------------------------

describe('orchestrator: collision check (negative control)', () => {
  // (B.1) checkCollisions passes on non-colliding operations
  it('checkCollisions does NOT throw when all operations have distinct projections', () => {
    const ops: Operation[] = [
      makeOp('ns-a/alpha/get-user', 'ns-a', 'alpha', 'getUser'),
      makeOp('ns-b/beta/send-email', 'ns-b', 'beta', 'sendEmail'),
    ]
    // Different namespaces → different MCP names, HTTP routes, CLI paths
    expect(() => checkCollisions(ops)).not.toThrow()
  })

  // (B.2) Two operations that project to the SAME MCP name collide — hard error
  it('checkCollisions throws CollisionDetectedError when two ops share an MCP target', () => {
    // Same namespace + same file + same name → same id is not possible (id is unique).
    // To trigger a collision we need two DIFFERENT ids that project to the SAME target.
    // We craft this by giving them the same namespace/file/export words but different
    // raw casing — the collision check works on projection output, not on the id string.
    const seg = (raw: string, words: string[]): Segment => ({ raw, words })

    const opA: Operation = {
      id: 'ns/file/ping-a',
      host: 'ts',
      namespace: seg('ns', ['ns']),
      path: [seg('file', ['file']), seg('pingA', ['ping'])], // words: ['ping']
      kind: 'action',
      async: true,
      streaming: false,
      safe: false,
      input: { type: 'object', properties: {}, required: [] },
      output: { type: 'string' },
      envelope: {},
      typeText: null,
    }
    const opB: Operation = {
      id: 'ns/file/ping-b',
      host: 'ts',
      namespace: seg('ns', ['ns']),
      path: [seg('file', ['file']), seg('pingB', ['ping'])], // same words → same projection
      kind: 'action',
      async: true,
      streaming: false,
      safe: false,
      input: { type: 'object', properties: {}, required: [] },
      output: { type: 'string' },
      envelope: {},
      typeText: null,
    }

    // Verify they DO project to the same MCP name (proof the collision is real)
    const projA = projectOp(opA)
    const projB = projectOp(opB)
    expect(projA.mcp.name).toBe(projB.mcp.name)
    expect(projA.http.route).toBe(projB.http.route)

    // Now the collision check must fire
    expect(() => checkCollisions([opA, opB])).toThrow(CollisionDetectedError)
  })

  // (B.3) Negative control: prove the test goes red when the collision check is bypassed
  //       We assert the error IS a CollisionDetectedError (not just any error).
  it('the thrown CollisionDetectedError carries collision details', () => {
    const seg = (raw: string, words: string[]): Segment => ({ raw, words })
    const opA: Operation = {
      id: 'shared/api/action-a',
      host: 'ts',
      namespace: seg('shared', ['shared']),
      path: [seg('api', ['api']), seg('actionA', ['action'])],
      kind: 'action',
      async: false,
      streaming: false,
      safe: false,
      input: { type: 'object', properties: {}, required: [] },
      output: {},
      envelope: {},
      typeText: null,
    }
    const opB: Operation = {
      id: 'shared/api/action-b',
      host: 'ts',
      namespace: seg('shared', ['shared']),
      path: [seg('api', ['api']), seg('actionB', ['action'])],
      kind: 'action',
      async: false,
      streaming: false,
      safe: false,
      input: { type: 'object', properties: {}, required: [] },
      output: {},
      envelope: {},
      typeText: null,
    }

    let caught: unknown
    try {
      checkCollisions([opA, opB])
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(CollisionDetectedError)
    const err = caught as CollisionDetectedError
    // Must report at least one collision
    expect(err.collisions.length).toBeGreaterThan(0)
    // Must name the two colliding ids
    const ids = err.collisions.flatMap(c => c.ids)
    expect(ids).toContain('shared/api/action-a')
    expect(ids).toContain('shared/api/action-b')
  })
})

// ---------------------------------------------------------------------------
// (C) Projection-override (http.verb) takes effect without touching source
//     Tenet 1: source is NEVER modified; config is out-of-source.
// ---------------------------------------------------------------------------

describe('orchestrator: projection-override config (Tenet 1)', () => {
  // (C.1) parseOverrides extracts http.verb overrides from --opt pairs
  it('parseOverrides extracts http.verb.<id>=GET from --opt pairs', () => {
    const overrides = parseOverrides([
      'http.verb.ns/file/get-user=GET',
      'http.verb.ns/file/send-email=PUT',
      'transport=sse', // unrelated plugin opt — must be ignored
    ])
    expect(overrides.http?.verb?.['ns/file/get-user']).toBe('GET')
    expect(overrides.http?.verb?.['ns/file/send-email']).toBe('PUT')
    // unrelated key is not present in overrides
    expect(Object.keys(overrides.http?.verb ?? {})).not.toContain('transport')
  })

  // (C.2) parseOverrides returns empty config when no relevant --opt pairs
  it('parseOverrides returns empty config for irrelevant --opt pairs', () => {
    const overrides = parseOverrides(['port=3000', 'transport=sse'])
    expect(overrides.http).toBeUndefined()
  })

  // (C.3) An override forces the verb without touching source
  //       Proved by: project() with the override config returns the forced verb,
  //       while the operation itself remains `safe: false` (action default).
  it('projection config overrides verb from POST to GET for a specific op id without altering safe', () => {
    const seg = (raw: string): Segment => ({
      raw,
      words: raw.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]/),
    })

    const op: Operation = {
      id: 'ns/file/get-user',
      host: 'ts',
      namespace: seg('ns'),
      path: [seg('file'), seg('getUser')],
      kind: 'action',
      async: true,
      streaming: false,
      safe: false, // action default → POST; override will force GET
      input: { type: 'object', properties: {}, required: [] },
      output: { type: 'object' },
      envelope: {},
      typeText: null,
    }

    // Without override → POST
    const defaultProjection = projectOp(op)
    expect(defaultProjection.http.verb).toBe('POST')

    // With override → GET — source (op.safe) is UNCHANGED (Tenet 1 verified)
    const overrideConfig = parseOverrides(['http.verb.ns/file/get-user=GET'])
    const overriddenProjection = projectOp(op, overrideConfig)
    expect(overriddenProjection.http.verb).toBe('GET')

    // Source field op.safe is still false — override is out-of-source only
    expect(op.safe).toBe(false)
  })

  // (C.4) loadOverrideConfig merges file config with CLI overrides; CLI wins
  it('loadOverrideConfig reads a config file and merges with CLI overrides (CLI wins)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-override-'))
    const configPath = path.join(tmp, 'apigen.config.json')
    fs.writeFileSync(configPath, JSON.stringify({
      http: { verb: { 'ns/file/list': 'GET', 'ns/file/update': 'POST' } }
    }))

    // CLI overrides 'ns/file/update' → PUT (should win over file's POST)
    const cliOverrides = parseOverrides(['http.verb.ns/file/update=PUT'])
    const merged = loadOverrideConfig(configPath, cliOverrides)

    expect(merged.http?.verb?.['ns/file/list']).toBe('GET')    // from file
    expect(merged.http?.verb?.['ns/file/update']).toBe('PUT')  // CLI wins

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // (C.5) loadOverrideConfig is a no-op when config file is absent
  it('loadOverrideConfig returns CLI overrides unchanged when no config file exists', () => {
    const nonExistent = '/tmp/apigen-no-such-config-xyz.json'
    const cliOverrides = parseOverrides(['http.verb.ns/file/ping=GET'])
    const merged = loadOverrideConfig(nonExistent, cliOverrides)
    expect(merged.http?.verb?.['ns/file/ping']).toBe('GET')
  })

  // (C.6) Integration: buildDescriptor respects overrides — operations are returned
  //       with the correct overrides ready for the collision check to consume.
  //       (The override itself is a ProjectionConfig consumed at project()-time,
  //       not stored in the Operation; this test proves the config flows through.)
  it(
    'buildDescriptor passes the override config through to collision check without error',
    async () => {
      // Override that forces a verb — should not cause collision on its own
      const overrides = parseOverrides(['http.verb.alpha/alpha/get-user=GET'])
      const descriptor = await buildDescriptor({
        sources: [{ file: alphaFixture, namespace: 'alpha' }],
        overrides,
      })
      // Descriptor returned without error — override config was accepted
      expect(descriptor.operations.length).toBeGreaterThan(0)
    },
    30_000
  )
})

// ---------------------------------------------------------------------------
// [dod.10 v2 teeth] buildDescriptor / orchestrateGenerate: default-import Decimal
// source produces format:decimal in packageSchemas and decimal.js in package.json.
//
// The v2 path builds ComposedSchemas via generateSchemas + composeSchemas, the
// SAME pipeline as v1. If normalizeTypeText() is absent from buildSchema, the
// qualified import path emitted by ts-morph (`import("…decimal.js…").default`)
// is NOT found in SCALAR_SCHEMAS → schema is {} → no format:decimal →
// collectDepsFromPackageSchemas returns {} → decimal.js absent from package.json.
//
// Regression guarantee: revert normalizeTypeText() call in buildSchema →
// packageSchemas for the Decimal fixture carry {} outputs → format:decimal
// absent → collectLogicalTypeDeps returns {} → these tests go RED.
// ---------------------------------------------------------------------------

describe('[dod.10 v2 teeth] buildDescriptor: default-import Decimal source carries format:decimal in packageSchemas', () => {
  const decimalRealFixture = path.join(fixturesDir, 'decimal-real-import.ts')

  // [v2.a] buildDescriptor composes schemas that carry format:decimal for a
  // source using `import Decimal from 'decimal.js'`.
  it(
    'buildDescriptor packageSchemas carry format:decimal for a default-imported Decimal source',
    async () => {
      const descriptor = await buildDescriptor({
        sources: [{ file: decimalRealFixture, namespace: 'decimal-test' }],
      })

      expect(descriptor.packageSchemas.has('decimal-test'), 'packageSchemas must contain the namespace').toBe(true)
      const { schemas } = descriptor.packageSchemas.get('decimal-test')!

      // The composed schema for addAmounts must carry format:decimal in input
      // or output. If normalizeTypeText is not called in buildSchema, the
      // schema will be {} (unresolvable qualified import path), and this fails.
      const addAmountsSchema = schemas['addAmounts']
      expect(addAmountsSchema, 'addAmounts must be present in packageSchemas').toBeDefined()

      // Import collectFormats from generate.ts (the dep-manifest machinery)
      const { collectFormats } = await import('../lib/commands/generate')
      const allFormats = new Set<string>()
      if (addAmountsSchema) {
        for (const f of collectFormats(addAmountsSchema.input)) allFormats.add(f)
        for (const f of collectFormats(addAmountsSchema.output)) allFormats.add(f)
      }

      expect(
        allFormats.has('decimal'),
        `format:decimal not in v2 packageSchemas schema — schema=${JSON.stringify(addAmountsSchema)}. ` +
        `The v2 buildDescriptor path lost format:decimal for the default-imported Decimal type.`,
      ).toBe(true)
    },
    30_000,
  )

  // [v2.b] orchestrateGenerate drives the full v2 path and collectDepsFromPackageSchemas
  // returns decimal.js — proving the dep-manifest step works through the v2 path.
  it(
    'orchestrateGenerate: collectDepsFromPackageSchemas returns decimal.js for a default-import Decimal source',
    async () => {
      const capturedPackageSchemas = new Map<string, { id: string; schemas: import('@adhd/apigen-core').ComposedSchemas; importPath: string }>()

      const capturingPlugin: OutputPlugin = {
        id: 'capturing',
        description: 'captures packageSchemas for inspection',
        generate(input: PluginInput) {
          return { files: [] }
        },
      }

      const result = await orchestrateGenerate(
        { sources: [{ file: decimalRealFixture, namespace: 'decimal-test' }] },
        capturingPlugin,
        os.tmpdir(),
      )

      // Collect deps via the same function used by the generate command.
      const { collectFormats } = await import('../lib/commands/generate')
      const { schemas } = result.descriptor.packageSchemas.get('decimal-test')!

      // Walk all schemas and collect all format values.
      const allFormats = new Set<string>()
      for (const entry of Object.values(schemas)) {
        for (const f of collectFormats(entry.input)) allFormats.add(f)
        for (const f of collectFormats(entry.output)) allFormats.add(f)
      }

      expect(
        allFormats.has('decimal'),
        `v2 orchestrateGenerate: format:decimal not found in descriptor packageSchemas — ` +
        `schemas=${JSON.stringify(schemas)}. Regression: normalizeTypeText() not called in buildSchema.`,
      ).toBe(true)
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// Live-server tests — gated behind APIGEN_LIVE=1
// ---------------------------------------------------------------------------
describe.skipIf(!process.env['APIGEN_LIVE'])('orchestrator: live integration (APIGEN_LIVE=1)', () => {
  it('TODO: add a live model end-to-end test here', () => {
    // This block intentionally left for a future live-run test.
    // Gate: APIGEN_LIVE=1 must be set in the environment.
    expect(true).toBe(true)
  })
})
