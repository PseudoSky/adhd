/**
 * guards: run-mode dispatch does not resolve $ref against the op schema root, or an unresolvable ref does not name the ref and op
 * tier: S
 * cites: 1bb4b5d5 AC1, AC2, AC3
 *
 * regression:1bb4b5d5 — run-mode dispatch resolves `$ref` against the op schema root.
 *
 * Consumer seam: the real `dispatch()` entrypoint (the single canonical path every
 * host uses in run mode). Nothing in the path is mocked; only the operation
 * function is a plain closure.
 *
 * Failure mode: run-mode dispatch bound no schema root, so every `$ref` in a
 * param or result reached the throwing default resolver ("cannot be resolved in
 * run-mode"). A `$ref` with no definition, an alias cycle, or an unsupported ref
 * form must produce an error that names the ref (and, for a missing definition,
 * the op id), never a RangeError and never a silent Object.prototype hit.
 *
 * Tier: S (in-process, default `test` lane, no subprocess, no socket).
 * Fidelity gap: none for S; host wiring is covered by the fastify e2e lane.
 * Items: 1bb4b5d5 AC1 (input + output $ref), AC2 ($defs root, self-referential
 * Node with a Date leaf), AC3 (missing ref names ref AND op id), plus the
 * reviewer-demanded alias-cycle and unsupported-ref-form tests.
 *
 * red: pending (user hold) — expected to fail at 373f1b0f^ (the parent of the
 * run-mode $ref fix 373f1b0f) because every `$ref` test fails with the default
 * resolver's "cannot be resolved in run-mode" error (AC1/AC2 assertions never reach
 * their value check). The unsupported-ref-form assertions are expected to fail at
 * a901ab8b^ (the parent of a901ab8b, which distinguished unsupported $ref forms).
 * The alias-cycle test is expected to fail at 1368b124^ (the parent of the alias
 * cycle guard 1368b124) with an unnamed RangeError.
 */

import { describe, it, expect } from 'vitest';
import { dispatch } from '../../../src/lib/dispatch';
import type { ComposedSchemas } from '../../../src/lib/types';

const ISO = '2024-01-15T12:00:00.000Z';
const ISO_CHILD = '2024-02-20T08:30:00.000Z';

type Schema = ComposedSchemas[string];

/** Run one op through the real dispatch entrypoint in run mode (no session, no ctx). */
function run(
  fns: Record<string, (...args: unknown[]) => unknown>,
  schema: Schema,
  fnName: string,
  domainArgs: Record<string, unknown>
): Promise<unknown> {
  return dispatch(fns, undefined, schema, fnName, {}, domainArgs);
}

