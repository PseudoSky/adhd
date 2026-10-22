/**
 * guards: `adhd-policy serve` lets a denied or ask call reach the upstream MCP server, drops a forced value, trusts the upstream's own server name, or leaves the host or upstream running after shutdown.
 * tier: S
 * cites: docs/plan/policy-core/tickets/T17.md (@S7.1, @S7.2, @S7.3; review fix E5)
 * item: qa-variance (docs/discovery/qa-test-variance-tail-policy.md)
 * red: pending (tests not run per user); assertions are unchanged, each case still gets its own empty directory.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createStdioHostTransport } from '@adhd/apigen-engine-gateway';
import { describe, expect, it, vi } from 'vitest';
import { mcpJsonVerb } from '../../wrapper/verbs/mcp-json';
import { createStubMcpUpstream, type IStubMcpUpstream } from '../helpers/stub-mcp-upstream';
import { resultText, startServeSession, type IServeSession } from '../helpers/mcp-memory-client';
import { capturedDeps } from '../helpers/run-deps';
import { settle } from '../helpers/flush';
import { useScratchDirs } from '../helpers/tmp';

const scratch = useScratchDirs('s7-serve');

/** B7.0: writer may call notes_add with tag forced to "policy"; notes_archive is ask; notes_clear has no permission. */
const NOTES_YAML = `version: 1
attributes:
  role: name
permissions:
  - tool: notes/notes-add
    context: { role: { _eq: writer } }
    set: { tag: policy }
  - tool: notes/notes-archive
    effect: ask
    context: { role: { _eq: writer } }
`;

const WRITER = '{"role":"writer"}';

function createNotesStub(overrides: { serverName?: string } = {}): IStubMcpUpstream {
  const schema = (properties: Record<string, unknown>): object => ({ type: 'object', properties });
  return createStubMcpUpstream({
    ...(overrides.serverName !== undefined ? { serverName: overrides.serverName } : {}),
    tools: [
      { name: 'notes_add', description: 'Add a note', title: 'Add', inputSchema: schema({ text: { type: 'string' }, tag: { type: 'string' } }), annotations: { readOnlyHint: false } },
      { name: 'notes_clear', description: 'Clear all notes', inputSchema: schema({}), annotations: { destructiveHint: true } },
      { name: 'notes_archive', description: 'Archive notes', inputSchema: schema({ before: { type: 'string' } }) },
    ],
  });
}

async function withNotes(
  fn: (ctx: { dir: string; spec: string; stub: IStubMcpUpstream }) => Promise<void>,
  options: { policy?: string } = {}
): Promise<void> {
  await scratch.with('s7-serve', async (dir) => {
    const spec = join(dir, 'notes.yaml');
    await writeFile(spec, options.policy ?? NOTES_YAML);
    await fn({ dir, spec, stub: createNotesStub({}) });
  });
}

/** Runs `fn` with a live serve session and always shuts it down (so a failing assertion leaves no pending verb). */
async function withSession(
  argv: string[],
  options: { dir: string; stub: IStubMcpUpstream; env?: Record<string, string> },
  fn: (session: IServeSession) => Promise<void>
): Promise<void> {
  const session = await startServeSession(argv, { cwd: options.dir, home: options.dir, launcher: options.stub.launcher, ...(options.env ? { env: options.env } : {}) });
  try {
    await fn(session);
  } finally {
    await session.client.close().catch(() => undefined);
    await session.exit;
  }
}

