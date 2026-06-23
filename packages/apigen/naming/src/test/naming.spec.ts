import { describe, it, expect } from 'vitest'
import type { Operation, Segment } from '@adhd/apigen-core'

import {
  toKebab,
  toCamel,
  toPascal,
  toSnake,
  normalizeFileName,
  project,
  checkCollisions,
  CollisionDetectedError,
  envelopeKey,
  envelopeCliFlag,
  envelopeEnvVar,
  envelopeMetaKey,
} from '../lib/naming'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal Segment. */
function seg(raw: string, words: string[]): Segment {
  return { raw, words }
}

/**
 * Build a minimal Operation for projection/collision tests.
 * Only the fields consumed by the naming module are populated.
 */
function op(
  id: string,
  namespace: Segment,
  path: Segment[],
  safe: boolean,
): Operation {
  return {
    id,
    host: 'ts',
    namespace,
    path,
    kind: 'action',
    async: false,
    streaming: false,
    safe,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  }
}

// SPEC §5 worked example:
//   namespace=transform, path=[humanize, humanizeBytes], kind=action
const nsTransform = seg('transform', ['transform'])
const segHumanize = seg('humanize', ['humanize'])
const segHumanizeBytes = seg('humanizeBytes', ['humanize', 'bytes'])

const opHumanizeBytes = op(
  'transform/humanize/humanize-bytes',
  nsTransform,
  [segHumanize, segHumanizeBytes],
  false, // action → unsafe → POST
)

// ---------------------------------------------------------------------------
// Casing projectors
// ---------------------------------------------------------------------------

describe('toKebab', () => {
  it('[naming.toKebab.1] single word stays lower', () => {
    expect(toKebab(seg('transform', ['transform']))).toBe('transform')
  })

  it('[naming.toKebab.2] camelCase source → words → kebab', () => {
    expect(toKebab(segHumanizeBytes)).toBe('humanize-bytes')
  })

  it('[naming.toKebab.3] three-word segment', () => {
    expect(toKebab(seg('getMyData', ['get', 'my', 'data']))).toBe('get-my-data')
  })
})

describe('toCamel', () => {
  it('[naming.toCamel.1] single word unchanged', () => {
    expect(toCamel(seg('transform', ['transform']))).toBe('transform')
  })

  it('[naming.toCamel.2] two words → camelCase', () => {
    expect(toCamel(segHumanizeBytes)).toBe('humanizeBytes')
  })

  it('[naming.toCamel.3] three words', () => {
    expect(toCamel(seg('getMyData', ['get', 'my', 'data']))).toBe('getMyData')
  })
})

describe('toPascal', () => {
  it('[naming.toPascal.1] single word → capitalised', () => {
    expect(toPascal(seg('humanize', ['humanize']))).toBe('Humanize')
  })

  it('[naming.toPascal.2] two words → PascalCase', () => {
    expect(toPascal(segHumanizeBytes)).toBe('HumanizeBytes')
  })

  it('[naming.toPascal.3] three words', () => {
    expect(toPascal(seg('getMyData', ['get', 'my', 'data']))).toBe('GetMyData')
  })
})

describe('toSnake', () => {
  it('[naming.toSnake.1] single word unchanged', () => {
    expect(toSnake(seg('transform', ['transform']))).toBe('transform')
  })

  it('[naming.toSnake.2] two words → snake_case', () => {
    expect(toSnake(segHumanizeBytes)).toBe('humanize_bytes')
  })

  it('[naming.toSnake.3] three words', () => {
    expect(toSnake(seg('getMyData', ['get', 'my', 'data']))).toBe('get_my_data')
  })
})

// ---------------------------------------------------------------------------
// normalizeFileName
// ---------------------------------------------------------------------------

describe('normalizeFileName', () => {
  it('[naming.normalize.1] strips extension', () => {
    expect(normalizeFileName('humanize.ts')).toBe('humanize')
  })

  it('[naming.normalize.2] dots → hyphens (SPEC §5 example)', () => {
    expect(normalizeFileName('file.name.ts')).toBe('file-name')
  })

  it('[naming.normalize.3] underscores → hyphens', () => {
    expect(normalizeFileName('my_util.js')).toBe('my-util')
  })

  it('[naming.normalize.4] mixed dots and underscores', () => {
    expect(normalizeFileName('my_file.name.ts')).toBe('my-file-name')
  })

  it('[naming.normalize.5] no extension — only normalises separators', () => {
    expect(normalizeFileName('my_util')).toBe('my-util')
  })
})

