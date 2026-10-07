/**
 * Ticket 5e72d493 (PF-1) — deterministic classifier fixtures.
 * Covers 5e72d493 AC1, AC2, AC4, AC5, AC6.
 *
 * AC1 gap, stated: SPEC §1.1 row 17 (cli-text / claudecli) has no pinned patterns
 * because PF-2.AC4's CLI captures do not exist yet. The claudecli fixtures below
 * therefore pin the CURRENT behaviour: cli-text routes through the heuristics and is
 * always `unknown` with a suspected class. When captures land, structured rules
 * replace these fixtures.
 *
 * AC4: this file imports `failure/index.js` with only `@adhd/agent-base-types`
 * resolvable; the no-SDK guarantee is enforced by `nx lint agent-core-provider`
 * (dependency-checks) and the `nx graph` edge assertion, not by string-grepping.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  CLASSIFIER_VERSION,
  FAILURE_RULES,
  PINNED_MESSAGE_RULE,
} from '../../failure/index.js';
import type { ProviderFailureClass, FailureScope } from '@adhd/agent-base-types';
import { anthropicBody, openaiBody, raw } from './helpers.js';

type Exp = [ProviderFailureClass, FailureScope, boolean, boolean];
interface Fx {
  name: string;
  input: ReturnType<typeof raw>;
  expect: Exp;
}

const A = 'anthropic' as const;
const O = 'openai' as const;
const OR = { host: 'openrouter.ai' };

const EXACT = 'You have reached your specified API usage limits.';

const FIXTURES: Fx[] = [
  // ---- Anthropic ----
  { name: 'anthropic-aborted (row 1)', input: raw(A, { aborted: true, errorName: 'AbortError' }), expect: ['cancelled', 'request', false, false] },
  { name: 'anthropic-402-billing_error (row 3)', input: raw(A, { status: 402, body: anthropicBody('billing_error', 'Your credit balance is too low') }), expect: ['billing', 'credential', false, true] },
  { name: 'anthropic-429-enforced-spend-limit (row 4)', input: raw(A, { status: 429, body: anthropicBody('rate_limit_error', 'spend', { error_code: 'enforced_spend_limit_reached' }) }), expect: ['billing', 'credential', false, true] },
  { name: 'anthropic-400-usage-limit-exact (row 5)', input: raw(A, { status: 400, body: anthropicBody('invalid_request_error', EXACT) }), expect: ['billing', 'credential', false, true] },
  { name: 'anthropic-400-usage-limit-exact-with-regain-date (row 5)', input: raw(A, { status: 400, body: anthropicBody('invalid_request_error', `${EXACT} You will regain access on 2026-11-01 at 00:00 UTC.`) }), expect: ['billing', 'credential', false, true] },
  { name: 'anthropic-429-plain (row 7)', input: raw(A, { status: 429, headers: { 'retry-after': '3' }, body: anthropicBody('rate_limit_error', 'Number of requests has exceeded your rate limit') }), expect: ['rate_limited', 'model', true, false] },
  { name: 'anthropic-529-overloaded (row 8)', input: raw(A, { status: 529, body: anthropicBody('overloaded_error', 'Overloaded') }), expect: ['overloaded', 'model', true, false] },
  { name: 'anthropic-401 (row 9)', input: raw(A, { status: 401, body: anthropicBody('authentication_error', 'invalid x-api-key') }), expect: ['auth', 'credential', false, true] },
  { name: 'anthropic-403 (row 11)', input: raw(A, { status: 403, body: anthropicBody('permission_error', 'not allowed') }), expect: ['permission', 'credential', false, true] },
  { name: 'anthropic-refusal-stop (row 10)', input: raw(A, { source: 'stream-event', body: { finish_reason: 'refusal' } }), expect: ['content_policy', 'request', false, false] },
  { name: 'anthropic-504 (row 13)', input: raw(A, { status: 504 }), expect: ['timeout', 'model', true, false] },
  { name: 'anthropic-500 (row 15)', input: raw(A, { status: 500, body: anthropicBody('api_error', 'Internal server error') }), expect: ['unavailable', 'model', true, false] },
  { name: 'anthropic-stream-event overloaded (row 16)', input: raw(A, { source: 'stream-event', body: anthropicBody('overloaded_error', 'Overloaded') }), expect: ['overloaded', 'model', true, false] },
  { name: 'anthropic-stream-event rate_limit_error (row 16)', input: raw(A, { source: 'stream-event', body: anthropicBody('rate_limit_error', 'slow down') }), expect: ['rate_limited', 'model', true, false] },
  { name: 'anthropic-400-invalid-request (row 18)', input: raw(A, { status: 400, body: anthropicBody('invalid_request_error', 'messages: field required') }), expect: ['invalid_request', 'request', false, false] },
  { name: 'anthropic-404 (row 18)', input: raw(A, { status: 404, body: anthropicBody('not_found_error', 'model: nope') }), expect: ['invalid_request', 'request', false, false] },
  { name: 'anthropic-520 (row 19)', input: raw(A, { status: 520 }), expect: ['unavailable', 'model', true, false] },
  // ---- OpenAI ----
  { name: 'openai-429-credit_balance_exhausted (row 6)', input: raw(O, { status: 429, body: openaiBody({ code: 'credit_balance_exhausted', type: 'billing_error' }) }), expect: ['billing', 'credential', false, true] },
  { name: 'openai-429-insufficient_quota (row 6)', input: raw(O, { status: 429, body: openaiBody({ code: 'insufficient_quota', type: 'insufficient_quota' }) }), expect: ['billing', 'credential', false, true] },
  { name: 'openai-429-project_spend_limit_exceeded (row 6)', input: raw(O, { status: 429, body: openaiBody({ code: 'project_spend_limit_exceeded' }) }), expect: ['billing', 'credential', false, true] },
  { name: 'openai-429-plain (row 7)', input: raw(O, { status: 429, headers: { 'retry-after-ms': '250' }, body: openaiBody({ code: 'rate_limit_exceeded', type: 'requests' }) }), expect: ['rate_limited', 'model', true, false] },
  { name: 'openai-503-server_is_overloaded (row 8)', input: raw(O, { status: 503, body: openaiBody({ code: 'server_is_overloaded' }) }), expect: ['overloaded', 'model', true, false] },
  { name: 'openai-401 (row 9)', input: raw(O, { status: 401, body: openaiBody({ code: 'invalid_api_key' }) }), expect: ['auth', 'credential', false, true] },
  { name: 'openai-403 (row 11)', input: raw(O, { status: 403 }), expect: ['permission', 'credential', false, true] },
  { name: 'openai-400-content_policy_violation (row 10)', input: raw(O, { status: 400, body: openaiBody({ code: 'content_policy_violation' }) }), expect: ['content_policy', 'request', false, false] },
  { name: 'openai-400-context_length_exceeded (row 12)', input: raw(O, { status: 400, body: openaiBody({ code: 'context_length_exceeded' }) }), expect: ['context_length', 'request', false, false] },
  { name: 'openai-APIConnectionTimeoutError (row 13)', input: raw(O, { errorName: 'APIConnectionTimeoutError', source: 'transport' }), expect: ['timeout', 'model', true, false] },
  { name: 'openai-ETIMEDOUT (row 13)', input: raw(O, { errorCode: 'ETIMEDOUT', source: 'transport' }), expect: ['timeout', 'model', true, false] },
  { name: 'openai-409 (row 14)', input: raw(O, { status: 409 }), expect: ['unavailable', 'model', true, false] },
  { name: 'openai-502 (row 15)', input: raw(O, { status: 502 }), expect: ['unavailable', 'model', true, false] },
  { name: 'openai-ECONNRESET (row 15)', input: raw(O, { errorCode: 'ECONNRESET', source: 'transport' }), expect: ['unavailable', 'model', true, false] },
  { name: 'openai-422 (row 18)', input: raw(O, { status: 422, body: openaiBody({ code: 'bad_param' }) }), expect: ['invalid_request', 'request', false, false] },
  // ---- OpenRouter (host openrouter.ai) ----
  { name: 'openrouter-402-credits (row 2)', input: raw(O, { ...OR, status: 402, body: { error: { code: 402, message: 'Insufficient credits', metadata: { limit_source: 'openrouter_credits' } } } }), expect: ['billing', 'credential', false, true] },
  { name: 'openrouter-402-key_limit (row 2)', input: raw(O, { ...OR, status: 402, body: { error: { code: 402, message: 'key limit', metadata: { limit_source: 'openrouter_key_limit' } } } }), expect: ['billing', 'credential', false, true] },
  { name: 'openrouter-402-in_flight_budget (row 2)', input: raw(O, { ...OR, status: 402, headers: { 'retry-after': '2' }, body: { error: { code: 402, message: 'budget', metadata: { limit_source: 'openrouter_in_flight_budget' } } } }), expect: ['rate_limited', 'model', true, false] },
  { name: 'openrouter-429 (row 7)', input: raw(O, { ...OR, status: 429, body: { error: { code: 429, message: 'rate limited' } } }), expect: ['rate_limited', 'model', true, false] },
  { name: 'openrouter-503-provider_overloaded (row 8)', input: raw(O, { ...OR, status: 503, body: { error: { code: 503, message: 'x', metadata: { error_type: 'provider_overloaded' } } } }), expect: ['overloaded', 'model', true, false] },
  { name: 'openrouter-503-not-overloaded (row 15 note)', input: raw(O, { ...OR, status: 503, body: { error: { code: 503, message: 'No endpoints found' } } }), expect: ['invalid_request', 'request', false, false] },
  { name: 'openrouter-context_length_exceeded (row 12)', input: raw(O, { ...OR, status: 400, body: { error: { code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } } } }), expect: ['context_length', 'request', false, false] },
  { name: 'openrouter-403-moderation (row 10)', input: raw(O, { ...OR, status: 403, body: { error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'], flagged_input: 'x' } } } }), expect: ['content_policy', 'request', false, false] },
];

const rowsCovered = () =>
  new Set(FIXTURES.flatMap((f) => [...f.name.matchAll(/row (\d+)/g)].map((m) => Number(m[1]))));

describe('5e72d493 AC1 - every SPEC 1.1 row is a fixture', () => {
  it.each(FIXTURES)('$name', ({ input, expect: e }) => {
    const f = classifyProviderError(input);
    expect([f.class, f.scope, f.retryable, f.resumable]).toEqual(e);
    expect(f.confidence).toBe('certain');
    expect(f.v).toBe(1);
    expect(f.attempts).toEqual([]);
    expect(f.hops).toEqual([]);
    expect(f.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(f.evidence).toBeUndefined();
    expect(f.suspectedClass).toBeUndefined();
  });

  it('has >=3 fixtures per provider family including OpenRouter, and covers rows 1-16 and 18-19', () => {
    const count = (p: (f: Fx) => boolean) => FIXTURES.filter(p).length;
    expect(count((f) => f.name.startsWith('anthropic'))).toBeGreaterThanOrEqual(3);
    expect(count((f) => f.name.startsWith('openai'))).toBeGreaterThanOrEqual(3);
    expect(count((f) => f.name.startsWith('openrouter'))).toBeGreaterThanOrEqual(3);
    for (const r of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19]) expect(rowsCovered().has(r), `row ${r}`).toBe(true);
  });

  it('every rule row in the table is exercised by a fixture row', () => {
    for (const rule of FAILURE_RULES) expect(rowsCovered().has(rule.row), `${rule.id} row ${rule.row}`).toBe(true);
  });

  it('carries identity, status, providerErrorType, requestId and truncates message to 500', () => {
    const f = classifyProviderError(
      raw(A, { status: 429, requestId: 'req_1', body: anthropicBody('rate_limit_error', 'x'.repeat(900)) })
    );
    expect(f.modelRef).toBe('anthropic/model');
    expect(f.wireModel).toBe('wire-model');
    expect(f.credentialScope).toBe('ck_abc');
    expect(f.status).toBe(429);
    expect(f.providerErrorType).toBe('rate_limit_error');
    expect(f.requestId).toBe('req_1');
    expect(f.message).toHaveLength(500);
  });

  it('claudecli cli-text routes through heuristics (row 17 gap: no captured patterns yet)', () => {
    const f = classifyProviderError(
      raw('claudecli', { source: 'cli-text', message: 'PROVIDER_ERROR: claude CLI exited 1: Claude AI usage limit reached' })
    );
    expect(f.class).toBe('unknown');
    expect(f.suspectedClass).toBe('billing');
    expect(f.confidence).toBe('medium');
    const g = classifyProviderError(raw('claudecli', { source: 'cli-text', message: 'segfault', toolUseEmitted: true }));
    expect(g.class).toBe('unknown');
    expect(g.toolUseEmitted).toBe(true);
    expect(classifyProviderError(raw('claudecli', { source: 'cli-text', message: 'overloaded_error' })).suspectedClass).toBe('overloaded');
  });

  it('x-should-retry:false turns a retryable verdict non-retryable and keeps retryAfterMs raw', () => {
    const f = classifyProviderError(raw(A, { status: 529, headers: { 'x-should-retry': 'false', 'retry-after': '120' }, body: anthropicBody('overloaded_error', 'o') }));
    expect(f.class).toBe('overloaded');
    expect(f.retryable).toBe(false);
    expect(f.retryAfterMs).toBe(120_000);
  });

  it('is total: seeded fuzz over hostile inputs never throws and always returns a valid value', () => {
    let seed = 1234;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const cyclic: Record<string, unknown> = { error: { type: 'x' } };
    cyclic.self = cyclic;
    const throwing = Object.defineProperty({}, 'error', { get() { throw new Error('boom'); } });
    const bodies: unknown[] = [undefined, null, 0, 42, '', ['plain text', ['sk', 'ant', 'SECRET1234'].join('-')].join(' '), [], [1, 2], {}, { error: 'str' }, { error: null }, { error: { type: 7, code: {}, message: [] } }, cyclic, throwing, { error: { metadata: 'x', details: 5 } }];
    const classes = new Set(['rate_limited', 'overloaded', 'unavailable', 'timeout', 'billing', 'auth', 'permission', 'invalid_request', 'context_length', 'content_policy', 'cancelled', 'unknown']);
    for (let i = 0; i < 500; i++) {
      const input = raw(pick(['anthropic', 'openai', 'claudecli'] as const), {
        source: pick(['http', 'stream-event', 'cli-text', 'transport', 'trip'] as const),
        status: pick([undefined, NaN, -1, 0, 200, 400, 402, 429, 503, 529, 99999]),
        body: pick(bodies),
        headers: pick([undefined, {}, { 'retry-after': 'garbage' }, { 'retry-after': ['1', '2'] }, { 'x-should-retry': 'FALSE' }, { 'retry-after-ms': '-5' }] as never[]),
        errorName: pick([undefined, 'AbortError', 'X']),
        errorCode: pick([undefined, 'ECONNRESET', 'weird']),
        message: pick([undefined, '', 'rate limit', 'x'.repeat(5000)]),
        host: pick([undefined, 'openrouter.ai', 'api.openai.com']),
        aborted: pick([undefined, false, true]),
      });
      const f = classifyProviderError(input);
      expect(f.v).toBe(1);
      expect(classes.has(f.class)).toBe(true);
      expect(f.message.length).toBeLessThanOrEqual(500);
    }
  });

  it('is total even for a null-ish raw input', () => {
    expect(() => classifyProviderError(undefined as never)).not.toThrow();
    expect(classifyProviderError(undefined as never).class).toBe('unknown');
  });
});

type R = ReturnType<typeof raw>;

/** Deliberately-wrong classifier (negative control): status only. */
function statusOnly(r: R): ProviderFailureClass {
  if (r.status === 429) return 'rate_limited';
  return r.status === 402 ? 'billing' : 'unknown';
}

