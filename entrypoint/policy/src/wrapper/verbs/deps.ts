import type { IProcessLauncher } from '@adhd/apigen-engine-gateway';

/** Ports shared by every wrapper verb. Nothing here reads `process.*`; the mount passes it in. */
export interface IVerbDeps {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Spawns the upstream command; defaults to the gateway's real launcher (a sandbox supplies a confining one). */
  readonly launcher?: IProcessLauncher;
  readonly readFile?: (path: string) => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
}