// ---------------------------------------------------------------------------
// project — per-transport projection
// ---------------------------------------------------------------------------

describe('project — SPEC §5 worked example', () => {
  it('[naming.project.1] HTTP: POST + kebab route for unsafe action', () => {
    const p = project(opHumanizeBytes)
    expect(p.http.verb).toBe('POST')
    expect(p.http.route).toBe('/transform/humanize/humanize-bytes')
  })

  it('[naming.project.2] MCP: flat name joined with underscores', () => {
    const p = project(opHumanizeBytes)
    expect(p.mcp.name).toBe('transform_humanize_humanize_bytes')
  })

  it('[naming.project.3] gRPC: dotted package + Pascal service + Pascal method', () => {
    const p = project(opHumanizeBytes)
    expect(p.grpc.package).toBe('transform.humanize')
    expect(p.grpc.service).toBe('Humanize')
    expect(p.grpc.method).toBe('HumanizeBytes')
  })

  it('[naming.project.4] CLI: array of kebab command segments', () => {
    const p = project(opHumanizeBytes)
    expect(p.cli.path).toEqual(['transform', 'humanize', 'humanize-bytes'])
  })
})

// ---------------------------------------------------------------------------
// Verb from `safe`, both directions
// ---------------------------------------------------------------------------

describe('project — verb derives from safe, not kind', () => {
  it('[naming.verb.1] safe=false → POST (unsafe action)', () => {
    const p = project(opHumanizeBytes) // safe=false
    expect(p.http.verb).toBe('POST')
  })

  it('[naming.verb.2] safe=true → GET (safe/query)', () => {
    const safeOp = op(
      'transform/humanize/humanize-bytes',
      nsTransform,
      [segHumanize, segHumanizeBytes],
      true, // safe → GET
    )
    const p = project(safeOp)
    expect(p.http.verb).toBe('GET')
  })

  it('[naming.verb.3] safe=false but config override → GET (Tenet 1: no source edit)', () => {
    const p = project(opHumanizeBytes, {
      http: { verb: { 'transform/humanize/humanize-bytes': 'GET' } },
    })
    expect(p.http.verb).toBe('GET')
  })

  it('[naming.verb.4] safe=true but config override → POST', () => {
    const safeOp = op(
      'transform/humanize/humanize-bytes',
      nsTransform,
      [segHumanize, segHumanizeBytes],
      true,
    )
    const p = project(safeOp, {
      http: { verb: { 'transform/humanize/humanize-bytes': 'POST' } },
    })
    expect(p.http.verb).toBe('POST')
  })

  it('[naming.verb.5] override only affects the specified id, not siblings', () => {
    const ping = op(
      'transform/ping',
      nsTransform,
      [seg('ping', ['ping'])],
      false,
    )
    const p = project(ping, {
      http: { verb: { 'transform/humanize/humanize-bytes': 'GET' } },
    })
    // ping is unsafe and NOT in the override map → still POST
    expect(p.http.verb).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// Collision check — the uniqueness invariant (SPEC §5)
// ---------------------------------------------------------------------------

describe('checkCollisions', () => {
  const opA = op(
    'pkg/a',
    seg('pkg', ['pkg']),
    [seg('a', ['a'])],
    false,
  )
  const opB = op(
    'pkg/b',
    seg('pkg', ['pkg']),
    [seg('b', ['b'])],
    true,
  )

  it('[naming.collision.1] distinct operations with distinct targets — no throw', () => {
    expect(() => checkCollisions([opA, opB])).not.toThrow()
  })

  it('[naming.collision.2] empty descriptor — no throw', () => {
    expect(() => checkCollisions([])).not.toThrow()
  })

  it('[naming.collision.3] same id appearing twice — NOT a collision (idempotent dedup)', () => {
    // Same id means same operation repeated; only distinct ids that collide are an error.
    expect(() => checkCollisions([opA, opA])).not.toThrow()
  })

  it('[naming.collision.4] two DISTINCT ids that resolve to the same MCP name → THROWS', () => {
    // These two ops have different `id`s but identical namespace+path → identical MCP name.
    const collision1 = op(
      'pkg/dup/id-one',
      seg('pkg', ['pkg']),
      [seg('dup', ['dup']), seg('shared', ['shared'])],
      false,
    )
    const collision2 = op(
      'pkg/dup/id-two',           // different id
      seg('pkg', ['pkg']),
      [seg('dup', ['dup']), seg('shared', ['shared'])],  // same segments → same projection
      false,
    )

    expect(() => checkCollisions([collision1, collision2])).toThrow(CollisionDetectedError)
  })

  it('[naming.collision.5] thrown error names both colliding ids', () => {
    const collision1 = op(
      'ns/file-alpha',
      seg('ns', ['ns']),
      [seg('fileAlpha', ['file', 'alpha'])],
      false,
    )
    const collision2 = op(
      'ns/file-beta',          // different id
      seg('ns', ['ns']),
      [seg('fileAlpha', ['file', 'alpha'])],  // identical words → same projection
      false,
    )

    let caught: CollisionDetectedError | null = null
    try {
      checkCollisions([collision1, collision2])
    } catch (e) {
      if (e instanceof CollisionDetectedError) caught = e
    }

    expect(caught).not.toBeNull()
    expect(caught!.collisions.length).toBeGreaterThan(0)
    // Both ids appear in at least one collision record.
    const ids = caught!.collisions.flatMap((c) => c.ids)
    expect(ids).toContain('ns/file-alpha')
    expect(ids).toContain('ns/file-beta')
  })

  it('[naming.collision.6] negative-control: fix the collision (give distinct words) → no throw', () => {
    // Prove the test above is not vacuous: distinct words → no collision.
    const fixed1 = op(
      'ns/file-alpha',
      seg('ns', ['ns']),
      [seg('fileAlpha', ['file', 'alpha'])],
      false,
    )
    const fixed2 = op(
      'ns/file-beta',
      seg('ns', ['ns']),
      [seg('fileBeta', ['file', 'beta'])],  // different words → different projection
      false,
    )

    expect(() => checkCollisions([fixed1, fixed2])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// §9.1 Envelope-binding helpers
// ---------------------------------------------------------------------------

describe('envelopeKey (HTTP / gRPC metadata / MCP _meta)', () => {
  it('[naming.envelope.1] plugin field → x-<pluginId>-<field>', () => {
    expect(envelopeKey('auth', 'session')).toBe('x-auth-session')
  })

  it('[naming.envelope.2] builtin (adhd) field → x-adhd-<field>', () => {
    expect(envelopeKey('adhd', 'trace-id')).toBe('x-adhd-trace-id')
  })

  it('[naming.envelope.3] envelopeMetaKey is an alias producing the same key', () => {
    expect(envelopeMetaKey('auth', 'session')).toBe(envelopeKey('auth', 'session'))
  })
})

describe('envelopeCliFlag', () => {
  it('[naming.envelope.4] plugin field → --<pluginId>-<field>', () => {
    expect(envelopeCliFlag('auth', 'session')).toBe('--auth-session')
  })

  it('[naming.envelope.5] builtin field → --adhd-<field>', () => {
    expect(envelopeCliFlag('adhd', 'trace-id')).toBe('--adhd-trace-id')
  })
})

describe('envelopeEnvVar', () => {
  it('[naming.envelope.6] plugin field → APIGEN_<PLUGINID>_<FIELD>', () => {
    expect(envelopeEnvVar('auth', 'session')).toBe('APIGEN_AUTH_SESSION')
  })

  it('[naming.envelope.7] builtin (adhd) → APIGEN_<FIELD>, no plugin segment', () => {
    expect(envelopeEnvVar('adhd', 'trace-id')).toBe('APIGEN_TRACE_ID')
  })

  it('[naming.envelope.8] hyphens in field → underscores in env var', () => {
    expect(envelopeEnvVar('my-plugin', 'api-key')).toBe('APIGEN_MY_PLUGIN_API_KEY')
  })
})
