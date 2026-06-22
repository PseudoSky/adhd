# integration-tests-v2 — END-TO-END INTEGRATION TEST SUITE

**Phase:** integration · **Depends on:** audit-cli · **Guard:** `npx --yes nx test apigen-cli --testPathPattern=integration`

---

## Goal

Author and pass a suite of integration tests that drive every public behavior through its real entrypoint. No mocks of the system under test. Unit tests prove code compiles; these prove the system works.

The distinction: unit tests call `generate()` and assert a string. Integration tests start a server, send a real request, and assert the response.

---

## Binary convention

Within the monorepo all tests invoke the CLI via tsx (no build step required):

```typescript
const CLI = path.resolve(__dirname, '../../index.ts')
// spawn: ['npx', 'tsx', CLI, 'generate', ...]
```

Published consumers use `npx @adhd/apigen-cli generate ...`. Any audit check that invokes the CLI from the shell uses:

```bash
npx --yes tsx packages/apigen/cli/src/index.ts generate ...
```

Never `node packages/apigen/cli/src/index.ts` (node can't run .ts directly).

---

## Fixture — `src/test/fixtures/real-api.ts`

A fixture that exercises every edge case the plan cares about — `ctx` exclusion, optional params, complex return types, zero-param, void return:

```typescript
// src/test/fixtures/real-api.ts
export type User = { id: string; name: string; role: 'admin' | 'user' }
export type Filter = { role?: User['role']; limit?: number }

/** ctx is the first param — must be excluded from every schema */
export async function getUser(ctx: unknown, userId: string): Promise<User> {
  return { id: userId, name: 'Alice', role: 'user' }
}

/** filter is optional — must NOT be in required[] */
export async function listUsers(ctx: unknown, filter?: Filter): Promise<User[]> {
  return []
}

/** no ctx — all params are domain params */
export async function createUser(name: string, role: User['role']): Promise<User> {
  return { id: 'new', name, role }
}

/** zero-param — data:{} must still appear in required[] */
export async function ping(): Promise<boolean> {
  return true
}

/** void return — output schema must be {} not undefined */
export async function sendEmail(to: string, subject: string): Promise<void> {}

// [conv:fixture-samples] — the probe derives its expected tool set + ground-truth
// outputs from THIS map plus the exported fns; no literal observable lives in the
// audit. `__samples__` is NOT a tool — extractors and the probe skip this key.
export const __samples__: Record<string, Record<string, unknown>> = {
  getUser:    { userId: 'abc' },
  listUsers:  {},
  createUser: { name: 'Bob', role: 'admin' },
  ping:       {},
  sendEmail:  { to: 'a@b.com', subject: 'hi' },
}
```

> **`__samples__` is mandatory on every entrypoint-driving fixture** (`real-api.ts`, `default-api.ts`, `object-api.ts`, and each `registry/pkg-*/index.ts`). See `[conv:fixture-samples]` in `_shared.md`. `scripts/probe_mcp.mjs` imports the fixture in-process to compute the expected tool set (= exported fn names minus `__samples__`) and the ground-truth outputs (= each export called directly with its sample args), then drives the real entrypoint and asserts a deep-equal. Extractors MUST skip the `__samples__` export so it never appears as a tool.

---

## Test file 1 — Schema extraction + composition

**`src/test/integration/schema.spec.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { generateSchemas } from '@adhd/apigen-core'
import { createApiPackage, defineMiddleware } from '@adhd/apigen-runtime'

const FIXTURE = path.resolve(__dirname, '../fixtures/real-api.ts')

describe('schema extraction — real-api.ts', () => {
  it('excludes ctx from getUser', async () => {
    const schemas = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    const props = schemas.getUser?.params?.map(p => p.name) ?? []
    expect(props).not.toContain('ctx')
    expect(props).toContain('userId')
  })

  it('marks filter as optional (not in required)', async () => {
    const schemas = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    const required = schemas.listUsers?.params?.filter(p => p.required).map(p => p.name) ?? []
    expect(required).not.toContain('filter')
  })

  it('produces params for createUser with no ctx', async () => {
    const schemas = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    const names = schemas.createUser?.params?.map(p => p.name) ?? []
    expect(names).toEqual(['name', 'role'])
  })

  it('produces empty params for ping (zero-param)', async () => {
    const schemas = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    expect(schemas.ping?.params ?? []).toHaveLength(0)
  })
})

describe('schema composition — middleware + override', () => {
  const sessionMw = defineMiddleware({
    id: 'session',
    envelope: {
      type: 'object',
      properties: { session: { type: 'string' } },
      required: ['session'],
    },
    createContext: async (env: Record<string, unknown>) => ({ session: env['session'] }),
    eventMapping: {},
  })

  it('adds session field to getUser input schema', async () => {
    const domain = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    const { schemas } = createApiPackage({ domainSchemas: domain, middlewares: [sessionMw] })
    expect(schemas.getUser.input.properties).toHaveProperty('session')
    expect(schemas.getUser.input.required).toContain('session')
    expect(schemas.getUser.input.required).toContain('data')
  })

  it('suppresses session from ping via false override', async () => {
    const domain = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    const { schemas } = createApiPackage({
      domainSchemas: domain,
      middlewares: [sessionMw],
      overrides: { ping: { session: false } },
    })
    expect(schemas.ping.input.properties).not.toHaveProperty('session')
    // data wrapper still present
    expect(schemas.ping.input.required).toContain('data')
  })

  it('data:{} present in required even for zero-param ping (no middleware)', async () => {
    const domain = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
    const { schemas } = createApiPackage({ domainSchemas: domain, middlewares: [] })
    expect(schemas.ping.input.required).toContain('data')
    expect(schemas.ping.input.properties).toHaveProperty('data')
  })
})
```

---

## Test file 2 — dispatch round-trip

**`src/test/integration/dispatch.spec.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { generateSchemas } from '@adhd/apigen-core'
import { createApiPackage, dispatch } from '@adhd/apigen-runtime'
import * as realApiFns from '../fixtures/real-api'

const FIXTURE = path.resolve(__dirname, '../fixtures/real-api.ts')

async function setup() {
  const domain = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
  const { schemas, createClient } = createApiPackage({ domainSchemas: domain, middlewares: [] })
  return { schemas, createClient }
}

describe('dispatch — real functions, real schemas', () => {
  it('calls getUser and returns correct shape', async () => {
    const { schemas, createClient } = await setup()
    const result = await dispatch(
      realApiFns as Record<string, (...a: unknown[]) => unknown>,
      createClient,
      schemas.getUser,
      'getUser',
      {},
      { userId: 'abc123' },
    )
    expect(result).toEqual({ id: 'abc123', name: 'Alice', role: 'user' })
  })

  it('calls ping (zero params) and returns true', async () => {
    const { schemas, createClient } = await setup()
    const result = await dispatch(
      realApiFns as Record<string, (...a: unknown[]) => unknown>,
      createClient,
      schemas.ping,
      'ping',
      {},
      {},
    )
    expect(result).toBe(true)
  })

  it('calls createUser with positional args in correct order', async () => {
    const { schemas, createClient } = await setup()
    const result = await dispatch(
      realApiFns as Record<string, (...a: unknown[]) => unknown>,
      createClient,
      schemas.createUser,
      'createUser',
      {},
      { name: 'Bob', role: 'admin' },
    )
    expect(result).toEqual({ id: 'new', name: 'Bob', role: 'admin' })
  })

  it('calls sendEmail (void) and returns undefined/null without throwing', async () => {
    const { schemas, createClient } = await setup()
    const result = await dispatch(
      realApiFns as Record<string, (...a: unknown[]) => unknown>,
      createClient,
      schemas.sendEmail,
      'sendEmail',
      {},
      { to: 'a@b.com', subject: 'hi' },
    )
    expect(result == null).toBe(true)
  })
})
```

---

## Test file 3 — MCP stdio round-trip

**`src/test/integration/mcp.spec.ts`**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as path from 'node:path'

const CLI = path.resolve(__dirname, '../../index.ts')
const FIXTURE = path.resolve(__dirname, '../fixtures/real-api.ts')

async function connectMcpClient() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', CLI, 'run', '--source', FIXTURE, '--type', 'mcp'],
  })
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

