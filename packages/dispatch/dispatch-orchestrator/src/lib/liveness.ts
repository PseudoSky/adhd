/**
 * liveness.ts — dispatch liveness heartbeats (backlog 7ed25125 D-AC2).
 *
 * A running dispatch emits a heartbeat; a node whose heartbeat stops for longer
 * than its deadline is marked dead. The monitor is PURE: it reads time only
 * through the injected `nowMs`, so tests prove the deadline with a fake clock
 * and no sleeping, and production passes `Date.now`.
 */

/** Injectable millisecond clock. Production: `Date.now`. */
export type NowMsFn = () => number;

/** Liveness configuration accepted by the orchestrator. */
export interface LivenessConfig {
  /** A node is dead when `nowMs() - lastHeartbeat > deadlineMs`. */
  deadlineMs: number;
  /** Default: `Date.now`. */
  nowMs?: NowMsFn;
}

export type LivenessState = 'alive' | 'dead' | 'finished';

interface Entry {
  lastBeat: number;
  state: LivenessState;
}

/** Tracks heartbeats for dispatch nodes (task ids / unit ids). */
export class LivenessMonitor {
  private readonly nodes = new Map<string, Entry>();
  private readonly nowMs: NowMsFn;
  readonly deadlineMs: number;

  constructor(config: LivenessConfig) {
    if (!(config.deadlineMs > 0)) throw new Error('LivenessMonitor: deadlineMs must be > 0');
    this.deadlineMs = config.deadlineMs;
    this.nowMs = config.nowMs ?? Date.now;
  }

  /** Begin tracking `id`; the registration itself counts as the first heartbeat. */
  register(id: string): void {
    this.nodes.set(id, { lastBeat: this.nowMs(), state: 'alive' });
  }

  /** Record a heartbeat. A node already marked dead stays dead (no resurrection). */
  heartbeat(id: string): void {
    const e = this.nodes.get(id);
    if (e?.state !== 'alive') return;
    e.lastBeat = this.nowMs();
  }

  /** Mark `id` finished so it is never reported dead afterwards. */
  finish(id: string): void {
    const e = this.nodes.get(id);
    if (e?.state === 'alive') e.state = 'finished';
  }

  /**
   * Mark every alive node whose heartbeat is older than the deadline as dead and
   * return the ids newly marked dead by THIS sweep.
   */
  sweep(): string[] {
    const now = this.nowMs();
    const newlyDead: string[] = [];
    for (const [id, e] of this.nodes) {
      if (e.state === 'alive' && now - e.lastBeat > this.deadlineMs) {
        e.state = 'dead';
        newlyDead.push(id);
      }
    }
    return newlyDead;
  }

  state(id: string): LivenessState | undefined {
    return this.nodes.get(id)?.state;
  }

  isDead(id: string): boolean {
    return this.nodes.get(id)?.state === 'dead';
  }
}
