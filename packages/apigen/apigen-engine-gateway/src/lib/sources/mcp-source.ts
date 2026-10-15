import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildId } from '@adhd/apigen-core-client';
import type { Operation } from '@adhd/apigen-core-client';
import { segmentOf } from './command-name';
import { createLauncherTransport } from './launcher-transport';
import type { IProcessHandle, IProcessLauncher } from './process';
import { startError } from './types';
import type { ISkippedTool } from './types';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Default per-call wait for an upstream `tools/call` result. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
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

/** The process an MCP stdio upstream is started from. */
export interface IMcpStdioCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** A started, handshaken MCP stdio upstream: the SDK client plus its raw `tools/list`. */
export interface IOpenedMcpUpstream {
  /** The connected SDK client (for callers that need the typed `callTool`). */
  readonly client: Client;
  /** The `tools` entries of every `tools/list` page, as received (unvalidated). */
  readonly rawTools: readonly unknown[];
  /** The upstream's self-reported version, when it sent one. */
  readonly serverVersion: string | undefined;
  /**
   * `tools/call` with `args` exactly as given and the upstream's result returned verbatim, bounded
   * by the call timeout and `signal`. An error the upstream itself returned rejects with the SDK
   * `McpError`; a call that outlives the timeout rejects with `McpError(RequestTimeout)`.
   */
  callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  /** Round-trips an MCP `ping`, bounded by the handshake timeout; rejects when the upstream is gone. */
  ping(): Promise<void>;
  /** Registers `cb` for when the connection closes (fires immediately, asynchronously, if it already has). */
  onClose(cb: () => void): void;
  /** True once the connection has closed (the process exited or `dispose` ran). */
  isClosed(): boolean;
  /** Closes the client and kills the process group. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Starts the process through `deps.launcher`, connects an SDK `Client` over
 * {@link createLauncherTransport}, performs `initialize` bounded by `handshakeTimeoutMs`
 * (default 10000) and reads `tools/list` (following cursors, entries left unvalidated so one
 * malformed tool cannot disable the source). Shared by the `mcp` extractor and the MCP
 * upstream adapter.
 *
 * A process that cannot be started, or a handshake / `tools/list` failure or timeout, rejects
 * with `makeUnavailableError(binding, '(start)', reason)` (the stderr tail is appended to the
 * reason) after the process was killed; nothing is left running and no close listener fires.
 *
 * @param spec    - The command to start.
 * @param binding - The binding key (`mcp:<name>`) named in startup failures.
 * @param deps    - Process launcher and the handshake / per-call timeouts.
 */
export async function openMcpStdioUpstream(
  spec: IMcpStdioCommand,
  binding: string,
  deps: { launcher: IProcessLauncher; handshakeTimeoutMs?: number; callTimeoutMs?: number }
): Promise<IOpenedMcpUpstream> {
  const timeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
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

  return {
    client,
    rawTools,
    serverVersion: client.getServerVersion()?.version,
    callTool: (name, args, signal) =>
      // `request` (not `callTool`) so the SDK adds no client-side output validation: the
      // result is the upstream's, and an McpError here is the upstream's own error.
      client.request(
        { method: 'tools/call', params: { name, ...(args !== undefined ? { arguments: args } : {}) } },
        CallToolResultSchema,
        { timeout: callTimeoutMs, ...(signal ? { signal } : {}) }
      ) as Promise<CallToolResult>,
    async ping() {
      await client.ping({ timeout: timeoutMs });
    },
    onClose(cb) {
      if (closed) queueMicrotask(cb);
      else closeListeners.push(cb);
    },
    isClosed: () => closed,
    dispose,
  };
}
