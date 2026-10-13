import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { composeSchemas } from '@adhd/apigen-core-client';
import type { GeneratedSchemas, Operation } from '@adhd/apigen-core-client';
import { commandBaseName, segmentOf, sourceNameOf } from './command-name';
import { createLauncherTransport } from './launcher-transport';
import type { IProcessHandle, IProcessLauncher } from './process';
import { SourceError } from './types';
import type { IResolvedSource, ISkippedTool } from './types';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Default per-call wait for an upstream `tools/call` result. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Diagnostic stderr kept for handshake failures. */
const STDERR_TAIL_BYTES = 4096;
/** Tool names that would poison a name-keyed table; skipped and reported. */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Upstream hints per operation id, for `draft` (SRC-03, SRC-14: advisory claims, never a guarantee). */
export type McpHints = Readonly<Record<string, { readOnly?: boolean; destructive?: boolean }>>;

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * D-08. Starts the process, connects an SDK `Client` over {@link createLauncherTransport},
 * performs `initialize` bounded by `handshakeTimeoutMs` (default 10000), lists tools
 * (following cursors) and builds one Operation per tool:
 *
 * - `id = '<source>.<tool>'` where `<source>` is the USER-CHOSEN name: `spec.name` when
 *   given, else the command basename, lowercased to `[a-z0-9_-]`. The upstream's own
 *   `serverInfo.name` is never used (an upstream could otherwise claim another source's
 *   prefix and inherit its permissions).
 * - `input` = the tool's `inputSchema`; `output = {}`; `safe` is ALWAYS `false`: the
 *   upstream's `readOnlyHint` is an untrusted claim and rides only in the advisory
 *   `hints` map.
 * - A tool with a non-object `inputSchema`, a duplicate name, or a reserved name
 *   (`__proto__`, `constructor`, `prototype`) is skipped and listed in `skipped`, with one
 *   `onWarn` line each; the rest of the source stays usable.
 *
 * The resolved source also carries `mcp`: the full upstream `Tool` objects and a verbatim
 * `callTool` (arguments exactly as given, result exactly as returned). The positional
 * `pkg.fns` table remains for hosts that dispatch through apigen, but it can only pass
 * the arguments the schema declares. `dispose()` closes the client and kills the
 * process group. A handshake failure or timeout is `SourceError('handshake-failed')` and
 * the process is killed; there is no argv fallback.
 */
export async function resolveMcpStdioSource(
  spec: {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: Record<string, string>;
    /** User-chosen source name (operation-id prefix); defaults to the command basename. */
    name?: string;
  },
  deps: {
    launcher: IProcessLauncher;
    handshakeTimeoutMs?: number;
    /** Per-call wait for an upstream result (default 120000). */
    callTimeoutMs?: number;
    /** One line per skipped tool; defaults to stderr. */
    onWarn?: (line: string) => void;
  }
): Promise<IResolvedSource & { hints: McpHints; skipped: readonly ISkippedTool[] }> {
  const timeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const onWarn = deps.onWarn ?? defaultWarn;
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

  let closed = false;
  const closeListeners: Array<() => void> = [];
  client.onclose = () => {
    closed = true;
    for (const cb of closeListeners.splice(0)) cb();
  };

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

  // `tools/list` is read untyped and each entry validated on its own: the SDK's typed
  // `listTools` rejects the WHOLE page when one tool is malformed, which would let a single
  // bad tool disable the source.
  const rawTools: unknown[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = (await client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        ResultSchema,
        { timeout: timeoutMs }
      )) as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(page.tools)) throw new Error('tools/list result has no tools array');
      rawTools.push(...page.tools);
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor);
  } catch (e) {
    return fail('handshake-failed', `tools/list on ${spec.command} failed: ${describeError(e)}`);
  }

  const info = client.getServerVersion();
  const server = sourceNameOf(spec.command, spec.name);
  const operations: Operation[] = [];
  const hints: Record<string, { readOnly?: boolean; destructive?: boolean }> = {};
  const skipped: ISkippedTool[] = [];
  const tools = new Map<string, Tool>();
  const generated: GeneratedSchemas = { metadata: { namespace: server, phase: '' }, schemas: Object.create(null) };
  const fns: Record<string, (...a: unknown[]) => unknown> = Object.create(null);

  const skip = (tool: string, reason: string): void => {
    skipped.push({ tool, reason });
    onWarn(`apigen-gateway: skipping upstream tool ${JSON.stringify(tool)} of ${server}: ${reason}`);
  };

  for (const entry of rawTools) {
    const parsed = ToolSchema.safeParse(entry);
    if (!parsed.success) {
      const candidate = entry as { name?: unknown; inputSchema?: { type?: unknown } } | null;
      const label = typeof candidate?.name === 'string' ? candidate.name : '<unnamed>';
      const objectSchema = candidate?.inputSchema?.type === 'object';
      skip(label, objectSchema ? 'invalid tool definition' : 'non-object inputSchema');
      continue;
    }
    const tool: Tool = parsed.data;
    if (RESERVED_TOOL_NAMES.has(tool.name)) {
      skip(tool.name, 'reserved tool name');
      continue;
    }
    if ((tool.inputSchema as { type?: unknown } | undefined)?.type !== 'object') {
      skip(tool.name, 'non-object inputSchema');
      continue;
    }
    if (tools.has(tool.name)) {
      skip(tool.name, 'duplicate tool name');
      continue;
    }
    const id = `${server}.${tool.name}`;
    const input = tool.inputSchema as Record<string, unknown>;
    tools.set(tool.name, tool);
    operations.push({
      id,
      host: 'ts',
      namespace: segmentOf(server),
      path: [{ raw: tool.name, words: segmentOf(tool.name).words }],
      kind: 'action',
      async: true,
      streaming: false,
      // Never trust the upstream's readOnlyHint for a decision the host or Layer makes.
      safe: false,
      input,
      output: {},
      envelope: {},
      typeText: null,
      hasCtx: false,
    });
    generated.schemas[tool.name] = { input, output: {}, safe: false };
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

  const callTool = (
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CallToolResult> =>
    // `request` (not `callTool`) so the SDK adds no client-side output validation: the
    // result is the upstream's, and an McpError here is the upstream's own error.
    client.request(
      { method: 'tools/call', params: { name, ...(args !== undefined ? { arguments: args } : {}) } },
      CallToolResultSchema,
      { timeout: callTimeoutMs, ...(signal ? { signal } : {}) }
    ) as Promise<CallToolResult>;

  // `composeSchemas` stamps `x-apigen-safe: true` on any tool whose arguments are all
  // primitives (the HTTP GET-eligibility rule), which would let an upstream's own argument
  // shape mark a destructive tool safe. No upstream tool is ever safe (G3).
  const composed = composeSchemas(generated, []);
  for (const entry of Object.values(composed)) entry['x-apigen-safe'] = false;

  return {
    sourceId: `bin:${commandBaseName(spec.command)}`,
    operations,
    pkg: {
      id: server,
      version: info?.version ?? '0.0.0',
      schemas: composed,
      importPath: `bin:${spec.command}`,
      fns,
      createClient: async () => undefined,
    },
    hints,
    skipped,
    mcp: {
      tools,
      callTool,
      onClose(cb) {
        if (closed) queueMicrotask(cb);
        else closeListeners.push(cb);
      },
    },
    dispose,
  };
}
