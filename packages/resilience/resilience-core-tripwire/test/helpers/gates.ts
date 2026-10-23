/**
 * Gate-driven interleaving over the memory fs (no timers, no polling).
 *
 * Every port operation of every task parks on a gate (a promise only the
 * driver resolves). The driver waits, by event notification, until every
 * task is parked or finished, lets the picker choose one parked operation,
 * resolves its gate and repeats. The schedule is therefore a pure function
 * of the picker, independent of machine load.
 */
import type {
  FsFileHandle,
  FsOpRecord,
  FsPort,
  MemoryFs,
  SchedulePicker,
} from '../../src/lib/memory-fs';
import { processView } from './harness';

interface Parked {
  op: string;
  path: string;
  release: () => void;
}

/** A gated view of a memory fs plus the driver that interleaves tasks over it. */
export interface Gates {
  /** The port to build the storages under test on: every operation parks. */
  fs: FsPort;
  /** Run `tasks` to completion; `pick` chooses which parked operation proceeds. */
  run<T>(
    tasks: ReadonlyArray<() => Promise<T>>,
    pick: SchedulePicker,
  ): Promise<PromiseSettledResult<T>[]>;
}

/** Gate every port operation (and file-handle operation) of `mfs`. */
export function createGates(mfs: MemoryFs): Gates {
  const parked: Parked[] = [];
  let finished = 0;
  let total = 0;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  const gate = (op: string, path: string): Promise<void> =>
    new Promise<void>((release) => {
      parked.push({ op, path, release });
      notify();
    });

  const wrapHandle = (h: FsFileHandle): FsFileHandle => ({
    write: async (d) => {
      await gate('write', '');
      return h.write(d);
    },
    sync: async () => {
      await gate('sync', '');
      return h.sync();
    },
    close: async () => {
      await gate('close', '');
      return h.close();
    },
  });

  const base = processView(mfs);
  const fs: FsPort = {
    mkdir: async (p, m) => (await gate('mkdir', p), base.mkdir(p, m)),
    chmod: async (p, m) => (await gate('chmod', p), base.chmod(p, m)),
    openExclusive: async (p, m) => {
      await gate('openExclusive', p);
      return wrapHandle(await base.openExclusive(p, m));
    },
    appendFile: async (p, d, m, x) =>
      (await gate('appendFile', p), base.appendFile(p, d, m, x)),
    link: async (a, b) => (await gate('link', b), base.link(a, b)),
    rename: async (a, b) => (await gate('rename', b), base.rename(a, b)),
    unlink: async (p) => (await gate('unlink', p), base.unlink(p)),
    readFile: async (p) => (await gate('readFile', p), base.readFile(p)),
    stat: async (p) => (await gate('stat', p), base.stat(p)),
    readdir: async (p) => (await gate('readdir', p), base.readdir(p)),
  };

  return {
    fs,
    async run(tasks, pick) {
      total = tasks.length;
      finished = 0;
      const results = tasks.map((task) =>
        Promise.resolve()
          .then(task)
          .finally(() => {
            finished += 1;
            notify();
          }),
      );
      const all = Promise.allSettled(results);
      for (let step = 0; ; step += 1) {
        // Every task is either parked on a gate or finished: only then pick.
        while (parked.length + finished < total) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (finished === total) break;
        const view = parked.map((p) => ({ op: p.op, path: p.path }) as FsOpRecord);
        const raw = pick(view, step);
        const index = Math.max(0, Math.min(parked.length - 1, raw));
        const [next] = parked.splice(index, 1);
        next.release();
      }
      return all;
    },
  };
}
