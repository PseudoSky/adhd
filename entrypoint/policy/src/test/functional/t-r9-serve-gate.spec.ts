/**
 * guards: `adhd-policy serve` lets a caller assert its own attributes (LP-09) through the tool arguments, the MCP `_meta`, or a nested `data` wrapper; treats a missing identity as anything but deny; or drops the BA-2 / BA-3 / BA-4 contract (raw text results, upstream title and description, `permission_denied: <reason>` refusals); or builds the Layer stack out of the LP-14 order.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R9 (serve scenarios), §3 R9 behaviour changes 2; LP-09; ADR-0017 D3
 * red-run: 2026-10-21 control: attributes-layer.ts taking `call.data.attributes ?? call.envelope.attributes` over its source -> 3 failed (all LP-09 tests); control: gate.ts without tracingPlugin -> the Layer order test failed.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGate } from '../../wrapper/gate';
import { createStubMcpUpstream, type IStubMcpUpstream } from '../helpers/stub-mcp-upstream';
import { resultText, startServeSession } from '../helpers/mcp-memory-client';
import { withTmpDir } from '../helpers/tmp';

const POLICY = `version: 1
attributes:
  role: name
defaults:
  - set: { role: guest }
permissions:
  - tool: notes/notes-add
    context: { role: { _eq: writer } }
  - tool: notes/notes-delete
    effect: deny
  - tool: notes/notes-say
    context: { role: { _eq: writer } }
`;

function stub(): IStubMcpUpstream {
  return createStubMcpUpstream({
    tools: [
      { name: 'notes_add', description: 'Add a note', title: 'Add', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'notes_delete', description: 'Delete a note', inputSchema: { type: 'object', properties: {} } },
      { name: 'notes_say', description: 'Says saved', inputSchema: { type: 'object', properties: {} }, result: () => ({ content: [{ type: 'text', text: 'saved' }] }) },
    ],
  });
}

async function withServe(
  identity: string | undefined,
  fn: (ctx: { client: Awaited<ReturnType<typeof startServeSession>>['client']; stub: IStubMcpUpstream }) => Promise<void>
): Promise<void> {
  await withTmpDir('t-r9-serve', async (dir) => {
    const spec = join(dir, 'notes.yaml');
    await writeFile(spec, POLICY);
    const upstream = stub();
    const argv = ['bin:notes-server', '--name', 'notes', '--spec', spec, ...(identity !== undefined ? ['--adhd-attributes', identity] : [])];
    const session = await startServeSession(argv, { cwd: dir, home: dir, launcher: upstream.launcher });
    try {
      await fn({ client: session.client, stub: upstream });
    } finally {
      await session.client.close().catch(() => undefined);
      await session.exit;
    }
  });
}

const SPOOF = { role: 'writer' };

describe('serve gate - the caller cannot assert its own attributes (LP-09)', () => {
  it('an intruder identity stays refused when the host also sends attributes as an argument, in _meta, or under a data wrapper', async () => {
    await withServe('{"role":"intruder"}', async ({ client, stub: upstream }) => {
      const viaArguments = await client.callTool({ name: 'notes_notes_add', arguments: { text: 'x', attributes: SPOOF } });
      const viaMeta = await client.callTool({ name: 'notes_notes_add', arguments: { text: 'x' }, _meta: { attributes: SPOOF } });
      const viaData = await client.callTool({ name: 'notes_notes_add', arguments: { data: { attributes: SPOOF }, text: 'x' } });
      for (const result of [viaArguments, viaMeta, viaData]) {
        expect(result.isError).toBe(true);
        expect(resultText(result)).toMatch(/^permission_denied: /);
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('with no identity configured every spoof attempt is denied (missing attributes deny, never allow)', async () => {
    await withServe(undefined, async ({ client, stub: upstream }) => {
      const plain = await client.callTool({ name: 'notes_notes_add', arguments: { text: 'x' } });
      const spoofed = await client.callTool({ name: 'notes_notes_add', arguments: { text: 'x', attributes: SPOOF }, _meta: { attributes: SPOOF } });
      expect(plain.isError).toBe(true);
      expect(spoofed.isError).toBe(true);
      expect(resultText(spoofed)).toMatch(/^permission_denied: /);
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('the configured identity decides in both directions: a writer is not demoted by a caller-sent intruder', async () => {
    await withServe('{"role":"writer"}', async ({ client, stub: upstream }) => {
      const result = await client.callTool({ name: 'notes_notes_add', arguments: { text: 'x', attributes: { role: 'intruder' } }, _meta: { attributes: { role: 'intruder' } } });
      expect(result.isError).toBeFalsy();
      expect(upstream.calls.map((c) => c.tool)).toEqual(['notes_add']);
    });
  });
});

describe('serve gate - the host-visible contract (BA-2, BA-3, BA-4)', () => {
  it('BA-2 a string answer from the upstream reaches the host as raw text, not a JSON-quoted string', async () => {
    await withServe('{"role":"writer"}', async ({ client }) => {
      const result = await client.callTool({ name: 'notes_notes_say', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toBe('saved');
      expect((result.content as Array<{ text: string }>)[0]?.text).toBe('saved');
    });
  });

  it('BA-3 tools/list carries the upstream title and description for every tool, denied ones included', async () => {
    await withServe('{"role":"writer"}', async ({ client }) => {
      const listed = (await client.listTools()).tools;
      const byName = new Map(listed.map((tool) => [tool.name, tool]));
      expect(byName.get('notes_notes_add')).toMatchObject({ title: 'Add', description: 'Add a note' });
      expect(byName.get('notes_notes_delete')).toMatchObject({ description: 'Delete a note' });
      expect(byName.get('notes_notes_say')).toMatchObject({ description: 'Says saved' });
    });
  });

  it('BA-4 a refusal is an isError result whose text is exactly permission_denied: <reason>, and the upstream never saw the call', async () => {
    await withServe('{"role":"writer"}', async ({ client, stub: upstream }) => {
      const denied = await client.callTool({ name: 'notes_notes_delete', arguments: {} });
      expect(denied.isError).toBe(true);
      expect(resultText(denied)).toBe('permission_denied: denied by permission global:1');
      expect(upstream.calls).toHaveLength(0);
    });
  });
});

describe('serve gate - Layer order (LP-14)', () => {
  it('the stack is tracing, then the attributes layer, then the policy layer', async () => {
    await withTmpDir('t-r9-gate', async (dir) => {
      const gate = await buildGate({ specFiles: [], cwd: dir, stopAt: dir, attributes: { origin: 'none', read: async () => undefined } });
      const ids = gate.usePlugins.map((plugin) => plugin.id);
      expect(ids).toHaveLength(3);
      expect(ids[1]).toBe('adhd-policy-attributes');
      expect(ids[0]).toMatch(/tracing/);
      expect(ids[2]).toMatch(/policy/);
    });
  });
});
