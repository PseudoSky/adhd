// A started gateway holding one MCP upstream adapter over the in-process stub upstream. No
// process is spawned: the stub speaks newline-delimited JSON-RPC behind a fake launcher.

import { createGateway } from '../../lib/gateway';
import type { BackoffPolicy, Gateway } from '../../lib/gateway';
import { createMcpUpstreamAdapter } from '../../lib/sources';
import type { IMcpUpstreamAdapter, IProcessLauncher } from '../../lib/sources';
import { createStubMcpUpstream } from './stub-mcp-upstream';
import type { IStubMcpUpstream, IStubOptions } from './stub-mcp-upstream';

/** Restarts happen at once (no timers) and without limit unless a test says otherwise. */
export const IMMEDIATE_BACKOFF: BackoffPolicy = { delayMs: () => 0, maxRestarts: 0 };

export interface IUpstreamRigOptions {
  readonly name?: string;
  readonly command?: string;
  readonly backoff?: BackoffPolicy;
  readonly handshakeTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly onWarn?: (line: string) => void;
  /** Replaces the stub's launcher (for example to make later starts fail). */
  readonly wrapLauncher?: (stub: IProcessLauncher) => IProcessLauncher;
  readonly timers?: Parameters<typeof createGateway>[0]['timers'];
}

export interface IUpstreamRig {
  readonly stub: IStubMcpUpstream;
  readonly adapter: IMcpUpstreamAdapter;
  readonly gateway: Gateway;
  /** Stops the gateway (and with it the adapter). Idempotent. */
  stop(): Promise<void>;
}

/** Builds the adapter and gateway for one stub upstream and starts the gateway. */
export async function openUpstreamRig(
  stubOptions: IStubOptions,
  options: IUpstreamRigOptions = {}
): Promise<IUpstreamRig> {
  const stub = createStubMcpUpstream(stubOptions);
  const adapter = createMcpUpstreamAdapter(
    {
      name: options.name ?? 'files',
      transport: { kind: 'stdio', command: options.command ?? 'node', args: ['stub.js'], cwd: '/w' },
    },
    {
      launcher: options.wrapLauncher ? options.wrapLauncher(stub.launcher) : stub.launcher,
      onWarn: options.onWarn ?? (() => undefined),
      ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
      ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
    }
  );
  const gateway = createGateway({
    adapters: [adapter],
    backoff: options.backoff ?? IMMEDIATE_BACKOFF,
    ...(options.timers ? { timers: options.timers } : {}),
  });
  await gateway.start();
  let stopping: Promise<void> | undefined;
  return { stub, adapter, gateway, stop: () => (stopping ??= gateway.stop()) };
}
