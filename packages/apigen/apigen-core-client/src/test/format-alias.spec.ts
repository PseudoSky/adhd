// format-alias.spec.ts — DEBT-APIGEN-007 unit tests for
// `detectFormatAnnotatedAlias`.
//
// Exercises the function directly against small in-memory ts-morph
// `Project`/`createSourceFile` fixtures (no file-system fixture files needed
// — every case here is a couple of lines of source text). The end-to-end
// `extract()` proof (both input AND output format preserved through the real
// extractor) lives in `extract.spec.ts`'s
// `DEBT-APIGEN-007: user type-alias with @format JSDoc preserves format
// annotation` describe block.

import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { FunctionDeclaration, TypeNode } from 'ts-morph';
import { detectFormatAnnotatedAlias } from '../lib/format-alias';

/**
 * Builds a throwaway in-memory source file containing:
 *   <preamble>
 *   function f(value: <paramTypeText>): void {}
 * and returns the `TypeNode` for `value`'s param type — the same shape
 * `paramDecl?.getTypeNode()` produces at the real extract.ts call sites.
 */
function paramTypeNodeFor(
  preamble: string,
  paramTypeText: string
): TypeNode | undefined {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(
    `__fixture-${Math.random().toString(36).slice(2)}.ts`,
    `${preamble}\nfunction f(value: ${paramTypeText}): void {}\n`,
    { overwrite: true }
  );
  const fnDecl = sf.getFunctions().find((f) => f.getName() === 'f') as
    | FunctionDeclaration
    | undefined;
  const paramDecl = fnDecl?.getParameters()[0];
  return paramDecl?.getTypeNode();
}

describe('DEBT-APIGEN-007: detectFormatAnnotatedAlias', () => {
  it('[format-alias.1] plain `type X = string` with no JSDoc -> undefined', () => {
    const typeNode = paramTypeNodeFor('type X = string;', 'X');
    expect(detectFormatAnnotatedAlias(typeNode)).toBeUndefined();
  });

  it('[format-alias.2] `/** @format decimal */ type X = string` -> "decimal"', () => {
    const typeNode = paramTypeNodeFor(
      '/** @format decimal */\ntype X = string;',
      'X'
    );
    expect(detectFormatAnnotatedAlias(typeNode)).toBe('decimal');
  });

  it('[format-alias.3] a generic reference `Array<X>` -> undefined (generics out of scope)', () => {
    const typeNode = paramTypeNodeFor(
      '/** @format decimal */\ntype X = string;',
      'Array<X>'
    );
    expect(detectFormatAnnotatedAlias(typeNode)).toBeUndefined();
  });

  it('[format-alias.4] a qualified name (`NS.X`) -> undefined (qualified names out of scope)', () => {
    const typeNode = paramTypeNodeFor(
      'namespace NS {\n  /** @format decimal */\n  export type X = string;\n}',
      'NS.X'
    );
    expect(detectFormatAnnotatedAlias(typeNode)).toBeUndefined();
  });

  it('[format-alias.5] a type alias to an object type with @format -> undefined (scalar guard)', () => {
    const typeNode = paramTypeNodeFor(
      '/** @format decimal */\ntype X = { amount: string };',
      'X'
    );
    expect(detectFormatAnnotatedAlias(typeNode)).toBeUndefined();
  });

  it('[format-alias.6] plain keyword type `string` (not a TypeReference at all) -> undefined', () => {
    const typeNode = paramTypeNodeFor('', 'string');
    expect(detectFormatAnnotatedAlias(typeNode)).toBeUndefined();
  });

  it('[format-alias.7] undefined typeNode input -> undefined', () => {
    expect(detectFormatAnnotatedAlias(undefined)).toBeUndefined();
  });

  it('[format-alias.NEGATIVE] a different tag name (@example) is not mistaken for @format', () => {
    const typeNode = paramTypeNodeFor(
      '/** @example "3.14" */\ntype X = string;',
      'X'
    );
    expect(detectFormatAnnotatedAlias(typeNode)).toBeUndefined();
  });
});
