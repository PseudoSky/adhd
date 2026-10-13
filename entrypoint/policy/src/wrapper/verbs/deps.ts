import type { IProcessLauncher } from '@adhd/apigen-engine-gateway';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Ports shared by every wrapper verb. Nothing here reads `process.*`; the mount passes it in. */
export interface IVerbDeps {
  readonly cwd: string;
  /** The user's home directory: the walk-up ceiling for project policy discovery (C7). */
  readonly home?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Spawns the upstream command; defaults to the gateway's real launcher (a sandbox supplies a confining one). */
  readonly launcher?: IProcessLauncher;
  /** `serve`: the transport facing the MCP host. Defaults to stdio over this process's stdin and stdout; a test supplies an in-memory one. */
  readonly hostTransport?: Transport;
  /** `serve`: bound on the upstream's `initialize` handshake in milliseconds (the gateway's default applies when absent). */
  readonly handshakeTimeoutMs?: number;
  readonly readFile?: (path: string) => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
}
