import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { composeSchemas } from '@adhd/apigen-core-client';
import type { GeneratedSchemas, Operation } from '@adhd/apigen-core-client';
import { commandBaseName, segmentOf } from './command-name';
import { createLauncherTransport } from './launcher-transport';
import type { IProcessHandle, IProcessLauncher } from './process';
import { SourceError } from './types';
import type { IResolvedSource } from './types';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Diagnostic stderr kept for handshake failures. */
const STDERR_TAIL_BYTES = 4096;

/** Upstream hints per operation id, for `draft` (SRC-03, SRC-14: claims, not guarantees). */
export type McpHints = Readonly<Record<string, { readOnly?: boolean; destructive?: boolean }>>;

function sanitizeServerName(raw: string | undefined, command: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean(raw ?? '') || clean(commandBaseName(command)) || 'server';
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * D-08. Starts the process, connects an SDK `Client` over {@link createLauncherTransport},
 * performs `initialize` bounded by `handshakeTimeoutMs` (default 10000), lists tools
 * (following cursors) and builds one Operation per tool: `id = '<server>.<tool>'` with
 * `server` the sanitised `serverInfo.name` (lowercase, `[a-z0-9_-]`, fallback the command
 * basename); `input` = the tool's `inputSchema` (a non-object schema is
 * `SourceError('unsupported')`); `output = {}`; `safe = annotations.readOnlyHint === true`.
 * Hints ride in the returned `hints` map. The fn table is keyed by the upstream tool name
 * verbatim and called positionally by apigen's dispatch: arguments are rebuilt by
 * `inputSchema.properties` key order, so a tool whose schema declares no `properties`
 * receives no arguments. A call returns `{content, structuredContent?, isError?}` taken
 * from the upstream result; an upstream `isError` result is returned as data, never thrown.
 * `dispose()` closes the client and kills the process. A handshake failure or timeout is
 * `SourceError('handshake-failed')` and the process is killed; there is no argv fallback.
 */
export async function resolveMcpStdioSource(
  spec: {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: Record<string, string>;
  },
  deps: { launcher: IProcessLauncher; handshakeTimeoutMs?: number }
): Promise<IResolvedSource & { hints: McpHints }> {
  const timeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const handle: IProcessHandle = await deps.launcher.start({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    ...(spec.env ? { env: spec.env } : {}),
  });

  let stderrTail = '';
  const transport = createLauncherTransport(handle, {
    onStderr: (t) => {
      stderrTail = (stderrTail + t).slice(-STDERR_TAIL_BYTES);
    },
  });
  const client = new Client({ name: 'adhd-apigen-source', version: '0.0.0' }, { capabilities: {} });

  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposing ??= (async () => {
      try {
        await client.close();
      } catch {
        // the transport close below is the authority
      }
      await transport.close();
    })();
    return disposing;
  };

  const fail = async (code: 'handshake-failed' | 'unsupported', message: string): Promise<never> => {
    await dispose();
    const tail = stderrTail.trim();
    throw new SourceError(code, tail ? `${message} (stderr: ${tail})` : message);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no initialize response within ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), deadline]);
  } catch (e) {
    return fail('handshake-failed', `MCP handshake with ${spec.command} failed: ${describeError(e)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const tools = [] as Awaited<ReturnType<Client['listTools']>>['tools'];
  try {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
  } catch (e) {
    return fail('handshake-failed', `tools/list on ${spec.command} failed: ${describeError(e)}`);
  }

  const info = client.getServerVersion();
  const server = sanitizeServerName(info?.name, spec.command);
  const operations: Operation[] = [];
  const hints: Record<string, { readOnly?: boolean; destructive?: boolean }> = {};
  const generated: GeneratedSchemas = { metadata: { namespace: server, phase: '' }, schemas: {} };
  const fns: Record<string, (...a: unknown[]) => unknown> = {};

  for (const tool of tools) {
    if ((tool.inputSchema as { type?: unknown } | undefined)?.type !== 'object') {
      return fail('unsupported', `tool ${tool.name} has a non-object inputSchema`);
    }
    if (Object.prototype.hasOwnProperty.call(fns, tool.name)) {
      return fail('unsupported', `duplicate tool name ${tool.name}`);
    }
    const id = `${server}.${tool.name}`;
    const safe = tool.annotations?.readOnlyHint === true;
    const input = tool.inputSchema as Record<string, unknown>;
    operations.push({
      id,
      host: 'ts',
      namespace: segmentOf(server),
      path: [{ raw: tool.name, words: segmentOf(tool.name).words }],
      kind: 'action',
      async: true,
      streaming: false,
      safe,
      input,
      output: {},
      envelope: {},
      typeText: null,
      hasCtx: false,
    });
    generated.schemas[tool.name] = { input, output: {}, safe };
    const annotations = tool.annotations;
    if (annotations && (annotations.readOnlyHint !== undefined || annotations.destructiveHint !== undefined)) {
      hints[id] = {
        ...(annotations.readOnlyHint !== undefined ? { readOnly: annotations.readOnlyHint } : {}),
        ...(annotations.destructiveHint !== undefined ? { destructive: annotations.destructiveHint } : {}),
      };
    }
    const paramNames = Object.keys((input['properties'] as Record<string, unknown> | undefined) ?? {});
    fns[tool.name] = async (...positional: unknown[]) => {
      const args: Record<string, unknown> = {};
      paramNames.forEach((name, i) => {
        if (positional[i] !== undefined) args[name] = positional[i];
      });
      const result = (await client.callTool({ name: tool.name, arguments: args })) as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: boolean;
      };
      return {
        content: result.content ?? [],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    };
  }

  return {
    sourceId: `bin:${commandBaseName(spec.command)}`,
    operations,
    pkg: {
      id: server,
      version: info?.version ?? '0.0.0',
      schemas: composeSchemas(generated, []),
      importPath: `bin:${spec.command}`,
      fns,
      createClient: async () => undefined,
    },
    hints,
    dispose,
  };
}
