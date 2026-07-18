// extract.spec.ts — v2 symbol-based extractor tests (SPEC §3, §4, §5).
//
// Covers all six shapes in the export-shape matrix:
//   1. Named function export        `export function foo`
//   2. Named arrow/const export     `export const foo = ...`
//   3. Named-object export          `export const api = { foo, bar }`
//   4. Default-export named fn      `export default function foo`
//   5. Anonymous default export     `export default () => ...`
//   6. CJS source                   `module.exports = { foo, bar }`
//
// Teeth: each test includes a negative-control assertion — a wrong symbol name
// produces no matching operation (verifying id/symbol correctness).

import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { extract } from '../lib/extract';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);

// ---------------------------------------------------------------------------
// Shape 1: Named function export
// ---------------------------------------------------------------------------

describe('extract — Shape 1: named function export', () => {
  it('[extract.1.1] emits an operation named by the exported symbol (getUser)', async () => {
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('getUser');
  });

  it('[extract.1.2] emits an operation for listItems', async () => {
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('listItems');
  });

  it('[extract.1.3] kind is action; safe defaults to false', async () => {
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'getUser');
    expect(op?.kind).toBe('action');
    expect(op?.safe).toBe(false);
  });

  it('[extract.1.4] async flag is true for async function', async () => {
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'getUser');
    expect(op?.async).toBe(true);
  });

  it('[extract.1.5] ctx param is excluded from input schema [inv:ctx-name-only]', async () => {
    const ops = await extract({ sourceFile: fixture('ctx-param.ts') });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'getUser');
    expect(op).toBeDefined();
    const props =
      (op?.input as { properties?: Record<string, unknown> })?.properties ?? {};
    expect(props).not.toHaveProperty('ctx');
    expect(props).toHaveProperty('userId');
  });

  it('[extract.1.NEGATIVE] a wrong symbol name produces no matching operation', async () => {
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const wrong = ops.find((o) => o.path.at(-1)?.raw === 'fetchUser'); // wrong name
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shape 2: Named arrow/const export
// ---------------------------------------------------------------------------

describe('extract — Shape 2: named arrow/const export', () => {
  it('[extract.2.1] emits sendEmail named by exported symbol', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-const.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('sendEmail');
  });

  it('[extract.2.2] emits computeScore', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-const.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('computeScore');
  });

  it('[extract.2.3] optional params are not in required array', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-const.ts'),
    });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'sendEmail');
    const input = op?.input as { required?: string[] };
    expect(input?.required).toContain('to');
    expect(input?.required).toContain('subject');
    expect(input?.required).not.toContain('body');
  });

  it('[extract.2.NEGATIVE] a misspelled symbol name produces no match', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-const.ts'),
    });
    const wrong = ops.find((o) => o.path.at(-1)?.raw === 'send_email');
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shape 3: Named-object export
// ---------------------------------------------------------------------------

describe('extract — Shape 3: named-object export', () => {
  it('[extract.3.1] emits getUser from userApi object', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-object.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('getUser');
  });

  it('[extract.3.2] emits deleteUser from userApi object', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-object.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('deleteUser');
  });

  it('[extract.3.3] path includes the object name as an intermediate segment', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-object.ts'),
    });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'getUser');
    // path should be [file, userApi, getUser]
    expect(op?.path.length).toBeGreaterThanOrEqual(2);
    const pathRaws = op?.path.map((s) => s.raw) ?? [];
    expect(pathRaws).toContain('userApi');
  });

  it('[extract.3.NEGATIVE] wrong property name produces no match', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-named-object.ts'),
    });
    const wrong = ops.find((o) => o.path.at(-1)?.raw === 'removeUser');
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shape 4: Default-export named function
// ---------------------------------------------------------------------------

