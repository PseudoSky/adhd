// Copied from packages/apigen/apigen-engine-gateway/src/test/helpers (nx module-boundaries forbids a deep import across packages). Shared-helper candidate: see the T17 report.
// An in-process MCP server speaking newline-delimited JSON-RPC behind an IProcessLauncher.
// No process is spawned. It logs every tools/call it receives (`calls` is the stub's own
// log), declares a deliberately false server name, and can be told to misbehave.

import type { IProcessLauncher, IProcessSpec } from '@adhd/apigen-engine-gateway';
import { FakeProcess } from './fake-process';

export interface IStubTool {
  readonly name: string;
  /** Raw wire value: tests may pass malformed definitions on purpose. */
  readonly inputSchema?: unknown;
  readonly description?: string;
  readonly title?: string;
  readonly outputSchema?: unknown;
  readonly annotations?: Record<string, unknown>;
  /** Result for a call; default is a text content block `ok:<name>`. */
  readonly result?: (args: Record<string, unknown> | undefined) => Record<string, unknown>;
  /** JSON-RPC error for a call instead of a result. */
  readonly rpcError?: { readonly code: number; readonly message: string };
  /** The upstream never answers a call to this tool (until it exits). */
  readonly silent?: boolean;
}

export interface IStubOptions {
  readonly tools: readonly IStubTool[];
  /** What `serverInfo.name` says; defaults to the deliberately false `liar-name`. */
  readonly serverName?: string;
  /** Tools per `tools/list` page (cursor paging); default: all in one page. */
  readonly pageSize?: number;
  /** `silent`: initialize is never answered; `error`: a JSON-RPC error. */
  readonly initialize?: 'ok' | 'silent' | 'error';
  /** `error`: tools/list answers a JSON-RPC error. */
  readonly listTools?: 'ok' | 'error';
  /** SIGTERM does not end the process. */
  readonly ignoreSigterm?: boolean;
  /** The launcher rejects instead of starting. */
  readonly failStart?: boolean;
  /** Stderr written as soon as the process starts. */
  readonly bootStderr?: string;
}

export interface IStubCall {
  readonly tool: string;
  readonly args: Record<string, unknown> | undefined;
}

export interface IStubMcpUpstream {
  readonly launcher: IProcessLauncher;
  readonly started: IProcessSpec[];
  /** Every tools/call the upstream received. */
  readonly calls: IStubCall[];
  /** The started process (undefined before `launcher.start`). */
  readonly proc: () => FakeProcess;
}

export function createStubMcpUpstream(options: IStubOptions): IStubMcpUpstream {
  const started: IProcessSpec[] = [];
  const calls: IStubCall[] = [];
  let current: FakeProcess | undefined;
  const serverName = options.serverName ?? 'liar-name';

  const respond = (proc: FakeProcess, payload: Record<string, unknown>): void => {
    queueMicrotask(() => {
      if (!proc.hasExited) proc.stdout(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    });
  };

  const handle = (proc: FakeProcess, message: Record<string, unknown>): void => {
    const id = message['id'];
    const method = message['method'];
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    if (id === undefined) return; // notification
    if (method === 'initialize') {
      if (options.initialize === 'silent') return;
      if (options.initialize === 'error') {
        respond(proc, { id, error: { code: -32603, message: 'initialize refused' } });
        return;
      }
      respond(proc, {
        id,
        result: {
          protocolVersion: params['protocolVersion'],
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: '9.9.9' },
        },
      });
      return;
    }
    if (method === 'ping') {
      // The gateway's readiness probe (McpUpstreamAdapter.ready) round-trips an MCP ping; an unanswered ping leaves the host 'degraded'.
      respond(proc, { id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      if (options.listTools === 'error') {
        respond(proc, { id, error: { code: -32603, message: 'list refused' } });
        return;
      }
      const all = options.tools.map((t) => ({
        name: t.name,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...('inputSchema' in t ? { inputSchema: t.inputSchema } : { inputSchema: { type: 'object', properties: {} } }),
        ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      }));
      const size = options.pageSize ?? all.length;
      const start = typeof params['cursor'] === 'string' ? Number(params['cursor']) : 0;
      const page = all.slice(start, start + Math.max(size, 1));
      const next = start + page.length < all.length ? String(start + page.length) : undefined;
      respond(proc, { id, result: { tools: page, ...(next !== undefined ? { nextCursor: next } : {}) } });
      return;
    }
    if (method === 'tools/call') {
      const name = String(params['name']);
      const args = params['arguments'] as Record<string, unknown> | undefined;
      calls.push({ tool: name, args });
      const tool = options.tools.find((t) => t.name === name);
      if (!tool) {
        respond(proc, { id, error: { code: -32602, message: `no such tool ${name}` } });
        return;
      }
      if (tool.silent) return;
      if (tool.rpcError) {
        respond(proc, { id, error: tool.rpcError });
        return;
      }
      respond(proc, {
        id,
        result: tool.result ? tool.result(args) : { content: [{ type: 'text', text: `ok:${name}` }] },
      });
      return;
    }
    respond(proc, { id, error: { code: -32601, message: `unknown method ${String(method)}` } });
  };

  return {
    started,
    calls,
    proc: () => {
      if (!current) throw new Error('the stub upstream has not been started');
      return current;
    },
    launcher: {
      async start(spec) {
        started.push(spec);
        if (options.failStart) throw new Error(`cannot start ${spec.command}: ENOENT`);
        let buffer = '';
        const proc: FakeProcess = new FakeProcess({
          ...(options.ignoreSigterm ? { ignoreSigterm: true } : {}),
          // A well-behaved stdio server exits when its stdin closes.
          onStdinEnd: (p) => p.exit(0),
          onStdin: (chunk, p) => {
            buffer += chunk;
            for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.trim()) handle(p, JSON.parse(line) as Record<string, unknown>);
            }
          },
        });
        current = proc;
        if (options.bootStderr) proc.stderr(options.bootStderr);
        return proc.handle;
      },
    },
  };
}
