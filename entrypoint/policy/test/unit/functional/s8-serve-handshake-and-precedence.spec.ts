/**
 * guards: `serve` falls back to treating a command that is not an MCP server as an argv operation, or merges attribute sources (flag, environment, file) instead of letting the flag win, so a call is allowed that should be refused.
 * tier: S
 * cites: docs/plan/policy-core/tickets/T19.md (@S8.2, @S8.3; D-06, D-08)
 * item: qa-variance (docs/discovery/qa-test-variance-tail-policy.md)
 * red: pending (tests not run per user); assertions are unchanged, each case still gets its own empty directory.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IProcessLauncher } from '@adhd/apigen-engine-gateway';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVerb } from '../../../src/wrapper/verbs/run';
import { serveVerb } from '../../../src/wrapper/verbs/serve';
import { createFakeLauncher } from '../../helpers/fake-launcher';
import { settle } from '../../helpers/flush';
import { resultText, startServeSession } from '../../helpers/mcp-memory-client';
import { capturedDeps } from '../../helpers/run-deps';
import { createStubMcpUpstream, type IStubMcpUpstream } from '../../helpers/stub-mcp-upstream';
import { useScratchDirs } from '../../helpers/tmp';

const scratch = useScratchDirs('s8');

const ATTRIBUTES_ENV = 'ADHD_POLICY_ATTRIBUTES';

const NOTES_POLICY = `version: 1
attributes:
  role: name
permissions:
  - tool: notes/notes-add
    context: { role: { _eq: writer } }
`;

const touchNotes = (): IStubMcpUpstream =>
  createStubMcpUpstream({ tools: [{ name: 'notes_add', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });

afterEach(() => {
  vi.useRealTimers();
});

describe('Safety-relevant failure paths - serve refuses an upstream that is not an MCP server', () => {
  /** Runs serveVerb against `stub` with a spy host transport; returns everything observable. */
  async function serveAgainst(
    dir: string,
    launcher: IProcessLauncher,
    handshakeTimeoutMs?: number,
    advance?: () => Promise<void>
  ): Promise<{ code: number; stderr: string; stdout: string; hostStarted: boolean }> {
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    let hostStarted = false;
    const start = serverSide.start.bind(serverSide);
    serverSide.start = async () => {
      hostStarted = true;
      await start();
    };
    const captured = capturedDeps({ cwd: dir });
    const pending = serveVerb(['bin:notes-server', '--name', 'notes'], {
      ...captured.deps,
      launcher,
      hostTransport: serverSide,
      ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
      signal: new AbortController().signal,
    });
    await advance?.();
    const code = await pending;
    return { code, stderr: captured.stderr.join(''), stdout: captured.stdout.join(''), hostStarted };
  }

  it('@S8.2 an upstream that never answers initialize fails serve with exit 1 after the handshake timeout: nothing registered, no fallback start, process gone', async () => {
    await scratch.with('s8-silent', async (dir) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const stub = createStubMcpUpstream({ tools: [], initialize: 'silent' });
      const result = await serveAgainst(dir, stub.launcher, 50, async () => {
        for (let attempt = 0; attempt < 200 && stub.started.length === 0; attempt += 1) await settle();
        expect(stub.started).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('MCP handshake with notes-server failed');
      expect(result.stderr).toContain('no initialize response within 50ms');
      expect(result.hostStarted).toBe(false);
      expect(result.stdout).toBe('');
      expect(stub.started).toHaveLength(1);
      expect(stub.proc().hasExited).toBe(true);
      expect(stub.calls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('@S8.2 the only thing written to the upstream is MCP JSON-RPC (initialize), never the command-as-argv treatment', async () => {
    await scratch.with('s8-wire', async (dir) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const stub = createStubMcpUpstream({ tools: [], initialize: 'silent' });
      await serveAgainst(dir, stub.launcher, 10, async () => {
        for (let attempt = 0; attempt < 200 && stub.started.length === 0; attempt += 1) await settle();
        await vi.advanceTimersByTimeAsync(10);
      });
      const written = stub.proc().stdinChunks.join('').split('\n').filter((line) => line.trim().length > 0);
      expect(written.length).toBeGreaterThan(0);
      for (const line of written) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
      expect((JSON.parse(written[0] as string) as { method: string }).method).toBe('initialize');
      expect(stub.started[0]).toMatchObject({ command: 'notes-server', args: [] });
    });
  });

  const failures: Array<{ name: string; stub: () => ReturnType<typeof createStubMcpUpstream>; message: RegExp }> = [
    { name: 'initialize answered with a JSON-RPC error', stub: () => createStubMcpUpstream({ tools: [], initialize: 'error' }), message: /MCP handshake with notes-server failed.*initialize refused/s },
    { name: 'tools/list answered with a JSON-RPC error', stub: () => createStubMcpUpstream({ tools: [], listTools: 'error' }), message: /tools\/list on notes-server failed.*list refused/s },
    { name: 'the command cannot be started', stub: () => createStubMcpUpstream({ tools: [], failStart: true }), message: /cannot start notes-server/ },
  ];
  for (const row of failures) {
    it(`@S8.2 ${row.name}: exit 1, the message on stderr, the host transport never started`, async () => {
      await scratch.with('s8-fail', async (dir) => {
        const stub = row.stub();
        const result = await serveAgainst(dir, stub.launcher);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(row.message);
        expect(result.hostStarted).toBe(false);
        expect(result.stdout).toBe('');
        expect(stub.started).toHaveLength(1);
        expect(stub.calls).toEqual([]);
      });
    });
  }

  it('@S8.2 a plain command that prints text and exits (not an MCP server) is an error, not an argv operation', async () => {
    await scratch.with('s8-plain', async (dir) => {
      const launcher = createFakeLauncher(() => ({ exit: 0, stdout: 'hello, I am just a program\n' }));
      const result = await serveAgainst(dir, launcher);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('MCP handshake with notes-server failed');
      expect(result.hostStarted).toBe(false);
      expect(launcher.started).toHaveLength(1);
    });
  });
});

describe('Safety-relevant failure paths - attribute sources do not merge (D-06)', () => {
  async function withRun(fn: (ctx: { dir: string; out: string; gate: string }) => Promise<void>): Promise<void> {
    await scratch.with('s8-run', async (dir) => {
      const out = join(dir, 'out');
      await mkdir(out);
      const gate = join(dir, 'gate.yaml');
      await writeFile(
        gate,
        `version: 1
attributes:
  role: name
  write_roots: paths
defaults:
  - set: { role: guest, write_roots: [] }
permissions:
  - tool: bin/touch
    context: { role: { _eq: dev } }
    args: { cwd: { _within: $attributes.write_roots } }
`
      );
      await fn({ dir, out, gate });
    });
  }

  /** Runs `run bin:touch` and returns the exit code and how many times the command was started. */
  async function runTouch(
    ctx: { out: string; gate: string },
    options: { flag?: string; env?: string }
  ): Promise<{ code: number; starts: number; stderr: string }> {
    const launcher = createFakeLauncher();
    const captured = capturedDeps({ cwd: ctx.out, launcher, env: options.env !== undefined ? { [ATTRIBUTES_ENV]: options.env } : {} });
    const flag = options.flag !== undefined ? ['--adhd-attributes', options.flag] : [];
    const code = await runVerb(['bin:touch', '--spec', ctx.gate, ...flag, '--', 'f.txt'], captured.deps);
    return { code, starts: launcher.started.length, stderr: captured.stderr.join('') };
  }

  it('@S8.3 run: the flag decides and nothing is taken from the environment value (flag dev beats env intern)', async () => {
    await withRun(async (ctx) => {
      const dev = JSON.stringify({ role: 'dev', write_roots: [ctx.out] });
      const result = await runTouch(ctx, { flag: dev, env: JSON.stringify({ role: 'intern' }) });
      expect(result).toMatchObject({ code: 0, starts: 1 });
    });
  });

  it('@S8.3 run: attributes are never merged - the env supplies write_roots the flag lacks and the call is still refused', async () => {
    await withRun(async (ctx) => {
      const result = await runTouch(ctx, { flag: '{"role":"dev"}', env: JSON.stringify({ role: 'dev', write_roots: [ctx.out] }) });
      expect(result).toMatchObject({ code: 3, starts: 0 });
    });
  });

  it('@S8.3 run: a flag that grants less than a permissive env still wins (flag intern, env dev)', async () => {
    await withRun(async (ctx) => {
      const result = await runTouch(ctx, { flag: '{"role":"intern"}', env: JSON.stringify({ role: 'dev', write_roots: [ctx.out] }) });
      expect(result).toMatchObject({ code: 3, starts: 0 });
    });
  });

  it('@S8.3 run: ADHD_POLICY_ATTRIBUTES alone is used when there is no flag, and neither means guest', async () => {
    await withRun(async (ctx) => {
      expect(await runTouch(ctx, { env: JSON.stringify({ role: 'dev', write_roots: [ctx.out] }) })).toMatchObject({ code: 0, starts: 1 });
      expect(await runTouch(ctx, { env: JSON.stringify({ role: 'intern' }) })).toMatchObject({ code: 3, starts: 0 });
      expect(await runTouch(ctx, {})).toMatchObject({ code: 3, starts: 0 });
    });
  });

  it('@S8.3 run: a bad ADHD_POLICY_ATTRIBUTES is not consulted when the flag is present, but refuses to start (exit 2) when it is the only source', async () => {
    await withRun(async (ctx) => {
      const result = await runTouch(ctx, { flag: JSON.stringify({ role: 'dev', write_roots: [ctx.out] }), env: '"not-an-object"' });
      expect(result).toMatchObject({ code: 0, starts: 1 });
      expect(await runTouch(ctx, { env: '"not-an-object"' })).toMatchObject({ code: 2, starts: 0 });
    });
  });

  it('@S8.3 serve: flag writer beats env intruder, env alone works, flag intruder beats env writer', async () => {
    await scratch.with('s8-serve', async (dir) => {
      const spec = join(dir, 'notes.yaml');
      await writeFile(spec, NOTES_POLICY);
      const attempt = async (options: { flag?: string; env?: string }): Promise<number> => {
        const stub = touchNotes();
        const argv = ['bin:notes-server', '--name', 'notes', '--spec', spec, ...(options.flag !== undefined ? ['--adhd-attributes', options.flag] : [])];
        const session = await startServeSession(argv, {
          cwd: dir,
          home: dir,
          launcher: stub.launcher,
          env: options.env !== undefined ? { [ATTRIBUTES_ENV]: options.env } : {},
        });
        try {
          await session.client.callTool({ name: 'notes_notes_add', arguments: { text: 'x' } });
          return stub.calls.length;
        } finally {
          await session.client.close();
          await session.exit;
        }
      };
      expect(await attempt({ flag: '{"role":"writer"}', env: '{"role":"intruder"}' })).toBe(1);
      expect(await attempt({ env: '{"role":"writer"}' })).toBe(1);
      expect(await attempt({ flag: '{"role":"intruder"}', env: '{"role":"writer"}' })).toBe(0);
      expect(await attempt({})).toBe(0);
    });
  });

  it('@S8.3 serve: an attributes @file is re-read on every call - changing it mid-session changes the next decision', async () => {
    await scratch.with('s8-reread', async (dir) => {
      const spec = join(dir, 'notes.yaml');
      const who = join(dir, 'who.json');
      await writeFile(spec, NOTES_POLICY);
      await writeFile(who, '{"role":"writer"}');
      const stub = touchNotes();
      const session = await startServeSession(['bin:notes-server', '--name', 'notes', '--spec', spec, '--adhd-attributes', `@${who}`], { cwd: dir, home: dir, launcher: stub.launcher });
      try {
        expect((await session.client.callTool({ name: 'notes_notes_add', arguments: { text: '1' } })).isError).toBeFalsy();
        await writeFile(who, '{"role":"intruder"}');
        const refused = await session.client.callTool({ name: 'notes_notes_add', arguments: { text: '2' } });
        expect(refused.isError).toBe(true);
        expect(resultText(refused)).toMatch(/^permission_denied: .*no permission allows notes\/notes-add/);
        await writeFile(who, '[1]');
        const broken = await session.client.callTool({ name: 'notes_notes_add', arguments: { text: '3' } });
        expect(broken.isError).toBe(true);
        expect(stub.calls).toHaveLength(1);
      } finally {
        await session.client.close();
        await session.exit;
      }
    });
  });
});