describe('extract — Shape 4: default-export named function', () => {
  it('[extract.4.1] emits processOrder named by the function symbol', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-default-named.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('processOrder');
  });

  it('[extract.4.2] kind is action, host is ts', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-default-named.ts'),
    });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'processOrder');
    expect(op?.kind).toBe('action');
    expect(op?.host).toBe('ts');
  });

  it('[extract.4.3] id is deterministic and stable on repeated extraction', async () => {
    const ops1 = await extract({
      sourceFile: fixture('extract-default-named.ts'),
    });
    const ops2 = await extract({
      sourceFile: fixture('extract-default-named.ts'),
    });
    const id1 = ops1.find((o) => o.path.at(-1)?.raw === 'processOrder')?.id;
    const id2 = ops2.find((o) => o.path.at(-1)?.raw === 'processOrder')?.id;
    expect(id1).toBe(id2);
    expect(id1).toBeTruthy();
  });

  it('[extract.4.NEGATIVE] wrong function name produces no match', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-default-named.ts'),
    });
    const wrong = ops.find((o) => o.path.at(-1)?.raw === 'placeOrder');
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shape 5: Anonymous default export
// ---------------------------------------------------------------------------

describe('extract — Shape 5: anonymous default export', () => {
  it('[extract.5.1] synthesises a stable id for anonymous default export', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    expect(ops.length).toBeGreaterThan(0);
    // id must be non-empty and stable
    expect(ops[0].id).toBeTruthy();
  });

  it('[extract.5.2] synthesised id is stable across two extractions (R13)', async () => {
    const ops1 = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    const ops2 = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    expect(ops1[0].id).toBe(ops2[0].id);
  });

  it('[extract.5.3] synthesised id is derived from the filename', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    // id must reference the file name (extract-default-anon) in some form
    expect(ops[0].id).toMatch(/extract|default|anon/);
  });

  it('[extract.5.4] kind is action', async () => {
    const ops = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    expect(ops[0].kind).toBe('action');
  });

  it('[extract.5.NEGATIVE] two anonymous-default extractions produce the same (not different) id', async () => {
    const ops1 = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    const ops2 = await extract({
      sourceFile: fixture('extract-default-anon.ts'),
    });
    // This test would fail if ids were non-deterministic (e.g., random UUID)
    expect(ops1[0].id).toStrictEqual(ops2[0].id);
  });
});

// ---------------------------------------------------------------------------
// Shape 6: CJS source (module.exports = {...})
// ---------------------------------------------------------------------------

