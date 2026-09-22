/**
 * vocabulary-drift.spec.ts — pins `RECOGNIZED_NODE_KINDS` to its documented
 * source of truth so the two can never silently diverge.
 *
 * `store/vocabulary-guard.ts`'s `RECOGNIZED_NODE_KINDS` hand-duplicates the
 * 13-kind node vocabulary whose documented source of truth is
 * `write/tx.ts`'s `IWriteNodeTxInput.kind` doc comment ("The entity-type
 * discriminator — `project`/`component`/`location`/`issue`/`kind`/`edge_kind`/
 * `status`/`priority`/`agent`/`note`/`citation`/`transition`/`audit` (§3)").
 *
 * That duplication is a fail-CLOSED drift risk: the guard refuses a store
 * whose live nodes are entirely outside `RECOGNIZED_NODE_KINDS`. So if
 * `write/tx.ts` gains a new kind the write layer legitimately composes but
 * `RECOGNIZED_NODE_KINDS` is not updated in lockstep, the guard starts
 * refusing a perfectly valid store — a healthy store reads as unreadable.
 *
 * This spec reads the vocabulary out of `write/tx.ts` AT TEST TIME and asserts
 * set equality with `RECOGNIZED_NODE_KINDS` in BOTH directions, so either half
 * of the pair changing without the other turns this red. It is deliberately a
 * source-anchored pin (the tx.ts list lives only in a doc comment — there is
 * no exported constant to import yet), and it fails LOUDLY if the anchor line
 * moves, rather than passing vacuously.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_NODE_KIND, RECOGNIZED_NODE_KINDS } from './vocabulary-guard.js';

/** `src/store/` -> `src/write/tx.ts`. */
const TX_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'write', 'tx.ts'),
  'utf8'
);

/**
 * The node kinds documented on `IWriteNodeTxInput.kind` — the write layer's
 * declared vocabulary, parsed from the backtick-quoted list on the
 * "entity-type discriminator" line. Throws (fails the test) if that anchor is
 * gone, so a moved/rewritten doc comment can never make this pin vacuous.
 */
function documentedWriteNodeKinds(): string[] {
  const line = TX_SOURCE.split('\n').find((l) =>
    l.includes('entity-type discriminator')
  );
  if (line === undefined) {
    throw new Error(
      'vocabulary-drift: the "entity-type discriminator" anchor line is gone from src/write/tx.ts — the documented source of truth moved; re-point this pin at its new home.'
    );
  }
  const kinds = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  if (kinds.length === 0) {
    throw new Error(
      `vocabulary-drift: found the anchor line but parsed no backticked kinds from it: ${line}`
    );
  }
  return kinds;
}

describe('RECOGNIZED_NODE_KINDS ↔ write/tx.ts vocabulary pin (fail-closed drift guard)', () => {
  it('is exactly the 13-kind vocabulary documented at IWriteNodeTxInput.kind', () => {
    const documented = documentedWriteNodeKinds();
    expect(documented).toHaveLength(13);
    expect(RECOGNIZED_NODE_KINDS.size).toBe(13);

    // BOTH directions, so drift on either side is red: a kind added to tx.ts
    // but not the guard, AND a kind in the guard that tx.ts no longer names.
    expect(new Set(documented)).toEqual(new Set(RECOGNIZED_NODE_KINDS));
  });

  it('contains ITEM_NODE_KIND — the read path filters kind:"issue", so the guard must always recognize it', () => {
    expect(RECOGNIZED_NODE_KINDS.has(ITEM_NODE_KIND)).toBe(true);
  });
});
