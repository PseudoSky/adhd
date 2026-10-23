/**
 * production-gate.verbs.spec.ts — 31b37c54 A-AC13 / 3bd99d24 A-AC13: the
 * production-write gate names the ACTUAL verb for EVERY mounted write verb.
 *
 * Real components: a real `GraphBacklogStore`, a real `BacklogCtx` carrying an
 * `isProductionStore:true, allowProductionWrite:false` gate, and the real
 * `api.ts` verb surface (the same wrappers a host mounts). Nothing is mocked.
 *
 * The write-verb list is DERIVED from `BACKLOG_VERBS` minus the explicit
 * read-only set, so a newly mounted verb forces a decision here (drift guard).
 *
 * Negative controls (run once, then restored): re-adding `?? 'write'` in
 * `executeWriteTransaction` and dropping one `verb:` decoration turns the
 * matching row red (its message would say "write", not the verb).
 *
 * guards: a mounted write verb reaches the live PRODUCTION store, or its refusal names a generic "write" instead of the verb
 * tier: S
 * cites: 31b37c54 A-AC13; 3bd99d24 A-AC13
 * teeth: red: pending (the negative controls above were run once and restored; no red-run record is cited for this variance edit)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTmpStore, type TmpStore } from '../../helpers/tmp-store.js';
import { buildBacklogEnv } from '../../../src/env.js';
import * as api from '../../../src/api.js';
import { BACKLOG_VERBS } from '../../../src/vocabulary.js';

const READ_ONLY_VERBS = new Set([
  'get',
  'query',
  'timeline',
  'priority-matrix',
  'part-of-rollup',
  'open-curve',
  'report',
  'lookup',
  'spec-check',
  'embedding-status',
]);

const here = dirname(fileURLToPath(import.meta.url));

type Invoker = (ctx: api.BacklogCtx, uid: string, project: string) => Promise<unknown>;

/** Seeded second issue / attestation uids (set in `beforeEach`). */
const seeded = { uid2: '', attestation: '' };

/** verb id -> a minimal, well-formed invocation of the mounted api wrapper. */
const INVOKERS: Record<string, Invoker> = {
  create: (c, _u, p) => api.create(c, { project: p, title: 't', body: 'b', by: 'x' }),
  update: (c, u) => api.update(c, { uid: u, by: 'x', title: 'renamed' }),
  'add-citation': (c, u) => api.addCitation(c, { uid: u, by: 'x', citation: { file: 'url:https://example.com' } }),
  'remove-citation': (c, u) => api.removeCitation(c, { uid: u, by: 'x' }),
  transition: (c, u) => api.transition(c, { uid: u, by: 'x', toStatus: 'IN_PROGRESS' }),
  attest: (c, u) =>
    api.attest(c, {
      subject: { id: u, revision: 1 },
      claim: { kind: 'k' },
      anchor: { locator: 'path:a', digest: 'd' },
      by: 'x',
    }),
  recheck: (c) => api.recheck(c, { attestationUid: seeded.attestation, by: 'seed' }),
  obligate: (c, u) =>
    api.obligate(c, {
      uid: u,
      applies_to: { to: '*' },
      requirement: { op: 'blockers_terminal' },
      on_fail: 'block',
      by: 'x',
    }),
  unobligate: (c, u) => api.unobligate(c, { obligationUid: u, by: 'x' }),
  'spec-append': (c, u) => api.specAppend(c, { uid: u, fragment: 'f', base_revision: 'sha256:0', by: 'x' }),
  claim: (c, u) => api.claim(c, { uid: u, by: 'x', action: 'claim' }),
  relate: (c, u) => api.relate(c, { sourceUid: u, targetUid: seeded.uid2, rel: 'relates_to', action: 'add', by: 'x' }),
  move: (c, u) => api.move(c, { uid: u, by: 'x', toComponent: 'c' }),
  'upsert-project': (c) => api.upsertProject(c, { name: 'p2', by: 'x' }),
  'upsert-component': (c, _u, p) => api.upsertComponent(c, { project: p, name: 'c2', by: 'x' }),
  'upsert-location': (c) => api.upsertLocation(c, { component: 'c2', locType: 'path', value: '/x', by: 'x' }),
  'rm-location': (c, u) => api.rmLocation(c, { uid: u, by: 'x' }),
  delete: (c, u) => api.delete(c, { uid: u, reason: 'r', by: 'x' }),
  remove: (c, u) => api.remove(c, { uid: u, confirm: true, by: 'x' }),
  restore: (c, u) => api.restore(c, { uid: u, by: 'x' }),
  'merge-project': (c, _u, p) => api.mergeProject(c, { fromUid: p, toUid: p, by: 'x' }),
  'rm-project': (c, _u, p) => api.rmProject(c, { uid: p, reason: 'r', by: 'x' }),
  // 0f9b6132 AC4: the gate names `remove-note` (note.ts decorates the transaction with that verb).
  'remove-note': (c, u) => api.removeNote(c, { uid: u, by: 'x', reason: 'r' }),
};

