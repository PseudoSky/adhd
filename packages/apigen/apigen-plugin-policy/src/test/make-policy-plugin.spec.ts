// guards: The policy plugin regains process-global state or reads caller attributes from the client envelope: two configurations leak into each other, a client forges attributes, a bare --use allows, or createLayer options are ignored.
// tier: S
// cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R6 (bare --use denies with guidance; attributes from ctx not envelope; two configurations independent), ADR-0019 D1 (createLayer once with the flat options bag), R6 optionsSchema
// tags: regression:module-singleton, security
// teeth: red: npx nx run apigen-plugin-policy:test -> exit 1; negative controls recorded in the Phase C report (envelope read -> "attributes come from ctx" red; module singleton -> "two configurations" red; options ignored -> "createLayer options" red)

import { afterEach, describe, expect, it, vi } from 'vitest';
import policyPlugin, { makePolicyPlugin, PolicyAttributes } from '../index';
import type { IPolicyDecideRequest, IPolicyDecider, IPolicyDecision } from '../index';
import { createHost, latch, layerOf, refusal } from './helpers/harness';

const ALLOW: IPolicyDecision = { decision: 'allow' };

/** Allows exactly the tools in `allowed`; denies the rest with a recognisable reason. */
function toolDecider(allowed: readonly string[], label: string): IPolicyDecider {
  return {
    decide: (request) =>
      Promise.resolve(allowed.includes(request.tool) ? ALLOW : { decision: 'deny', reason: `${label} denies ${request.tool}` }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature: a policy plugin without a decider refuses with configuration guidance', () => {
  it('@T-R6 @negative the default export (bare --use) denies every call with permission_denied and says how to configure a decider', async () => {
    const host = createHost(policyPlugin);
    const error = await refusal(host.invoke('files/read', { path: '/a' }, {}));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toContain('makePolicyPlugin');
    expect(error.message).toContain('decider');
    expect(error.details).toEqual({ code: 'policy-not-configured' });
    expect(host.ran).toHaveLength(0);
  });

  it('@T-R6 @negative makePolicyPlugin() with no options refuses the same way, even with a valid timeoutMs in the host bag', async () => {
    const host = createHost(makePolicyPlugin(), { timeoutMs: 100 });
    const error = await refusal(host.invoke('files/write', { path: '/a' }, { attributes: { role: 'admin' } }));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toContain('makePolicyPlugin');
    expect(host.ran).toHaveLength(0);
  });
});

describe('Feature: attributes come from the call ctx, never from the envelope', () => {
  const teamCore: IPolicyDecider = {
    decide: (request: IPolicyDecideRequest) =>
      Promise.resolve(request.attributes?.['team'] === 'core' ? ALLOW : { decision: 'deny', reason: 'team is not core' }),
  };

  it('@T-R6 @security ctx PolicyAttributes team=core allows although the envelope claims team=other', async () => {
    const host = createHost(makePolicyPlugin({ decider: teamCore }));
    const result = await host.invoke('files/read', { path: '/a' }, { attributes: { team: 'core' }, envelope: { attributes: { team: 'other' } } });
    expect(result).toBe('read-ran');
  });

  it('@T-R6 @security a client-forged envelope.attributes team=core is not honoured: with nothing on ctx the call is denied and the decider saw no attributes', async () => {
    const seen: IPolicyDecideRequest[] = [];
    const decider: IPolicyDecider = {
      decide: (request) => {
        seen.push(request);
        return teamCore.decide(request);
      },
    };
    const host = createHost(makePolicyPlugin({ decider }));
    const error = await refusal(host.invoke('files/read', { path: '/a' }, { envelope: { attributes: { team: 'core' } } }));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe('team is not core');
    expect(seen[0]?.attributes).toBeUndefined();
    // The envelope still reaches the decider verbatim, as data.
    expect(seen[0]?.envelope).toEqual({ attributes: { team: 'core' } });
    expect(host.ran).toHaveLength(0);
  });

  it('@T-R6 @edge a lookalike class is not the PolicyAttributes key: attributes written under it are not seen', async () => {
    class PolicyAttributesCopy {
      constructor(readonly values: Record<string, string>) {}
    }
    const seen: Array<IPolicyDecideRequest['attributes']> = [];
    const host = createHost(makePolicyPlugin({ decider: { decide: (r) => (seen.push(r.attributes), Promise.resolve(ALLOW)) } }));
    const before = {
      name: 'writer',
      capabilities: {
        layer: {
          layer: (call: { ctx: { set(token: unknown, value: unknown): void } }, next: () => unknown) => {
            call.ctx.set(PolicyAttributesCopy, new PolicyAttributesCopy({ team: 'core' }));
            return next();
          },
        },
      },
    };
    expect(PolicyAttributes).not.toBe(PolicyAttributesCopy);
    const writer = layerOf({ id: 'writer', capabilities: before.capabilities as never });
    await host.invoke('files/read', { path: '/a' }, { before: [writer] });
    expect(seen).toEqual([undefined]);
  });

  it('@T-R6 @happy an earlier Layer that writes PolicyAttributes on ctx feeds the policy Layer (LP-14 ordering)', async () => {
    const seen: Array<IPolicyDecideRequest['attributes']> = [];
    const host = createHost(makePolicyPlugin({ decider: { decide: (r) => (seen.push(r.attributes), Promise.resolve(ALLOW)) } }));
    const authLayer = layerOf({
      id: 'auth',
      capabilities: {
        layer: {
          layer: (call: { ctx: { set(token: unknown, value: unknown): void } }, next: () => unknown) => {
            call.ctx.set(PolicyAttributes, new PolicyAttributes({ team: 'core', level: 3, repos: ['a', 'b'] }));
            return next();
          },
        },
      } as never,
    });
    expect(await host.invoke('files/read', { path: '/a' }, { before: [authLayer] })).toBe('read-ran');
    expect({ ...seen[0] }).toEqual({ team: 'core', level: 3, repos: ['a', 'b'] });
  });
});

describe('Feature: two configurations in one process are independent', () => {
  it('@T-R6 @regression one plugin allowing files/read and another denying it, built in the same process, each keep their own verdict in either call order', async () => {
    const allowing = createHost(makePolicyPlugin({ decider: toolDecider(['files/read'], 'A') }));
    const denying = createHost(makePolicyPlugin({ decider: toolDecider([], 'B') }));

    expect(await allowing.invoke('files/read', { path: '/a' }, {})).toBe('read-ran');
    const first = await refusal(denying.invoke('files/read', { path: '/a' }, {}));
    expect(first.code).toBe('permission_denied');
    expect(first.message).toBe('B denies files/read');

    // Reverse order: the later-built plugin must not have replaced the earlier one.
    expect(await allowing.invoke('files/read', { path: '/b' }, {})).toBe('read-ran');
    expect((await refusal(denying.invoke('files/read', { path: '/b' }, {}))).message).toBe('B denies files/read');
    expect(allowing.ran).toHaveLength(2);
    expect(denying.ran).toHaveLength(0);
  });

  it('@T-R6 @regression a configured plugin does not configure the default export, and a plugin built after it does not reconfigure it', async () => {
    const configured = createHost(makePolicyPlugin({ decider: toolDecider(['files/read'], 'A') }));
    expect(await configured.invoke('files/read', { path: '/a' }, {})).toBe('read-ran');
    const bare = createHost(policyPlugin);
    expect((await refusal(bare.invoke('files/read', { path: '/a' }, {}))).details).toEqual({ code: 'policy-not-configured' });
    expect(bare.ran).toHaveLength(0);
  });

  it('@T-R6 @regression a plugin materialised twice with different host bags keeps each Layer on its own timeoutMs', async () => {
    vi.useFakeTimers();
    const plugin = makePolicyPlugin({ decider: { decide: () => new Promise<never>(() => undefined) }, onError: () => undefined });
    const fast = createHost(plugin, { timeoutMs: 10 });
    const slow = createHost(plugin, { timeoutMs: 1000 });
    const fastOutcome = refusal(fast.invoke('files/read', { path: '/a' }, {}));
    const slowOutcome = refusal(slow.invoke('files/read', { path: '/a' }, {}));
    await vi.advanceTimersByTimeAsync(10);
    expect((await fastOutcome).message).toBe('policy decision failed');
    let slowSettled = false;
    void slowOutcome.then(() => (slowSettled = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(slowSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await slowOutcome).message).toBe('policy decision failed');
  });
});

describe('Feature: the plugin shape and its createLayer options (adhd ADR-0019 D1)', () => {
  it('@T-R6 @contract the plugin is id policy, declares createLayer (and no static layer), and carries an optionsSchema', () => {
    const plugin = makePolicyPlugin({ decider: toolDecider([], 'A') });
    expect(plugin.id).toBe('policy');
    const cap = plugin.capabilities?.layer as { createLayer?: unknown; layer?: unknown } | undefined;
    expect(cap?.createLayer).toBeTypeOf('function');
    expect(cap?.layer).toBeUndefined();
    const schema = plugin.optionsSchema as { type?: unknown; properties?: Record<string, unknown> } | undefined;
    expect(schema?.type).toBe('object');
    expect(Object.keys(schema?.properties ?? {})).toEqual(['timeoutMs']);
  });

  it('@T-R6 @contract the default export and a factory plugin share one optionsSchema shape', () => {
    expect(policyPlugin.id).toBe('policy');
    expect(policyPlugin.optionsSchema).toEqual(makePolicyPlugin().optionsSchema);
  });

  it('@T-R6 @negative the optionsSchema accepts a positive number and a positive decimal string for timeoutMs and nothing else', () => {
    const schema = makePolicyPlugin().optionsSchema as { properties: { timeoutMs: { anyOf: Array<Record<string, unknown>> } } };
    const [numeric, textual] = schema.properties.timeoutMs.anyOf as [{ type: string; exclusiveMinimum: number }, { type: string; pattern: string }];
    expect(numeric).toEqual({ type: 'number', exclusiveMinimum: 0 });
    const pattern = new RegExp(textual.pattern);
    for (const ok of ['5', '0.5', '1500', '10.25']) expect(pattern.test(ok), ok).toBe(true);
    for (const bad of ['', '-1', 'abc', '1e3', '5ms', ' 5', '.5', '5.']) expect(pattern.test(bad), bad).toBe(false);
  });

  it('@T-R6 @happy a timeoutMs in the host bag overrides the factory value: decimal string and number both expire the decision', async () => {
    for (const bagValue of [25, '25']) {
      vi.useFakeTimers();
      const entered = latch();
      const plugin = makePolicyPlugin({
        timeoutMs: 100_000,
        onError: () => undefined,
        decider: { decide: () => (entered.resolve(), new Promise<never>(() => undefined)) },
      });
      const host = createHost(plugin, { timeoutMs: bagValue });
      const outcome = refusal(host.invoke('files/read', { path: '/a' }, {}));
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25);
      const error = await outcome;
      expect(error.code, String(bagValue)).toBe('permission_denied');
      expect(error.message, String(bagValue)).toBe('policy decision failed');
      vi.useRealTimers();
    }
  });

  it('@T-R6 @negative an invalid timeoutMs in the host bag fails composition with invalid_argument, before any call', () => {
    const plugin = makePolicyPlugin({ decider: toolDecider([], 'A') });
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0', 'abc', '-5', '1e3', null, {}, true]) {
      let thrown: unknown;
      try {
        layerOf(plugin, { timeoutMs });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string } | undefined)?.code, String(timeoutMs)).toBe('invalid_argument');
      expect((thrown as Error).message).toContain('timeoutMs must be a finite number greater than 0');
    }
  });

  it('@T-R6 @negative an invalid timeoutMs is rejected even when no decider is configured, so a bad --opt is never masked by the refusal Layer', () => {
    expect(() => layerOf(makePolicyPlugin(), { timeoutMs: 'abc' })).toThrow(/timeoutMs must be a finite number greater than 0/);
  });

  it('@T-R6 @edge unknown keys in the shared flat bag are ignored (every --use plugin sees the whole bag)', async () => {
    const host = createHost(makePolicyPlugin({ decider: toolDecider(['files/read'], 'A') }), { cache: '/x', verbose: true, 'http.verb.list': 'GET' });
    expect(await host.invoke('files/read', { path: '/a' }, {})).toBe('read-ran');
  });

  it('@T-R6 @negative an invalid factory timeoutMs throws at construction (not at the first call)', () => {
    for (const timeoutMs of [0, -1, Number.NaN, 'abc', '0']) {
      expect(() => makePolicyPlugin({ decider: toolDecider([], 'A'), timeoutMs: timeoutMs as never }), String(timeoutMs)).toThrow(
        /timeoutMs must be a finite number greater than 0/
      );
    }
  });
});
