// guards: The policy client operations return a wrong decision or hide why: deny/ask/allow precedence across layers, attribute defaulting, explain output, narrowing that widens, audit sink and createDecider host-port mapping.
// tier: S
// cites: L1.1-L1.4 client operations (evaluate, check, verify, explain, narrow, createDecider).

import { ApiError } from '@adhd/apigen-base-errors';
import { describe, expect, it } from 'vitest';
import { createDecider, createMemoryCtx, createPolicyClient } from '../../../src/index';
import type { IAuditEntry, IDecision } from '../../../src/index';
import { layer } from '../../helpers/policies';

/** Three layers whose rules interact: global denies shell, project asks on writes, local widens. */
const GLOBAL = {
  version: 1,
  attributes: { role: 'name', read_roots: 'paths', write_roots: 'paths' },
  defaults: [{ set: { role: 'guest' } }],
  permissions: [
    { tool: 'shell/*', effect: 'deny' },
    { tool: 'files/read', args: { path: { _within: '$attributes.read_roots' } } },
  ],
};
const PROJECT = {
  version: 1,
  permissions: [
    { tool: 'files/write', effect: 'ask', args: { path: { _within: '$attributes.write_roots' } } },
    { tool: 'agent/spawn', args: { child: { write_roots: { _within: '$attributes.write_roots' } } } },
  ],
};
const LOCAL = {
  version: 1,
  permissions: [
    { tool: 'files/write', args: { path: { _within: '$attributes.write_roots' } } },
    { tool: 'shell/exec' },
    { tool: 'files/stat' },
  ],
};
// Deliberately out of order: the client orders them global, project, local.
const LAYERS = [layer('local', LOCAL), layer('global', GLOBAL), layer('project', PROJECT)];

const client = (): ReturnType<typeof createPolicyClient> => createPolicyClient({ layers: LAYERS });