describe('extract — Shape 6: CJS source', () => {
  it('[extract.6.1] emits ping named by the CJS symbol', async () => {
    const ops = await extract({ sourceFile: fixture('extract-cjs.ts') });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('ping');
  });

  it('[extract.6.2] emits echo named by the CJS symbol', async () => {
    const ops = await extract({ sourceFile: fixture('extract-cjs.ts') });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('echo');
  });

  it('[extract.6.3] CJS op id is stable across two extractions (R13)', async () => {
    const ops1 = await extract({ sourceFile: fixture('extract-cjs.ts') });
    const ops2 = await extract({ sourceFile: fixture('extract-cjs.ts') });
    const id1 = ops1.find((o) => o.path.at(-1)?.raw === 'ping')?.id;
    const id2 = ops2.find((o) => o.path.at(-1)?.raw === 'ping')?.id;
    expect(id1).toBe(id2);
    expect(id1).toBeTruthy();
  });

  it('[extract.6.NEGATIVE] wrong CJS symbol name produces no match', async () => {
    const ops = await extract({ sourceFile: fixture('extract-cjs.ts') });
    const wrong = ops.find((o) => o.path.at(-1)?.raw === 'pong');
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shape 1b / re-exports: `export { x [as y] } from './module.js'`
// ---------------------------------------------------------------------------
//
// Regression coverage for the re-export-barrel extraction gap: a source file
// that is a pure re-export barrel (e.g. a package's `index.ts`) previously
// extracted almost nothing, because the old walker never followed
// `export { x } from './other.js'` for ANY export-shape kind. Each test below
// compares a re-exported operation against the SAME operation extracted
// directly from the declaring file (reexport-source.ts), asserting identical
// name/kind/safe/shape — everything except `id`/`path[0]`, which correctly
// differ because the operation's file segment is the FILE THAT EXPOSES IT
// (the barrel), not the file that happens to declare it.

describe('extract — Shape 1b: re-exported named function', () => {
  it('[extract.reexport.1.1] a plain re-export (`export { sourceFn } from` ...) is extracted, named by the re-exported symbol', async () => {
    const ops = await extract({ sourceFile: fixture('reexport-barrel.ts') });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'sourceFn');
    expect(op).toBeDefined();
    expect(op?.kind).toBe('action');
  });

  it('[extract.reexport.1.2] re-exported op input schema matches the direct-declaration op', async () => {
    const direct = await extract({ sourceFile: fixture('reexport-source.ts') });
    const reexported = await extract({ sourceFile: fixture('reexport-barrel.ts') });
    const directOp = direct.find((o) => o.path.at(-1)?.raw === 'sourceFn');
    const reexportedOp = reexported.find(
      (o) => o.path.at(-1)?.raw === 'sourceFn'
    );
    expect(reexportedOp?.input).toEqual(directOp?.input);
    expect(reexportedOp?.output).toEqual(directOp?.output);
    expect(reexportedOp?.kind).toBe(directOp?.kind);
    expect(reexportedOp?.safe).toBe(directOp?.safe);
  });

  it('[extract.reexport.1.NEGATIVE] the LOCAL declaration name never leaks through when only re-exported', async () => {
    // reexport-barrel.ts never exports anything under the bare name
    // "sourceFn_local" — this just guards against a future accidental
    // internal-name leak; sourceFn IS the correct exported name here (no
    // rename applied to this particular specifier).
    const ops = await extract({ sourceFile: fixture('reexport-barrel.ts') });
    const bad = ops.find((o) => o.path.at(-1)?.raw === 'sourceFn_local');
    expect(bad).toBeUndefined();
  });
});

describe('extract — Shape 1b: re-exported + renamed arrow/const function', () => {
  it('[extract.reexport.2.1] `export { sourceConst as barrelConst } from` ... is named by the OUTER alias, never the local name', async () => {
    const ops = await extract({ sourceFile: fixture('reexport-barrel.ts') });
    const renamed = ops.find((o) => o.path.at(-1)?.raw === 'barrelConst');
    const local = ops.find((o) => o.path.at(-1)?.raw === 'sourceConst');
    expect(renamed).toBeDefined();
    expect(local).toBeUndefined();
  });

  it('[extract.reexport.2.2] renamed re-export input schema matches the direct-declaration op (by underlying shape)', async () => {
    const direct = await extract({ sourceFile: fixture('reexport-source.ts') });
    const reexported = await extract({ sourceFile: fixture('reexport-barrel.ts') });
    const directOp = direct.find((o) => o.path.at(-1)?.raw === 'sourceConst');
    const renamedOp = reexported.find(
      (o) => o.path.at(-1)?.raw === 'barrelConst'
    );
    expect(renamedOp?.input).toEqual(directOp?.input);
    expect(renamedOp?.output).toEqual(directOp?.output);
  });
});

describe('extract — Shape 1b: re-exported named-object export', () => {
  it('[extract.reexport.3.1] a re-exported named-object export still expands to per-property ops', async () => {
    const ops = await extract({ sourceFile: fixture('reexport-barrel.ts') });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'getThing');
    expect(op).toBeDefined();
    // Path: [file, objectName, propName]
    expect(op?.path[1].raw).toBe('sourceApi');
    expect(op?.path[2].raw).toBe('getThing');
  });
});

describe('extract — Shape 1b: multi-hop re-export chains', () => {
  it('[extract.reexport.4.1] a two-hop chain (outer → mid → source) resolves to the terminal declaration', async () => {
    const ops = await extract({
      sourceFile: fixture('reexport-chain-outer.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('outerFn');
    expect(names).toContain('outerConst');
  });

  it('[extract.reexport.4.2] only the OUTERMOST alias is used — intermediate-hop names never leak', async () => {
    const ops = await extract({
      sourceFile: fixture('reexport-chain-outer.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    // reexport-mid.ts re-exports these under their ORIGINAL (unrenamed)
    // names; only reexport-chain-outer.ts renames them. Neither the
    // mid-hop names nor the innermost declaration names should appear.
    expect(names).not.toContain('sourceFn');
    expect(names).not.toContain('sourceConst');
  });

  it('[extract.reexport.4.3] two-hop chain op shape matches the direct-declaration op', async () => {
    const direct = await extract({ sourceFile: fixture('reexport-source.ts') });
    const chained = await extract({
      sourceFile: fixture('reexport-chain-outer.ts'),
    });
    const directOp = direct.find((o) => o.path.at(-1)?.raw === 'sourceFn');
    const chainedOp = chained.find((o) => o.path.at(-1)?.raw === 'outerFn');
    expect(chainedOp?.input).toEqual(directOp?.input);
    expect(chainedOp?.output).toEqual(directOp?.output);
  });
});

describe('extract — Shape 1b: `export * from` wildcard re-exports', () => {
  it('[extract.reexport.5.1] a wildcard re-export surfaces all of the source module’s exports', async () => {
    const ops = await extract({
      sourceFile: fixture('reexport-wildcard-barrel.ts'),
    });
    const names = ops.map((op) => op.path.at(-1)?.raw);
    expect(names).toContain('sourceFn');
    expect(names).toContain('sourceConst');
    expect(names).toContain('getThing');
  });
});

// ---------------------------------------------------------------------------
// Cross-shape invariants
// ---------------------------------------------------------------------------

describe('extract — cross-shape invariants', () => {
  it('[extract.inv.1] all ops have host="ts"', async () => {
    const fixtures = [
      'extract-named-fn.ts',
      'extract-named-const.ts',
      'extract-named-object.ts',
      'extract-default-named.ts',
      'extract-default-anon.ts',
      'extract-cjs.ts',
      'reexport-source.ts',
      'reexport-barrel.ts',
      'reexport-chain-outer.ts',
      'reexport-wildcard-barrel.ts',
    ];
    for (const f of fixtures) {
      const ops = await extract({ sourceFile: fixture(f) });
      for (const op of ops) {
        expect(op.host).toBe('ts');
      }
    }
  });

  it('[extract.inv.2] query consts have safe=true, action ops have safe=false', async () => {
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    for (const op of ops) {
      if (op.kind === 'action') expect(op.safe).toBe(false);
      if (op.kind === 'query') expect(op.safe).toBe(true);
    }
  });

  it('[extract.inv.3] all ops have non-empty id', async () => {
    const allFixtures = [
      'extract-named-fn.ts',
      'extract-named-const.ts',
      'extract-named-object.ts',
      'extract-default-named.ts',
      'extract-default-anon.ts',
      'extract-cjs.ts',
      'reexport-source.ts',
      'reexport-barrel.ts',
      'reexport-chain-outer.ts',
      'reexport-wildcard-barrel.ts',
    ];
    for (const f of allFixtures) {
      const ops = await extract({ sourceFile: fixture(f) });
      for (const op of ops) {
        expect(op.id).toBeTruthy();
        expect(op.id.length).toBeGreaterThan(0);
      }
    }
  });

  it('[extract.inv.4] __samples__ is never emitted as an operation', async () => {
    // Even if a fixture has __samples__, it must not appear
    const ops = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const samplesOp = ops.find((o) => o.path.at(-1)?.raw === '__samples__');
    expect(samplesOp).toBeUndefined();
  });

  it('[extract.inv.5] id is deterministic — same file always yields same ids', async () => {
    const ops1 = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const ops2 = await extract({ sourceFile: fixture('extract-named-fn.ts') });
    const ids1 = ops1.map((o) => o.id).sort();
    const ids2 = ops2.map((o) => o.id).sort();
    expect(ids1).toEqual(ids2);
  });
});

// ---------------------------------------------------------------------------
// tokenize helper (exported for testability)
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('[tokenize.1] camelCase → words', async () => {
    const { tokenize } = await import('../lib/extract');
    expect(tokenize('humanizeBytes')).toEqual(['humanize', 'bytes']);
  });

  it('[tokenize.2] PascalCase → words', async () => {
    const { tokenize } = await import('../lib/extract');
    expect(tokenize('HumanizeBytes')).toEqual(['humanize', 'bytes']);
  });

  it('[tokenize.3] kebab-case → words', async () => {
    const { tokenize } = await import('../lib/extract');
    expect(tokenize('my-util')).toEqual(['my', 'util']);
  });

  it('[tokenize.4] SCREAMING_SNAKE → words', async () => {
    const { tokenize } = await import('../lib/extract');
    expect(tokenize('SOME_CONST')).toEqual(['some', 'const']);
  });
});
