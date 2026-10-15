import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildId, composeSchemas } from '@adhd/apigen-core-client';
import type { GeneratedSchemas, Operation } from '@adhd/apigen-core-client';
import { commandBaseName, segmentOf, sourceNameOf } from './command-name';
import { createLauncherTransport } from './launcher-transport';
import type { IProcessHandle, IProcessLauncher } from './process';
import { startError } from './types';
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

/** Producer tag (`Operation.host`) of the MCP translator (ADR-0017). */
export const MCP_HOST = 'mcp';

/** The binding key (`Operation.binding`) of every operation of the MCP source `name`: `mcp:<name>`. */
export function mcpBindingOf(name: string): string {
  return `mcp:${name}`;
}

/** Result of {@link operationsFromMcpTools}. */
export interface IMcpTranslation {
  /** One operation per exposed tool, in `tools/list` order. */
  readonly operations: Operation[];
  /** Tools that were not exposed, with the reason. */
  readonly skipped: ISkippedTool[];
  /** Upstream `readOnlyHint` / `destructiveHint` per operation id (advisory only). */
  readonly hints: McpHints;
  /** Every exposed upstream `Tool`, by upstream name. */
  readonly tools: Map<string, Tool>;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * The pure MCP translator (ADR-0017, gap analysis §3e): maps the raw entries of an upstream
 * `tools/list` (all pages, unvalidated) to apigen IR. Starts nothing and talks to nothing, so
 * a remote MCP source can reuse it unchanged.
 *
 * Each exposed tool becomes one `action` operation:
 * - `id` is rendered by the core `buildId` from the source name and the tool name
 *   (`<source>/<tool>`; each segment is tokenised, so `read_file` renders `read-file`);
 *   `namespace` is the source segment and the path tail's `raw` is the upstream tool name.
 * - `host: 'mcp'` (the producer tag), `binding: 'mcp:<name>'` (the runtime adapter key).
 * - `input` is the tool's `inputSchema`; `output = {}` (the upstream result is a
 *   `CallToolResult`, not an instance of the tool's `outputSchema`).
 * - `safe` is ALWAYS `false`: the upstream's `readOnlyHint` is an untrusted claim and rides
 *   only in the advisory `hints` map (D-08).
 * - `tool` carries the upstream `title` and `annotations` when present (E3).
 *
 * A tool with an invalid definition, a non-object `inputSchema`, a duplicate name, a reserved
 * name (`__proto__`, `constructor`, `prototype`) or a name whose rendered id collides with an
 * earlier tool's id is skipped and listed in `skipped`, with one `onWarn` line each; the rest
 * of the source stays usable.
 *
 * @param rawTools - The `tools` entries of every `tools/list` page, as received.
 * @param name     - The user-chosen source name (already normalised, e.g. by `sourceNameOf`);
 *                   never the upstream's own `serverInfo.name`.
 * @param onWarn   - Receives one line per skipped tool.
 */
export function operationsFromMcpTools(
  rawTools: readonly unknown[],
  name: string,
  onWarn: (line: string) => void
): IMcpTranslation {
  const operations: Operation[] = [];
  const hints: Record<string, { readOnly?: boolean; destructive?: boolean }> = {};
  const skipped: ISkippedTool[] = [];
  const tools = new Map<string, Tool>();
  const ids = new Map<string, string>();
  const namespace = segmentOf(name);
  const binding = mcpBindingOf(name);

  const skip = (tool: string, reason: string): void => {
    skipped.push({ tool, reason });
    onWarn(`apigen-gateway: skipping upstream tool ${JSON.stringify(tool)} of ${name}: ${reason}`);
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
    const tail = segmentOf(tool.name);
    const id = buildId(namespace, [tail]);
    const clash = ids.get(id);
    if (clash !== undefined) {
      skip(tool.name, `operation id ${JSON.stringify(id)} already taken by tool ${JSON.stringify(clash)}`);
      continue;
    }
    ids.set(id, tool.name);
    tools.set(tool.name, tool);

    const annotations = tool.annotations as Record<string, unknown> | undefined;
    const title = typeof tool.title === 'string' ? tool.title : undefined;
    const meta: { title?: string; annotations?: Record<string, unknown> } = {
      ...(title !== undefined ? { title } : {}),
      ...(annotations !== undefined ? { annotations: { ...annotations } } : {}),
    };
    operations.push({
      id,
      host: MCP_HOST,
      binding,
      namespace,
      path: [tail],
      kind: 'action',
      async: true,
      streaming: false,
      // Never trust the upstream's readOnlyHint for a decision the host or Layer makes.
      safe: false,
      input: tool.inputSchema as Record<string, unknown>,
      output: {},
      envelope: {},
      typeText: null,
      hasCtx: false,
      ...(Object.keys(meta).length > 0 ? { tool: meta } : {}),
    });
    const ann = tool.annotations;
    if (ann && (ann.readOnlyHint !== undefined || ann.destructiveHint !== undefined)) {
      hints[id] = {
        ...(ann.readOnlyHint !== undefined ? { readOnly: ann.readOnlyHint } : {}),
        ...(ann.destructiveHint !== undefined ? { destructive: ann.destructiveHint } : {}),
      };
    }
  }

  return { operations, skipped, hints, tools };
}

/**
 * D-08. Starts the process, connects an SDK `Client` over {@link createLauncherTransport},
 * performs `initialize` bounded by `handshakeTimeoutMs` (default 10000), lists tools
 * (following cursors) and translates them with {@link operationsFromMcpTools}. The source
 * name is the USER-CHOSEN `spec.name` when given, else the command basename, lowercased to
 * `[a-z0-9_-]`; the upstream's own `serverInfo.name` is never used (an upstream could
 * otherwise claim another source's prefix and inherit its permissions).
 *
 * The resolved source also carries `mcp`: the full upstream `Tool` objects and a verbatim
 * `callTool` (arguments exactly as given, result exactly as returned). The positional
 * `pkg.fns` table (keyed by upstream tool name, the path tail's `raw`) remains for hosts that
 * dispatch through apigen, but it can only pass the arguments the schema declares.
 * `dispose()` closes the client and kills the process group.
 *
 * A process that cannot be started, or a handshake / `tools/list` failure or timeout, rejects
 * with `makeUnavailableError('mcp:<name>', '(start)', reason)` (the stderr tail is appended to
 * the reason) and the process is killed; there is no argv fallback.
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
  const server = sourceNameOf(spec.command, spec.name);
  const binding = mcpBindingOf(server);
  let handle: IProcessHandle;
  try {
    handle = await deps.launcher.start({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      ...(spec.env ? { env: spec.env } : {}),
    });
  } catch (e) {
    throw startError(binding, e);
  }

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

  const fail = async (message: string): Promise<never> => {
    await dispose();
    const tail = stderrTail.trim();
    throw startError(binding, tail ? `${message} (stderr: ${tail})` : message);
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
    return fail(`MCP handshake with ${spec.command} failed: ${describeError(e)}`);
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
    return fail(`tools/list on ${spec.command} failed: ${describeError(e)}`);
  }

  const info = client.getServerVersion();
  const { operations, skipped, hints, tools } = operationsFromMcpTools(rawTools, server, onWarn);
  const generated: GeneratedSchemas = { metadata: { namespace: server, phase: '' }, schemas: Object.create(null) };
  const fns: Record<string, (...a: unknown[]) => unknown> = Object.create(null);

  for (const operation of operations) {
    // The path tail's `raw` is the upstream tool name: the key of `pkg.fns` / `pkg.schemas`.
    const toolName = operation.path[operation.path.length - 1]?.raw ?? operation.id;
    const input = operation.input;
    generated.schemas[toolName] = { input, output: {}, safe: false };
    const paramNames = Object.keys((input['properties'] as Record<string, unknown> | undefined) ?? {});
    fns[toolName] = async (...positional: unknown[]) => {
      const args: Record<string, unknown> = {};
      paramNames.forEach((param, i) => {
        if (positional[i] !== undefined) args[param] = positional[i];
      });
      const result = (await client.callTool({ name: toolName, arguments: args })) as {
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

  const composed = composeSchemas(generated, []);

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
