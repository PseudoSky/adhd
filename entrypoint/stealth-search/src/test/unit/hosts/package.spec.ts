/**
 * The apigen package of the eleven verbs both hosts serve: extraction from `src/api.ts`, $ref
 * inlining, naming, descriptions, the launchChrome hardening and the operations cache. Ticket
 * 8468f7b1 · plan state search-hosts.
 *
 * Criteria: [search-hosts.4] [search-hosts.7] [search-hosts.8] [search-hosts.16] · inventory row
 * I-35 ($ref inlining, package build, IR cache).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as api from '../../../api.js'
import { OPERATION_DESCRIPTIONS, OPERATION_NAMES, buildStealthSearchPackage, dereferenceSchema, keepVerbWhole } from '../../../server.js'
import type { StealthSearchPackage, Verbs } from '../../../server.js'
import { API_SOURCE, BUILD_TIMEOUT_MS, fakeVerbs, packageFor } from './host-harness.js'

const scratch = mkdtempSync(join(tmpdir(), 'stealth-search-package-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the package of the eleven verbs [search-hosts.4] [search-hosts.8]', () => {
  let built: StealthSearchPackage
  it(
    'extracts exactly the eleven verbs of src/api.ts, in help order, with whole-verb MCP names stealth_<verb> and the apigen CLI route `stealth <verb>` (the host takes the bare verb)',
    async () => {
      built = await packageFor(fakeVerbs(vi.fn))
      expect(built.surface.map((s) => s.operation)).toEqual([...OPERATION_NAMES])
      expect(built.surface.map((s) => s.mcpTool)).toEqual(OPERATION_NAMES.map((n) => `stealth_${n}`))
      expect(built.surface.map((s) => s.cliPath.join(' '))).toEqual(OPERATION_NAMES.map((n) => `stealth ${n}`))
      expect(Object.keys(built.pkg.schemas).sort()).toEqual([...OPERATION_NAMES].sort())
    },
    BUILD_TIMEOUT_MS
  )

  it('every verb of the api module is in the surface and nothing else is (no helper leaked into the tool list)', () => {
    const exported = Object.entries(api)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort()
    expect(exported).toEqual([...OPERATION_NAMES].sort())
  })

  it('every operation has a description of at least 40 characters that names what it does', () => {
    expect(Object.keys(OPERATION_DESCRIPTIONS).sort()).toEqual([...OPERATION_NAMES].sort())
    for (const [name, d] of Object.entries(OPERATION_DESCRIPTIONS)) expect(d.length, name).toBeGreaterThanOrEqual(40)
    expect(built.toolDescriptions['launchChrome']).toBe(OPERATION_DESCRIPTIONS.launchChrome)
  })

  it('the composed schemas hold no $ref and no definitions block (run-mode dispatch cannot resolve them)', () => {
    for (const [name, s] of Object.entries(built.pkg.schemas)) {
      const text = JSON.stringify(s)
      expect(text, name).not.toContain('$ref')
      expect(text, name).not.toContain('"definitions"')
    }
  })

  it('P1: the launchChrome input accepts only port and userDataDir and REQUIRES data.input (an empty call can never start a default Chrome)', () => {
    const input = built.pkg.schemas['launchChrome']?.input as { required?: string[]; properties: { data: { required?: string[]; properties: { input: { properties: Record<string, unknown>; additionalProperties: unknown } } } } }
    expect(Object.keys(input.properties.data.properties.input.properties).sort()).toEqual(['port', 'userDataDir'])
    expect(input.properties.data.properties.input.additionalProperties).toBe(false)
    expect(input.properties.data.required).toContain('input')
    expect(input.required).toContain('data')
  })

  it('the verbs the package calls are the live functions given (api.js by default)', async () => {
    const verbs = fakeVerbs(vi.fn)
    const p = await packageFor(verbs)
    expect(p.pkg.fns?.['chromeStatus']).toBe(verbs.chromeStatus)
    const real = await buildStealthSearchPackage({ apiSource: API_SOURCE })
    expect(real.pkg.fns?.['search']).toBe((api as unknown as Verbs)['search'])
  }, BUILD_TIMEOUT_MS)
})

describe('$ref inlining [search-hosts.16]', () => {
  it('inlines definitions, drops the definitions blocks and resolves a recursive reference to {}', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/definitions/Leaf' }, b: { type: 'array', items: { $ref: '#/definitions/Tree' } } },
      definitions: { Leaf: { type: 'string', description: 'leaf' }, Tree: { type: 'object', properties: { child: { $ref: '#/definitions/Tree' }, leaf: { $ref: '#/definitions/Leaf' } } } },
    }
    const out = dereferenceSchema(schema) as { properties: { a: unknown; b: { items: { properties: { child: unknown; leaf: unknown } } } } } & Record<string, unknown>
    expect(out['definitions']).toBeUndefined()
    expect(out.properties.a).toEqual({ type: 'string', description: 'leaf' })
    expect(out.properties.b.items.properties.leaf).toEqual({ type: 'string', description: 'leaf' })
    expect(out.properties.b.items.properties.child).toEqual({})
    expect(JSON.stringify(out)).not.toContain('$ref')
  })

  it('a schema with no definitions, a scalar and an unknown reference pass through or resolve to {}', () => {
    const plain = { type: 'object', properties: { x: { type: 'number' } } }
    expect(dereferenceSchema(plain)).toBe(plain)
    expect(dereferenceSchema('x')).toBe('x')
    expect(dereferenceSchema({ definitions: { A: { type: 'string' } }, properties: { m: { $ref: '#/definitions/Missing' } } })).toEqual({ properties: { m: {} } })
  })
})

describe('naming keeps each verb whole [search-hosts.8]', () => {
  it('keepVerbWhole sets the last path segment words to the raw verb', () => {
    const ops = keepVerbWhole([{ path: [{ raw: 'listProviders', words: ['list', 'providers'] }] } as never])
    expect(ops[0]?.path[0]).toEqual({ raw: 'listProviders', words: ['listProviders'] })
  })
})

describe('the operations cache [search-hosts.16]', () => {
  it(
    'I-35 a second build with the same declarations reads the cache instead of extracting (a poisoned operations list proves the hit), and a changed key re-extracts',
    async () => {
      const cacheFile = join(scratch, 'cache', 'operations.json')
      const first = await buildStealthSearchPackage({ apiSource: API_SOURCE, verbs: fakeVerbs(vi.fn), cacheFile })
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { key: string; operations: Array<{ id: string }> }
      expect(cached.operations).toHaveLength(11)
      expect(first.surface).toHaveLength(11)
      // A hit: keep the key, mark the first operation, and see the mark come back.
      const marked = cached.operations.map((o, i) => (i === 0 ? { ...o, marked: true } : o))
      writeFileSync(cacheFile, JSON.stringify({ key: cached.key, operations: marked }))
      const second = await buildStealthSearchPackage({ apiSource: API_SOURCE, verbs: fakeVerbs(vi.fn), cacheFile })
      expect((second.operations[0] as unknown as { marked?: boolean }).marked).toBe(true)
      // A miss: another key is ignored and the file is rewritten from a fresh extraction.
      writeFileSync(cacheFile, JSON.stringify({ key: 'stale', operations: marked }))
      const third = await buildStealthSearchPackage({ apiSource: API_SOURCE, verbs: fakeVerbs(vi.fn), cacheFile })
      expect((third.operations[0] as unknown as { marked?: boolean }).marked).toBeUndefined()
      expect((JSON.parse(readFileSync(cacheFile, 'utf8')) as { key: string }).key).toBe(cached.key)
      // A corrupt cache is a miss, not a failure.
      writeFileSync(cacheFile, '{not json')
      expect((await buildStealthSearchPackage({ apiSource: API_SOURCE, verbs: fakeVerbs(vi.fn), cacheFile })).surface).toHaveLength(11)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'a missing declaration file is a typed HOST_BOOT_FAILED naming the file',
    async () => {
      await expect(buildStealthSearchPackage({ apiSource: join(scratch, 'nope.d.ts'), verbs: fakeVerbs(vi.fn) })).rejects.toMatchObject({ code: 'HOST_BOOT_FAILED' })
    },
    BUILD_TIMEOUT_MS
  )
})