describe('MCP stdio — real-api.ts', () => {
  let client: Client | null = null

  afterEach(async () => {
    await client?.close()
    client = null
  })

  it('tools/list returns all exported functions except ctx', async () => {
    client = await connectMcpClient()
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['createUser', 'getUser', 'listUsers', 'ping', 'sendEmail'])
  })

  it('getUser tool call returns correct User shape', async () => {
    client = await connectMcpClient()
    const result = await client.callTool({ name: 'getUser', arguments: { data: { userId: 'abc' } } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toEqual({ id: 'abc', name: 'Alice', role: 'user' })
  })

  it('ping tool call (zero params) returns true', async () => {
    client = await connectMcpClient()
    const result = await client.callTool({ name: 'ping', arguments: { data: {} } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toBe(true)
  })

  it('createUser called with correct positional arg order', async () => {
    client = await connectMcpClient()
    const result = await client.callTool({
      name: 'createUser',
      arguments: { data: { name: 'Bob', role: 'admin' } },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toEqual({ id: 'new', name: 'Bob', role: 'admin' })
  })

  it('getUser inputSchema excludes ctx, includes userId', async () => {
    client = await connectMcpClient()
    const { tools } = await client.listTools()
    const getUserTool = tools.find(t => t.name === 'getUser')!
    const dataProps = (getUserTool.inputSchema as any).properties?.data?.properties ?? {}
    expect(dataProps).not.toHaveProperty('ctx')
    expect(dataProps).toHaveProperty('userId')
  })
})
```

---

## Test file 4 — HTTP plugins round-trip

**`src/test/integration/http.spec.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import { generateSchemas } from '@adhd/apigen-core'
import { createApiPackage } from '@adhd/apigen-runtime'
import * as realApiFns from '../fixtures/real-api'

const FIXTURE = path.resolve(__dirname, '../fixtures/real-api.ts')
const FASTIFY_PORT = 13001
const EXPRESS_PORT = 13002

// Import plugins directly — no CLI spawning needed for HTTP (in-process is fine)
// These imports are resolved once packages are built in prior phases
let fastifyStop: (() => Promise<void>) | null = null
let expressStop: (() => Promise<void>) | null = null

beforeAll(async () => {
  const domain = await generateSchemas({ sourceFile: FIXTURE, exportMode: { type: 'named' } })
  const { schemas, createClient } = createApiPackage({ domainSchemas: domain, middlewares: [] })

  const { default: fastifyPlugin } = await import('@adhd/apigen-plugin-api-fastify')
  const { default: expressPlugin } = await import('@adhd/apigen-plugin-api-express')

  const ctrl = new AbortController()
  const pkgs = [{ id: 'real-api', schemas, importPath: FIXTURE, fns: realApiFns as any, createClient }]

  // Start both in-process
  fastifyPlugin.run!({ packages: pkgs, outputDir: '', options: { port: FASTIFY_PORT }, signal: ctrl.signal })
  expressPlugin.run!({ packages: pkgs, outputDir: '', options: { port: EXPRESS_PORT }, signal: ctrl.signal })

  // Give them a moment to bind
  await new Promise(r => setTimeout(r, 300))
  fastifyStop = expressStop = async () => ctrl.abort()
})

afterAll(async () => {
  await fastifyStop?.()
})

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

describe('Fastify HTTP plugin — POST routes', () => {
  it('POST /real-api/getUser returns User', async () => {
    const result = await post(FASTIFY_PORT, '/real-api/getUser', { data: { userId: 'abc' } })
    expect(result).toEqual({ id: 'abc', name: 'Alice', role: 'user' })
  })

  it('POST /real-api/ping returns true', async () => {
    const result = await post(FASTIFY_PORT, '/real-api/ping', { data: {} })
    expect(result).toBe(true)
  })

  it('POST /real-api/createUser passes args in correct order', async () => {
    const result = await post(FASTIFY_PORT, '/real-api/createUser', { data: { name: 'Bob', role: 'admin' } })
    expect(result).toEqual({ id: 'new', name: 'Bob', role: 'admin' })
  })
})

describe('Express HTTP plugin — identical route shape', () => {
  it('POST /real-api/getUser returns same result as Fastify', async () => {
    const fastifyResult = await post(FASTIFY_PORT, '/real-api/getUser', { data: { userId: 'abc' } })
    const expressResult = await post(EXPRESS_PORT, '/real-api/getUser', { data: { userId: 'abc' } })
    expect(expressResult).toEqual(fastifyResult)
  })

  it('POST /real-api/ping returns true', async () => {
    const result = await post(EXPRESS_PORT, '/real-api/ping', { data: {} })
    expect(result).toBe(true)
  })
})
```

---

## Test file 5 — generate/run parity

**`src/test/integration/parity.spec.ts`**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const CLI = path.resolve(__dirname, '../../index.ts')
const FIXTURE = path.resolve(__dirname, '../fixtures/real-api.ts')

let clients: Client[] = []

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {})
  clients = []
})

async function connectToSource() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', CLI, 'run', '--source', FIXTURE, '--type', 'mcp'],
  })
  const client = new Client({ name: 'parity-source', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  clients.push(client)
  return client
}

async function connectToGenerated(outDir: string) {
  // The generated server.ts is compiled via tsx as well
  const serverFile = path.join(outDir, 'server.ts')
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverFile],
  })
  const client = new Client({ name: 'parity-generated', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  clients.push(client)
  return client
}

describe('generate/run parity — same response from both paths', () => {
  it('tools/list is identical between run and generated server', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-parity-'))

    // Generate
    const { execFileSync } = await import('node:child_process')
    execFileSync('npx', ['tsx', CLI, 'generate', '--source', FIXTURE, '--type', 'mcp', '--out-dir', outDir], {
      stdio: 'inherit',
    })

    expect(fs.existsSync(path.join(outDir, 'server.ts'))).toBe(true)

    const [sourceClient, generatedClient] = await Promise.all([
      connectToSource(),
      connectToGenerated(outDir),
    ])

    const [sourceTools, generatedTools] = await Promise.all([
      sourceClient.listTools(),
      generatedClient.listTools(),
    ])

    expect(generatedTools.tools.map(t => t.name).sort()).toEqual(
      sourceTools.tools.map(t => t.name).sort()
    )
  })

  it('getUser callTool returns identical response from run vs generated server', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-parity-call-'))

    const { execFileSync } = await import('node:child_process')
    execFileSync('npx', ['tsx', CLI, 'generate', '--source', FIXTURE, '--type', 'mcp', '--out-dir', outDir], {
      stdio: 'inherit',
    })

    const [sourceClient, generatedClient] = await Promise.all([
      connectToSource(),
      connectToGenerated(outDir),
    ])

    const args = { data: { userId: 'parity-test' } }
    const [sourceResult, generatedResult] = await Promise.all([
      sourceClient.callTool({ name: 'getUser', arguments: args }),
      generatedClient.callTool({ name: 'getUser', arguments: args }),
    ])

    const sourceText = (sourceResult.content as Array<{ type: string; text: string }>)[0].text
    const generatedText = (generatedResult.content as Array<{ type: string; text: string }>)[0].text

    expect(JSON.parse(generatedText)).toEqual(JSON.parse(sourceText))
  })
})
```

---

## Test file 6 — run-registry multi-package

**`src/test/integration/registry.spec.ts`**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as path from 'node:path'

const CLI = path.resolve(__dirname, '../../index.ts')
const REGISTRY = path.resolve(__dirname, '../fixtures/registry')
// pkg-a exports: hello()
// pkg-b exports: world()
// pkg-c exports: internal() — tagged "internal", not "api"

let client: Client | null = null

afterEach(async () => {
  await client?.close()
  client = null
})

describe('run-registry — multi-package MCP', () => {
  it('discovers api-tagged packages, excludes non-api', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', CLI, 'run-registry',
        '--packages-dir', REGISTRY,
        '--tag', 'api',
        '--type', 'mcp',
      ],
    })
    client = new Client({ name: 'registry-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)

    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()

    expect(names).toContain('hello')
    expect(names).toContain('world')
    expect(names).not.toContain('internal')  // pkg-c excluded by tag
    expect(names).toHaveLength(2)
  })

  it('routes tool call to correct package — hello → pkg-a', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', CLI, 'run-registry',
        '--packages-dir', REGISTRY,
        '--tag', 'api',
        '--type', 'mcp',
      ],
    })
    client = new Client({ name: 'registry-route-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)

    const result = await client.callTool({ name: 'hello', arguments: { data: {} } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toBe('a')  // pkg-a/index.ts: export function hello() { return 'a' }
  })
})
```

---

## Test file 7 — export modes

**`src/test/integration/export-modes.spec.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { generateSchemas } from '@adhd/apigen-core'

const FIXTURES = path.resolve(__dirname, '../fixtures')

describe('export mode: default', () => {
  it('extracts functions from default export object', async () => {
    // fixtures/default-api.ts: export default { getUser, ping }
    const schemas = await generateSchemas({
      sourceFile: path.join(FIXTURES, 'default-api.ts'),
      exportMode: { type: 'default' },
    })
    expect(Object.keys(schemas).sort()).toEqual(['getUser', 'ping'])
    // ctx still excluded in default mode
    const props = schemas.getUser?.params?.map(p => p.name) ?? []
    expect(props).not.toContain('ctx')
  })
})

describe('export mode: named-object', () => {
  it('extracts functions from named export object', async () => {
    // fixtures/object-api.ts: export const userService = { getUser, ping }
    const schemas = await generateSchemas({
      sourceFile: path.join(FIXTURES, 'object-api.ts'),
      exportMode: { type: 'named-object', name: 'userService' },
    })
    expect(Object.keys(schemas).sort()).toEqual(['getUser', 'ping'])
  })
})
```

Additional fixture files needed:

**`src/test/fixtures/default-api.ts`**:
```typescript
const api = {
  async getUser(ctx: unknown, userId: string) { return { id: userId } },
  async ping() { return true },
}
export default api
// [conv:fixture-samples] — derived ground truth for the probe
export const __samples__: Record<string, Record<string, unknown>> = {
  getUser: { userId: 'abc' },
  ping: {},
}
```

**`src/test/fixtures/object-api.ts`**:
```typescript
export const userService = {
  async getUser(ctx: unknown, userId: string) { return { id: userId } },
  async ping() { return true },
}
// [conv:fixture-samples] — derived ground truth for the probe
export const __samples__: Record<string, Record<string, unknown>> = {
  getUser: { userId: 'abc' },
  ping: {},
}
```

---

## Registry fixtures (already in cli-generate-cmd.md, augmented here)

**`src/test/fixtures/registry/pkg-c/index.ts`** — excluded package:
```typescript
export function internal() { return 'secret' }
// [conv:fixture-samples]
export const __samples__: Record<string, Record<string, unknown>> = { internal: {} }
```

**`src/test/fixtures/registry/pkg-c/package.json`**:
```json
{ "name": "@test/pkg-c", "tags": ["internal"] }
```

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/cli/src/test/fixtures/real-api.ts",
            "packages/apigen/cli/src/test/fixtures/default-api.ts",
            "packages/apigen/cli/src/test/fixtures/object-api.ts",
            "packages/apigen/cli/src/test/fixtures/registry/pkg-c/index.ts",
            "packages/apigen/cli/src/test/fixtures/registry/pkg-c/package.json",
            "packages/apigen/cli/src/test/integration/schema.spec.ts",
            "packages/apigen/cli/src/test/integration/dispatch.spec.ts",
            "packages/apigen/cli/src/test/integration/mcp.spec.ts",
            "packages/apigen/cli/src/test/integration/http.spec.ts",
            "packages/apigen/cli/src/test/integration/parity.spec.ts",
            "packages/apigen/cli/src/test/integration/registry.spec.ts",
            "packages/apigen/cli/src/test/integration/export-modes.spec.ts"]
read_only:  ["packages/apigen/*/src/"]
```

---

## Acceptance criteria

- `[integration-tests-v2.1]` `schema.spec.ts` — `ctx` absent from extracted schemas for all fixtures, `filter` optional, `ping` has zero domain params, `data:{}` in required.
- `[integration-tests-v2.2]` `schema.spec.ts` — middleware `session` field appears; `false` override suppresses it from `ping` only.
- `[integration-tests-v2.3]` `dispatch.spec.ts` — `dispatch()` calls real functions; `getUser('abc')` returns `{id:'abc',...}`; `ping()` returns `true`; void return doesn't throw.
- `[integration-tests-v2.4]` `dispatch.spec.ts` — `createUser('Bob','admin')` args arrive in correct positional order (not swapped).
- `[integration-tests-v2.5]` `mcp.spec.ts` — `tools/list` returns exactly `[createUser, getUser, listUsers, ping, sendEmail]` (no `ctx`-only functions appearing).
- `[integration-tests-v2.6]` `mcp.spec.ts` — `callTool('getUser', {data:{userId:'abc'}})` returns `{id:'abc',name:'Alice',role:'user'}`.
- `[integration-tests-v2.7]` `mcp.spec.ts` — `callTool('ping', {data:{}})` returns `true`.
- `[integration-tests-v2.8]` `http.spec.ts` — `POST /real-api/getUser {data:{userId:'abc'}}` returns `{id:'abc',...}` from both Fastify and Express.
- `[integration-tests-v2.9]` `http.spec.ts` — Fastify and Express return identical JSON for the same request (route parity).
- `[integration-tests-v2.10]` `parity.spec.ts` — `tools/list` from `run` mode and `tools/list` from `generate`+run-generated-server are identical.
- `[integration-tests-v2.11]` `parity.spec.ts` — `callTool('getUser',...)` returns same JSON from `run` and from generated server.
- `[integration-tests-v2.12]` `registry.spec.ts` — `run-registry --tag api` discovers `pkg-a` and `pkg-b`, excludes `pkg-c`; tools list has exactly `hello` and `world`.
- `[integration-tests-v2.13]` `registry.spec.ts` — `callTool('hello', ...)` routes to `pkg-a` and returns `'a'` (not silently routed to `pkg-b`).
- `[integration-tests-v2.14]` `export-modes.spec.ts` — default and named-object export modes extract the same function signatures as named mode.

---

## Commit points

1. After fixtures written: `test(apigen-cli): add real-api fixture with ctx, optional, void, zero-param coverage`
2. After schema + dispatch specs pass: `test(apigen-cli): integration tests — schema extraction and dispatch`
3. After MCP spec passes: `test(apigen-cli): integration tests — MCP stdio round-trip`
4. After HTTP spec passes: `test(apigen-cli): integration tests — HTTP plugins round-trip and parity`
5. After parity + registry specs pass: `test(apigen-cli): integration tests — generate/run parity and multi-package registry`
