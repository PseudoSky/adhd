import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCtx,
  createFsLayerSource,
  createPolicyClient,
  nodePolicyFs,
  parsePolicyYaml,
} from '../../index';
import type { IPolicyFs } from '../../index';
import { layer } from '../helpers/policies';
import { withTmpDir } from '../helpers/tmp';

describe('Feature: review fixes - the client fails closed and says why', () => {
  describe('C1 narrowing of supplied keys', () => {
    const spawn = layer('project', {
      version: 1,
      attributes: { role: 'name', write_roots: 'paths' },
      permissions: [{ tool: 'agent.spawn', args: { child: { write_roots: { _within: '$attributes.write_roots' } } } }],
    });
    const client = createPolicyClient({ layers: [spawn] });

    it('@C1 a supplied write_roots of "/" is refused against a parent holding "/work"', async () => {
      const outcome = await client.narrow({ parent: { write_roots: ['/work'] }, request: { attributes: { write_roots: ['/'] } } });
      expect(outcome).toMatchObject({ ok: false, variable: 'write_roots', rule: 'exceeds-parent' });
    });

    it('@C1 a supplied value inside the parent passes, a parent lacking the key refuses, an uncovered key passes through', async () => {
      const inside = await client.narrow({ parent: { write_roots: ['/work'] }, request: { attributes: { write_roots: ['/work/sub'] } } });
      expect(inside).toEqual({ ok: true, child: { write_roots: ['/work/sub'] } });

      const noParentKey = await client.narrow({ parent: {}, request: { attributes: { write_roots: ['/work'] } } });
      expect(noParentKey).toMatchObject({ ok: false, variable: 'write_roots', rule: 'exceeds-parent' });

      // `role` is not guarded by any narrowing check, so a supplied role is final and unchecked.
      const role = await client.narrow({ parent: { write_roots: ['/work'] }, request: { attributes: { role: 'admin' } } });
      expect(role).toEqual({ ok: true, child: { role: 'admin', write_roots: ['/work'] } });
    });
  });

  describe('C2 a rule that cannot be evaluated denies the call', () => {
    const doc = {
      version: 1,
      attributes: { pattern: 'name' },
      permissions: [
        { tool: 'files.read' },
        { tool: 'files.read', effect: 'deny', args: { path: { _regex: '$attributes.pattern' } } },
      ],
    };

    it('@C2 a deny whose regular expression comes from an attribute and does not compile denies eval-error naming the permission', async () => {
      const client = createPolicyClient({ layers: [layer('project', doc)] });
      const decision = await client.evaluate({ tool: 'files.read', args: { path: '/a/.env' }, attributes: { pattern: '(' } });
      expect(decision.effect).toBe('deny');
      expect(decision.denial?.code).toBe('eval-error');
      expect(decision.denial?.reason).toContain('project:1');
      expect(decision.set).toEqual({});
      // explain reports the same refusal.
      const explained = await client.explain({ tool: 'files.read', args: { path: '/a/.env' }, attributes: { pattern: '(' } });
      expect(explained.decision.denial?.code).toBe('eval-error');
    });

    it('@C2 the same deny with a valid pattern works as a deny, and without a match the allow stands', async () => {
      const client = createPolicyClient({ layers: [layer('project', doc)] });
      const hit = await client.evaluate({ tool: 'files.read', args: { path: '/a/.env' }, attributes: { pattern: '\\.env$' } });
      expect(hit.denial?.code).toBe('explicit-deny');
      const miss = await client.evaluate({ tool: 'files.read', args: { path: '/a/notes' }, attributes: { pattern: '\\.env$' } });
      expect(miss.effect).toBe('allow');
    });

    it('@C2 a literal regular expression that does not compile is rejected when the policy is verified', async () => {
      const bad = { version: 1, permissions: [{ tool: 'x.y', effect: 'deny', args: { path: { _regex: '(' } } }] };
      const report = await createPolicyClient({ layers: [layer('project', bad)] }).verify();
      expect(report.ok).toBe(false);
      expect(report.errors[0]).toMatchObject({ code: 'unknown-operator', path: '/project/permissions/0/args/path/_regex' });
    });
  });

  describe('C3 properties are own properties', () => {
    it('@C3 a document key named constructor is rejected, and an attribute named constructor is not a valid declaration', async () => {
      const withKey = await createPolicyClient({ layers: [layer('project', { version: 1, permissions: [{ tool: 'a' }], constructor: 1 })] }).verify();
      expect(withKey.ok).toBe(false);
      expect(withKey.errors[0]).toMatchObject({ code: 'schema', path: '/project/constructor' });

      const withAttribute = await createPolicyClient({
        layers: [layer('project', { version: 1, attributes: { constructor: 'bogus' }, permissions: [{ tool: 'a' }] })],
      }).verify();
      expect(withAttribute.ok).toBe(false);
      expect(withAttribute.errors[0].code).toBe('schema');
    });

    it('@C3 a tool called constructor or toString is simply unknown, never an inherited member', async () => {
      const client = createPolicyClient({ layers: [layer('project', { version: 1, permissions: [{ tool: 'a' }] })] });
      for (const tool of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const decision = await client.evaluate({ tool });
        expect(decision.denial?.code, tool).toBe('no-match');
      }
    });

    it('@C3 attributes named like inherited members are dropped, never resolved', async () => {
      const client = createPolicyClient({
        layers: [layer('project', { version: 1, attributes: { role: 'name' }, permissions: [{ tool: 'a' }] })],
      });
      const resolved = await client.resolve({ attributes: JSON.parse('{"constructor":"x","__proto__":"y","role":"dev"}') });
      expect(resolved.attributes).toEqual({ role: 'dev' });
    });
  });

  describe('C5 defaults[].where uses present-only semantics', () => {
    const doc = {
      version: 1,
      attributes: { team: 'name', role: 'name' },
      defaults: [{ where: { team: { _ne: 'payments' } }, set: { role: 'outsider' } }],
      permissions: [{ tool: 'a' }],
    };
    const client = createPolicyClient({ layers: [layer('project', doc)] });

    it('@C5 a not-equal rule does not apply when the attribute was not supplied', async () => {
      expect((await client.resolve()).attributes).toEqual({});
      expect((await client.resolve({ attributes: { team: 'search' } })).attributes).toEqual({ role: 'outsider', team: 'search' });
      expect((await client.resolve({ attributes: { team: 'payments' } })).attributes).toEqual({ team: 'payments' });
    });
  });

  describe('C2/C5 a defaults rule that cannot be evaluated is never skipped', () => {
    const doc = {
      version: 1,
      attributes: { team: 'name', role: 'name' },
      defaults: [{ where: { team: { _regex: 5 } }, set: { role: 'x' } }],
      permissions: [{ tool: 'a' }],
    };
    const client = createPolicyClient({ layers: [layer('project', doc)] });

    it('@C5 resolve fails with internal naming the rule; evaluate denies eval-error', async () => {
      await expect(client.resolve({ attributes: { team: 'a' } })).rejects.toMatchObject({
        code: 'internal',
        message: expect.stringContaining('project:0'),
      });
      const decision = await client.evaluate({ tool: 'a', attributes: { team: 'a' } });
      expect(decision.effect).toBe('deny');
      expect(decision.denial?.code).toBe('eval-error');
      expect(decision.denial?.reason).toContain('defaults rule project:0');
    });
  });

  describe('C8/C2 synthetic row keys are stripped from arguments', () => {
    it('@C8 an argument named $$c0 cannot turn a comparison against an absent attribute into a match', async () => {
      const client = createPolicyClient({
        layers: [layer('project', { version: 1, attributes: { home: 'name' }, permissions: [{ tool: 'f.open', args: { dir: { _eq: '$attributes.home' } } }] })],
      });
      const forged = await client.evaluate({ tool: 'f.open', args: { dir: 'x', $$c0: 1 } });
      expect(forged.denial?.code).toBe('no-match');
      // The honest call with the attribute present is allowed, so the rule itself works.
      expect((await client.evaluate({ tool: 'f.open', args: { dir: 'x' }, attributes: { home: 'x' } })).effect).toBe('allow');
    });

    it('@C8 an argument named $$s0 cannot stand in for a _within result', async () => {
      const client = createPolicyClient({
        layers: [layer('project', { version: 1, attributes: { roots: 'paths' }, permissions: [{ tool: 'f.open', args: { path: { _within: '$attributes.roots' } } }] })],
      });
      const attributes = { roots: ['/work'] };
      expect((await client.evaluate({ tool: 'f.open', args: { path: '/etc/passwd', $$s0: true }, attributes })).denial?.code).toBe('no-match');
      expect((await client.evaluate({ tool: 'f.open', args: { path: '/work/a' }, attributes })).effect).toBe('allow');
    });
  });

  describe('C9 reserved attribute names', () => {
    it('@C9 attributes named runtime or starting with $ are rejected at compile', async () => {
      const bad = { version: 1, attributes: { runtime: 'name', $secret: 'name', fine: 'name' }, permissions: [{ tool: 'a' }] };
      const summary = await createPolicyClient({ layers: [layer('project', bad)] }).compile();
      expect(summary.ok).toBe(false);
      expect(summary.errors.map((e) => e.path).sort()).toEqual(['/project/attributes/$secret', '/project/attributes/runtime']);
      expect(summary.errors.every((e) => e.code === 'schema')).toBe(true);
    });
  });

  describe('C6 draft', () => {
    const operations = [
      { name: 'fs.read', args: [{ name: 'path', type: 'string', kind: 'path', provenance: 'declared' as const }], hints: { readOnly: true } },
      { name: 'fs.readMany', args: [{ name: 'paths', type: 'string[]', kind: 'path', provenance: 'declared' as const }], hints: { readOnly: true } },
      { name: 'fs.remove', args: [{ name: 'path', type: 'string', kind: 'path' }], hints: { destructive: true } },
    ];

    it('@C6 the drafted policy denies secret paths including a trailing slash and nested segments, and allows ordinary ones', async () => {
      const drafted = await createPolicyClient({ layers: [] }).draft({ operations });
      const client = createPolicyClient({ layers: [layer('project', drafted.document)] });
      const attributes = { read_roots: ['/x'] };
      const call = (path: string): Promise<string> =>
        client.evaluate({ tool: 'fs.read', args: { path }, attributes }).then((d) => `${d.effect}${d.denial ? ':' + d.denial.code : ''}`);

      expect(await call('/x/ok.txt')).toBe('allow');
      expect(await call('/x/.env')).toBe('deny:explicit-deny');
      expect(await call('/x/.env/')).toBe('deny:explicit-deny');
      expect(await call('/x/.env/backup')).toBe('deny:explicit-deny');
      expect(await call('/x/sub/.env.local')).toBe('deny:explicit-deny');
      expect(await call('/x/.ssh')).toBe('deny:explicit-deny');
      expect(await call('/x/keys/server.pem')).toBe('deny:explicit-deny');
      // `_` is a literal underscore and `.env` must be a whole segment: lookalikes are ordinary files.
      expect(await call('/x/.envrc')).toBe('allow');
      expect(await call('/x/idxrsa')).toBe('allow');
      expect(await call('/x/id_rsa.pub')).toBe('deny:explicit-deny');
      // Outside the read root nothing is allowed.
      expect(await call('/etc/hosts')).toBe('deny:no-match');
    });

    it('@C6 a list-valued path argument is listed as inferred for review and keeps its root constraint per element', async () => {
      const drafted = await createPolicyClient({ layers: [] }).draft({ operations });
      expect(drafted.inferred).toContainEqual(
        expect.objectContaining({ operation: 'fs.readMany', argument: 'paths', reason: expect.stringContaining('list-valued') })
      );
      expect(drafted.inferred.some((entry) => entry.operation === 'fs.read')).toBe(false);

      const client = createPolicyClient({ layers: [layer('project', drafted.document)] });
      const attributes = { read_roots: ['/x'] };
      expect((await client.evaluate({ tool: 'fs.readMany', args: { paths: ['/x/a', '/x/b'] }, attributes })).effect).toBe('allow');
      expect((await client.evaluate({ tool: 'fs.readMany', args: { paths: ['/x/a', '/etc/passwd'] }, attributes })).denial?.code).toBe('no-match');
    });

    it('@C6 destructive operations are denied outright, read-only allowed, others ask; the yaml parses back to the document', async () => {
      const drafted = await createPolicyClient({ layers: [] }).draft({
        operations: [...operations, { name: 'fs.write', args: [{ name: 'path', type: 'string', kind: 'path' }] }],
        options: { source: 'demo' },
      });
      const client = createPolicyClient({ layers: [layer('project', parsePolicyYaml(drafted.yaml, 'drafted.yaml'))] });
      const attributes = { read_roots: ['/x'], write_roots: ['/x'] };
      expect((await client.evaluate({ tool: 'fs.remove', args: { path: '/x/a' }, attributes })).denial?.code).toBe('explicit-deny');
      expect((await client.evaluate({ tool: 'fs.write', args: { path: '/x/a' }, attributes })).effect).toBe('ask');
      expect(parsePolicyYaml(drafted.yaml, 'drafted.yaml')).toEqual(JSON.parse(JSON.stringify(drafted.document)));
    });

    it('@C6 secretPatterns replaces the built-in list, and ctx is ignored', async () => {
      const drafted = await createPolicyClient({ layers: [] }).draft({ operations, options: { source: 'demo', secretPatterns: ['%/vault/%'] } });
      const client = createPolicyClient({ layers: [layer('project', drafted.document)] });
      const attributes = { read_roots: ['/x'] };
      expect((await client.evaluate({ tool: 'fs.read', args: { path: '/x/vault/k' }, attributes })).denial?.code).toBe('explicit-deny');
      expect((await client.evaluate({ tool: 'fs.read', args: { path: '/x/.env' }, attributes })).effect).toBe('allow');
      await expect(client.draft({ operations: 'nope' as never })).rejects.toMatchObject({ code: 'invalid_argument' });
    });
  });

  describe('C8 the layer cache is keyed by file signature', () => {
    function countingFs(): { fs: IPolicyFs; reads: string[] } {
      const reads: string[] = [];
      return {
        reads,
        fs: {
          async readText(path) {
            reads.push(path);
            return nodePolicyFs.readText(path);
          },
          stat: (path) => (nodePolicyFs.stat as NonNullable<IPolicyFs['stat']>)(path),
        },
      };
    }
    const allowDoc = (tool: string): string => JSON.stringify({ version: 1, permissions: [{ tool }] });

    it('@C8 an unchanged file is read once however many decisions are taken, and a changed file is reloaded', async () => {
      await withTmpDir('cache', async (dir) => {
        const file = join(dir, 'global.yaml');
        await writeFile(file, allowDoc('a.one'));
        const { fs, reads } = countingFs();
        const client = createPolicyClient(createCtx({ source: createFsLayerSource({ explicit: [file], fs }) }));

        for (let i = 0; i < 5; i += 1) expect((await client.evaluate({ tool: 'a.one' })).effect).toBe('allow');
        expect((await client.evaluate({ tool: 'a.two' })).denial?.code).toBe('no-match');
        expect(reads.filter((p) => p === file)).toHaveLength(1);

        // A different size changes the signature: the file is read again and the new policy decides.
        await writeFile(file, allowDoc('a.two') + '\n');
        expect((await client.evaluate({ tool: 'a.two' })).effect).toBe('allow');
        expect((await client.evaluate({ tool: 'a.one' })).denial?.code).toBe('no-match');
        expect(reads.filter((p) => p === file)).toHaveLength(2);
      });
    });

    it('@C8 the compiled policy object is reused while nothing changed and replaced after an edit', async () => {
      await withTmpDir('cache-hash', async (dir) => {
        const file = join(dir, 'global.yaml');
        await writeFile(file, allowDoc('a.one'));
        const ctx = createCtx({ source: createFsLayerSource({ explicit: [file] }) });
        const client = createPolicyClient(ctx);
        const first = await ctx.policy();
        expect(await ctx.policy()).toBe(first);
        const summary = await client.compile();
        expect(summary.contentHash).toBe(first.contentHash);
        await writeFile(file, allowDoc('a.three'));
        const edited = await ctx.policy();
        expect(edited).not.toBe(first);
        expect(edited.contentHash).not.toBe(first.contentHash);
      });
    });

    it('@C8 touching a file without changing its text keeps the parsed layers: the source returns the same array', async () => {
      await withTmpDir('cache-touch', async (dir) => {
        const file = join(dir, 'global.yaml');
        await writeFile(file, allowDoc('a.one'));
        await utimes(file, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
        const { fs, reads } = countingFs();
        const source = createFsLayerSource({ explicit: [file], fs });
        const first = await source.load();
        expect(await source.load()).toBe(first);
        expect(reads).toHaveLength(1);

        // A new modification time forces a read, but identical text reuses the remembered parse.
        await utimes(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
        const touched = await source.load();
        expect(reads).toHaveLength(2);
        expect(touched).toBe(first);
        expect(touched[0]).toBe(first[0]);
      });
    });

    it('@C8 layers are cached independently: editing the local file leaves the global file unread', async () => {
      await withTmpDir('cache-layers', async (dir) => {
        const global = join(dir, 'global.yaml');
        const project = join(dir, 'project.yaml');
        const local = join(dir, 'local.yaml');
        await writeFile(global, allowDoc('g.tool'));
        await writeFile(project, allowDoc('p.tool'));
        await writeFile(local, allowDoc('l.tool'));
        const { fs, reads } = countingFs();
        const client = createPolicyClient(createCtx({ source: createFsLayerSource({ explicit: [global, project, local], fs }) }));
        expect((await client.evaluate({ tool: 'l.tool' })).effect).toBe('allow');
        await writeFile(local, allowDoc('l.other') + '\n');
        expect((await client.evaluate({ tool: 'l.other' })).effect).toBe('allow');
        expect((await client.evaluate({ tool: 'g.tool' })).effect).toBe('allow');
        expect(reads.filter((p) => p === global)).toHaveLength(1);
        expect(reads.filter((p) => p === project)).toHaveLength(1);
        expect(reads.filter((p) => p === local)).toHaveLength(2);
      });
    });
  });

  describe('C7 the project file walk-up stops at stopAt', () => {
    const fileText = (tool: string): string => JSON.stringify({ version: 1, permissions: [{ tool }] });

    it('@C7 a policy file above stopAt is never adopted; without stopAt it would be', async () => {
      await withTmpDir('walkup', async (base) => {
        const home = join(base, 'home');
        const cwd = join(home, 'proj', 'sub');
        await mkdir(cwd, { recursive: true });
        await writeFile(join(base, 'workspace-policy.yaml'), fileText('leak.tool'));

        const bounded = createPolicyClient(createCtx({ source: createFsLayerSource({ cwd, stopAt: home }) }));
        expect((await bounded.evaluate({ tool: 'leak.tool' })).denial?.code).toBe('no-match');
        expect((await bounded.show()).sources).toEqual([{ layer: 'global', source: 'built-in' }]);

        // Control inside the test: the same tree without a ceiling adopts the file above.
        const unbounded = createPolicyClient(createCtx({ source: createFsLayerSource({ cwd }) }));
        // (this walk continues to the filesystem root, so it finds the file in `base` first)
        expect((await unbounded.evaluate({ tool: 'leak.tool' })).effect).toBe('allow');
      });
    });

    it('@C7 the file in stopAt itself is adopted (inclusive) and the nearest file wins', async () => {
      await withTmpDir('walkup-near', async (base) => {
        const home = join(base, 'home');
        const proj = join(home, 'proj');
        const cwd = join(proj, 'sub');
        await mkdir(cwd, { recursive: true });
        await writeFile(join(home, 'workspace-policy.yaml'), fileText('home.tool'));

        const atCeiling = createPolicyClient(createCtx({ source: createFsLayerSource({ cwd, stopAt: home }) }));
        expect((await atCeiling.evaluate({ tool: 'home.tool' })).effect).toBe('allow');

        await writeFile(join(proj, 'workspace-policy.yaml'), fileText('proj.tool'));
        const nearest = createPolicyClient(createCtx({ source: createFsLayerSource({ cwd, stopAt: home }) }));
        expect((await nearest.evaluate({ tool: 'proj.tool' })).effect).toBe('allow');
        expect((await nearest.evaluate({ tool: 'home.tool' })).denial?.code).toBe('no-match');
        expect((await nearest.show()).sources[0].source).toBe(join(proj, 'workspace-policy.yaml'));
      });
    });

    it('@C7 a cwd outside stopAt is not bounded by it', async () => {
      await withTmpDir('walkup-outside', async (base) => {
        const elsewhere = join(base, 'elsewhere');
        const cwd = join(base, 'work', 'deep');
        await mkdir(elsewhere, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(join(base, 'workspace-policy.yaml'), fileText('top.tool'));
        const client = createPolicyClient(createCtx({ source: createFsLayerSource({ cwd, stopAt: elsewhere }) }));
        expect((await client.evaluate({ tool: 'top.tool' })).effect).toBe('allow');
      });
    });

    it('@C7 with no cwd nothing is discovered: the built-in policy denies everything', async () => {
      const client = createPolicyClient(createCtx({ source: createFsLayerSource({}) }));
      expect((await client.evaluate({ tool: 'anything' })).denial?.code).toBe('no-match');
    });
  });

  describe('C11 the unit lane runs in the node environment', () => {
    it('@C11 there is no browser global', () => {
      expect(typeof window).toBe('undefined');
      expect(typeof document).toBe('undefined');
    });
  });
});