describe('Wrap an unmodified MCP server - serve', () => {
  it('@S7.2 the client sees every upstream tool (denied ones included) under the BA-1 projection <alias>_<tool>, with the upstream definition carried through (D-08)', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      await withSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { dir, stub }, async (session) => {
        const listed = await session.client.listTools();
        expect(listed.tools.map((t) => t.name)).toEqual(['notes_notes_add', 'notes_notes_clear', 'notes_notes_archive']);
        expect(listed.tools[0]).toMatchObject({ name: 'notes_notes_add', title: 'Add', description: 'Add a note', annotations: { readOnlyHint: false } });
        expect(listed.tools[1]).toMatchObject({ name: 'notes_notes_clear', description: 'Clear all notes', annotations: { destructiveHint: true } });
        expect(listed.tools[2]).toMatchObject({ name: 'notes_notes_archive', description: 'Archive notes' });
        expect(listed.tools[0]?.inputSchema).toEqual({ type: 'object', properties: { text: { type: 'string' }, tag: { type: 'string' } } });
        expect(session.client.getServerVersion()?.name).toBe('adhd-policy');
        expect(stub.calls).toEqual([]);
      });
    });
  });

  it('@S7.2 the allowed call reaches the upstream with the forced value: exactly one entry, tag "policy" (regression: set must reach tools/call)', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      await withSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { dir, stub }, async (session) => {
        const result = await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'hello', tag: 'mine' } });
        expect(result.isError).toBeFalsy();
        expect(resultText(result)).toBe('ok:notes_add');
        expect(stub.calls).toEqual([{ tool: 'notes_add', args: { text: 'hello', tag: 'policy' } }]);
      });
    });
  });

  it('@S7.2 a forced value is added when the host omitted the argument, and when it sent no arguments at all', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      await withSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { dir, stub }, async (session) => {
        await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'no tag' } });
        await session.client.callTool({ name: 'notes_notes_add' });
        expect(stub.calls).toEqual([
          { tool: 'notes_add', args: { text: 'no tag', tag: 'policy' } },
          { tool: 'notes_add', args: { tag: 'policy' } },
        ]);
      });
    });
  });

  it('@S7.2 denied and ask calls are refused with the reason and never reach the upstream (call count 0)', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      await withSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { dir, stub }, async (session) => {
        const denied = await session.client.callTool({ name: 'notes_notes_clear', arguments: {} });
        expect(denied.isError).toBe(true);
        expect(resultText(denied)).toMatch(/^permission_denied: .*no permission allows notes\/notes-clear/);
        const asked = await session.client.callTool({ name: 'notes_notes_archive', arguments: { before: 'today' } });
        expect(asked.isError).toBe(true);
        expect(resultText(asked)).toMatch(/^permission_denied: .*requires approval/);
        expect(stub.calls).toHaveLength(0);
        // the same session still serves the allowed call afterwards
        await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'x' } });
        expect(stub.calls).toHaveLength(1);
      });
    });
  });

  it('@S7.2 an unknown tool is a protocol error and a role the policy does not know is refused', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      await withSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', '{"role":"intruder"}'], { dir, stub }, async (session) => {
        await expect(session.client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool/);
        const refused = await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'x' } });
        expect(refused.isError).toBe(true);
        expect(stub.calls).toHaveLength(0);
      });
    });
  });

  it('@S7.3 with no policy and no attributes the built-in default refuses every call, announces "policy: built-in" once, and the upstream log stays empty', async () => {
    await withNotes(async ({ dir, stub }) => {
      await withSession(['bin:notes-server', '--name', 'notes'], { dir, stub }, async (session) => {
        for (const name of ['notes_notes_add', 'notes_notes_clear', 'notes_notes_archive']) {
          const result = await session.client.callTool({ name, arguments: {} });
          expect(result.isError, name).toBe(true);
        }
        expect(stub.calls).toHaveLength(0);
        expect(session.stderr.filter((line) => line.includes('policy: built-in'))).toHaveLength(1);
        expect(session.stdout.join('')).toBe('');
      });
    });
  });

  it('@S7.1 the entry mcp-json wrote is a serve command that works: wrap, then run exactly those arguments', async () => {
    await withNotes(async ({ dir, stub }) => {
      const file = join(dir, '.mcp.json');
      await writeFile(file, JSON.stringify({ mcpServers: { notes: { command: 'notes-server', args: ['--stdio'] } } }));
      expect(await mcpJsonVerb(['init', '--spec', 'notes.yaml'], capturedDeps({ cwd: dir }).deps)).toBe(0);
      const entry = (JSON.parse(await readFile(file, 'utf8')) as { mcpServers: { notes: { command: string; args: string[] } } }).mcpServers.notes;
      expect(entry.command).toBe('adhd-policy');
      expect(entry.args[0]).toBe('serve');
      // The host launches `adhd-policy <args>`; the identity and alias flags go before the `--` that starts the original arguments.
      const dashDash = entry.args.indexOf('--');
      const argv = [...entry.args.slice(1, dashDash), '--name', 'notes', '--adhd-attributes', WRITER, ...entry.args.slice(dashDash)];
      expect(entry.args.slice(dashDash)).toEqual(['--', '--stdio']);
      await withSession(argv, { dir, stub }, async (session) => {
        await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'via wrapped entry', tag: 'mine' } });
        expect(stub.calls).toEqual([{ tool: 'notes_add', args: { text: 'via wrapped entry', tag: 'policy' } }]);
        expect(stub.started[0]).toMatchObject({ command: 'notes-server', args: ['--stdio'], cwd: dir });
      });
    });
  });
});

