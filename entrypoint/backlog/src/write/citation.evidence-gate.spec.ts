/**
 * citation.evidence-gate.spec.ts — 82e2c109 (the ticket states no numbered
 * ACs; AC1..AC3 map to its three stated expectations):
 *   AC1  computeCitationSha enforces a size cap (streamed, never loaded whole);
 *        an over-cap target is PERSISTED `unverified-with-reason`
 *        (`target-too-large`), never refused;
 *   AC2  the vestigial default-external-roots indirection is gone (asserted in
 *        citation-path.spec.ts / catalog.spec.ts, where the module lives; the
 *        policy opt-in `citationAllowedExternalRoots` still works — AC2 below);
 *   AC3  an abstract url:/registry:/query: anchor is PERSISTED
 *        `unverified-with-reason` (`abstract-anchor-unchecked`) under the
 *        DEFAULT `citationRequiresSha:true` — never refused (SPEC-SET S02.C2
 *        "never drop, never abort"; ADR-0007 #8) — and reads back as
 *        evidence-free (`verification:'unverified-with-reason'`, sha sentinel).
 *        Only a MISSING target is still refused under the policy.
 *
 * UNIT tests (real store + real verbs). Negative controls (run once,
 * restored): (a) drop the cap check in `hashFileCapped` -> AC1 cap tests red;
 * (b) add 'abstract-anchor-unchecked' to `refusable` -> AC3 persist tests red.
 */
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import { computeCitationSha, MAX_CITATION_BYTES } from './citation.js';
import type { IResolvedProjectRow } from './catalog.js';

describe('82e2c109 — citation persist-not-refuse and size cap', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let repo: string;
  let projectUid: string;

  async function citationCount(): Promise<number> {
    const r = await tmp.store.adapter.executeGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM node WHERE kind = 'citation' AND t_invalid IS NULL"
    );
    return Number(r?.c);
  }
  function create(file: string) {
    return api.create(ctx, { project: projectUid, title: `cites ${file}`.slice(0, 60), body: 'b', by: 'filer', citations: [{ file }] });
  }
  async function citationsOf(uid: string): Promise<Array<Record<string, unknown>>> {
    const got = await api.get(ctx, { uid, fields: ['citations'] });
    if (!got.ok) throw new Error(JSON.stringify(got));
    return (got.data as unknown as { citations: Array<Record<string, unknown>> }).citations;
  }
  const project = (): IResolvedProjectRow => ({ uid: projectUid, metadata: { path: repo } }) as unknown as IResolvedProjectRow;

  beforeEach(async () => {
    tmp = await openTmpStore('citation-evidence');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    repo = join(tmp.dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const p = await api.upsertProject(ctx, { name: 'evidence', path: repo, by: 'seed' });
    if (!p.ok) throw new Error(JSON.stringify(p));
    projectUid = (p.data as { uid: string }).uid;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('82e2c109 AC1 — a target over the cap is target-too-large and never hashed; at the cap it verifies', async () => {
    const f = join(repo, 'big.bin');
    const body = Buffer.alloc(20, 7);
    writeFileSync(f, body);
    const over = await computeCitationSha(project(), f, undefined, [], [], 19);
    expect(over).toMatchObject({ outcome: 'unverified-with-reason', reason: 'target-too-large', sha: 'unverified' });
    const exact = await computeCitationSha(project(), f, undefined, [], [], 20);
    expect(exact).toMatchObject({ outcome: 'verified', sha: createHash('sha256').update(body).digest('hex') });
  });

  it('82e2c109 AC1 — the production cap is 64 MiB: an over-cap file is PERSISTED target-too-large under the default policy (never refused)', async () => {
    const f = join(repo, 'huge.bin');
    writeFileSync(f, '');
    truncateSync(f, MAX_CITATION_BYTES + 1); // sparse
    const ok = await create(f);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(await citationCount()).toBe(1);
    const [c] = await citationsOf((ok as { data: { uid: string } }).data.uid);
    expect(c).toMatchObject({ verification: 'unverified-with-reason', unverifiedReason: 'target-too-large' });
  });

  it('82e2c109 AC2 — the typed per-project external-root opt-in still resolves (only the vestigial default is gone)', async () => {
    const ext = join(tmp.dir, 'external');
    mkdirSync(ext, { recursive: true });
    const file = join(ext, 'e.txt');
    writeFileSync(file, 'e\n');
    const v = await computeCitationSha(project(), file, undefined, [ext]);
    expect(v.outcome).toBe('verified');
  });

  it.each(['url:https://example.com/doc', 'registry:npm/@adhd/backlog', 'query:status=open'])(
    '82e2c109 AC3 — abstract anchor %s is PERSISTED unverified-with-reason under the default policy (never refused)',
    async (anchor) => {
      const out = await create(anchor);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(await citationCount()).toBe(1);
      const [c] = await citationsOf((out as { data: { uid: string } }).data.uid);
      expect(c).toMatchObject({ verification: 'unverified-with-reason', sha: 'unverified', unverifiedReason: 'abstract-anchor-unchecked' });
    }
  );

  it('82e2c109 AC3 — a MISSING target is still refused under the default policy and writes nothing', async () => {
    const out = await create(join(repo, 'nope.txt'));
    expect(out.ok).toBe(false);
    expect((out as { error: { message: string } }).error.message).toMatch(/could not be verified/);
    expect(await citationCount()).toBe(0);
  });
});