/** Capture a rejection's error (undefined when the call resolves). */
async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('regression:1bb4b5d5 — dispatch resolves $ref against the op schema root', () => {
  it('AC1 input: a param $ref to a date-time definition is decoded to a Date (1bb4b5d5 AC1)', async () => {
    const schema: Schema = {
      input: {
        type: 'object',
        definitions: { When: { type: 'string', format: 'date-time' } },
        properties: {
          data: {
            type: 'object',
            properties: { at: { $ref: '#/definitions/When' } },
            required: ['at'],
          },
        },
        required: ['data'],
      },
      output: {},
    };
    let seen: unknown;
    await run({ op: (at: unknown) => (seen = at) }, schema, 'op', { at: ISO });
    expect(seen).toBeInstanceOf(Date);
    expect((seen as Date).toISOString()).toBe(ISO);
  });

  it('AC1 output: a $ref result to a date-time definition encodes to an RFC 3339 string (1bb4b5d5 AC1)', async () => {
    const schema: Schema = {
      input: {
        type: 'object',
        properties: { data: { type: 'object', properties: {}, required: [] } },
        required: ['data'],
      },
      output: {
        $defs: { When: { type: 'string', format: 'date-time' } },
        $ref: '#/$defs/When',
      },
    };
    const result = await run(
      { op: () => new Date(ISO) },
      schema,
      'op',
      {}
    );
    expect(result).toBe(ISO);
  });

  it('AC2: a $defs root with a self-referential Node carrying a Date leaf encodes to the finite wire shape (1bb4b5d5 AC2)', async () => {
    const nodeDefs = {
      Node: {
        type: 'object',
        properties: {
          at: { type: 'string', format: 'date-time' },
          next: { $ref: '#/$defs/Node' },
        },
        required: ['at'],
      },
    };
    const schema: Schema = {
      input: {
        type: 'object',
        properties: { data: { type: 'object', properties: {}, required: [] } },
        required: ['data'],
      },
      output: { $defs: nodeDefs, $ref: '#/$defs/Node' },
    };
    const result = await run(
      {
        op: () => ({
          at: new Date(ISO),
          next: { at: new Date(ISO_CHILD) },
        }),
      },
      schema,
      'op',
      {}
    );
    expect(result).toEqual({ at: ISO, next: { at: ISO_CHILD } });
  });

  it('AC3: a missing $ref names the ref AND the op id, even when a sibling op defines the name (1bb4b5d5 AC3)', async () => {
    // The sibling op defines `Missing`; the op under test has an op-local root
    // that lacks it. Only the per-op root binding can reject this correctly.
    const composed: ComposedSchemas = {
      defines: {
        input: {
          type: 'object',
          definitions: { Missing: { type: 'string', format: 'date-time' } },
          properties: { data: { type: 'object', properties: {}, required: [] } },
          required: ['data'],
        },
        output: {},
      },
      lonely: {
        input: {
          type: 'object',
          definitions: {},
          properties: {
            data: {
              type: 'object',
              properties: { at: { $ref: '#/definitions/Missing' } },
              required: ['at'],
            },
          },
          required: ['data'],
        },
        output: {},
      },
    };
    const err = await errorOf(
      run({ lonely: () => null }, composed['lonely'], 'lonely', { at: ISO })
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('#/definitions/Missing');
    expect(message).toContain('"lonely"');
  });

  it('alias cycle: definitions.Loop = {$ref: Loop} throws an error naming the ref, not a RangeError (1bb4b5d5 guard)', async () => {
    const schema: Schema = {
      input: {
        type: 'object',
        definitions: { Loop: { $ref: '#/definitions/Loop' } },
        properties: {
          data: {
            type: 'object',
            properties: { at: { $ref: '#/definitions/Loop' } },
            required: ['at'],
          },
        },
        required: ['data'],
      },
      output: {},
    };
    const err = await errorOf(
      run({ op: () => null }, schema, 'op', { at: ISO })
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toContain('#/definitions/Loop');
  });

  it.each([
    ['#/properties/x'],
    ['https://example.com/schema.json#/definitions/A'],
    ['#/$defs/A/properties/b'],
  ])(
    'unsupported ref form %s fails naming the ref, not as a missing definition (1bb4b5d5 AC3)',
    async (ref) => {
      const schema: Schema = {
        input: {
          type: 'object',
          definitions: { A: { type: 'string', format: 'date-time' } },
          properties: {
            data: {
              type: 'object',
              properties: { at: { $ref: ref } },
              required: ['at'],
            },
          },
          required: ['data'],
        },
        output: {},
      };
      const err = await errorOf(
        run({ op: () => null }, schema, 'op', { at: ISO })
      );
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(ref);
      expect(message).not.toMatch(/no matching definition/);
    }
  );
});

// plan discovery-sweep-1014 blind-review C AC2
//   Failure mode: dispatch.ts kept its own copy of the resolvable-$ref regex and a
//     blanket `catch {}` that replaced the resolver's error, so the E_EMIT
//     diagnosis from rootRefResolver (apigen-base-logical) never reached a
//     run-mode caller and the cause was dropped.
//   Tier: S (real dispatch() in process, no mocks, no I/O).
//   Gap statement: none; dispatch() is the consumer seam.
//   Item/criterion: plan discovery-sweep-1014 blind-review C AC2.
//   Risk map (Light): the op id must still be present (pre-existing assertions
//     above); the cause must be the original EmitError, not a stringified copy.
//   Red run: against the unfixed dispatch.ts the E_EMIT-message and cause
//     assertions fail (message lacks "E_EMIT", err.cause is undefined).
describe('plan discovery-sweep-1014 blind-review C AC2 — run-mode $ref errors keep the E_EMIT diagnosis and cause', () => {
  const schemaWithRef = (ref: string): Schema => ({
    input: {
      type: 'object',
      definitions: { A: { type: 'string', format: 'date-time' } },
      properties: {
        data: {
          type: 'object',
          properties: { at: { $ref: ref } },
          required: ['at'],
        },
      },
      required: ['data'],
    },
    output: {},
  });

  it('AC2: an unsupported $ref form surfaces the E_EMIT message with the op id and the EmitError as cause', async () => {
    const err = (await errorOf(
      run({ op: () => null }, schemaWithRef('#/$defs/A/properties/b'), 'op', {
        at: ISO,
      })
    )) as Error & { cause?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('"op"');
    expect(err.message).toContain('E_EMIT: unsupported $ref form');
    expect(err.message).toContain('#/$defs/A/properties/b');
    const cause = err.cause as { code?: string; name?: string } | undefined;
    expect(cause).toBeInstanceOf(Error);
    expect(cause?.code).toBe('E_EMIT');
    expect(cause?.name).toBe('EmitError');
  });

  it('AC2: a missing definition names the op id and ref, and keeps the EmitError as cause', async () => {
    const err = (await errorOf(
      run({ op: () => null }, schemaWithRef('#/definitions/Nope'), 'op', {
        at: ISO,
      })
    )) as Error & { cause?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('"op"');
    expect(err.message).toContain('#/definitions/Nope');
    expect((err.cause as { code?: string } | undefined)?.code).toBe('E_EMIT');
  });
});