describe('5e72d493 AC2 - billing 429 vs plain 429 (with negative control)', () => {
  const cases = {
    openaiBilling: raw(O, { status: 429, body: openaiBody({ code: 'credit_balance_exhausted' }) }),
    openaiPlain: raw(O, { status: 429, body: openaiBody({ code: 'rate_limit_exceeded' }) }),
    anthropicBilling: raw(A, { status: 429, body: anthropicBody('rate_limit_error', 's', { error_code: 'enforced_spend_limit_reached' }) }),
    anthropicPlain: raw(A, { status: 429, headers: { 'retry-after': '5' }, body: anthropicBody('rate_limit_error', 'r') }),
  };
  const assertAC2 = (classify: (r: R) => ProviderFailureClass) => {
    expect(classify(cases.openaiBilling)).toBe('billing');
    expect(classify(cases.openaiPlain)).toBe('rate_limited');
    expect(classify(cases.anthropicBilling)).toBe('billing');
    expect(classify(cases.anthropicPlain)).toBe('rate_limited');
  };
  it('real classifier separates billing from rate_limited on identical status', () => {
    assertAC2((r) => classifyProviderError(r).class);
  });
  it('NC: classify-by-status-only goes RED on the same assertions', () => {
    expect(() => assertAC2(statusOnly)).toThrow();
  });
});

