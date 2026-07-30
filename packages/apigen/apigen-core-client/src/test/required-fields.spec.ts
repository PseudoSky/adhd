/**
 * Regression tests for BUG-APIGEN-CORE-CLIENT-001.
 *
 * Root cause: a named interface/type-literal used as a function-parameter
 * type resolves, via `p.getTypeAtLocation(sig.getDeclaration()).getText()`
 * (extract.ts's `rawParams`/`rawParamsFromSig`, called with NO enclosing-node
 * context), to a fully-qualified `import("<abs path>").TypeName` expression —
 * not the bare type name. `buildSchema`'s Path 1 (ts-json-schema-generator)
 * cannot resolve that qualified-import string as a type name, throws, and
 * falls through to Path 2 (`morph-walk.ts`'s `walkType`, which resolves the
 * REAL ts-morph `Type` structurally instead of by name). Path 2's object
 * branch built `properties` for every named property but never inspected
 * `Symbol.isOptional()` or emitted a `required` array at all — so ANY object
 * type reaching Path 2 (which is the common case for named parameter types,
 * not an edge case) silently lost required-field enforcement at every
 * apigen-based transport's AJV validate-layer.
 *
 * Confirmed in production: `entrypoint/backlog`'s `CreateItemInput.family`
 * (required, non-optional per model.ts:211) was NOT rejected when omitted —
 * the write proceeded and persisted the literal string "undefined".
 *
 * Fix: packages/apigen/apigen-core-client/src/lib/schema-builders/morph-walk.ts's
 * `walkType` object branch now collects `required` from `sym.isOptional()`
 * (mirroring ts-json-schema-generator's own ObjectTypeFormatter signal) and
 * attaches it to the emitted schema — omitted entirely when empty, matching
 * ts-json-schema-generator's own convention of never emitting `required: []`.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { extract } from '../index';
import type { GeneratedSchemas } from '../lib/types';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);

const _genCache = new Map<string, Promise<GeneratedSchemas>>();
function gen(sourceFile: string): Promise<GeneratedSchemas> {
  let p = _genCache.get(sourceFile);
  if (!p) {
    p = extract({ sourceFile }).then((ops) => {
      const schemas: GeneratedSchemas['schemas'] = {};
      for (const op of ops) {
        if (op.kind !== 'action') continue;
        const name = op.path.at(-1)?.raw;
        if (!name) continue;
        schemas[name] = {
          input: op.input,
          output: op.output,
          ...(op.hasCtx ? { hasCtx: true } : {}),
        };
      }
      return { metadata: { namespace: '', phase: '' }, schemas };
    });
    _genCache.set(sourceFile, p);
  }
  return p;
}

describe('BUG-APIGEN-CORE-CLIENT-001: required TS properties carry into JSON-Schema `required`', () => {
  it('[required.minimal] a named interface param with a mix of required + optional fields produces a `required` array containing exactly the required field names', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createThing']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    expect(nested.required).toEqual(
      expect.arrayContaining(['family', 'title', 'body', 'repo'])
    );
    expect((nested.required as string[]).length).toBe(4);

    // Teeth: optional fields must NOT appear in `required`.
    expect(nested.required).not.toContain('priority');
    expect(nested.required).not.toContain('tags');

    // Every declared property (required and optional alike) must still be
    // present in `properties` — this fix must not drop optional properties,
    // only correctly classify them.
    const props = nested.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      ['body', 'family', 'priority', 'repo', 'tags', 'title'].sort()
    );
  });

  it('[required.all-optional] a type with zero required fields omits `required` entirely (matches ts-json-schema-generator convention of never emitting `required: []`)', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createOptionalThing']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    expect(nested).not.toHaveProperty('required');
    expect(Object.keys(nested.properties as Record<string, unknown>).sort()).toEqual(
      ['count', 'note'].sort()
    );
  });

  it('[required.create-item-input-shaped] a CreateItemInput-shaped real-world type (entrypoint/backlog model.ts) carries all its required string fields into `required` and excludes every optional field', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createItemShaped']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    expect(nested.required).toEqual(
      expect.arrayContaining(['family', 'title', 'body', 'repo'])
    );
    expect((nested.required as string[]).length).toBe(4);

    const optionalFields = [
      'idOverride',
      'projectPath',
      'priority',
      'tags',
      'plan',
      'importedFrom',
      'dedupeScan',
      'force',
    ];
    for (const field of optionalFields) {
      expect(nested.required).not.toContain(field);
    }
  });
});
