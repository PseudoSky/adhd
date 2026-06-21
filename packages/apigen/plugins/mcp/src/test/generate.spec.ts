import { describe, it, expect } from 'vitest'
import { generate } from '../lib/generate'
import { mcpPlugin } from '../lib/plugin'
import type { PluginInput } from '@adhd/apigen-core'

// ---------- fixture ----------
// Simple domain functions — schemas follow ComposedSchemas shape (data-wrapped).
const testSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
  listUsers: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'array' },
  },
}

const baseInput: PluginInput = {
  packages: [
    {
      id: 'test-pkg',
      schemas: testSchema,
      importPath: '@test/test-pkg',
    },
  ],
  outputDir: '/tmp/out',
  options: {},
}

// ---------- generate() — stdio ----------

describe('[plugin-mcp.1] generate() — stdio transport', () => {
  it('emits index.ts and server.ts', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } })
    expect(out.files).toHaveLength(2)
    const paths = out.files.map((f) => f.path)
    expect(paths).toContain('index.ts')
    expect(paths).toContain('server.ts')
  })

  it('server.ts contains StdioServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } })
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).toContain('StdioServerTransport')
  })

  it('index.ts contains toolMetas with fixture fn names', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } })
    const idx = out.files.find((f) => f.path === 'index.ts')!
    expect(idx.content).toContain('getUser')
    expect(idx.content).toContain('listUsers')
    expect(idx.content).toContain('toolMetas')
    expect(idx.content).toContain('groupFns')
    expect(idx.content).toContain('groupCreateClient')
  })

  it('server.ts imports dispatch from @adhd/apigen-runtime', () => {
    const out = generate({ ...baseInput, options: { transport: 'stdio' } })
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).toContain("from '@adhd/apigen-runtime'")
    expect(server.content).toContain('dispatch')
  })

  it('defaults to stdio when no transport option given', () => {
    const out = generate(baseInput)
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).toContain('StdioServerTransport')
  })
})

// ---------- generate() — SSE ----------

describe('[plugin-mcp.2] generate() — sse transport', () => {
  it('server.ts contains SSEServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'sse' } })
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).toContain('SSEServerTransport')
  })

  it('does NOT contain StdioServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'sse' } })
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).not.toContain('StdioServerTransport')
  })
})

// ---------- generate() — streaming-http ----------

describe('[plugin-mcp.3] generate() — streaming-http transport', () => {
  it('server.ts contains StreamableHTTPServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'streaming-http' } })
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).toContain('StreamableHTTPServerTransport')
  })

  it('does NOT contain StdioServerTransport or SSEServerTransport', () => {
    const out = generate({ ...baseInput, options: { transport: 'streaming-http' } })
    const server = out.files.find((f) => f.path === 'server.ts')!
    expect(server.content).not.toContain('StdioServerTransport')
    expect(server.content).not.toContain('SSEServerTransport')
  })
})

// ---------- plugin interface ----------

describe('[plugin-mcp.6] mcpPlugin — optionsSchema transport enum', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(mcpPlugin.id).toBe('mcp')
    expect(typeof mcpPlugin.generate).toBe('function')
    expect(typeof mcpPlugin.run).toBe('function')
  })

  it('optionsSchema.properties.transport.enum contains all 3 transports', () => {
    const schema = mcpPlugin.optionsSchema as any
    const enumValues: string[] = schema.properties.transport.enum
    expect(enumValues).toContain('stdio')
    expect(enumValues).toContain('sse')
    expect(enumValues).toContain('streaming-http')
  })

  it('delegates generate() to the generate module', () => {
    const out = mcpPlugin.generate(baseInput)
    expect((out as { files: unknown[] }).files).toHaveLength(2)
  })
})

// ---------- [plugin-mcp.5] no inline dispatch ----------

describe('[plugin-mcp.5] no inline dispatch logic in generate output', () => {
  it('index.ts does not contain dispatch implementation', () => {
    const out = generate(baseInput)
    const idx = out.files.find((f) => f.path === 'index.ts')!
    // index.ts is a data file — it must not contain any dispatch call
    expect(idx.content).not.toContain('dispatch(')
  })
})