describe('5e72d493 AC5 - row 5 is exact-only (precedence guard S1, with negative control)', () => {
  const prompt = raw(A, { status: 400, body: anthropicBody('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum') });
  const exact = raw(A, { status: 400, body: anthropicBody('invalid_request_error', EXACT) });
  const reworded = raw(A, { status: 400, body: anthropicBody('invalid_request_error', 'You have reached your specified API usage limits. Contact your workspace admin to raise the cap.') });

  it('anthropic-400-prompt-too-long is not swallowed by row 5: unknown, suspected context_length', () => {
    const f = classifyProviderError(prompt);
    expect(f.class).toBe('unknown');
    expect(f.suspectedClass).toBe('context_length');
    expect(f.evidence?.matchedTokens).toContain('prompt is too long');
  });
  it('anthropic-400-usage-limit-exact => billing (row 5)', () => {
    const f = classifyProviderError(exact);
    expect([f.class, f.scope, f.retryable, f.resumable, f.confidence]).toEqual(['billing', 'credential', false, true, 'certain']);
  });
  it('anthropic-400-usage-limit-reworded fails safe: unknown, suspected billing, medium, evidence attached', () => {
    const f = classifyProviderError(reworded);
    expect(f.class).toBe('unknown');
    expect(f.suspectedClass).toBe('billing');
    expect(f.confidence).toBe('medium');
    expect(f.evidence?.matchedTokens.length).toBeGreaterThan(0);
    expect(f.evidence?.status).toBe(400);
    expect(f.evidence?.bodySnippet).toContain('usage limits');
  });
  it('the row is the single pinned message rule', () => {
    expect(FAILURE_RULES.filter((r) => r.id === PINNED_MESSAGE_RULE)).toHaveLength(1);
    expect(FAILURE_RULES.find((r) => r.id === PINNED_MESSAGE_RULE)?.row).toBe(5);
  });
  it('NC: a substring row 5 flips the reworded fixture to billing and the exact-only assertion goes RED', () => {
    const substringRow5 = (r: R): ProviderFailureClass => {
      const msg = (r.body as { error: { message: string } }).error.message;
      return msg.includes('specified API usage limits') ? 'billing' : classifyProviderError(r).class;
    };
    const exactOnly = (c: (r: R) => ProviderFailureClass) => {
      expect(c(exact)).toBe('billing');
      expect(c(reworded)).toBe('unknown');
    };
    exactOnly((r) => classifyProviderError(r).class);
    expect(() => exactOnly(substringRow5)).toThrow();
  });
});

