/**
 * c536ce29 TRC-AC7 — pricing ops-channel emitter.
 *
 * The pull / scheduler / service paths record their lifecycle (`pricing.*` events) on the
 * process-wide `agent-mcp.ops` channel under `resolveLogRoots().ops`. Logging never reaches the
 * caller: every emit is try/caught, and an inert channel makes it a no-op (P2-AC-C).
 */
import type { LogChannel } from '@adhd/agent-plugin-tracing';

import { getLogChannels } from '../wire/channels.js';

/** A channel, or a thunk resolving it lazily; `undefined` selects the process-wide ops channel. */
export type OpsSource = LogChannel | (() => LogChannel) | undefined;

/** Level of a pricing ops record. */
export type OpsLevel = 'info' | 'warn' | 'error';

/** Emits `event` with `fields` on the ops channel; swallows every failure. */
export function pricingOps(
  source: OpsSource,
  event: string,
  fields: Record<string, unknown>,
  level: OpsLevel = 'info'
): void {
  try {
    let ch: LogChannel;
    if (source === undefined) ch = getLogChannels().ops;
    else if (typeof source === 'function') ch = source();
    else ch = source;
    ch.logEvent(event, { component: 'pricing', ...fields }, level);
  } catch {
    /* logging never takes pricing down */
  }
}
