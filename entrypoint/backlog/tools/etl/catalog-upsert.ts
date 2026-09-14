/**
 * catalog-upsert.ts — hand-composed find-then-create for `project` and
 * `component` (SPEC.md §1/§4c/§8.1/§8.6 step 3-4).
 *
 * `write/catalog.ts` (frozen) ships `resolveProjectTx`/`resolveComponentTx`
 * — RESOLVE-ONLY, by design (SPEC.md §1/§6.1: "minting a project is the
 * explicit `upsertProject` registry verb's job alone... out of scope for
 * this slice"). That registry verb does not exist yet anywhere in this
 * package (confirmed: no `upsertProject`/`upsertComponent` export anywhere
 * under `src/`). The ETL is the one caller that DOES need to mint a project/
 * component (SPEC.md §8.1: "the write layer's hand-composed find-then-create
 * (§4c), or `upsertProject`"), so this module implements that exact
 * find-then-create shape itself — the SAME `tx.executeGet` SELECT
 * `resolveProjectTx`/`resolveComponentTx` already run, falling through to a
 * `writeNodeTx` INSERT on a miss, inside the SAME caller-supplied
 * `immediate`-mode `tx` — never `GraphBackend.findOrCreateNode()` (§4c).
 * A future real `upsertProject`/`upsertComponent` registry verb should
 * subsume this module; nothing here is meant to be a permanent parallel
 * implementation.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { IResolvedCatalogRow, IResolvedProjectRow } from '../../src/write/catalog.js';
import { resolveEdgeKindTx } from '../../src/write/catalog.js';
import type { IWriteStoreHandle } from '../../src/write/tx.js';
import { writeEdgeTx, writeNodeTx } from '../../src/write/tx.js';

export interface IUpsertProjectInput {
  name: string;
  /** Only ever set for the `"adhd"` project (SPEC.md §8.4) — merged over `{}` on a fresh mint, never overwritten on a resolve of an already-existing row (an existing project's metadata is authoritative; the ETL never clobbers it). */
  metadata?: Record<string, unknown>;
  at?: string;
}

/**
 * Find-then-create a `project` by `name` (SPEC.md §8.1's `repo` mapping).
 * Mints the reserved default `(root)` component + `owns_project` edge in the
 * SAME transaction as a fresh project mint (mirrors `upsertProject`'s
 * documented guarantee, and `open-test-issue-store.ts`'s `seedProject` test
 * helper's identical shape) — never minted for an ALREADY-existing project
 * (idempotent: the `(root)` component from that project's first mint is
 * still live).
 */
export async function upsertProjectTx(
  handle: Pick<IWriteStoreHandle, 'typePolicy'>,
  tx: AdapterTransaction,
  input: IUpsertProjectInput,
): Promise<IResolvedProjectRow> {
  const existing = await tx.executeGet<{ rowid: number; uid: string; name: string | null; meta: string | null }>(
    "SELECT rowid, uid, name, meta FROM node WHERE kind = 'project' AND name = ? AND t_invalid IS NULL LIMIT 1",
    [input.name],
  );
  if (existing) {
    let metadata: Record<string, unknown> | undefined;
    if (existing.meta !== null) {
      try {
        metadata = JSON.parse(existing.meta) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
    }
    return { rowid: existing.rowid, uid: existing.uid, name: existing.name ?? input.name, metadata };
  }

  const project = await writeNodeTx(tx, { kind: 'project', name: input.name, metadata: input.metadata ?? {}, at: input.at });
  const component = await writeNodeTx(tx, {
    kind: 'component',
    name: '(root)',
    metadata: { projectUid: project.uid },
    at: input.at,
  });
  const rule = await resolveEdgeKindTx(tx, 'owns_project');
  await writeEdgeTx(tx, {
    at: input.at,
    srcRowid: project.rowid, srcUid: project.uid, srcKind: 'project',
    dstRowid: component.rowid, dstUid: component.uid, dstKind: 'component',
    rel: 'owns_project', rule, typePolicy: handle.typePolicy,
  });
  return { rowid: project.rowid, uid: project.uid, name: input.name, metadata: input.metadata ?? {} };
}

export interface IUpsertComponentInput {
  projectUid: string;
  name: string;
  at?: string;
}

/**
 * Find-then-create a `component` scoped to `projectUid` (SPEC.md §8.1's
 * `projectPath` mapping) — the SAME `(name, projectUid)` uniqueness scope
 * `resolveComponentTx` reads, mirrored here with a mint-on-miss branch.
 */
export async function upsertComponentTx(
  tx: AdapterTransaction,
  input: IUpsertComponentInput,
): Promise<IResolvedCatalogRow> {
  const existing = await tx.executeGet<{ rowid: number; uid: string; name: string | null }>(
    `SELECT rowid, uid, name FROM node
     WHERE kind = 'component' AND name = ? AND t_invalid IS NULL
       AND json_extract(meta, '$.projectUid') = ?
     LIMIT 1`,
    [input.name, input.projectUid],
  );
  if (existing) {
    return { rowid: existing.rowid, uid: existing.uid, name: existing.name ?? input.name };
  }
  const minted = await writeNodeTx(tx, {
    kind: 'component',
    name: input.name,
    metadata: { projectUid: input.projectUid },
    at: input.at,
  });
  return { rowid: minted.rowid, uid: minted.uid, name: input.name };
}