describe('5e72d493 AC6 - heuristics never promote; evidence is scrubbed', () => {
  // Assembled at runtime so no literal credential-shaped string lives in the repo.
  const SECRET = ['sk', 'ant', 'api03', 'SUPERSECRETKEYVALUE1234567890'].join('-');
  const unknowns = [
    raw(A, { status: 400, body: anthropicBody('invalid_request_error', `You have reached your specified API usage limits, key ${SECRET}`) }),
    raw(O, { status: 418, body: { detail: `teapot overloaded Authorization: Bearer ${SECRET}` } }),
    raw(O, { status: 402, message: `payment required api_key=${SECRET}` }),
    raw(A, { status: 400, body: anthropicBody('invalid_request_error', `prompt is too long ${SECRET}`) }),
    raw('claudecli', { source: 'cli-text', message: `rate limit hit with ${SECRET}` }),
    raw(O, { status: 0, body: `weird ${SECRET}` }),
    raw(O, { source: 'transport', message: `socket hang up ${SECRET}` }),
  ];
  it.each(unknowns.map((u, i) => [i, u] as const))('fixture %i stays class unknown and leaks no secret', (_i, input) => {
    const f = classifyProviderError(input);
    expect(f.class).toBe('unknown');
    expect(f.scope).toBe('request');
    expect([f.retryable, f.resumable]).toEqual([false, false]);
    expect(['high', 'medium', 'low']).toContain(f.confidence);
    expect(f.evidence).toBeDefined();
    expect(f.evidence?.bodySnippet?.length ?? 0).toBeLessThanOrEqual(300);
    expect(JSON.stringify(f)).not.toContain('SUPERSECRET');
  });
  it('a secret in a rule-matched failure message is scrubbed too', () => {
    const f = classifyProviderError(raw(A, { status: 401, body: anthropicBody('authentication_error', `bad key ${SECRET}`) }));
    expect(f.class).toBe('auth');
    expect(JSON.stringify(f)).not.toContain('SUPERSECRET');
    expect(f.message).toContain('[REDACTED]');
  });
  it('confidence is high with >=2 independent signals (status + token), medium with one token, low otherwise', () => {
    expect(classifyProviderError(raw(O, { status: 402, message: 'insufficient credit' })).confidence).toBe('high');
    expect(classifyProviderError(raw(O, { status: 418, message: 'insufficient credit' })).confidence).toBe('medium');
    const low = classifyProviderError(raw(O, { status: 402, message: 'no' }));
    expect([low.class, low.suspectedClass, low.confidence]).toEqual(['unknown', 'billing', 'low']);
    const none = classifyProviderError(raw(O, { status: 418, message: 'teapot' }));
    expect([none.class, none.suspectedClass, none.confidence]).toEqual(['unknown', undefined, 'low']);
  });
  it('truncates the evidence snippet to 300', () => {
    const f = classifyProviderError(raw(O, { status: 418, body: { detail: 'y'.repeat(2000) } }));
    expect(f.evidence?.bodySnippet).toHaveLength(300);
  });
});

describe('5e72d493 AC4 - classifier loads with only @adhd/agent-base-types resolvable', () => {
  it('classifies without any provider SDK present (lint dependency-checks + nx graph enforce the edge set)', () => {
    expect(classifyProviderError(raw(A, { status: 429 })).class).toBe('rate_limited');
  });
});