describe('Feature: decisions across the global, project and local layers', () => {
  it('@L1.1 deny beats ask beats allow, across layers, and matched lists ids in layer order', async () => {
    const c = client();
    const attributes = { role: 'dev', read_roots: ['/work'], write_roots: ['/work'] };

    // global denies shell.*, local allows shell.exec: the deny from the earlier layer wins.
    const shell = await c.evaluate({ tool: 'shell/exec', attributes });
    expect(shell.effect).toBe('deny');
    expect(shell.denial?.code).toBe('explicit-deny');
    expect(shell.matched).toEqual(['global:0', 'local:1']);

    // project asks, local allows the same write: ask beats allow.
    const write = await c.evaluate({ tool: 'files/write', args: { path: '/work/a.txt' }, attributes });
    expect(write.effect).toBe('ask');
    expect(write.matched).toEqual(['project:0', 'local:0']);

    // A call outside the write root matches neither write permission: no-match deny.
    const outside = await c.evaluate({ tool: 'files/write', args: { path: '/etc/passwd' }, attributes });
    expect(outside.effect).toBe('deny');
    expect(outside.denial?.code).toBe('no-match');

    // Only local mentions files.stat: allow.
    expect((await c.evaluate({ tool: 'files/stat', attributes })).effect).toBe('allow');
    // A tool nobody mentions is denied.
    expect((await c.evaluate({ tool: 'nothing/here', attributes })).denial?.code).toBe('no-match');
  });

  it('@L1.2 check returns an allow and throws permission_denied carrying the decision for ask and deny', async () => {
    const c = client();
    const attributes = { read_roots: ['/work'], write_roots: ['/work'] };

    const allowed = await c.check({ tool: 'files/read', args: { path: '/work/a' }, attributes });
    expect(allowed.effect).toBe('allow');

    const asked = await c.check({ tool: 'files/write', args: { path: '/work/a' }, attributes }).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(ApiError);
    expect((asked as ApiError).code).toBe('permission_denied');
    expect(((asked as ApiError).details as { decision: IDecision }).decision.effect).toBe('ask');

    const denied = await c.check({ tool: 'shell/exec', attributes }).catch((e: unknown) => e);
    expect((denied as ApiError).code).toBe('permission_denied');
    expect(((denied as ApiError).details as { decision: IDecision }).decision.denial?.code).toBe('explicit-deny');
  });

  it('@L1.3 a project layer may not set an absolute path; verify reports it and every other defect together', async () => {
    const bad = {
      version: 1,
      attributes: { read_roots: 'paths' },
      defaults: [{ set: { read_roots: ['/abs'] } }],
      permissions: [{ tool: 'x/y', args: { a: { _nope: 1 } } }, { tool: 'x/z', args: { a: '$attributes.ghost' } }],
    };
    const report = await createPolicyClient({ layers: [layer('project', bad, 'project.yaml')] }).verify();
    expect(report.ok).toBe(false);
    expect(report.sources).toEqual(['project.yaml']);
    const codes = report.errors.map((e) => e.code).sort();
    expect(codes).toEqual(['layer-violation', 'undeclared-attribute', 'unknown-operator']);
    // compile reports the same, not thrown.
    const summary = await createPolicyClient({ layers: [layer('project', bad)] }).compile();
    expect(summary.ok).toBe(false);
    expect(summary.errors).toHaveLength(3);
    expect(summary.policy).toBeUndefined();
  });

  it('@L1.4 evaluate rejects a malformed call and a policy that cannot compile never yields a decision', async () => {
    const c = client();
    await expect(c.evaluate({ tool: '' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(c.evaluate({ tool: 't', args: [] as unknown as Record<string, unknown> })).rejects.toMatchObject({ code: 'invalid_argument' });

    const broken = createPolicyClient({ layers: [layer('project', { version: 2, permissions: [] }, 'broken.yaml')] });
    const failure = await broken.evaluate({ tool: 'files/read' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('internal');
    expect((failure as ApiError).message).toContain('policy failed to compile');
    expect((failure as ApiError).message).toContain('broken.yaml');

    // An issue whose own message does not name the file still reports the layer source.
    const noName = createPolicyClient({
      layers: [layer('project', { version: 1, permissions: [{ tool: 'x/y', args: { a: { _nope: 1 } } }] }, 'ops.yaml')],
    });
    await expect(noName.evaluate({ tool: 'x/y' })).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('[ops.yaml]'),
    });
  });
});

describe('Feature: attributes - supplied, defaulted and declared', () => {
  it('@A1.1 supplied values are final, defaults fill the rest, undeclared attributes are dropped', async () => {
    const c = createPolicyClient({
      layers: [
        layer('global', {
          version: 1,
          attributes: { role: 'name', team: 'name', read_roots: 'paths' },
          defaults: [
            { set: { role: 'guest', read_roots: ['/pub'] } },
            { where: { team: { _eq: 'payments' } }, set: { read_roots: ['/pay'] } },
          ],
          permissions: [{ tool: 't' }],
        }),
      ],
    });
    const none = await c.resolve();
    expect(none.attributes).toEqual({ read_roots: ['/pub'], role: 'guest' });
    expect(none.provenance).toEqual({ read_roots: 'global:0', role: 'global:0' });

    const payments = await c.resolve({ attributes: { team: 'payments', role: 'admin', stranger: 'x' } });
    // role is supplied (final), team is supplied, read_roots comes from the LAST matching rule, stranger is dropped.
    expect(payments.attributes).toEqual({ read_roots: ['/pay'], role: 'admin', team: 'payments' });
    expect(payments.provenance).toEqual({ read_roots: 'global:1', role: 'supplied', team: 'supplied' });
  });

  it('@A1.2 AT-10 a comparison on an absent attribute is false, including negative operators; _is_null is the presence test', async () => {
    const decls = { version: 1, attributes: { level: 'name' } } as const;
    const doc = (permissions: unknown[]): ReturnType<typeof layer> => layer('project', { ...decls, permissions });

    // A deny conditioned on a missing attribute does NOT fire.
    const guarded = createPolicyClient({
      layers: [doc([{ tool: 't/run' }, { tool: 't/run', effect: 'deny', context: { level: { _ne: 'high' } } }])],
    });
    expect((await guarded.evaluate({ tool: 't/run' })).effect).toBe('allow');
    expect((await guarded.evaluate({ tool: 't/run', attributes: { level: 'low' } })).denial?.code).toBe('explicit-deny');
    expect((await guarded.evaluate({ tool: 't/run', attributes: { level: 'high' } })).effect).toBe('allow');

    // _nin and _nlike are false on an absent attribute too.
    const negatives = createPolicyClient({
      layers: [
        doc([
          { tool: 't/run' },
          { tool: 't/run', effect: 'deny', context: { level: { _nin: ['x'] } } },
          { tool: 't/run', effect: 'deny', context: { level: { _nlike: '%x%' } } },
        ]),
      ],
    });
    expect((await negatives.evaluate({ tool: 't/run' })).effect).toBe('allow');
    expect((await negatives.evaluate({ tool: 't/run', attributes: { level: 'y' } })).effect).toBe('deny');

    // _is_null is the presence test: it holds exactly when the attribute is absent.
    const presence = createPolicyClient({
      layers: [doc([{ tool: 't/run' }, { tool: 't/run', effect: 'deny', context: { level: { _is_null: true } } }])],
    });
    expect((await presence.evaluate({ tool: 't/run' })).denial?.code).toBe('explicit-deny');
    expect((await presence.evaluate({ tool: 't/run', attributes: { level: 'low' } })).effect).toBe('allow');

    // _not negates the false comparison (two-valued): the negated rule fires when the attribute is absent.
    const negated = createPolicyClient({
      layers: [doc([{ tool: 't/run' }, { tool: 't/run', effect: 'deny', context: { _not: { level: { _eq: 'high' } } } }])],
    });
    expect((await negated.evaluate({ tool: 't/run' })).denial?.code).toBe('explicit-deny');
    expect((await negated.evaluate({ tool: 't/run', attributes: { level: 'high' } })).effect).toBe('allow');
  });

  it('@A1.3 AT-10 an absent $attributes placeholder in args makes the comparison false and explain lists the absent value', async () => {
    const c = createPolicyClient({
      layers: [
        layer('project', {
          version: 1,
          attributes: { home: 'name' },
          permissions: [
            { tool: 'f/open', args: { dir: { _eq: '$attributes.home' } } },
            { tool: 'f/other', args: { dir: { _ne: '$attributes.home' } } },
          ],
        }),
      ],
    });
    expect((await c.evaluate({ tool: 'f/open', args: { dir: 'x' } })).denial?.code).toBe('no-match');
    expect((await c.evaluate({ tool: 'f/open', args: { dir: 'x' }, attributes: { home: 'x' } })).effect).toBe('allow');
    // `_ne` against an absent placeholder is false, not "everything differs from nothing".
    expect((await c.evaluate({ tool: 'f/other', args: { dir: 'x' } })).denial?.code).toBe('no-match');
    expect((await c.evaluate({ tool: 'f/other', args: { dir: 'x' }, attributes: { home: 'y' } })).effect).toBe('allow');
  });

  it('@A1.3 a deny whose regular expression comes from an absent attribute does not fire and does not error', async () => {
    const c = createPolicyClient({
      layers: [
        layer('project', {
          version: 1,
          attributes: { pattern: 'name' },
          permissions: [{ tool: 'f/rx' }, { tool: 'f/rx', effect: 'deny', args: { path: { _regex: '$attributes.pattern' } } }],
        }),
      ],
    });
    const absent = await c.evaluate({ tool: 'f/rx', args: { path: '/a/.env' } });
    expect(absent.effect).toBe('allow');
    expect(absent.denial).toBeUndefined();
    expect((await c.evaluate({ tool: 'f/rx', args: { path: '/a/.env' }, attributes: { pattern: '\\.env$' } })).denial?.code).toBe('explicit-deny');
  });

  it('@A1.4 list-valued path arguments are within a root only when every element is', async () => {
    const c = createPolicyClient({
      layers: [layer('project', { version: 1, attributes: { roots: 'paths' }, permissions: [{ tool: 'f/many', args: { paths: { _within: '$attributes.roots' } } }] })],
    });
    const attributes = { roots: ['/work'] };
    expect((await c.evaluate({ tool: 'f/many', args: { paths: ['/work/a', '/work/b/../c'] }, attributes })).effect).toBe('allow');
    expect((await c.evaluate({ tool: 'f/many', args: { paths: ['/work/a', '/etc/passwd'] }, attributes })).denial?.code).toBe('no-match');
    expect((await c.evaluate({ tool: 'f/many', args: { paths: ['/work/../etc/passwd'] }, attributes })).denial?.code).toBe('no-match');
  });
});

describe('Feature: explain shows what was considered', () => {
  it('@E1.1 explain returns the decision, every permission considered and the substituted arguments', async () => {
    const c = client();
    const explanation = await c.explain({
      tool: 'files/write',
      args: { path: '/work/a.txt' },
      attributes: { write_roots: ['/work'] },
    });
    expect(explanation.decision.effect).toBe('ask');
    expect(explanation.considered.map((entry) => entry.id)).toEqual(['project:0', 'local:0']);
    expect(explanation.considered.every((entry) => entry.applicable && entry.argsMatched === true)).toBe(true);
    expect(explanation.considered[0].substituted).toEqual({ path: { _within: ['/work'] } });

    const miss = await c.explain({ tool: 'files/write', args: { path: '/etc/x' }, attributes: { write_roots: ['/work'] } });
    expect(miss.considered.map((entry) => entry.argsMatched)).toEqual([false, false]);
  });
});

/** A policy whose `agent.spawn` guards `child.write_roots`, so `write_roots` is a narrowed attribute and `role` is not. */
const NARROWING = layer('project', {
  version: 1,
  attributes: { role: 'name', write_roots: 'paths' },
  permissions: [{ tool: 'agent/spawn', args: { child: { write_roots: { _within: '$attributes.write_roots' } } } }],
});

describe('Feature: narrowing - grant adds, only restricts, widening is refused', () => {
  const parent = Object.freeze({ role: 'dev', write_roots: Object.freeze(['/work']) });
  const client = (): ReturnType<typeof createPolicyClient> => createPolicyClient({ layers: [NARROWING] });

  it('@N1.1 only restricts to a subset and grant of what the parent holds is accepted; the parent is untouched', async () => {
    const c = client();
    const snapshot = JSON.stringify(parent);

    const restricted = await c.narrow({ parent, request: { only: { write_roots: ['/work/sub'] } } });
    expect(restricted).toEqual({ ok: true, child: { role: 'dev', write_roots: ['/work/sub'] } });

    const granted = await c.narrow({ parent, request: { grant: { write_roots: ['/work/sub'] } } });
    expect(granted).toEqual({ ok: true, child: { role: 'dev', write_roots: ['/work/sub'] } });

    expect(JSON.stringify(parent)).toBe(snapshot);
  });

  it('@N1.2 widening is refused naming the attribute and the rule', async () => {
    const c = client();
    expect(await c.narrow({ parent, request: { grant: { write_roots: ['/etc'] } } })).toMatchObject({
      ok: false,
      variable: 'write_roots',
      rule: 'exceeds-parent',
    });
    expect(await c.narrow({ parent, request: { only: { write_roots: ['/etc'] } } })).toMatchObject({
      ok: false,
      variable: 'write_roots',
      rule: 'only-outside',
    });
    // An attribute no narrowing check covers cannot be granted at all.
    expect(await c.narrow({ parent, request: { grant: { role: 'admin' } } })).toMatchObject({ ok: false, variable: 'role', rule: 'uncovered' });
    // A grant of the wrong kind is refused.
    expect(await c.narrow({ parent, request: { grant: { write_roots: 'nope' } } })).toMatchObject({ ok: false, rule: 'type' });
  });

  it('@N1.3 a supplied attribute is final: grant cannot change it, and supplied values do not need a grant', async () => {
    const c = client();
    expect(await c.narrow({ parent, request: { attributes: { write_roots: ['/work/x'] }, grant: { write_roots: ['/work/y'] } } })).toMatchObject({
      ok: false,
      rule: 'supplied-final',
    });
  });
});

describe('Feature: the runtime provider and the audit sink', () => {
  const runtimePolicy = layer('project', {
    version: 1,
    runtime: { calls: 'number' },
    permissions: [{ tool: 'api/call', context: { runtime: { calls: { _lte: 2 } } } }],
  });

  it('@R1.1 runtime values come from the provider, one observe per decision; none available denies runtime-unavailable', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    const c = createPolicyClient({
      layers: [runtimePolicy],
      runtime: {
        async observe(input) {
          calls += 1;
          seen.push(input.tool);
          return { calls };
        },
      },
    });
    expect((await c.evaluate({ tool: 'api/call' })).effect).toBe('allow');
    expect((await c.evaluate({ tool: 'api/call' })).effect).toBe('allow');
    expect((await c.evaluate({ tool: 'api/call' })).denial?.code).toBe('no-match');
    expect(seen).toEqual(['api/call', 'api/call', 'api/call']);

    // Caller-supplied runtime wins over the provider.
    expect((await c.evaluate({ tool: 'api/call', runtime: { calls: 0 } })).effect).toBe('allow');
    expect(calls).toBe(3);

    // No provider and no values: fail closed.
    const bare = createPolicyClient({ layers: [runtimePolicy] });
    expect((await bare.evaluate({ tool: 'api/call' })).denial?.code).toBe('runtime-unavailable');

    // A provider that throws leaves the values unavailable: deny, never allow.
    const broken = createPolicyClient({ layers: [runtimePolicy], runtime: { observe: () => Promise.reject(new Error('down')) } });
    expect((await broken.evaluate({ tool: 'api/call' })).denial?.code).toBe('runtime-unavailable');
  });

  it('@R1.2 the audit sink gets one redacted record per decision; a failing sink or clock never changes the decision', async () => {
    const entries: IAuditEntry[] = [];
    const c = createPolicyClient({
      layers: LAYERS,
      audit: { record: (entry) => void entries.push(entry) },
      now: () => 1234,
    });
    await c.evaluate({ tool: 'files/read', args: { path: '/work/a' }, attributes: { read_roots: ['/work'], role: 'secret-role-value' } });
    await c.evaluate({ tool: 'shell/exec' });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ at: 1234, tool: 'files/read', effect: 'allow', matched: ['global:1'] });
    expect(entries[0].attributeNames).toEqual(['read_roots', 'role']);
    expect(entries[1]).toMatchObject({ effect: 'deny', denialCode: 'explicit-deny' });
    // Values are never recorded.
    expect(JSON.stringify(entries)).not.toContain('secret-role-value');
    expect(JSON.stringify(entries)).not.toContain('/work');

    const failing = createPolicyClient({
      layers: LAYERS,
      audit: { record: () => { throw new Error('disk full'); } },
      now: () => { throw new Error('no clock'); },
    });
    const decision = await failing.evaluate({ tool: 'files/read', args: { path: '/work/a' }, attributes: { read_roots: ['/work'] } });
    expect(decision.effect).toBe('allow');
  });

  it('@R1.3 a policy that cannot load rejects and is audited as a deny eval-error', async () => {
    const entries: IAuditEntry[] = [];
    const c = createPolicyClient({
      layers: [layer('project', { version: 9, permissions: [] })],
      audit: { record: (entry) => void entries.push(entry) },
    });
    await expect(c.evaluate({ tool: 'x/y', attributes: { a: 'b' } })).rejects.toMatchObject({ code: 'internal' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ effect: 'deny', denialCode: 'eval-error', attributeNames: ['a'] });
  });
});

