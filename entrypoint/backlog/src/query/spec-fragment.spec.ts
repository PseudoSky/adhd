/**
 * spec-fragment.spec.ts — 34b69c69 B-AC9 (ADR-0007 D7, additive):
 * `get {uid, fields:["specRevisionFragment"]}` returns the HEAD revision's
 * fragment, and that fragment equals — byte for byte — what `spec-append`
 * wrote. The body deliberately carries multi-byte characters, a combining mark,
 * CRLF, and a trailing newline so a re-encode or trim is caught.
 *
 * Real store + real api verbs.
 *
 * Negative control (run once, restored): returning the pointer only (no
 * fragment) turns the equality rows red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}
interface IFrag {
  revision_uid: string;
  revision_token: string;
  revision_seq: number;
  fragment: string;
}

describe('34b69c69 B-AC9 — specRevisionFragment', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let issue: string;

  const fragmentOf = async (uid = issue): Promise<IFrag | null> =>
    ((data(await api.get(ctx, { uid, fields: ['specRevisionFragment'] })) as unknown) as { specRevisionFragment: IFrag | null })
      .specRevisionFragment;

  beforeEach(async () => {
    tmp = await openTmpStore('spec-fragment');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const project = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
    issue = data(await api.create(ctx, { project, title: 't', body: 'b', by: 'f' } as never)).uid as string;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('34b69c69 B-AC9 an item with no spec returns null', async () => {
    expect(await fragmentOf()).toBeNull();
  });

  it('34b69c69 B-AC9 the head fragment equals the bytes spec-append wrote (multi-byte, CRLF, trailing newline)', async () => {
    const body = '## Zusammenfassung — café ☕ 日本語 é\r\nzweite Zeile\n\n  indented  \n';
    const r = data(
      await api.specAppend(ctx, { uid: issue, fragment: body, base_revision: '', by: 'author' })
    );
    const got = await fragmentOf();
    expect(got).not.toBeNull();
    expect(got!.fragment).toBe(body);
    expect(Buffer.from(got!.fragment, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(got!.revision_uid).toBe(r.spec_revision);
    expect(got!.revision_token).toBe(r.spec_revision_token);
    expect(got!.revision_seq).toBe(r.revision_seq);
  });

  it('34b69c69 B-AC9 after a second append the HEAD fragment (not the base) is returned', async () => {
    const first = data(await api.specAppend(ctx, { uid: issue, fragment: 'base\n', base_revision: '', by: 'a' }));
    const second = data(
      await api.specAppend(ctx, { uid: issue, fragment: 'delta ✓\n', base_revision: first.spec_revision, by: 'a' })
    );
    const got = await fragmentOf();
    expect(got!.fragment).toBe('delta ✓\n');
    expect(got!.revision_uid).toBe(second.spec_revision);
    expect(got!.revision_seq).toBe(second.revision_seq);
  });
});
