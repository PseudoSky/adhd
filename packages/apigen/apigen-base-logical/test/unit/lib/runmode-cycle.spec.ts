/**
 * guards: a same-value $ref/oneOf cycle in the run-mode transcoder recurses to an unnamed RangeError instead of E_RUNMODE_CYCLE, or value-shrinking recursion is blocked
 * tier: S
 * cites: apigen-runmode-oneof-ref-cycle CYC-1, CYC-2, CYC-3 (no backlog uid recorded)
 */
import { describe, expect, it } from 'vitest';
import { buildTranscoder } from '../../../src/lib/runmode';
import { createRegistry } from '../../../src/lib/registry';
import type { LogicalTypeCodec, SchemaNode } from '../../../src/lib/contracts';

/*
 * regression:apigen-runmode-oneof-ref-cycle — same-value `$ref`/`oneOf` cycles in
 * the run-mode transcoder (follow-up to 1368b124, which guarded bare `$ref`
 * alias chains only; no backlog uid is recorded in that commit message).
 *
 * Failure mode: `A = { oneOf: [{ $ref: '#/definitions/A' }] }` never consumes
 * the value, so encodeNode / scoreUnionBranch recursed until the engine threw an
 * unnamed `RangeError: Maximum call stack size exceeded`. A cycle must instead
 * throw a NAMED error (E_RUNMODE_CYCLE) that locates the ref, while recursive
 * schemas whose value shrinks on every step (trees) must keep working.
 *
 * Tier: S (pure in-process transcoder, real registry, real codec; nothing mocked).
 * Item: apigen-base-logical run-mode cycle guard. Criteria cited per test:
 *   CYC-1 named error through encodeNode, CYC-2 named error through the union
 *   scorer, CYC-3 value-driven recursion is not blocked.
 *
 * red: pending (user hold) — expected to fail at 1368b124 (the commit before the
 * cycle guard) because CYC-1 and CYC-2 reject with a RangeError, so the
 * "not a RangeError" and E_RUNMODE_CYCLE assertions fail. CYC-3 passes on both
 * sides by design: it is the over-blocking guard for the fix.
 */

const MARKED_FORMAT = 'x-test-marked';
const markedCodec: LogicalTypeCodec = {
  id: MARKED_FORMAT,
  kind: 'scalar',
  schema: { type: 'string', format: MARKED_FORMAT },
  matches: (node: SchemaNode) => node['format'] === MARKED_FORMAT,
  encode: (v) => `encoded(${String(v)})`,
  decode: (w) => `decoded(${String(w)})`,
};

function transcoder() {
  const registry = createRegistry();
  registry.register(markedCodec);
  return buildTranscoder(registry.freeze());
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectNamedCycleError(err: unknown, ref: string): void {
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(RangeError);
  const message = (err as Error).message;
  expect(message).toMatch(/E_RUNMODE_CYCLE/);
  expect(message).toContain(ref);
}

describe('regression:apigen-runmode-oneof-ref-cycle — same-value $ref/oneOf cycle', () => {
  const defs: Record<string, SchemaNode> = {
    '#/definitions/A': { oneOf: [{ $ref: '#/definitions/A' }] },
  };
  const resolve = (ref: string): SchemaNode => defs[ref] ?? {};

  it('CYC-1: a self-referential oneOf alias throws a named cycle error through encodeNode, not a RangeError', () => {
    const err = capture(() =>
      transcoder().encode({ x: 1 }, { $ref: '#/definitions/A' }, { resolve })
    );
    expectNamedCycleError(err, '#/definitions/A');
  });

  it('CYC-2: the same cycle reached through the union scorer (nested oneOf under a oneOf) throws the named error, not a RangeError', () => {
    // The root oneOf scores branch `{ $ref: A }`; A is itself a oneOf whose only
    // member is `{ $ref: A }`, so scoreUnionBranch recurses on the same value.
    const schema: SchemaNode = { oneOf: [{ $ref: '#/definitions/A' }] };
    const err = capture(() =>
      transcoder().encode({ x: 1 }, schema, { resolve })
    );
    expectNamedCycleError(err, '#/definitions/A');
  });

  it('CYC-2: the union scorer treats a cyclic branch as ineligible and picks the valid sibling without throwing', () => {
    const schema: SchemaNode = {
      oneOf: [
        { $ref: '#/definitions/A' },
        {
          type: 'object',
          required: ['x'],
          properties: { x: { type: 'number' } },
        },
      ],
    };
    const wire = transcoder().encode({ x: 1 }, schema, { resolve });
    expect(wire).toEqual({ x: 1 });
  });

  it('CYC-2: a mutual two-ref oneOf cycle names the cycle and does not overflow the stack', () => {
    const mutual: Record<string, SchemaNode> = {
      '#/definitions/P': { oneOf: [{ $ref: '#/definitions/Q' }] },
      '#/definitions/Q': { oneOf: [{ $ref: '#/definitions/P' }] },
    };
    const err = capture(() =>
      transcoder().encode(
        { x: 1 },
        { $ref: '#/definitions/P' },
        { resolve: (ref) => mutual[ref] ?? {} }
      )
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/E_RUNMODE_CYCLE/);
  });
});

describe('regression:apigen-runmode-oneof-ref-cycle — recursion that consumes the value still works', () => {
  it('CYC-3: a recursive tree (children items $ref the same node) encodes every level', () => {
    const defs: Record<string, SchemaNode> = {
      '#/definitions/Tree': {
        type: 'object',
        required: ['label', 'children'],
        properties: {
          label: { type: 'string', format: MARKED_FORMAT },
          children: { type: 'array', items: { $ref: '#/definitions/Tree' } },
        },
      },
    };
    const value = {
      label: 'root',
      children: [
        { label: 'a', children: [] },
        { label: 'b', children: [{ label: 'c', children: [] }] },
      ],
    };
    const wire = transcoder().encode(
      value,
      { $ref: '#/definitions/Tree' },
      { resolve: (ref) => defs[ref] ?? {} }
    );
    expect(wire).toEqual({
      label: 'encoded(root)',
      children: [
        { label: 'encoded(a)', children: [] },
        {
          label: 'encoded(b)',
          children: [{ label: 'encoded(c)', children: [] }],
        },
      ],
    });
  });

  it('CYC-3: a recursive union (Node = Leaf | Branch, Branch.children items $ref Node) encodes through the oneOf at every depth', () => {
    const defs: Record<string, SchemaNode> = {
      '#/definitions/Node': {
        oneOf: [{ $ref: '#/definitions/Leaf' }, { $ref: '#/definitions/Branch' }],
      },
      '#/definitions/Leaf': {
        type: 'object',
        required: ['leaf'],
        properties: { leaf: { type: 'string', format: MARKED_FORMAT } },
      },
      '#/definitions/Branch': {
        type: 'object',
        required: ['children'],
        properties: {
          children: { type: 'array', items: { $ref: '#/definitions/Node' } },
        },
      },
    };
    const value = {
      children: [{ leaf: 'a' }, { children: [{ leaf: 'b' }] }],
    };
    const wire = transcoder().encode(
      value,
      { $ref: '#/definitions/Node' },
      { resolve: (ref) => defs[ref] ?? {} }
    );
    expect(wire).toEqual({
      children: [
        { leaf: 'encoded(a)' },
        { children: [{ leaf: 'encoded(b)' }] },
      ],
    });
  });
});
