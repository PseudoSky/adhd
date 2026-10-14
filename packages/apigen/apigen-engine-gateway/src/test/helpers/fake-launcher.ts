// A fake IProcessLauncher that records every start and never spawns anything.

import type { IProcessLauncher, IProcessSpec } from '../../lib/sources';
import { FakeProcess } from './fake-process';
import type { IFakeProcessOptions } from './fake-process';

export interface IFakeLauncherScript {
  /** Exit code the process ends with once started (default 0). `'hang'` leaves it running until killed. */
  readonly exit?: number | 'hang';
  readonly stdout?: string;
  readonly stderr?: string;
  readonly process?: IFakeProcessOptions;
}

export interface IFakeLauncher extends IProcessLauncher {
  /** Every start, in order, with the exact spec the launcher received. */
  readonly started: IProcessSpec[];
  /** The fake processes, parallel to `started`. */
  readonly processes: FakeProcess[];
}

/**
 * Creates a launcher whose processes follow `script(spec)`. Nothing is spawned; the
 * `started` record is the observable ("the command ran" is `started.length === 1`).
 */
export function createFakeLauncher(
  script: (spec: IProcessSpec) => IFakeLauncherScript = () => ({})
): IFakeLauncher {
  const started: IProcessSpec[] = [];
  const processes: FakeProcess[] = [];
  return {
    started,
    processes,
    async start(spec) {
      started.push(spec);
      const plan = script(spec);
      const proc = new FakeProcess(plan.process);
      processes.push(proc);
      if (plan.stdout !== undefined) proc.stdout(plan.stdout);
      if (plan.stderr !== undefined) proc.stderr(plan.stderr);
      const exit = plan.exit ?? 0;
      if (exit !== 'hang') proc.exit(exit);
      return proc.handle;
    },
  };
}