describe('serve --name - operation ids use the alias the user chose, never the upstream\'s own name', () => {
  const LIAR_POLICY = `version: 1
attributes:
  role: name
permissions:
  - tool: liar-name/notes-clear
    context: { role: { _eq: writer } }
  - tool: notes/notes-add
    context: { role: { _eq: writer } }
`;

  it('@S7.2 serverInfo.name "liar-name" is ignored: a rule written for it grants nothing, the alias rule applies', async () => {
    await withNotes(
      async ({ dir, spec }) => {
        const liar = createNotesStub({ serverName: 'liar-name' });
        await withSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { dir, stub: liar }, async (session) => {
          const clear = await session.client.callTool({ name: 'notes_notes_clear', arguments: {} });
          expect(clear.isError).toBe(true);
          expect(resultText(clear)).toMatch(/^permission_denied: .*no permission allows notes\/notes-clear/);
          const add = await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'ok' } });
          expect(add.isError).toBeFalsy();
          expect(liar.calls.map((c) => c.tool)).toEqual(['notes_add']);
        });
      },
      { policy: LIAR_POLICY }
    );
  });

  it('@S7.2 without --name the alias is the command basename (<basename>_<tool>)', async () => {
    const policy = `version: 1
attributes:
  role: name
permissions:
  - tool: notes-server/notes-add
    context: { role: { _eq: writer } }
`;
    await withNotes(
      async ({ dir, spec, stub }) => {
        await withSession(['bin:/usr/local/bin/notes-server', '--spec', spec, '--adhd-attributes', WRITER], { dir, stub }, async (session) => {
          expect((await session.client.callTool({ name: 'notes_server_notes_add', arguments: { text: 'x' } })).isError).toBeFalsy();
          expect((await session.client.callTool({ name: 'notes_server_notes_clear', arguments: {} })).isError).toBe(true);
          expect(stub.calls.map((c) => c.tool)).toEqual(['notes_add']);
        });
      },
      { policy }
    );
  });
});

describe('Review fix E5 - serve ends with its host and leaves no orphan', () => {
  it('E5 the host closing the transport ends serve with exit 0 and the upstream process is gone', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      const session = await startServeSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { cwd: dir, home: dir, launcher: stub.launcher });
      expect(stub.proc().hasExited).toBe(false);
      await session.client.close();
      expect(await session.exit).toBe(0);
      expect(stub.proc().hasExited).toBe(true);
      expect(stub.proc().stdinEnded || stub.proc().kills.length > 0).toBe(true);
    });
  });

  it('E5 the signal (SIGTERM in the bin) ends serve with exit 0, disconnects the host and kills the upstream', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      const session = await startServeSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { cwd: dir, home: dir, launcher: stub.launcher });
      const hostSawClose = new Promise<void>((resolve) => {
        session.client.onclose = () => resolve();
      });
      session.abort();
      expect(await session.exit).toBe(0);
      await hostSawClose;
      expect(stub.proc().hasExited).toBe(true);
    });
  });

  it('BA-6 the upstream exiting on its own does not end serve: the gateway relaunches it and the host keeps being served', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      const session = await startServeSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], { cwd: dir, home: dir, launcher: stub.launcher });
      expect(stub.started).toHaveLength(1);
      stub.proc().exit(1);
      // The relaunch waits out the gateway's first backoff step; await the observable (a second start), bounded.
      await vi.waitFor(() => expect(stub.started).toHaveLength(2), { timeout: 5000 });
      await vi.waitFor(async () => expect((await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'after restart' } })).isError).toBeFalsy(), { timeout: 5000 });
      expect(stub.calls).toEqual([{ tool: 'notes_add', args: { text: 'after restart', tag: 'policy' } }]);
      await session.client.close();
      expect(await session.exit).toBe(0);
      expect(stub.proc().hasExited).toBe(true);
    });
  });

  it('E5 over real stdio framing, the host closing stdin ends serve with exit 0 and no orphan', async () => {
    await withNotes(async ({ dir, spec, stub }) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const lines: string[] = [];
      let buffered = '';
      stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
          lines.push(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
        }
      });
      const waitForLine = async (predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const found = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find(predicate);
          if (found) return found;
          await settle();
        }
        throw new Error('the awaited message never arrived');
      };
      const stdio = createStdioHostTransport(stdin, stdout);
      const { serveVerb } = await import('../../wrapper/verbs/serve');
      const stderr: string[] = [];
      const controller = new AbortController();
      const exit = serveVerb(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', WRITER], {
        cwd: dir,
        home: dir,
        env: {},
        stdout: () => undefined,
        stderr: (t) => void stderr.push(t),
        launcher: stub.launcher,
        hostTransport: stdio,
        signal: controller.signal,
      });
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } })}\n`);
      await waitForLine((m) => m['id'] === 1);
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notes_notes_add', arguments: { text: 'framed', tag: 'mine' } } })}\n`);
      const reply = await waitForLine((m) => m['id'] === 2);
      expect(JSON.stringify(reply)).toContain('ok:notes_add');
      expect(stub.calls).toEqual([{ tool: 'notes_add', args: { text: 'framed', tag: 'policy' } }]);
      stdin.end();
      expect(await exit).toBe(0);
      expect(stub.proc().hasExited).toBe(true);
    });
  });
});
