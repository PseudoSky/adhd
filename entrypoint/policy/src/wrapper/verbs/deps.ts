/** Ports shared by every wrapper verb. Nothing here reads `process.*`; the mount passes it in. */
export interface IVerbDeps {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
}
