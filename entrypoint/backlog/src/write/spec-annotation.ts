/**
 * spec-annotation.ts — review commentary on a spec revision, kept OUT of the
 * revision body (C10, DESIGN §12; AC4).
 *
 * An annotation is a `kind:'attestation'` record keyed to the EXACT revision
 * object:
 *
 *   subject = { id: <revision uid>, token: <revision token, 'sha256:<hex>'> },
 *   anchor  = { locator: 'revision:<revision uid>', digest: <revision token> }.
 *
 * It is never written into the revision body. Because the revision is
 * immutable, a comment on revision n can never drift onto revision n+1.
 *
 * `annotate` DELEGATES to C3's `attest` — it does not re-implement one. C3's
 * own spec carries the reciprocal widening note this depends on (`subject.id`
 * may name a `SPEC` node; `subject.revision` accepts an opaque `sha256:<hex>`
 * token string), and this module's `revision:` anchor scheme is parsed by
 * `anchor-check.ts`'s closed grammar.
 */

import { attest } from './attestation.js';
import type { IAttestCheck } from './anchor-check.js';
import type { IWriteStoreHandle } from './tx.js';
import type { ISpecAnchor } from './spec-revision.js';
import { InvalidArgumentError } from './errors.js';

export interface IAnnotateInput {
  /** The revision uid + its `'sha256:<hex>'` token. */
  subject: { id: string; token: string };
  comment: string;
  /** Defaults to the revision anchor `{ locator: 'revision:<revision uid>', digest: <revision token> }`. */
  anchor?: ISpecAnchor;
  by: string;
}

export interface IAnnotateOutcome {
  /** The created `attestation` node uid. */
  annotationUid: string;
  /** Echoed, revision-keyed. */
  subject: { id: string; token: string };
  /** C3's shape — unchanged. */
  check: IAttestCheck;
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * Record a comment against a spec revision. Delegates to C3's `attest`; the
 * revision body is never modified (AC4). The subject is the revision, so the
 * annotation can never be keyed to the work item instead.
 */
export async function annotate(
  handle: IWriteStoreHandle,
  input: IAnnotateInput
): Promise<IAnnotateOutcome> {
  assertNonBlank('subject.id', input.subject?.id);
  assertNonBlank('subject.token', input.subject?.token);
  assertNonBlank('comment', input.comment);
  assertNonBlank('by', input.by);

  const anchor: ISpecAnchor = input.anchor ?? {
    locator: `revision:${input.subject.id}`,
    digest: input.subject.token,
  };

  const outcome = await attest(handle, {
    subject: { id: input.subject.id, revision: input.subject.token },
    claim: { kind: 'spec-annotation', body: input.comment },
    anchor,
    by: input.by,
  });

  return {
    annotationUid: outcome.attestationUid,
    subject: { id: input.subject.id, token: input.subject.token },
    check: outcome.check,
  };
}
