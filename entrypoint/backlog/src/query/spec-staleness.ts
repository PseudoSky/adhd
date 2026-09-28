/**
 * spec-staleness.ts — the spec staleness compare exposed on every read that can
 * supply a token (C10, DESIGN §12 rung 5). Pure read; no writes.
 *
 * The ladder is cheap-first:
 *  1. TOKEN — `token === current_token` → `fresh`; differs → `stale`. Default rung.
 *  2. CONTENT HASH — recompute `sha256` of the CURRENT FOLD; a match (a bare
 *     hex, or the same hash under a different prefix) proves the frozen state.
 *  3. ANCESTRY — `git merge-base` of the anchored file's recorded commit vs
 *     HEAD; a non-git root or an unanchored revision degrades to `unknown`.
 *
 * **An absent token is STALE, never fresh** (AC3): no token → `stale` with
 * `method: 'none'`, reason `no-token-supplied` — never `fresh`, and never
 * `method: 'token'` (there was no token to compare). `unknown` is never fresh.
 *
 * **Forged-currentness guard (AC7):** the on-record pointer is crossed against
 * the independently-derived chain head. If they disagree, `stale` /
 * `revision-drift` for every caller — the pointer is never silently trusted.
 */

import type { GraphBackend } from '@adhd/sox-graph-store';
import {
  deriveSpecHead,
  readPointerRecord,
} from '../write/spec-revision.js';

export type SpecFreshness = 'fresh' | 'stale' | 'unknown';

export interface ISpecCheckInput {
  uid: string;
  token?: string;
}

export interface ISpecCheckOutcome {
  current_revision: string;
  /** `'sha256:<hex>'` — always this encoding. */
  current_token: string;
  state: SpecFreshness;
  method: 'token' | 'content_hash' | 'ancestry' | 'none';
  reason?: string;
}

/**
 * Negative-control switch — DANGER, test use ONLY. Read on every call (never
 * cached at import time) so it reverts the moment the process exits.
 *
 *  - `'default-fresh'` — emulate the wrong implementation AC3 must catch: an
 *    absent token falls back to the current token and reads `fresh`.
 */
const STALENESS_MODES = ['normal', 'default-fresh'] as const;
type StalenessMode = (typeof STALENESS_MODES)[number];

function resolveStalenessMode(): StalenessMode {
  const raw = process.env['ADHD_BACKLOG_UNSAFE_SPEC_STALENESS'];
  if (raw === undefined) return 'normal';
  if ((STALENESS_MODES as readonly string[]).includes(raw))
    return raw as StalenessMode;
  throw new Error(
    `ADHD_BACKLOG_UNSAFE_SPEC_STALENESS="${raw}" is not a recognized mode (expected ${STALENESS_MODES.join(', ')}). ` +
      'This variable exists solely for negative-control test runs and must never be set in normal operation.'
  );
}

function bareHex(token: string): string {
  return token.startsWith('sha256:') ? token.slice('sha256:'.length) : token;
}

/**
 * Compare the caller's `token` against the ticket's current revision token and
 * report the freshness ladder's verdict. See the module header for the rules.
 * `uid` is the ticket (any uid on its `SUPERSEDES` chain is resolved forward).
 */
export async function checkSpecStaleness(
  graph: GraphBackend,
  input: ISpecCheckInput
): Promise<ISpecCheckOutcome> {
  const mode = resolveStalenessMode();

  const pointer = await readPointerRecord(graph, input.uid);
  const derived = await deriveSpecHead(graph, input.uid);

  // AC7 — the pointer is never silently trusted: a divergence between the
  // on-record pointer and the derived chain head is `stale` for every caller.
  if (
    pointer !== undefined &&
    derived !== undefined &&
    pointer.revision_uid !== derived.revision_uid
  ) {
    return {
      current_revision: derived.revision_uid,
      current_token: derived.revision_token,
      state: 'stale',
      method: 'none',
      reason: 'revision-drift',
    };
  }

  const current = pointer ?? derived;
  if (current === undefined) {
    return {
      current_revision: '',
      current_token: '',
      state: 'unknown',
      method: 'none',
      reason: 'no-revision',
    };
  }

  // AC3 — ABSENT token → stale / none / no-token-supplied. Never fresh.
  if (input.token === undefined || input.token === '') {
    if (mode === 'default-fresh') {
      // Negative control ONLY: the wrong "token ?? current → fresh" behavior
      // AC3's test must go RED against.
      return {
        current_revision: current.revision_uid,
        current_token: current.revision_token,
        state: 'fresh',
        method: 'token',
      };
    }
    return {
      current_revision: current.revision_uid,
      current_token: current.revision_token,
      state: 'stale',
      method: 'none',
      reason: 'no-token-supplied',
    };
  }

  // Rung 1 — TOKEN (the default rung).
  if (input.token === current.revision_token) {
    return {
      current_revision: current.revision_uid,
      current_token: current.revision_token,
      state: 'fresh',
      method: 'token',
    };
  }

  // Rung 2 — CONTENT HASH: a bare hex (or the same digest under a different
  // token encoding) equal to the current token's digest proves the frozen
  // state. The token IS the fold hash, so this is an equality on the digest.
  if (bareHex(input.token) === bareHex(current.revision_token)) {
    return {
      current_revision: current.revision_uid,
      current_token: current.revision_token,
      state: 'fresh',
      method: 'content_hash',
    };
  }

  // Rung 3 — ANCESTRY would run here (git merge-base of the anchored file's
  // recorded commit vs HEAD). This build stores no recorded commit on a revision, so
  // it can only degrade to `unknown`; the rung is left for the slice that
  // records one and never fabricates a `fresh` in the meantime.

  // Rung 1's default verdict: a differing token is stale.
  return {
    current_revision: current.revision_uid,
    current_token: current.revision_token,
    state: 'stale',
    method: 'token',
    reason: 'older-token',
  };
}
