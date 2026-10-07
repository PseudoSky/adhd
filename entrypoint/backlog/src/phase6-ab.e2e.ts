/**
 * phase6-ab.e2e.ts — L2 proof for Buckets A and B: the BUILT `adhd-backlog` bin,
 * through the real CLI transport, against an isolated sandbox store.
 *
 * A-AC1 (050ea18f), A-AC5 (e54bd58b), A-AC6/7/8 (7ef53d55), A-AC9 (7a78312c),
 * A-AC10 (3a4a0405), A-AC12 (39799f8e); B-AC2/3 (46cf1086), B-AC5/6/7 (91a8c640),
 * B-AC9 (34b69c69), B-AC10 (7e5469d3).
 *
 * Resource lane: spawns the built bin per call.
 *
 * B-AC7 negative control (run 2026-10-07, 91a8c640): the pre-change globally installed
 * `adhd-backlog timeline --input '{"sessionId":"S1"}'` exits 4 with a typed `not_found`
 * "Unknown command" error on stderr; the built bin of this branch exits 1 with the
 * `item_not_found` envelope asserted below, and returns real ops for known sessions.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintBacklogSandbox, type SandboxHandle } from './test/helpers/spawn-backlog-bin.js';
import { call, driveSessionFlows, ok, type ISessionFlowsResult } from './test/helpers/session-flows-driver.js';
import { runInBacklogSandbox } from './test/helpers/spawn-backlog-bin.js';
import { e2eTestTimeoutMs } from './test/helpers/spawn-timeout.js';

describe('phase 6 A — the built bin', () => {
  let scratch: string;
  let sandbox: SandboxHandle;
  let root1: string;
  let root2: string;
  let outside: string;
  let p1: string;
  let p2: string;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'phase6-ab-e2e-')));
    sandbox = mintBacklogSandbox();
    root1 = join(scratch, 'one');
    root2 = join(scratch, 'two');
    outside = join(scratch, 'outside');
    for (const d of [join(root1, 'pkg-a'), join(root2, 'pkg-x'), outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(root1, 'pkg-a', 'a.ts'), 'a\n');
    writeFileSync(join(root2, 'pkg-x', 'x.ts'), 'x\n');
    writeFileSync(join(outside, 'o.ts'), 'o\n');
    p1 = ok(call(sandbox, 'upsert-project', { name: 'one', path: root1, by: 's' }), 'p1')['uid'] as string;
    p2 = ok(call(sandbox, 'upsert-project', { name: 'two', path: root2, by: 's' }), 'p2')['uid'] as string;
    const c1 = ok(call(sandbox, 'upsert-component', { project: p1, name: 'pkg-a', by: 's' }), 'c1')['uid'] as string;
    const c2 = ok(call(sandbox, 'upsert-component', { project: p2, name: 'pkg-x', by: 's' }), 'c2')['uid'] as string;
    ok(call(sandbox, 'upsert-location', { component: c1, locType: 'path', value: join(root1, 'pkg-a'), by: 's' }), 'l1');
    ok(call(sandbox, 'upsert-location', { component: c2, locType: 'path', value: join(root2, 'pkg-x'), by: 's' }), 'l2');
  }, e2eTestTimeoutMs(10));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(sandbox.adhdRoot, { recursive: true, force: true });
  });

  it(
    '050ea18f A-AC1 / e54bd58b A-AC5 / 7e5469d3 B-AC10: out-of-root + directory citations persist; membership spans two projects; byCitationPath finds it',
    () => {
      const fileInP2 = join(root2, 'pkg-x', 'x.ts');
      const uid = ok(
        call(sandbox, 'create', {
          project: p1,
          title: 'spans two projects',
          body: 'b',
          by: 'filer',
          citations: [{ file: join(root1, 'pkg-a', 'a.ts') }, { file: fileInP2 }, { file: join(outside, 'o.ts') }, { file: outside }, { file: 'url:https://example.com/x' }],
        }),
        'create'
      )['uid'] as string;

      const card = ok(call(sandbox, 'get', { uid, fields: ['citations', 'primaryOwner', 'memberships'] }), 'get') as unknown as {
        citations: Array<{ file: string; verification: string; unverifiedReason?: string }>;
        primaryOwner: { projectUid: string };
        memberships: Array<{ projectUid: string; via: string }>;
      };
      const byFile = new Map(card.citations.map((c) => [c.file, c]));
      expect(byFile.get(join(outside, 'o.ts'))?.verification).toBe('verified'); // existing out-of-root file
      expect(byFile.get(outside)?.verification).toBe('unverified-with-reason'); // a directory
      expect(byFile.get(outside)?.unverifiedReason).toBe('target-is-directory');
      expect(byFile.get('url:https://example.com/x')?.unverifiedReason).toBe('abstract-anchor-unchecked');
      expect(card.primaryOwner.projectUid).toBe(p1);
      // One row per (component, via): the primary row and a citation row can both land in p1, so assert per DISTINCT project.
      expect([...new Set(card.memberships.map((m) => m.projectUid))].sort()).toEqual([p1, p2].sort());
      expect(card.memberships.some((m) => m.via === 'primary' && m.projectUid === p1)).toBe(true);
      expect(card.memberships.some((m) => m.via === 'citation' && m.projectUid === p2)).toBe(true);

      const spanning = ok(call(sandbox, 'query', { filter: { memberOfProject: [p2] }, fields: ['uid'] }), 'query') as unknown as { items: Array<{ uid: string }> };
      expect(spanning.items.map((i) => i.uid)).toContain(uid);
      const primaryOnly = ok(call(sandbox, 'query', { filter: { project: p2 }, fields: ['uid'] }), 'query') as unknown as { items: Array<{ uid: string }> };
      expect(primaryOnly.items.map((i) => i.uid)).not.toContain(uid);

      const byPath = ok(call(sandbox, 'query', { projection: 'byCitationPath', path: fileInP2 }), 'byCitationPath') as unknown as { items: Array<{ uid: string }> };
      expect(byPath.items.map((i) => i.uid)).toEqual([uid]);
    },
    e2eTestTimeoutMs(8)
  );

  it(
    '7ef53d55 A-AC6/7/8: SUPERSEDED with reason and successor; query reads them back; out-of-enum is invalid_argument',
    () => {
      const mk = (t: string) => ok(call(sandbox, 'create', { project: p1, title: t, body: 'b', by: 'f' }), t)['uid'] as string;
      const retired = mk('retired');
      const successor = mk('successor');
      // An out-of-enum reason is refused by the CLI schema layer (exit 2) before any envelope exists.
      const badRun = runInBacklogSandbox(sandbox, ['transition', '--input', JSON.stringify({ uid: retired, by: 'o', toStatus: 'SUPERSEDED', note: 'n', reason: 'bogus' })]);
      expect(badRun.status).toBe(2);
      expect(`${badRun.stdout}${badRun.stderr}`).toMatch(/reason/);
      ok(call(sandbox, 'transition', { uid: retired, by: 'o', toStatus: 'SUPERSEDED', note: 'n', supersededBy: successor, reason: 'deliberate-plan-retirement' }), 'transition');
      const rows = ok(call(sandbox, 'query', { filter: { status: 'SUPERSEDED' }, fields: ['uid', 'supersedeReason', 'supersededBy'] }), 'query') as unknown as {
        items: Array<{ uid: string; supersedeReason: string | null; supersededBy: string | null }>;
      };
      expect(rows.items.find((r) => r.uid === retired)).toMatchObject({ supersedeReason: 'deliberate-plan-retirement', supersededBy: successor });
    },
    e2eTestTimeoutMs(8)
  );

  it(
    '7a78312c A-AC9: a terminal parent with open children is flagged by part-of-rollup and the orphaned-parents view',
    () => {
      const mk = (t: string) => ok(call(sandbox, 'create', { project: p1, title: t, body: 'b', by: 'f' }), t)['uid'] as string;
      const parent = mk('orphan parent');
      const kids = [mk('kid 1'), mk('kid 2')];
      for (const k of kids) ok(call(sandbox, 'relate', { sourceUid: k, targetUid: parent, rel: 'part_of', action: 'add', by: 'o' }), 'relate');
      ok(call(sandbox, 'transition', { uid: parent, by: 'o', toStatus: 'closed', note: 'done' }), 'close');
      const r = ok(call(sandbox, 'part-of-rollup', { uid: parent }), 'rollup') as unknown as { orphanedParent?: { openChildren: number } };
      expect(r.orphanedParent?.openChildren).toBe(2);
      const v = ok(call(sandbox, 'query', { view: 'orphaned-parents' }), 'view') as unknown as { items: Array<{ uid: string }> };
      expect(v.items.map((i) => i.uid)).toContain(parent);
    },
    e2eTestTimeoutMs(10)
  );

  it(
    '3a4a0405 A-AC10: over the real CLI a too-short prefix is invalid_argument and an unmatched 8-char prefix is item_not_found (the ambiguous_reference candidate set is proven in uid-verbs.ambiguity.spec.ts)',
    () => {
      const uid = ok(call(sandbox, 'create', { project: p1, title: 'prefix probe', body: 'b', by: 'f' }), 'create')['uid'] as string;
      const short = call(sandbox, 'get', { uid: uid.slice(0, 2) });
      expect(short.ok).toBe(false);
      expect(short.error?.code).toBe('invalid_argument');
      const exactPrefix = call(sandbox, 'get', { uid: uid.slice(0, 8) });
      expect(exactPrefix.ok).toBe(true);
      const none = call(sandbox, 'get', { uid: uid.slice(0, 7) === 'deadbee' ? 'cafef00d' : 'deadbeef' });
      expect(none.ok).toBe(false);
      expect(none.error?.code).toBe('item_not_found');
    },
    e2eTestTimeoutMs(8)
  );
});

describe('phase 6 B — sessions, reservations, timeline through the built bin', () => {
  let scratch: string;
  let result: ISessionFlowsResult;

  beforeAll(() => {
    // realpath: macOS tmpdir is /var -> /private/var and the reservations pathPrefix is realpath-canonical.
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'phase6-b-e2e-')));
    result = driveSessionFlows(scratch);
  }, e2eTestTimeoutMs(40));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(result.sandbox.adhdRoot, { recursive: true, force: true });
  });

  it('91a8c640 B-AC5/B-AC7: timeline returns agent, session and ordered ops, including the child session', () => {
    const f1 = result.flows[0]!.timeline;
    expect(f1.session).toMatchObject({ sessionId: 'S-flow-1', agent: 'agent-alpha' });
    expect(f1.ops.map((o) => o.op)).toEqual(['created', 'claimed', 'transitioned', 'released']);

    const f2 = result.flows[1]!.timeline;
    expect(f2.children).toEqual(['S-flow-2.1']);
    expect(f2.ops.map((o) => `${o.sessionId}:${o.op}:${o.agent}`)).toEqual([
      'S-flow-2:created:agent-beta',
      'S-flow-2:claimed:agent-beta',
      'S-flow-2.1:created:agent-gamma',
      'S-flow-2.1:transitioned:agent-gamma',
    ]);
  });

  it('46cf1086 B-AC2/B-AC3: the reservations view lists the claim made in flow 3 before the reclaim, with its session', () => {
    const mine = result.reservationsDuringFlow3.filter((r) => r.holder === 'agent-delta');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ sessionId: 'S-flow-3' });
    expect(mine[0]!.path.endsWith('delta.ts')).toBe(true);
  });

  it('91a8c640 B-AC6: the reclaim shows as an op by the OTHER agent, in the child session of flow 3', () => {
    const f3 = result.flows[2]!.timeline;
    expect(f3.ops.map((o) => `${o.sessionId}:${o.op}:${o.agent}`)).toEqual([
      'S-flow-3:created:agent-delta',
      'S-flow-3:claimed:agent-delta',
      'S-flow-3.1:reclaimed-stale:agent-epsilon',
    ]);
    expect(f3.ops[2]!.delta).toMatchObject({ from: 'agent-delta', to: 'agent-epsilon' });
  });

  it('91a8c640 B-AC7: an unknown session is item_not_found over the real CLI', () => {
    const env = call(result.sandbox, 'timeline', { sessionId: 'S-does-not-exist' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('item_not_found');
  });

  it('34b69c69 B-AC9: spec-append then get specRevisionFragment returns the same bytes over the real CLI', () => {
    const project = ok(call(result.sandbox, 'upsert-project', { name: 'spec-proj', by: 's' }), 'p')['uid'] as string;
    const uid = ok(call(result.sandbox, 'create', { project, title: 'spec', body: 'b', by: 'f' }), 'create')['uid'] as string;
    const body = '## naïve ☕ 日本語\r\nline2\n';
    ok(call(result.sandbox, 'spec-append', { uid, fragment: body, base_revision: '', by: 'a' }), 'spec-append');
    const got = ok(call(result.sandbox, 'get', { uid, fields: ['specRevisionFragment'] }), 'get') as unknown as { specRevisionFragment: { fragment: string } };
    expect(got.specRevisionFragment.fragment).toBe(body);
  });
});
