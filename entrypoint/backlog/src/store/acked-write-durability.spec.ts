/**
 * acked-write-durability.spec.ts — the DEFAULT-LANE durability check that pairs
 * with the resource-heavy sibling `acked-write-durability.e2e.ts`.
 *
 * The e2e sibling is the full multi-holder, real-subprocess crash proof: it
 * spawns 5 genuine `serve --transport mcp` children, SIGKILLs them, and reopens
 * the store from a fresh process. That is a `proc`-lane resource hog, so it
 * lives only in the on-demand `e2e` lane (`nx run backlog:e2e`) and never runs
 * under `nx affected -t test` / the pre-commit + pre-push hooks.
 *
 * This file is the cheap, default-lane counterpart, and it makes a REAL
 * assertion (never a placeholder): a write that `backlog` ACKNOWLEDGED is still
 * readable by uid after the store is closed and reopened from a FRESH adapter
 * connection — driven through the real `createIssue` verb and the real
 * `getIssue` read path against a real on-disk store, entirely in-process (no
 * child processes), so the default target picks it up and runs it.
 *
 * It is deliberately NOT the crash proof — proving a SIGKILL leaves acked rows
 * intact requires the 5-holder topology the `e2e` lane exists to keep out of
 * the default target. This test proves the ack-then-reopen durability contract
 * holds for the common single-holder case; the crash and live-peer topologies
 * are the e2e file's job.
 *
 * Resource lane: proc (the sibling `*.e2e.ts`). THIS file is default-lane — an
 * in-process store only, no subprocess, no model.
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { getIssue } from '../query/get.js';

describe('acked-write durability (default lane, single holder, in-process)', () => {
  let dir: string | undefined;
  let store: TestIssueStore | undefined;

  afterEach(async () => {
    await store?.close().catch(() => undefined);
    store = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('an acknowledged create is still readable by uid after the store is closed and reopened from a fresh connection', async () => {
    dir = freshTmpDir('acked-write-durability-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const { projectUid } = await seedProject(store, 'acked-write-durability-spec');

    const acked = await createIssue(store, {
      title: 'acked once, durable across reopen',
      body: 'the acknowledgement must never outlive the row',
      project: projectUid,
      by: 'durability-spec',
    });
    expect(acked.created, `create was not acked: ${JSON.stringify(acked)}`).toBe(true);
    if (!acked.created || !acked.uid) throw new Error('expected an acked create with a uid');

    await store.close();

    // Reopen a FRESH connection on the SAME file. Seeing the row here is a
    // genuine "did the acked write persist" proof — not the closed handle's
    // own still-open view. If the ack were not durable, `getIssue` would throw
    // `IssueNotFoundError(uid)` and this test would go red.
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const card = await getIssue(store.graph, { uid: acked.uid });
    expect(card.uid).toBe(acked.uid);
    expect(card.title).toBe('acked once, durable across reopen');
  });
});
