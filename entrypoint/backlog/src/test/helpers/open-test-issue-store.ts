/**
 * open-test-issue-store.ts — a store-open helper for tests that exercise the
 * write layer (`write/create-issue.ts`) and read layer (`query/query.ts`)
 * DIRECTLY, opening the store itself rather than going through any wrapper.
 *
 * **Why this opens the store itself.** The helper depends on nothing but
 * `@adhd/sox-store-adapter` and `@adhd/sox-graph-store` — the same two
 * packages any store wrapper in this package wraps. Depending only on those
 * keeps the harness stable across changes to the application layer above it:
 * a test harness that reached through a wrapper would break whenever the
 * wrapper did, which is exactly the coupling
 * `cross-process-write-safety.spec.ts` was relocated to avoid.
 *
 * **Why the `TypePolicy` here is open, not `DEFAULT_TYPE_POLICY`.** The write
 * layer's own kinds (`project`/`component`/`issue`/`kind`/`status`/
 * `priority`/`agent`/`citation`/`audit`) and rels (`owns_project`/
 * `owns_component`/`has_kind`/`has_status`/`has_priority`/`authored_by`/
 * `has_citation`/`audits`) are NOT in `@adhd/sox-graph-store`'s closed
 * `DEFAULT_NODE_KINDS`/`DEFAULT_EDGE_RELS` vocabulary, so writing them under
 * the default policy raises a `ConstraintError`. `write/tx.ts`'s own doc
 * comment on {@link IWriteStoreHandle.typePolicy} records that a dedicated
 * store-bootstrap module — one that would inject an open-schema policy for
 * every write path — is out of scope for the current slice. So this helper
 * supplies the same shape of policy such a module will eventually install:
 * unconditionally permissive, exactly matching the OPEN schema DDL
 * (`NODE_TABLE_DDL_OPEN`/`EDGE_TABLE_DDL_OPEN`, `@adhd/sox-graph-store`)
 * that `applySchema()` already installs on a fresh store — no `kind`/`rel`
 * CHECK constraint at the DB level, verified against the published dist's
 * `applySchema()`/`ensureCheckConstraints()`. Nothing here narrows that
 * vocabulary; a real bootstrap module can replace this policy later without
 * changing the DB schema at all.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import {
  createGraphBackend,
  type GraphBackend,
  type TypePolicy,
} from '@adhd/sox-graph-store';
import {
  type IWriteStoreHandle,
  writeNodeTx,
  writeEdgeTx,
  nowISO,
} from '../../write/tx.js';
import { resolveEdgeKindTx } from '../../write/catalog.js';
export { OPEN_TYPE_POLICY } from '../../store/type-policy.js';
import { OPEN_TYPE_POLICY } from '../../store/type-policy.js';
import type { IQueryStoreHandle } from '../../query/query.js';
import {
  embedDrainFor,
  type IEmbedDrainOptions,
  type IEmbedDrainResult,
} from '../../write/embed-drain.js';

export interface TestIssueStore extends IWriteStoreHandle, IQueryStoreHandle {
  readonly adapter: StoreAdapter;
  readonly graph: GraphBackend;
  readonly typePolicy: TypePolicy;
  /**
   * The real per-adapter embed drain (`write/embed-drain.ts`) — present so a
   * test can drive the PRODUCTION close path (`closeGraphBacklogStore`) with
   * this store, exactly as `openGraphBacklogStore` wires it. `close()` below
   * stays a bare `adapter.close()` and deliberately does NOT drain (that is
   * the defect the production `closeGraphBacklogStore` fixes), so a test that
   * means to exercise the drain must call `closeGraphBacklogStore(store)`,
   * never `store.close()`.
   */
  flushEmbeds(opts?: IEmbedDrainOptions): Promise<IEmbedDrainResult>;
  close(): Promise<void>;
}

/**
 * Opens a real store at `dbPath` (creating parent dirs as needed — never
 * `:memory:`, since a cross-process test needs a real shared file two OS
 * processes can both open) with the open-vocabulary policy above already
 * injected, and applies schema. Safe to call from the test's own process OR
 * from a child process spawned against the SAME `dbPath` — each call opens
 * its own genuine adapter connection.
 */
export async function openTestIssueStore(
  dbPath: string,
  busyTimeoutMs = 5000
): Promise<TestIssueStore> {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const adapter = await createStoreAdapter({ dbPath });
  await adapter.pragmaSet('busy_timeout', busyTimeoutMs);
  const graph = createGraphBackend(adapter, { typePolicy: OPEN_TYPE_POLICY });
  await graph.applySchema();
  return {
    adapter,
    graph,
    typePolicy: OPEN_TYPE_POLICY,
    flushEmbeds: (opts?: IEmbedDrainOptions) =>
      embedDrainFor(adapter).drain(opts),
    close: () => adapter.close(),
  };
}

/** Removes the on-disk store (db file + any WAL/SHM sidecars via the parent dir) — test teardown only. */
export function removeTestIssueStoreDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Seeds exactly ONE `project` node plus its reserved default `component`
 * (name `(root)`, `owns_project`-linked) — the ONLY two rows `createIssue`
 * requires to already exist (SPEC.md §1/§6.1: `project`/`component` are
 * resolved-only, never minted by an issue verb; minting a project is the
 * separate `upsertProject` registry verb, not yet built — see
 * `write/catalog.ts`'s own doc comments). Run as one `immediate` transaction
 * so it is race-free even if called concurrently (it never is, in this
 * harness — one seed call happens before any writer is spawned), and so it
 * exercises the exact same hand-composed `writeNodeTx`/`writeEdgeTx`
 * primitives every real write verb uses, never a bespoke schema-agnostic
 * insert.
 *
 * Returns the project's `uid` — usable directly as `ICreateIssueInput.project`
 * (a uid or name both resolve; the uid is unambiguous and never collides with
 * a later-run's project name).
 */
export async function seedProject(
  handle: Pick<TestIssueStore, 'adapter' | 'typePolicy'>,
  name: string
): Promise<{ projectUid: string }> {
  const projectUid = await handle.adapter.transaction(
    async (tx) => {
      const now = nowISO();
      const project = await writeNodeTx(tx, {
        kind: 'project',
        name,
        metadata: {},
        at: now,
      });
      const component = await writeNodeTx(tx, {
        kind: 'component',
        name: '(root)',
        metadata: { projectUid: project.uid },
        at: now,
      });
      const rule = await resolveEdgeKindTx(tx, 'owns_project');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: project.rowid,
        srcUid: project.uid,
        srcKind: 'project',
        dstRowid: component.rowid,
        dstUid: component.uid,
        dstKind: 'component',
        rel: 'owns_project',
        rule,
        typePolicy: handle.typePolicy,
      });
      return project.uid;
    },
    { mode: 'immediate' }
  );
  return { projectUid };
}
