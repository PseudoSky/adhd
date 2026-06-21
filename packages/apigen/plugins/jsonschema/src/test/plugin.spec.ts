import { describe, it, expect } from 'vitest'
import { jsonschemaPlugin } from '../lib/plugin'
import type { PluginInput } from '@adhd/apigen-core'

const input: PluginInput = {
  packages: [{
    id: 'test-pkg',
    schemas: {
      getUser: {
        input: { type: 'object', properties: { data: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] } }, required: ['data'] },
        output: { type: 'object' },
      },
    },
    importPath: '@test/pkg',
  }],
  outputDir: '/tmp/test',
  options: {},
}

describe('jsonschema plugin', () => {
  it('emits one file per function at <packageId>/<fnName>.json', () => {
    const output = jsonschemaPlugin.generate(input)
    expect(output.files).toHaveLength(1)
    expect(output.files[0].path).toBe('test-pkg/getUser.json')
  })

  it('emits valid JSON content', () => {
    const output = jsonschemaPlugin.generate(input)
    const parsed = JSON.parse(output.files[0].content)
    expect(parsed).toHaveProperty('input')
    expect(parsed).toHaveProperty('output')
  })

  it('respects pretty: false option', () => {
    const output = jsonschemaPlugin.generate({ ...input, options: { pretty: false } })
    // No newlines in compact JSON
    expect(output.files[0].content).not.toContain('\n')
  })

  it('satisfies OutputPlugin interface — has id, description, generate', () => {
    expect(typeof jsonschemaPlugin.id).toBe('string')
    expect(typeof jsonschemaPlugin.generate).toBe('function')
    expect(jsonschemaPlugin.run).toBeUndefined() // no run() for jsonschema
  })

  it('emits multiple files for multiple functions', () => {
    const multiInput: PluginInput = {
      packages: [{
        id: 'pkg-a',
        schemas: {
          fnOne: { input: { type: 'object' }, output: { type: 'string' } },
          fnTwo: { input: { type: 'object' }, output: { type: 'number' } },
        },
        importPath: '@test/pkg-a',
      }],
      outputDir: '/tmp/test',
      options: {},
    }
    const output = jsonschemaPlugin.generate(multiInput)
    expect(output.files).toHaveLength(2)
    const paths = output.files.map((f) => f.path)
    expect(paths).toContain('pkg-a/fnOne.json')
    expect(paths).toContain('pkg-a/fnTwo.json')
  })

  it('emits files across multiple packages', () => {
    const multiPkgInput: PluginInput = {
      packages: [
        {
          id: 'pkg-x',
          schemas: { getX: { input: { type: 'object' }, output: { type: 'string' } } },
          importPath: '@test/pkg-x',
        },
        {
          id: 'pkg-y',
          schemas: { getY: { input: { type: 'object' }, output: { type: 'string' } } },
          importPath: '@test/pkg-y',
        },
      ],
      outputDir: '/tmp/test',
      options: {},
    }
    const output = jsonschemaPlugin.generate(multiPkgInput)
    expect(output.files).toHaveLength(2)
    expect(output.files[0].path).toBe('pkg-x/getX.json')
    expect(output.files[1].path).toBe('pkg-y/getY.json')
  })

  it('pretty-prints by default', () => {
    const output = jsonschemaPlugin.generate(input)
    // Pretty JSON contains newlines
    expect(output.files[0].content).toContain('\n')
  })
})
