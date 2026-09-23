/**
 * catalog-upsert.ts — thin ETL-side adapters over the REAL registry verbs
 * `upsertProjectTx`/`upsertComponentTx` (`src/write/catalog.ts`).
 *
 * This module used to hand-roll its own find-then-create SQL for `project`
 * and `component` (SPEC.md §1/§4c/§8.1/§8.6 step 3-4), predating the real
 * `upsertProject`/`upsertComponent` registry verbs' existence — its own
 * header comment said so explicitly: "A future real upsertProject/
 * upsertComponent registry verb should subsume this module; nothing here is
 * meant to be a permanent parallel implementation." That duplication was not
 * incidental — it already caused a real, shipped bug
 * (BUG-BACKLOG-ETL-COMPONENT-MISSING-OWNS-PROJECT-001: the hand-rolled
 * `upsertComponentTx` minted a component but forgot the `owns_project` edge
 * back to its project, something the real `upsertComponent` verb always
 * wrote).
 *
 * The real verbs exist now (`src/write/catalog.ts`), each split into a
 * transaction-PARTICIPANT `*Tx` core (`upsertProjectTx`/`upsertComponentTx`)
 * and a thin `executeWriteTransaction`-opening public wrapper — exactly the
 * shape this ETL needs, since `import-item.ts` bundles an entire source
 * item's writes into ONE caller-owned `immediate` transaction (SPEC.md §7a)
 * and cannot nest a second `executeWriteTransaction` inside it. This module
 * now does nothing but call the real `*Tx` cores and reshape their
 * `IUpsertProjectOutcome`/`IUpsertComponentOutcome` results into the
 * `IResolvedProjectRow`/`IResolvedCatalogRow` shape (which carries `rowid`)
 * this package's downstream ETL code (`import-item.ts`, `run-etl.ts`,
 * `_profile.ts`) already consumes for `writeEdgeTx` endpoints. `rowid` is
 * deliberately NOT part of either outcome type's public contract (§3a/§4:
 * outcomes are business-facing, not storage-facing), so it is re-fetched
 * here via `getNodeByUidTx`, inside the SAME transaction the real verb just
 * wrote in — never by touching the real verbs' return shape.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  upsertProjectTx as realUpsertProjectTx,
  upsertComponentTx as realUpsertComponentTx,
  type IResolvedCatalogRow,
  type IResolvedProjectRow,
} from '../../src/write/catalog.js';
import { getNodeByUidTx, type IWriteStoreHandle } from '../../src/write/tx.js';
import { ETL_ACTOR } from './constants.js';

export interface IUpsertProjectInput {
  name: string;
  /** Only ever set for the `"adhd"` project (SPEC.md §8.4) — the real verb merges this over `{}` on a fresh mint, and never overwrites an existing row's `meta` wholesale (its own documented merge rule). */
  metadata?: Record<string, unknown>;
}

/**
 * ETL-side project upsert: calls the REAL `upsertProjectTx` (SPEC.md §8.1's
 * `repo` mapping) — the first-mint `(root)` component + `owns_project` edge
 * is the real verb's own guarantee, not reimplemented here — then re-fetches
 * `rowid` (needed by every downstream `writeEdgeTx` call) via
 * `getNodeByUidTx` against the SAME `tx`.
 */
export async function upsertProjectTx(
  handle: Pick<IWriteStoreHandle, 'typePolicy'>,
  tx: AdapterTransaction,
  input: IUpsertProjectInput
): Promise<IResolvedProjectRow> {
  const outcome = await realUpsertProjectTx(tx, handle, {
    name: input.name,
    path: input.metadata?.path as string | undefined,
    repoUrl: input.metadata?.repoUrl as string | undefined,
    monorepo: input.metadata?.monorepo as boolean | undefined,
    description: input.metadata?.description as string | undefined,
    by: ETL_ACTOR,
  });
  const row = await getNodeByUidTx(tx, outcome.uid);
  if (!row) {
    throw new Error(
      `upsertProjectTx: real upsertProjectTx returned uid="${outcome.uid}" that does not resolve inside the same transaction.`
    );
  }
  return {
    rowid: row.rowid,
    uid: row.uid,
    name: outcome.project.name,
    metadata: row.metadata,
  };
}

export interface IUpsertComponentInput {
  projectUid: string;
  name: string;
}

/**
 * ETL-side component upsert: calls the REAL `upsertComponentTx` (SPEC.md
 * §8.1's `projectPath` mapping) — the `owns_project` edge back to
 * `projectUid` is the real verb's own guarantee (this is exactly the
 * production behavior BUG-BACKLOG-ETL-COMPONENT-MISSING-OWNS-PROJECT-001's
 * hand-rolled predecessor was missing; that hand-rolled version is gone) —
 * then re-fetches `rowid` the same way `upsertProjectTx` above does.
 * `projectUid` is passed as the real verb's `project` reference — a
 * `randomUUID()`-shaped `uid`, so it resolves via {@link resolveProjectTx}'s
 * uid branch without a second name lookup.
 */
export async function upsertComponentTx(
  handle: Pick<IWriteStoreHandle, 'typePolicy'>,
  tx: AdapterTransaction,
  input: IUpsertComponentInput
): Promise<IResolvedCatalogRow> {
  const outcome = await realUpsertComponentTx(tx, handle, {
    project: input.projectUid,
    name: input.name,
    by: ETL_ACTOR,
  });
  const row = await getNodeByUidTx(tx, outcome.uid);
  if (!row) {
    throw new Error(
      `upsertComponentTx: real upsertComponentTx returned uid="${outcome.uid}" that does not resolve inside the same transaction.`
    );
  }
  return { rowid: row.rowid, uid: row.uid, name: outcome.component.name };
}
