// Regression test for BUG-APIGEN-IMPORT-SOURCE-CJS-JS-EXT.
//
// Real-world trigger: `node dist/entrypoint/apigen-cli/index.js run --source
// <path>/index.ts --type api-express` against @adhd/sox-memory-core's
// libs/memory-core/src/index.ts crashed with:
//
//   Error: Cannot find module './db.js'
//   Require stack:
//   - .../memory-core/src/index.ts
//
// even though `db.ts` sits right next to `index.ts`. Root cause: memory-core's
// package.json has no `"type": "module"`, so a plain `node` process treats the
// `.ts` entry as CommonJS and routes its relative imports through Node's real
// CJS `require()` resolver — which `importSource()` (src/lib/import-source.ts)
// only patched via `tsx/esm/api`, not `tsx/cjs/api`. The ESM-only patch doesn't
// cover that CJS-translator require path, so the `.js` -> `.ts` extension
// mapping tsx normally provides never kicks in there.
//
// This MUST run against the BUILT bin as a real `node` child process (no `tsx`
// CLI wrapper, no vitest transform in the loop) — that's the exact runtime path
// that broke. A vitest in-process unit test of `importSource()` would pass
// regardless of the bug, because Vitest's own SSR transform resolves the fixture
// before Node's loader ever sees it.

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
// A `.ts` entry, in a package with NO "type": "module", re-exporting from a
// sibling `.ts` module via a `./helper.js` specifier — the exact shape that
// broke against the real @adhd/sox-memory-core package.
const CJS_FORMAT_SRC = path.join(
  __dirname,
  '..',
  'fixtures',
  'cjs-format-js-import',
  'index.ts'
);

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

describe('importSource: CommonJS-format source with a .js-extension relative specifier', () => {
  it('resolves the sibling .ts module instead of crashing with MODULE_NOT_FOUND', async () => {
    mcpTransport = new StdioClientTransport({
      command: 'node',
      args: [BUILT_BIN, 'run', '--source', CJS_FORMAT_SRC, '--type', 'mcp'],
      cwd: REPO_ROOT,
    });
    mcpClient = new Client(
      { name: 'import-source-cjs-format-test', version: '1.0.0' },
      { capabilities: {} }
    );
    // Pre-fix, the spawned bin process crashes on startup (`Cannot find module
    // './helper.js'`) and this connect() never resolves the handshake — it
    // rejects/times out instead of returning.
    await mcpClient.connect(mcpTransport);

    const listed = await mcpClient.listTools();
    // DEBT-APIGEN-CLI-STALE-ROUTE-TOOL-NAME-ASSERTIONS-001: since BUG-APIGEN-
    // OPENAPI-ROUTE-PATH-MISMATCH-001's MCP-side fix, the tool is registered
    // under project(op).mcp.name (<namespace>_<file>_<export>) — namespace
    // "apigen-cli", file "index" (fixtures/cjs-format-js-import/index.ts),
    // export "greet" — not the raw export name.
    const toolName = 'apigen_cli_index_greet';
    expect(listed.tools.map((t) => t.name)).toEqual([toolName]);

    const res = (await mcpClient.callTool({
      name: toolName,
      arguments: { data: { name: 'world' } },
    })) as { content: Array<{ type: string; text: string }> };
    const got = JSON.parse(
      res.content.find((c) => c.type === 'text')?.text ?? 'null'
    );
    expect(got).toBe('hello world');
  }, 30_000);
});
