import { describe, it, expect } from 'vitest';
import { composeSchemas } from '../lib/compose-schemas';
import type { GeneratedSchemas } from '../lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const domainSchemas: GeneratedSchemas = {
  metadata: { namespace: 'test', phase: '' },
  schemas: {
    getUser: {
      input: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId'],
      },
      output: { type: 'object' },
    },
    sendEmail: {
      input: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' } },
        required: ['to', 'subject'],
      },
      output: { type: 'null' },
    },
    listAll: {
      // zero params (ctx was the only param, filtered by generateSchemas)
      input: { type: 'object', properties: {}, required: [] },
      output: { type: 'array' },
    },
  },
};

const sessionMiddleware = {
  id: 'session',
  envelope: { session: { type: 'string' } },
};
const authMiddleware = { id: 'auth', envelope: { token: { type: 'string' } } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeSchemas', () => {
  it('[schema-composition.1] no middleware — data wrapper property present; no other keys in properties', () => {
    const composed = composeSchemas(domainSchemas, []);

    for (const [fnName, schema] of Object.entries(composed)) {
      const input = schema.input as {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(
        input.properties,
        `${fnName} should only have "data" in properties`
      ).toEqual(expect.objectContaining({ data: expect.any(Object) }));
      expect(Object.keys(input.properties)).toEqual(['data']);
    }

    // FEAT-APIGEN-023: the "data" property is always present, but it is only
    // listed in the outer `required` array for functions that actually have
    // ≥1 required domain param. `listAll` has none, so "data" is optional.
    const getUserInput = composed['getUser'].input as { required: string[] };
    const sendEmailInput = composed['sendEmail'].input as {
      required: string[];
    };
    const listAllInput = composed['listAll'].input as { required: string[] };

    expect(getUserInput.required).toEqual(['data']);
    expect(sendEmailInput.required).toEqual(['data']);
    expect(listAllInput.required).toEqual([]);
  });

  it('[schema-composition.2] session middleware — session and data both in required; domain params inside data', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware]);

    const getUserInput = composed['getUser'].input as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(getUserInput.required).toContain('session');
    expect(getUserInput.required).toContain('data');

    const dataSchema = getUserInput.properties['data'] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(dataSchema.properties['userId']).toBeDefined();
    expect(dataSchema.required).toContain('userId');
  });

  it('[schema-composition.3] override { getUser: { session: false } } — getUser loses session; sendEmail keeps it', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware], {
      getUser: { session: false },
    });

    const getUserInput = composed['getUser'].input as {
      properties: Record<string, unknown>;
    };
    const sendEmailInput = composed['sendEmail'].input as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(getUserInput.properties)).not.toContain('session');
    expect(Object.keys(sendEmailInput.properties)).toContain('session');
  });

  it('[schema-composition.4] zero-param function with session middleware — session required, data NOT required; data.properties is {}', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware]);

    const listAllInput = composed['listAll'].input as {
      properties: Record<string, unknown>;
      required: string[];
    };

    // FEAT-APIGEN-023: a middleware-contributed envelope field (e.g. "session")
    // is still required on its own merits, but it does not drag "data" along
    // with it — "data" is only required when the function itself has ≥1
    // required domain param.
    expect(listAllInput.required).toContain('session');
    expect(listAllInput.required).not.toContain('data');

    const dataSchema = listAllInput.properties['data'] as {
      properties: Record<string, unknown>;
    };
    expect(dataSchema.properties).toEqual({});
  });

  it('[schema-composition.5] multiple middlewares — both envelope fields appear when no overrides', () => {
    const composed = composeSchemas(domainSchemas, [
      sessionMiddleware,
      authMiddleware,
    ]);

    const getUserInput = composed['getUser'].input as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(getUserInput.properties['session']).toBeDefined();
    expect(getUserInput.properties['token']).toBeDefined();
    expect(getUserInput.required).toContain('session');
    expect(getUserInput.required).toContain('token');
    expect(getUserInput.required).toContain('data');
  });

  it('[schema-composition.5] false is the ONLY value that suppresses; null/undefined do not', () => {
    // TypeScript won't allow null/undefined in the typed Record<string, boolean>,
    // but at runtime a caller could pass them — we test the runtime invariant.
    const composed = composeSchemas(
      domainSchemas,
      [sessionMiddleware],
      // cast to bypass strict type to test runtime behaviour
      { getUser: { session: null as unknown as boolean } }
    );

    const getUserInput = composed['getUser'].input as {
      properties: Record<string, unknown>;
    };
    // null should NOT suppress — session must still be present
    expect(Object.keys(getUserInput.properties)).toContain('session');
  });
});

