/**
 * Schedule exploration over the memory-fs scheduler (ticket 8468f7b1):
 * exhaustive depth-first enumeration of every interleaving (bounded by a
 * run budget) plus seeded-random schedules for larger cases.
 */
import type { SchedulePicker } from '../../src/lib/memory-fs';

/** Runs one scenario with the given picker and asserts its invariants. */
export type ScenarioRun = (pick: SchedulePicker) => Promise<void>;

export interface ExploreResult {
  runs: number;
  /** True when every interleaving was enumerated within the budget. */
  complete: boolean;
}

/** Enumerate interleavings depth-first, at most `maxRuns` of them. */
export async function exploreExhaustive(
  run: ScenarioRun,
  maxRuns: number,
): Promise<ExploreResult> {
  let prefix: number[] = [];
  let runs = 0;
  for (;;) {
    const trace: Array<{ choice: number; width: number }> = [];
    await run((pending) => {
      const i = trace.length;
      const choice = i < prefix.length ? prefix[i] : 0;
      trace.push({
        choice,
        width: pending.length,
      });
      return choice;
    });
    runs += 1;
    let i = trace.length - 1;
    while (i >= 0 && trace[i].choice + 1 >= trace[i].width) i -= 1;
    if (i < 0) {
      return {
        runs,
        complete: true,
      };
    }
    if (runs >= maxRuns) {
      return {
        runs,
        complete: false,
      };
    }
    prefix = trace.slice(0, i).map((t) => t.choice);
    prefix.push(trace[i].choice + 1);
  }
}

/** Deterministic PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `runs` seeded-random schedules (seeds 1..runs). */
export async function exploreRandom(
  run: ScenarioRun,
  runs: number,
): Promise<void> {
  for (let seed = 1; seed <= runs; seed += 1) {
    const rnd = seeded(seed);
    await run((pending) => Math.floor(rnd() * pending.length));
  }
}
