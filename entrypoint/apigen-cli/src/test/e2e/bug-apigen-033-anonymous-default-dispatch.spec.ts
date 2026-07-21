// BUG-APIGEN-033 regression — anonymous default-export functions must
// actually be CALLABLE at dispatch time, not just listed in the schema.
//
// Root cause: `extract.ts` (Shape 5, anonymous default export — a real fn
// expression/arrow with no name) synthesized a filename-derived operation
// name (e.g. `foo_default`) — this became the route/tool/schema key. But
// `apigen-engine-runtime/src/lib/fn-table.ts`'s `buildFnTable()`, which
// builds the `name -> fn` table dispatch actually indexes into, keys every
// function by its JS-inferred `.name` property. ECMAScript's `export default
// AssignmentExpression` NamedEvaluation rule gives an anonymous
// default-exported fn/arrow a real runtime `.name` of `"default"` — so
// `buildFnTable` produced `fns['default']`, never `fns['foo_default']`. At
// dispatch time `fns[operationName]` was `undefined` -> crash, even though
// the operation was correctly listed in the served schema/tool listing.
//
// This MUST run against the BUILT bin as a real `node` child process (no
// vitest transform in the loop) — the exact runtime path that broke. tsx
// (the ESM loader `importSource()` registers, matching how `run.ts` loads a
// TypeScript source at runtime) double-wraps a CJS-interop-compiled default
// export as `default.default` before `buildFnTable`'s unwrap logic resolves
// the real function under its runtime `.name`; Vitest's own SSR transform
// resolves the fixture differently and would mask this exact class of bug
// (see `import-source-cjs-format.spec.ts`'s header comment for the established
// precedent — same lesson, different trigger).
//
// Pre-fix: `tools/list` shows a `foo_default`-style tool name, but
// `tools/call` on it throws ("fns[fnName] is not a function" / MCP tool-call
// error), because dispatch looks up `fns['foo_default']` in a table that only
// ever contains `fns['default']`.
// Post-fix: the tool is named `'default'` (the runtime `.name`, matching
// `buildFnTable`'s only possible key for this shape) and `tools/call`
// deep-equals the in-process ground truth.

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BUILT_BIN = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'dist',
  'index.js'
);
const shapesDir = path.join(__dirname, '..', 'fixtures', 'shapes');

let mcpClient: Client | undefined;
let mcpTransport: StdioClientTransport | undefined;

afterEach(async () => {
  if (mcpClient) {
    await mcpClient.close().catch(() => undefined);
    mcpClient = undefined;
  }
  if (mcpTransport) {
    await mcpTransport.close().catch(() => undefined);
    mcpTransport = undefined;
  }
});

async function connectTo(sourceFile: string): Promise<Client> {
  mcpTransport = new StdioClientTransport({
    command: 'node',
    args: [BUILT_BIN, 'run', '--source', sourceFile, '--type', 'mcp'],
    cwd: REPO_ROOT,
  });
  mcpClient = new Client(
    { name: 'bug-apigen-033-test', version: '1.0.0' },
    { capabilities: {} }
  );
  await mcpClient.connect(mcpTransport);
  return mcpClient;
}

describe('BUG-APIGEN-033: anonymous default-export dispatch, against the REAL built bin over real MCP stdio', () => {
  it('Shape 5 (`export default (n) => ...`) is listed AND callable — tools/call returns the real result, not a dispatch crash', async () => {
    const client = await connectTo(path.join(shapesDir, 'anonymous-default.ts'));

    const listed = await client.listTools();
    // The tool must be named 'default' — the runtime .name buildFnTable can
    // actually resolve — not a filename-derived synthetic id.
    expect(listed.tools.map((t) => t.name)).toEqual(['default']);

    // Pre-fix this call would throw/error ("function not found") because
    // dispatch looked up a key buildFnTable never produced.
    const res = (await client.callTool({
      name: 'default',
      arguments: { data: { n: 21 } },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError, JSON.stringify(res)).not.toBe(true);
    const got = JSON.parse(
      res.content.find((c) => c.type === 'text')?.text ?? 'null'
    );
    expect(got).toBe(42);
  }, 30_000);

  it('Shape 4 anonymous sub-case (`export default function(n){...}`) is listed AND callable', async () => {
    const client = await connectTo(
      path.join(shapesDir, 'anonymous-default-fn-decl.ts')
    );

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['default']);

    const res = (await client.callTool({
      name: 'default',
      arguments: { data: { n: 7 } },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError, JSON.stringify(res)).not.toBe(true);
    const got = JSON.parse(
      res.content.find((c) => c.type === 'text')?.text ?? 'null'
    );
    expect(got).toBe(21);
  }, 30_000);

  it('negative control: a NAMED default export (Shape 4, declared name) is unaffected by this fix', async () => {
    const client = await connectTo(path.join(shapesDir, 'default-fn.ts'));

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['greet']);

    const res = (await client.callTool({
      name: 'greet',
      arguments: { data: { name: 'Ada' } },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError, JSON.stringify(res)).not.toBe(true);
    const got = JSON.parse(
      res.content.find((c) => c.type === 'text')?.text ?? 'null'
    );
    expect(got).toBe('hello Ada');
  }, 30_000);
});
