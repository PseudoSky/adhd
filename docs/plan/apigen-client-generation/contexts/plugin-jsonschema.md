# plugin-jsonschema — IMPLEMENT @adhd/apigen-plugin-jsonschema

**Phase:** plugins · **Depends on:** audit-runtime · **Parallel with:** plugin-mcp, plugin-api-fastify, plugin-api-express, plugin-cli-output · **Guard:** `npx --yes nx test apigen-plugin-jsonschema`

---

## Goal

Implement the simplest possible `OutputPlugin` — the jsonschema plugin. Its sole job is to emit one JSON file per function per package at `outputDir/<packageId>/<fnName>.json`. No `run()` method. This state validates that the `OutputPlugin` interface is correctly defined and satisfiable before moving on to more complex plugins.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/plugins/jsonschema/src/lib/plugin.ts` — 20 lines.
- **Reference Pattern:** See `[def:OutputPlugin]` in `_shared.md`. Also see SCOPE.md §3.3 jsonschema section.
- **Delta Spec:**

### `plugin.ts`

```typescript
import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core'
import * as path from 'node:path'

export const jsonschemaPlugin: OutputPlugin = {
  id: 'jsonschema',
  description: 'Emit one JSON Schema file per function per package',
  optionsSchema: {
    type: 'object',
    properties: {
      pretty: { type: 'boolean', description: 'Pretty-print JSON (default: true)' },
    },
  },
  generate(input: PluginInput): PluginOutput {
    const pretty = (input.options['pretty'] as boolean) !== false  // default true
    const files: PluginOutput['files'] = []

    for (const pkg of input.packages) {
      for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
        files.push({
          path: path.join(pkg.id, `${fnName}.json`),
          content: JSON.stringify(fnSchema, null, pretty ? 2 : 0),
        })
      }
    }

    return { files }
  },
}

export default jsonschemaPlugin
```

### `index.ts`

```typescript
export { jsonschemaPlugin } from './lib/plugin'
export default jsonschemaPlugin
```

### Test file

```typescript
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
    expect(jsonschemaPlugin.run).toBeUndefined()  // no run() for jsonschema
  })
})
```

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/plugins/jsonschema/src/lib/plugin.ts",
            "packages/apigen/plugins/jsonschema/src/index.ts",
            "packages/apigen/plugins/jsonschema/src/test/plugin.spec.ts"]
read_only:  []
```

---

## Acceptance criteria

- `[plugin-jsonschema.1]` Plugin emits `<packageId>/<fnName>.json` file per function.
- `[plugin-jsonschema.2]` Emitted content parses as valid JSON with `input` and `output` keys.
- `[plugin-jsonschema.3]` Plugin has no `run()` method (`jsonschemaPlugin.run === undefined`).
- `[plugin-jsonschema.4]` Plugin satisfies `OutputPlugin` interface (TypeScript build passes).

---

## Commit points

1. After tests pass: `feat(apigen-plugin-jsonschema): implement jsonschema OutputPlugin`