describe('31b37c54 A-AC13 — production gate names the real verb for every write verb', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let uid: string;
  let project: string;

  // Variance fix (qa-variance 2026-10-14, verification pending): this was a per-test `beforeEach` (a real Turso open
  // plus 5 seed writes, 24 times). Every test below drives a REFUSED write through the production gate, so the seeded
  // state is never mutated by contract (the 'seed issue is unchanged' test asserts exactly that): one shared store is
  // equivalent and removes 23 of the 24 store opens whose cost swung 0.3 - 2.7 s under load.
  beforeAll(async () => {
    tmp = await openTmpStore('production-gate-verbs');
    const env = buildBacklogEnv({ adhdRoot: tmp.dir });
    const open: api.BacklogCtx = { store: tmp.store, env };
    const p = await api.upsertProject(open, { name: 'gate-verbs', by: 'seed' });
    if (!p.ok) throw new Error(`seed project: ${JSON.stringify(p)}`);
    project = (p.data as { uid: string }).uid;
    const c = await api.create(open, { project, title: 'seed', body: 'seed body', by: 'seed' });
    if (!c.ok) throw new Error(`seed create: ${JSON.stringify(c)}`);
    uid = (c.data as { uid: string }).uid;
    const c2 = await api.create(open, { project, title: 'seed two', body: 'seed body two', by: 'seed' });
    if (!c2.ok) throw new Error(`seed create 2: ${JSON.stringify(c2)}`);
    seeded.uid2 = (c2.data as { uid: string }).uid;
    const at = await api.attest(open, {
      subject: { id: uid, revision: 1 },
      claim: { kind: 'k' },
      anchor: { locator: 'path:a', digest: 'd' },
      by: 'seed',
    });
    if (!at.ok) throw new Error(`seed attest: ${JSON.stringify(at)}`);
    seeded.attestation = (at.data as { attestationUid: string }).attestationUid;
    ctx = { ...open, productionWrite: { isProductionStore: true, allowProductionWrite: false } };
  });

  afterAll(async () => {
    await tmp.cleanup();
  });

  for (const verb of Object.keys(INVOKERS)) {
    it(`31b37c54 A-AC13 — "${verb}" refusal names "${verb}", never a generic "write"`, async () => {
      const out = (await INVOKERS[verb]!(ctx, uid, project)) as {
        ok: boolean;
        error?: { code: string; message: string };
      };
      expect(out.ok).toBe(false);
      expect(out.error?.code, JSON.stringify(out.error)).toBe('precondition_failed');
      expect(out.error?.message).toContain(`"${verb}" would write to the live PRODUCTION store`);
    });
  }

  it('31b37c54 A-AC13 — the gate refuses before any write: the seed issue is unchanged', async () => {
    await INVOKERS['update']!(ctx, uid, project);
    const got = await api.get({ ...ctx, productionWrite: undefined } as api.BacklogCtx, { uid });
    expect(got.ok && (got.data as { title: string }).title).toBe('seed');
  });
});

// Pure checks (no store): kept out of the store-backed describe so they do not pay its setup.
describe('31b37c54 / 3bd99d24 A-AC13 — static shape of the mounted write surface', () => {
  it('31b37c54 A-AC13 — the verb list below is exactly the mounted write surface (drift guard)', () => {
    const writeVerbs = BACKLOG_VERBS.filter((v) => !READ_ONLY_VERBS.has(v)).sort();
    expect(Object.keys(INVOKERS).sort()).toEqual(writeVerbs);
  });

  it('3bd99d24 A-AC13 — api.ts has a single create-issue.js import and a non-async get', () => {
    const src = readFileSync(join(here, '..', '..', '..', 'src', 'api.ts'), 'utf8');
    expect(src.match(/from '\.\/write\/create-issue\.js'/g)?.length).toBe(1);
    expect(src).toMatch(/export function get\(/);
    expect(src).not.toMatch(/export async function get\(/);
  });
});
