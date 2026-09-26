/**
 * flat-content-payload.spec.ts — ADR-0004 default-running REAL-client guard.
 *
 * ADR-0004 (MCP tool output is the flat `content` payload) is proven here by
 * driving the **built** `dist/` entry as a real MCP stdio server through the
 * SDK's own `Client` + `StdioClientTransport` — the way a host consumes it —
 * and asserting on the returned payload. This is deliberately NOT an in-process
 * call of `run()`'s internals: the defect this guards was a transport-level
 * shape disagreement (`content` flat vs `structuredContent` `{result}`), so the
 * proof must cross the real JSON-RPC/stdio seam, never import the build and
 * call functions directly.
 *
 * For a union-returning tool (not a top-level `type:'object'`):
 *   - `content[0].text` parses to the FLAT object, and
 *   - `structuredContent` is `undefined` (no `{result}` envelope, no schema).
 * For an object-returning tool:
 *   - its `outputSchema` is advertised, and `structuredContent` is still
 *     present and mirrors `content`.
 *
 * `apigen-plugin-mcp:test` dependsOn `build` (see project.json), so the server
 * under test is always freshly built. RED-provable: restore the pre-ADR-0004
 * `buildMcpOutputSchema` wrap and the union case fails with the envelope
 * present (demonstrated in the ADR-0004 completion report).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { project } from '@adhd/apigen-engine-naming';
import { operationFor } from '../lib/tool-naming';

const PKG = { id: 'flat-content-pkg', importPath: '@test/flat-content-pkg' };
const getUserName = project(operationFor(PKG, 'getUser')).mcp.name;
const searchName = project(operationFor(PKG, 'search')).mcp.name;

const fixturePath = path.join(__dirname, 'fixtures', 'flat-content-mcp-entry.js');
const distEntry = path.join(__dirname, '..', '..', 'dist', 'index.js');

interface McpTextContent {
  type: string;
  text: string;
}

describe('[ADR-0004] flat-content payload — real MCP stdio client vs the BUILT server', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Fail loudly if the prerequisite artifact is missing — a silent skip would
    // hide a broken build wiring (project.json's test.dependsOn `build`).
    if (!fs.existsSync(distEntry)) {
      throw new Error(
        `built entry missing at ${distEntry} — apigen-plugin-mcp:test must dependOn build`
      );
    }
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath],
    });
    client = new Client(
      { name: 'flat-content-spec-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
  });

  it('advertises an outputSchema for the object tool and NONE for the union tool', async () => {
    const { tools } = await client.listTools();
    const objectTool = tools.find((t) => t.name === getUserName);
    const unionTool = tools.find((t) => t.name === searchName);

    expect(objectTool, `missing tool ${getUserName}`).toBeDefined();
    expect(unionTool, `missing tool ${searchName}`).toBeDefined();
    // Object return: schema still advertised (unchanged by ADR-0004).
    expect(objectTool?.outputSchema).toBeDefined();
    // Union return: no outputSchema (ADR-0004) — nothing to wrap.
    expect(unionTool?.outputSchema).toBeUndefined();
  });

  it('union-returning tool: content is the FLAT payload and structuredContent is undefined', async () => {
    const result = await client.callTool({
      name: searchName,
      arguments: { data: {} },
    });
    const content = (result.content ?? []) as McpTextContent[];

    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual({
      outcome: 'found',
      hits: ['result-1'],
    });
    // ADR-0004: no `{result: …}` envelope, no structuredContent at all.
    expect(result.structuredContent).toBeUndefined();
  });

  it('object-returning tool: structuredContent is still present and mirrors content', async () => {
    const result = await client.callTool({
      name: getUserName,
      arguments: { data: { userId: 'u1' } },
    });
    const content = (result.content ?? []) as McpTextContent[];

    expect(result.structuredContent).toEqual(JSON.parse(content[0]?.text ?? 'null'));
    expect(result.structuredContent).toEqual({ id: 'u1', name: 'User-u1' });
  });
});
