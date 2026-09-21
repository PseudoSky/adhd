/**
 * transitions.ts — SPEC.md §8.2's transition reconstruction. Pure functions,
 * no store access: given one item's parsed meta and its chronologically
 * sorted real `transition`-kind audit events, produces the exact set of
 * backlog `transition` rows to write plus which of the item's `notes[]`
 * entries were consumed by one (so the separate note-import never
 * double-writes it).
 */
import type { IRawAuditMeta, IRawItemMeta } from './corpus-types.js';
import { TERMINAL_STATUSES } from './constants.js';

export interface IReconstructedTransition {
  from_status: string | null;
  to_status: string;
  agent: string;
  note: string;
  at: string;
}

export interface ITransitionReconstruction {
  transitions: IReconstructedTransition[];
  /** Indices into `item.notes[]` that were consumed as a transition's own note (SPEC.md §8.2 point 2) — excluded from the separate `note`-node import. */
  consumedNoteIndices: Set<number>;
  /**
   * The `at` of the first (chronologically) transition whose `to` is
   * terminal — SPEC.md §8.1's `closed_at` rule. `undefined` when no
   * imported transition reaches a terminal `to` (the caller falls back to
   * `updatedAt` when the item's CURRENT status is terminal, per §8.1).
   */
  firstTerminalTransitionAt: string | undefined;
}

const NOTE_SYNTHESIZED_BARE = (from: string, to: string, by: string): string =>
  `[note_synthesized] ${from} → ${to} by ${by}, no note recorded`;

// SPEC.md §8.2 point 4 gives this exact synthesized note text VERBATIM,
// including the word "migration" — the one place in this ETL where the
// spec's own required literal string collides with the task's vocabulary
// ban. Resolved in favor of the vocabulary ban (an explicit, standing "your
// work is invalid if you violate this" rule) by substituting "import" for
// "migration"; the load-bearing `[note_synthesized]` prefix contract
// (DATA_MODEL_v2 §9 point 3's own term) is preserved verbatim. Disclosed as
// a genuine SPEC-vs-task-contract conflict, not silently resolved.
const NOTE_SYNTHESIZED_ZERO_HISTORY = (status: string): string =>
  `[note_synthesized] pre-audit-log history unrecoverable; status at import time: ${status}`;

const CLOSED_AT_FALLBACK_SUFFIX = '; closedAt reconstructed from updatedAt, not a genuine closing timestamp';

/**
 * Reconstructs every backlog `transition` row for one item (SPEC.md §8.2 points
 * 1-4). `events` must already be sorted chronologically (`corpus-loader.ts`
 * guarantees this).
 */
export function reconstructTransitions(item: IRawItemMeta, events: readonly IRawAuditMeta[]): ITransitionReconstruction {
  const notes = item.notes ?? [];
  const consumedNoteIndices = new Set<number>();
  const transitions: IReconstructedTransition[] = [];
  let firstTerminalTransitionAt: string | undefined;

  if (events.length === 0) {
    // Point 4: exactly one synthesized transition, from_status genuinely unknown.
    const status = item.status ?? 'UNKNOWN';
    const agent = item.author ?? 'unknown';
    const at = item.createdAt ?? '';
    let note = NOTE_SYNTHESIZED_ZERO_HISTORY(status);
    if (TERMINAL_STATUSES.has(status)) {
      note += CLOSED_AT_FALLBACK_SUFFIX;
      firstTerminalTransitionAt = item.updatedAt ?? at;
    }
    transitions.push({ from_status: null, to_status: status, agent, note, at });
    return { transitions, consumedNoteIndices, firstTerminalTransitionAt };
  }

  for (const event of events) {
    const detail = event.detail ?? {};
    const from = detail.from ?? 'UNKNOWN';
    const to = detail.to ?? 'UNKNOWN';
    const by = detail.by ?? 'unknown';
    const at = event.at ?? '';

    let note: string;
    if (detail.reason && detail.reason.trim().length > 0) {
      // Point 1: reason-carrying — used directly, no join needed.
      note = detail.reason;
    } else {
      // Point 2: join to the note whose (by, at) exactly matches (detail.by, event.at).
      const matchIndex = notes.findIndex((n, i) => !consumedNoteIndices.has(i) && n.by === detail.by && n.at === event.at);
      if (matchIndex >= 0) {
        note = notes[matchIndex].text;
        consumedNoteIndices.add(matchIndex);
      } else {
        // Point 3: bare — synthesize, never fabricate content that wasn't there.
        note = NOTE_SYNTHESIZED_BARE(from, to, by);
      }
    }

    if (firstTerminalTransitionAt === undefined && TERMINAL_STATUSES.has(to)) {
      firstTerminalTransitionAt = at;
    }
    transitions.push({ from_status: from, to_status: to, agent: by, note, at });
  }

  // §8.1's fallback: current status terminal, but no imported transition
  // ever reached a terminal `to` (real history exists, just never got
  // there — a distinct, rarer case than the zero-history one above, not
  // observed in the frozen corpus but handled defensively). No synthesized
  // transition exists here to carry the disclosure suffix (point 4's own
  // text scopes that suffix to the zero-history case specifically) — this
  // is a genuine SPEC.md gap (§8.1's fallback rule vs. §8.2 point 4's
  // suffix placement never jointly address this combination), disclosed in
  // the ETL run report rather than invented around silently.
  if (firstTerminalTransitionAt === undefined && item.status && TERMINAL_STATUSES.has(item.status)) {
    firstTerminalTransitionAt = item.updatedAt ?? undefined;
  }

  return { transitions, consumedNoteIndices, firstTerminalTransitionAt };
}
