/**
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
 * Red expectation: on the pre-fix commit c882f1e1^ every `$ref` test fails with the
 * default resolver's "cannot be resolved in run-mode" error (AC1/AC2 assertions
 * never reach their value check). The alias-cycle test is a guard for the cycle
 * guard added alongside the fix and is not a pre-fix red on its own.
 */

import { describe, it, expect } from 'vitest';
import { dispatch } from './dispatch';
import type { ComposedSchemas } from './types';

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
      run({ lonely: () => null }, composed.lonely, 'lonely', { at: ISO })
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
