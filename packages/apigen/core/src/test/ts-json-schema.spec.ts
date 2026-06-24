/**
 * Tests for the scalar logical-type schema extraction (lt-extract-scalars / BUG-APIGEN-005).
 *
 * Verifies that well-known TS built-in types produce their canonical {type, format}
 * JSON-Schema fragments (§3 / §12-13 of apigen-logical-types/DESIGN.md) instead of
 * falling through to the empty {} schema.
 *
 * Includes a negative-control sense: plain `string` stays {type:"string"} with no format.
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { generateSchemas } from '../index'

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name)

describe('lt-extract-scalars: built-in TS scalar → {type, format}', () => {
  // [lt-extract-scalars.1] guard green: npx nx test apigen-core
  // Each test below is a concrete check that contributes to this criterion.

  it('[scalar.date-time] Date return type extracts as {type:string,format:date-time} (not {})', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const output = result.schemas['returnsDate']?.output
    expect(output).toEqual({ type: 'string', format: 'date-time' })
  })

  it('[scalar.date-time.negative-control] plain string stays {type:string} with no format', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const output = result.schemas['takesString']?.output
    // string return — must be {type:"string"} with no format key
    expect(output).toBeDefined()
    const schema = output as Record<string, unknown>
    expect(schema['type']).toBe('string')
    expect(schema).not.toHaveProperty('format')
  })

  it('[scalar.int64] bigint param extracts as {type:string,format:int64}', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const props = result.schemas['takesBigint']?.input?.properties as Record<string, unknown>
    expect(props?.['value']).toEqual({ type: 'string', format: 'int64' })
  })

  it('[scalar.byte.uint8array] Uint8Array param extracts as {type:string,format:byte}', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const props = result.schemas['takesUint8Array']?.input?.properties as Record<string, unknown>
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' })
  })

  it('[scalar.byte.buffer] Buffer param extracts as {type:string,format:byte}', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const props = result.schemas['takesBuffer']?.input?.properties as Record<string, unknown>
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' })
  })

  it('[scalar.uri] URL param extracts as {type:string,format:uri}', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const props = result.schemas['takesURL']?.input?.properties as Record<string, unknown>
    expect(props?.['url']).toEqual({ type: 'string', format: 'uri' })
  })

  it('[scalar.regex] RegExp param extracts as {type:string,format:regex}', async () => {
    const result = await generateSchemas({ sourceFile: fixture('scalar-types.ts') })
    const props = result.schemas['takesRegExp']?.input?.properties as Record<string, unknown>
    expect(props?.['pattern']).toEqual({ type: 'string', format: 'regex' })
  })
})
