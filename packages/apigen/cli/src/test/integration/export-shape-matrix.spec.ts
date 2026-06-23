// Export-shape matrix — proves F28/F29 closed (dod.9).
//
// Drives the REAL v2 extractor (`@adhd/apigen-core`'s `extract`) over one fixture
// per export shape and asserts that EVERY operation is named by its EXPORTED
// symbol — never the local declaration name. The per-transport projections
// (`@adhd/apigen-naming`'s `project`) are derived from the same operations, so
// the MCP tool name / HTTP route / CLI path all track the exported symbol too.
//
// Teeth (CLAUDE.md §6): the `renamed` / `default-object` / `cjs` rows have a
// DECLARATION name that differs from the EXPORTED name. If the extractor
// regresses to naming-by-declaration-symbol (the F28/F29 bug), those rows stop
// matching the exported names and these assertions go red. The assertions key on
// the leaf segment's `raw` (the exported symbol spelling) AND the projected
// names, so a silent drift in either layer fails the test.
//
// Determinism: pure in-process extraction — no servers, no timers, no sleeps.

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { extract } from '@adhd/apigen-core'
import { project } from '@adhd/apigen-naming'
import type { Operation } from '@adhd/apigen-core'

const shapesDir = path.join(__dirname, '..', 'fixtures', 'shapes')

/** The leaf (export) segment's raw spelling — the exported symbol name. */
function leafName(op: Operation): string {
  return op.path[op.path.length - 1].raw
}

/** Extract a fixture under the shared `shapes` namespace. */
async function extractShape(file: string): Promise<Operation[]> {
  return extract({ sourceFile: path.join(shapesDir, file), namespace: 'shapes' })
}

describe('export-shape matrix — every shape names ops by EXPORTED symbol (F28/F29)', () => {
  // ── Shape 1 & 2: named function + named arrow/const ────────────────────────
  it('named exports: op leaf name == exported declaration name', async () => {
    const ops = await extractShape('named.ts')
    const names = ops.map(leafName).sort()
    expect(names).toEqual(['getUser', 'listUsers'])
    // __samples__ is never an op.
    expect(names).not.toContain('__samples__')
  })

  // ── Shape 1b: renamed export `export { local as exported }` ────────────────
  // The F28/F29 regression row. DECLARATION names are `internalGet`/`internalList`;
  // EXPORTED symbols are `fetchUser`/`fetchAll`. The op MUST be named by the
  // exported symbol. A regression to declaration-naming yields `internalGet`/
  // `internalList` → this assertion goes red (negative control).
  it('renamed exports: op leaf name == EXPORTED alias, never the local declaration name', async () => {
    const ops = await extractShape('renamed.ts')
    const names = ops.map(leafName).sort()
    expect(names).toEqual(['fetchAll', 'fetchUser'])
    // Teeth: the local declaration names must NOT leak through.
    expect(names).not.toContain('internalGet')
    expect(names).not.toContain('internalList')

    // The MCP name + HTTP route + CLI path all track the exported symbol.
    const fetchUser = ops.find((o) => leafName(o) === 'fetchUser')!
    const proj = project(fetchUser)
    expect(proj.mcp.name).toBe('shapes_renamed_fetch_user')
    expect(proj.http.route).toBe('/shapes/renamed/fetch-user')
    expect(proj.cli.path).toEqual(['shapes', 'renamed', 'fetch-user'])
    // Never the declaration spelling.
    expect(proj.mcp.name).not.toContain('internal')
    expect(proj.http.route).not.toContain('internal')
  })

  // ── Shape 4: default-exported NAMED function ───────────────────────────────
  it('default-exported named function: op leaf name == declaration name (greet)', async () => {
    const ops = await extractShape('default-fn.ts')
    const names = ops.map(leafName)
    expect(names).toEqual(['greet'])
    const proj = project(ops[0])
    expect(proj.mcp.name).toBe('shapes_default_fn_greet')
  })

  // ── Shape 3 (via default): `export default { ... }` ────────────────────────
  // The op leaf name is the OBJECT KEY (the exported symbol), with path
  // [file, 'default', key] per SPEC §5.
  it('default object: op leaf names == object keys (sum, product)', async () => {
    const ops = await extractShape('default-object.ts')
    const names = ops.map(leafName).sort()
    expect(names).toEqual(['product', 'sum'])
    const sum = ops.find((o) => leafName(o) === 'sum')!
    // Path includes the synthetic 'default' segment.
    expect(sum.path.map((s) => s.raw)).toEqual(['default-object', 'default', 'sum'])
    expect(project(sum).http.route).toBe('/shapes/default-object/default/sum')
  })

  // ── Shape 5: anonymous default export ──────────────────────────────────────
  // No exported symbol name → the extractor SYNTHESISES a STABLE id from the
  // filename. Determinism: extracting twice yields the identical id.
  it('anonymous default: synthesizes a stable filename-derived id', async () => {
    const ops1 = await extractShape('anonymous-default.ts')
    const ops2 = await extractShape('anonymous-default.ts')
    expect(ops1).toHaveLength(1)
    expect(leafName(ops1[0])).toBe('anonymous_default_default')
    // Stable across runs (same file → same id).
    expect(ops1[0].id).toBe(ops2[0].id)
    expect(ops1[0].id).toBe('shapes/anonymous-default-default')
  })

  // ── Shape 6: CJS `module.exports = { ... }` ────────────────────────────────
  // The op leaf name is the object KEY (the exported symbol), with a stable id
  // synthesized from filename + symbol.
  it('cjs source: op leaf names == module.exports keys (toUpper, repeat)', async () => {
    const ops = await extractShape('cjs-source.cts')
    const names = ops.map(leafName).sort()
    expect(names).toEqual(['repeat', 'toUpper'])
    const toUpper = ops.find((o) => leafName(o) === 'toUpper')!
    expect(toUpper.id).toBe('shapes/cjs-source/to-upper')
    expect(project(toUpper).mcp.name).toBe('shapes_cjs_source_to_upper')
  })

  // ── Full-matrix collision-freedom: all shapes merge without target clashes ─
  it('every shape projects to a UNIQUE id (no two ops share an id)', async () => {
    const files = [
      'named.ts',
      'renamed.ts',
      'default-fn.ts',
      'default-object.ts',
      'anonymous-default.ts',
      'cjs-source.cts',
    ]
    const all: Operation[] = []
    for (const f of files) all.push(...(await extractShape(f)))
    const ids = all.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Sanity: the exported-symbol leaf names are present across the matrix.
    const leaves = all.map(leafName)
    for (const expected of [
      'getUser',
      'listUsers',
      'fetchUser',
      'fetchAll',
      'greet',
      'sum',
      'product',
      'anonymous_default_default',
      'toUpper',
      'repeat',
    ]) {
      expect(leaves).toContain(expected)
    }
  })
})