// ---------------------------------------------------------------------------
// BUG-APIGEN-017 — additionalProperties:false (unknown params rejected, not ignored)
// ---------------------------------------------------------------------------

describe('composeSchemas — BUG-APIGEN-017: additionalProperties:false', () => {
  it('top-level (envelope + data) schema rejects unknown properties', () => {
    const composed = composeSchemas(domainSchemas, []);
    const getUserInput = composed['getUser'].input as {
      additionalProperties?: unknown;
    };
    // This is the exact assertion that catches the regression: if a future
    // change drops `additionalProperties: false` from the composed schema,
    // this goes from `false` back to `undefined` and the test fails.
    expect(getUserInput.additionalProperties).toBe(false);
  });

  it('the nested "data" wrapper also rejects unknown properties (zero-arg tools included)', () => {
    const composed = composeSchemas(domainSchemas, []);

    const getUserData = (
      composed['getUser'].input as { properties: Record<string, unknown> }
    ).properties['data'] as { additionalProperties?: unknown };
    expect(getUserData.additionalProperties).toBe(false);

    // BUG-APIGEN-017's reported symptom: a ZERO-ARGUMENT tool (`listAll`)
    // silently accepted a bogus `{ data: { provider: '...' } }` envelope.
    const listAllData = (
      composed['listAll'].input as { properties: Record<string, unknown> }
    ).properties['data'] as { additionalProperties?: unknown };
    expect(listAllData.additionalProperties).toBe(false);
  });

  it('additionalProperties:false holds regardless of middleware envelope fields', () => {
    const composed = composeSchemas(domainSchemas, [
      sessionMiddleware,
      authMiddleware,
    ]);
    const getUserInput = composed['getUser'].input as {
      additionalProperties?: unknown;
    };
    expect(getUserInput.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG-APIGEN-020 — the "data" envelope + naming convention is documented
// ---------------------------------------------------------------------------

describe('composeSchemas — BUG-APIGEN-020: envelope calling-convention documentation', () => {
  it('every composed schema carries a top-level description explaining the "data" envelope', () => {
    const composed = composeSchemas(domainSchemas, []);
    for (const [fnName, schema] of Object.entries(composed)) {
      const input = schema.input as { description?: unknown };
      expect(typeof input.description, `${fnName} missing description`).toBe(
        'string'
      );
      expect(input.description).toMatch(/"data"/);
    }
  });

  it('a zero-parameter tool notes the envelope is an empty object, not that params exist', () => {
    const composed = composeSchemas(domainSchemas, []);
    const listAllInput = composed['listAll'].input as { description: string };
    expect(listAllInput.description).toMatch(/empty object/);
  });

  it('when a middleware contributes an envelope field, the description names it and explains it is NOT part of "data"', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware]);
    const getUserInput = composed['getUser'].input as { description: string };
    expect(getUserInput.description).toMatch(/"session"/);
    expect(getUserInput.description).toMatch(/NOT domain data/);
  });

  it('with no middleware, the description does not mention envelope fields at all', () => {
    const composed = composeSchemas(domainSchemas, []);
    const getUserInput = composed['getUser'].input as { description: string };
    expect(getUserInput.description).not.toMatch(/NOT domain data/);
  });
});

// ---------------------------------------------------------------------------
// BUG-APIGEN-CORE-001 (v1 retirement) — composeSchemas() re-validates $ref
// resolvability at compose/generate time, the same safety net v1's deleted
// generate-schemas.ts had (pooling $defs across every function, throwing a
// clear function-scoped error). This is the exact class of bug BUG-APIGEN-026
// hit at runtime instead — this test proves it is now caught earlier, at
// composeSchemas() time, not just downstream in AJV.
// ---------------------------------------------------------------------------

describe('composeSchemas — BUG-APIGEN-CORE-001: dangling $ref caught at compose time', () => {
  it('throws a function-scoped error when a schema $refs a $def that is never pooled from any function', () => {
    const withDanglingRef: GeneratedSchemas = {
      metadata: { namespace: 'test', phase: '' },
      schemas: {
        // Some $defs pool exists (from another function in the same source
        // file) — but it never defines "Choice", so `pick`'s $ref dangles.
        // (An empty $defs pool is a different, deliberately-unvalidated case
        // — see the "no $defs at all" test below — so this fixture must
        // carry at least one *other* $def to exercise the real dangling path.)
        unrelated: {
          input: { type: 'object', properties: {}, required: [] },
          output: {
            $defs: { '#/$defs/Other': { type: 'number' } },
            type: 'number',
          },
        },
        pick: {
          input: {
            type: 'object',
            properties: {
              choice: { $ref: '#/$defs/Choice' },
            },
            required: ['choice'],
          },
          output: { type: 'string' },
        },
      },
    };

    expect(() => composeSchemas(withDanglingRef, [])).toThrow(
      /Schema validation failed for function "pick"/
    );
  });

  it('a $ref that resolves against the pooled cross-function $defs does not throw', () => {
    const withResolvableRef: GeneratedSchemas = {
      metadata: { namespace: 'test', phase: '' },
      schemas: {
        // $defs is pooled ACROSS functions — declared once here...
        declareChoice: {
          input: { type: 'object', properties: {}, required: [] },
          output: {
            $defs: {
              '#/$defs/Choice': { type: 'string', enum: ['a', 'b', 'c'] },
            },
            type: 'string',
          },
        },
        // ...and resolved here, on a different function's input.
        pick: {
          input: {
            type: 'object',
            properties: { choice: { $ref: '#/$defs/Choice' } },
            required: ['choice'],
          },
          output: { type: 'string' },
        },
      },
    };

    expect(() => composeSchemas(withResolvableRef, [])).not.toThrow();
  });

  it('a schema with no $defs at all is not flagged (structural $ref problems are left to downstream AJV compile)', () => {
    const composed = composeSchemas(domainSchemas, []);
    expect(composed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FEAT-APIGEN-023 — a zero-param, zero-required-envelope operation does not
// force callers to send an empty `data: {}` (or any envelope field) in the
// published schema. Pre-fix, `required: [...envelopeRequired, 'data']` was
// unconditional, so every one of these assertions failed. Post-fix, "data"
// (and any given envelope field) is only required when something actually
// makes it non-optional.
// ---------------------------------------------------------------------------

describe('composeSchemas — FEAT-APIGEN-023: zero-param/zero-envelope schema', () => {
  it('a zero-param function with no middleware has an EMPTY top-level required array', () => {
    const composed = composeSchemas(domainSchemas, []);
    const listAllInput = composed['listAll'].input as { required: string[] };

    expect(listAllInput.required).toEqual([]);
    expect(listAllInput.required).not.toContain('data');
  });

  it('an empty object {} satisfies the top-level required array for a zero-param, zero-middleware function', () => {
    const composed = composeSchemas(domainSchemas, []);
    const listAllInput = composed['listAll'].input as {
      required: string[];
      additionalProperties: boolean;
    };

    // JSON Schema semantics: an empty `required` array means no top-level
    // key is mandatory, so `{}` is a fully valid instance of this schema —
    // "call it with nothing beyond the name" is what FEAT-APIGEN-023 asked for.
    expect(listAllInput.required.every((k) => k in {})).toBe(true);
    expect(listAllInput.required.length).toBe(0);
  });

  it('the "data" PROPERTY is still declared (not removed) for a zero-param function — {"data": {}} remains valid too', () => {
    const composed = composeSchemas(domainSchemas, []);
    const listAllInput = composed['listAll'].input as {
      properties: Record<string, unknown>;
    };

    expect(listAllInput.properties['data']).toBeDefined();
    const dataSchema = listAllInput.properties['data'] as {
      type: string;
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(dataSchema.type).toBe('object');
    expect(dataSchema.properties).toEqual({});
    expect(dataSchema.additionalProperties).toBe(false);
  });

  it('REGRESSION: a parameterized function (≥1 required domain param) still requires "data" — unchanged by this fix', () => {
    const composed = composeSchemas(domainSchemas, []);

    const getUserInput = composed['getUser'].input as { required: string[] };
    const sendEmailInput = composed['sendEmail'].input as {
      required: string[];
    };

    expect(getUserInput.required).toEqual(['data']);
    expect(sendEmailInput.required).toEqual(['data']);
  });

  it('REGRESSION: middleware envelope fields remain required on their own merits, independent of "data"', () => {
    const composed = composeSchemas(domainSchemas, [
      sessionMiddleware,
      authMiddleware,
    ]);

    const getUserInput = composed['getUser'].input as { required: string[] };
    const listAllInput = composed['listAll'].input as { required: string[] };

    // getUser: has a required domain param -> "data" required alongside envelope fields.
    expect(getUserInput.required.sort()).toEqual(['data', 'session', 'token']);
    // listAll: zero domain params -> envelope fields required, "data" is not.
    expect(listAllInput.required.sort()).toEqual(['session', 'token']);
  });

  it('a zero-param function with its only middleware overridden false has a fully empty required array', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware], {
      listAll: { session: false },
    });

    const listAllInput = composed['listAll'].input as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(listAllInput.required).toEqual([]);
    expect(Object.keys(listAllInput.properties)).toEqual(['data']);
  });
});
