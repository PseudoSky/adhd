/**
 * crosshost_ts_shim.ts — REAL TypeScript host leg for the cross-host conformance audit.
 *
 * This is NOT a mock. It drives the actual shipped TS host binding
 * (`tsHostBinding` from `@adhd/apigen-runtime`, whose codecs come straight from
 * `@adhd/apigen-logical`) so the Python audit can prove a value round-trips
 * TS → wire → Python → wire → TS byte-stable through the genuine artifacts.
 *
 * Protocol (line-oriented JSON over stdin/stdout):
 *   Request  (one JSON object on stdin):
 *     { "op": "encode_seed",      "vector": <LogicalTypeVector> }
 *       → construct the native TS seed from vector.seed, encode it with the
 *         real codec, return the produced wire.
 *     { "op": "decode_reencode",  "vector": <LogicalTypeVector>, "wire": <Wire> }
 *       → decode the supplied wire with the real codec, re-encode it, return
 *         the produced wire. (This is the "TS receives a foreign wire" leg.)
 *
 *   Response (one JSON object on stdout):
 *     { "ok": true,  "wire": <Wire> }            on success
 *     { "ok": false, "error": "<message>" }      on any codec / construction error
 *
 * The wire is serialized with a canonical JSON form (sorted keys) by the Python
 * side for byte comparison; here we just return the structured Wire value.
 *
 * Invoked exactly as the proven `apigen-conformance:conformance` target invokes
 * tsx: `{workspaceRoot}/node_modules/.bin/tsx --tsconfig
 * packages/apigen/conformance/tsconfig.json <thisfile>`, cwd = workspace root.
 */

import {
  createRegistry,
  registerWellKnown,
  type LogicalTypeCodec,
  type LogicalTypeId,
  type SchemaNode,
  type TranscodeCtx,
  type Wire,
} from '@adhd/apigen-logical'
import { tsHostBinding } from '@adhd/apigen-runtime'

// ---- Vector shape (mirrors LogicalTypeVector; kept local to avoid a build dep) ----
interface SeedConstruct {
  readonly $construct: LogicalTypeId
  readonly args: Wire[]
}
interface LogicalTypeVector {
  readonly id: string
  readonly logicalType: LogicalTypeId
  readonly schema: Record<string, unknown>
  readonly seed: Wire | SeedConstruct
  readonly wire: Wire
  readonly invariants?: ReadonlyArray<{ pointer: string; equals: Wire }>
  readonly negativeControl: { mutate: string; to: unknown }
}

// ---- Real TranscodeCtx (registry with the genuine well-known codecs) ----
function makeCtx(): TranscodeCtx {
  const registry = createRegistry()
  registerWellKnown(registry)
  return {
    registry,
    resolve: (_ref: string) => ({}) as SchemaNode,
    seen: new WeakSet<object>(),
    path: '/',
    mode: 'strict',
  }
}

/** Resolve the REAL shipped codec for this vector's logical type. */
function codecFor(v: LogicalTypeVector): LogicalTypeCodec {
  const codec = tsHostBinding.codecs.get(v.logicalType)
  if (!codec) {
    throw new Error(`tsHostBinding has no codec for logicalType "${v.logicalType}"`)
  }
  return codec
}

/**
 * Construct the native TS seed from a vector recipe.
 * Mirrors apigen_logical.py:construct_seed / gate.ts:constructSeedTs so both
 * hosts start from the same conceptual native value.
 */
function constructSeed(v: LogicalTypeVector, codec: LogicalTypeCodec): unknown {
  const seed = v.seed
  if (typeof seed !== 'object' || seed === null || !('$construct' in seed)) {
    // Plain wire seed (e.g. int64 '9007199254740993', decimal '123.456'):
    // decode it through the real codec to obtain the native value.
    return codec.decode(seed as Wire, codec.schema, makeCtx())
  }
  const { $construct, args } = seed as SeedConstruct
  switch ($construct) {
    case 'date-time':
      return new Date(args[0] as string)
    case 'byte':
      return new Uint8Array(args[0] as number[])
    case 'number-special': {
      const s = args[0] as string
      if (s === 'NaN') return NaN
      if (s === 'Infinity') return Infinity
      if (s === '-Infinity') return -Infinity
      throw new Error(`unknown number-special sentinel: ${s}`)
    }
    case 'int64':
      return BigInt(args[0] as string)
    case 'decimal':
      return args[0] as string
    case 'uuid':
      return (args[0] as string).toLowerCase()
    default:
      throw new Error(`unsupported $construct logicalType: ${$construct}`)
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

async function main(): Promise<void> {
  const input = await readStdin()
  let req: { op: string; vector: LogicalTypeVector; wire?: Wire }
  try {
    req = JSON.parse(input)
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `bad request JSON: ${String(e)}` }))
    return
  }

  try {
    const v = req.vector
    const codec = codecFor(v)
    const ctx = makeCtx()

    if (req.op === 'encode_seed') {
      const native = constructSeed(v, codec)
      const wire = codec.encode(native, codec.schema, ctx)
      process.stdout.write(JSON.stringify({ ok: true, wire }))
      return
    }

    if (req.op === 'decode_reencode') {
      const decoded = codec.decode(req.wire as Wire, codec.schema, ctx)
      const wire = codec.encode(decoded, codec.schema, ctx)
      process.stdout.write(JSON.stringify({ ok: true, wire }))
      return
    }

    process.stdout.write(JSON.stringify({ ok: false, error: `unknown op: ${req.op}` }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  }
}

void main()