describe('Feature: createDecider maps a decision onto the host port', () => {
  it('@D1.1 allow carries the forced set, ask carries a reason, deny carries the denial, load failure denies', async () => {
    const ctx = createMemoryCtx({
      layers: [
        layer('project', {
          version: 1,
          permissions: [
            { tool: 'a/allow', set: { dry: true } },
            { tool: 'a/ask', effect: 'ask' },
            { tool: 'a/deny', effect: 'deny' },
          ],
        }),
      ],
    });
    const decider = createDecider(ctx);
    const base = { args: {}, envelope: {}, transport: 'cli' } as const;
    expect(await decider.decide({ ...base, tool: 'a/allow' })).toEqual({ decision: 'allow', set: { dry: true } });
    expect(await decider.decide({ ...base, tool: 'a/ask' })).toMatchObject({ decision: 'ask' });
    expect(await decider.decide({ ...base, tool: 'a/deny' })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('denied by permission project:2') });
    expect(await decider.decide({ ...base, tool: 'a/unknown' })).toMatchObject({ decision: 'deny' });

    const aborted = new AbortController();
    aborted.abort();
    expect(await decider.decide({ ...base, tool: 'a/allow' }, aborted.signal)).toMatchObject({ decision: 'deny' });

    const broken = createDecider(createMemoryCtx({ layers: [layer('project', { version: 9, permissions: [] })] }));
    expect(await broken.decide({ ...base, tool: 'a/allow' })).toMatchObject({ decision: 'deny' });
  });
});
