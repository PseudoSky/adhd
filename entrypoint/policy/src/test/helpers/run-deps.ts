import type { IProcessLauncher } from '@adhd/apigen-engine-gateway';
import type { IVerbDeps } from '../../wrapper/verbs/deps';

/** What a verb wrote, with the deps that capture it. */
export interface ICapturedDeps {
  readonly deps: IVerbDeps;
  readonly stdout: string[];
  readonly stderr: string[];
}

/** IVerbDeps with captured stdout/stderr. `home` defaults to `cwd` so policy discovery never walks above the temp directory. */
export function capturedDeps(options: {
  readonly cwd: string;
  readonly launcher?: IProcessLauncher;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly signal?: AbortSignal;
}): ICapturedDeps {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      cwd: options.cwd,
      home: options.home ?? options.cwd,
      env: options.env ?? {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      ...(options.launcher !== undefined ? { launcher: options.launcher } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  };
}
