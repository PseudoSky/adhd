import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { generateSchemas } from '../index'

const fixture = (name: string) =>
  path.resolve(__dirname, 'fixtures', name)

describe('generateSchemas — named exports', () => {
  it('[schema-extraction.1] includes getUser and sendEmail; excludes VERSION', async () => {
    const result = await generateSchemas({ sourceFile: fixture('named-exports.ts') })
    expect(result.schemas).toHaveProperty('getUser')
    expect(result.schemas).toHaveProperty('sendEmail')
    expect(result.schemas).not.toHaveProperty('VERSION')
  })

  it('[schema-extraction.2] ctx first param is excluded from input properties', async () => {
    const result = await generateSchemas({ sourceFile: fixture('ctx-param.ts') })
    const props = result.schemas['getUser']?.input?.properties as Record<string, unknown> | undefined
    expect(props).toBeDefined()
    expect(props).not.toHaveProperty('ctx')
    expect(props).toHaveProperty('userId')
  })

  it('[schema-extraction.3] optional param body is not in required array', async () => {
    const result = await generateSchemas({ sourceFile: fixture('named-exports.ts') })
    const input = result.schemas['sendEmail']?.input as { required?: string[] }
    expect(input?.required).toContain('to')
    expect(input?.required).toContain('subject')
    expect(input?.required).not.toContain('body')
  })

  it('[schema-extraction.4] Promise<T> is unwrapped — output schema is not Promise<...>', async () => {
    const result = await generateSchemas({ sourceFile: fixture('named-exports.ts') })
    const output = result.schemas['getUser']?.output
    // Output schema must represent the resolved type, not Promise<...>
    expect(output).toBeDefined()
    // ts-json-schema-generator may return definitions; verify it is a schema object (not a string)
    expect(typeof output).toBe('object')
    // Must NOT be a schema whose type includes the word "Promise"
    const outputStr = JSON.stringify(output)
    expect(outputStr).not.toMatch(/Promise/)
  })
})

describe('generateSchemas — default export mode', () => {
  it('[schema-extraction.5] both functions appear as endpoints', async () => {
    const result = await generateSchemas({
      sourceFile: fixture('default-export.ts'),
      exportMode: { type: 'default' },
    })
    expect(result.schemas).toHaveProperty('getUser')
    expect(result.schemas).toHaveProperty('deleteUser')
  })
})

describe('generateSchemas — named-object export mode', () => {
  it('[schema-extraction.6] myApi.getUser appears', async () => {
    const result = await generateSchemas({
      sourceFile: fixture('named-object.ts'),
      exportMode: { type: 'named-object', name: 'myApi' },
    })
    expect(result.schemas).toHaveProperty('getUser')
  })
})

describe('generateSchemas — ctx filtering edge cases', () => {
  it('[schema-extraction.7] zero-param-with-ctx: listAll input properties is empty {}', async () => {
    const result = await generateSchemas({ sourceFile: fixture('ctx-param.ts') })
    const input = result.schemas['listAll']?.input as {
      properties?: Record<string, unknown>
    }
    expect(input).toBeDefined()
    expect(input.properties).toEqual({})
  })
})
