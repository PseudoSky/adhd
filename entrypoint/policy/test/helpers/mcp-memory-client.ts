import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IProcessLauncher } from '@adhd/apigen-engine-gateway';
import { serveVerb } from '../../src/wrapper/verbs/serve';
import type { IVerbDeps } from '../../src/wrapper/verbs/deps';

/** A running `serve` verb with a real SDK client attached to its host side. */
export interface IServeSession {
  /** The MCP host: an SDK `Client` over an in-memory transport pair connected to the transport `serveVerb` was handed. */
  readonly client: Client;
  /** Resolves with the exit code `serveVerb` returned once it stopped. */
  readonly exit: Promise<number>;
  /** What the verb wrote to stdout / stderr. */
  readonly stdout: string[];
  readonly stderr: string[];
  /** Aborts the signal the verb was given (what SIGTERM does in the bin). */
  readonly abort: () => void;
  /** True once the host-side transport has been started by the server. */
  readonly serverTransportStarted: () => boolean;
}

export interface IServeSessionOptions {
  readonly cwd: string;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly launcher: IProcessLauncher;
  /** Replaces the in-memory pair's server side (for example a stdio transport over PassThrough streams). */
  readonly hostTransport?: Transport;
}

/**
 * Runs `serveVerb(argv, deps)` with an injected launcher and host transport and
 * connects an SDK `Client` to it, exactly as an MCP host would. Only for the paths
 * where the handshake with the upstream succeeds (a failing handshake never
 * answers the client's `initialize`).
 */
export async function startServeSession(argv: readonly string[], options: IServeSessionOptions): Promise<IServeSession> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const hostTransport = options.hostTransport ?? serverSide;
  let started = false;
  const start = hostTransport.start.bind(hostTransport);
  hostTransport.start = async () => {
    started = true;
    await start();
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  const deps: IVerbDeps & { signal: AbortSignal } = {
    cwd: options.cwd,
    ...(options.home !== undefined ? { home: options.home } : {}),
    env: options.env ?? {},
    stdout: (text) => void stdout.push(text),
    stderr: (text) => void stderr.push(text),
    launcher: options.launcher,
    hostTransport,
    signal: controller.signal,
  };
  const exit = serveVerb(argv, deps);
  const client = new Client({ name: 'test-host', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientSide);
  return { client, exit, stdout, stderr, abort: () => controller.abort(), serverTransportStarted: () => started };
}

/** The text of a `tools/call` result's first content block. */
export function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? '').join('');
}
