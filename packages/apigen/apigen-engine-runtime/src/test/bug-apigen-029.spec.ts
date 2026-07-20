/**
 * Regression test for BUG-APIGEN-029 — real extract → compose → AJV-compile
 * pipeline, not hand-built schema fixtures (same rationale as
 * `named-type-param.spec.ts`/BUG-APIGEN-026 and `bug-apigen-030.spec.ts`).
 *
 * BUG-APIGEN-026 fixed the common case (a named type used as a top-level
 * param, e.g. `type Choice = 'a'|'b'|'c'`) by passing `topRef: false` to
 * `ts-json-schema-generator`, which inlines the ENTRY type instead of
 * `$ref`-wrapping it. But `topRef` only controls the ENTRY type — a type it
 * recursively/self-referentially contains still MUST be represented as an
 * internal `$ref` + `definitions` entry (there is no other way to express a
 * cycle in JSON Schema), and BUG-APIGEN-026's own doc comment flagged this as
 * an unresolved follow-up.
 *
 * Traced empirically (not just by reading the generator's source — see
 * `extract.ts`'s `hoistNestedDefs` doc comment for the full mechanism):
 * `buildSchema()`'s ancestors/deadlock guard (BUG-APIGEN-CORE-003) keys on
 * the literal type-text STRING, but the same TS type is frequently reported
 * by ts-morph as a DIFFERENT string depending on calling context (a
 * fully-qualified `import("path").Foo` for the top-level param vs. bare `Foo`
 * for the same type reached again via one of its own properties). That
 * mismatch defeats the deadlock guard, lets `ts-json-schema-generator`
 * resolve the SAME type a second time independently at the nested property
 * position, and produces a self-contained `$ref` + `definitions` pair
 * several levels deep inside the outer param fragment — confirmed directly:
 * for `interface SelfRefParams { key: string; override?: SelfRefParams }`,
 * `definitions` landed at `<paramFragment>.properties.override.definitions`,
 * not at the fragment's own top level.
 *
 * `extract.ts`'s `buildActionOpAtPath` spliced each per-param `buildSchema()`
 * fragment straight into `properties[p.name]`, at whatever depth its
 * `definitions` actually landed. JSON-Schema `$ref` resolution is always
 * root-relative to the document Ajv compiles (`#/definitions/X` resolves
 * against the document's OWN top level), so once `composeSchemas()`
 * assembled the final `input` document (which never carried that nested
 * `definitions` forward either), the `$ref` permanently dangled:
 * `ajv.compile(schema.input)` threw `"can't resolve reference #/definitions/X
 * from id #"` — a real production repro, verbatim, against
 * `~/dev/ai/sox-ecosystem/libs/memory-core`'s `WriteParams` and
 * `db: BetterSqlite3.Database` parameters.
 *
 * The fix: `extract.ts`'s `hoistNestedDefs` walks the ENTIRE per-param
 * fragment tree (not just its own top level) and hoists every
 * `definitions`/`$defs` dict found at ANY depth up to the function-level
 * `input` schema's own root; `compose-schemas.ts` carries that root-level
 * `definitions`/`$defs` forward onto the final composed `input` document —
 * so `$ref`s resolve no matter how deep the originating param sits.
 *
 * `writeWithSelfRef`/`SelfRefParams` below deterministically reproduces the
 * nested-nesting mechanism (proven above). `queryDatabase`/
 * `BetterSqlite3.Database` reproduces the OTHER real symptom from the
 * BACKLOG (a complex external-type param) — in THIS no-tsconfig test
 * environment `Database` happens to resolve to a small flat schema with no
 * internal `$ref` at all (`ts-json-schema-generator`'s `functions:"comment"`
 * default strips every one of `Database`'s chainable methods, so no cycle
 * ever manifests here), so [apigen-029.4]/[apigen-029.5] assert the REAL
 * reported symptom directly — the route dispatches successfully end-to-end —
 * without asserting a specific internal `definitions`-nesting mechanism that
 * this particular fixture doesn't happen to trigger.
 */
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import type { Operation, GeneratedSchemas } from '@adhd/apigen-core-client';
import { createInvoker, LayerContext } from '../lib/invoke';
import { makeValidateLayer } from '../lib/validate-layer';
import type { Call } from '../lib/invoke';

const fixture = path.resolve(__dirname, 'fixtures', 'bug-apigen-029.ts');

function makeCall(operationId: string, domainArgs: Record<string, unknown>): Call {
  return {
    operation: { id: operationId },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs,
  };
}

// Mirrors buildDescriptor's Step 5 adapter (orchestrator.ts) — same helper as
// named-type-param.spec.ts / bug-apigen-030.spec.ts, reproduced here since
// it isn't exported as a standalone helper.
function toGeneratedSchemas(operations: readonly Operation[]): GeneratedSchemas {
  const generated: GeneratedSchemas = {
    metadata: { namespace: '', phase: '' },
    schemas: {},
  };
  for (const op of operations) {
    if (op.kind !== 'action') continue;
    const fnName = op.path[op.path.length - 1].raw;
    generated.schemas[fnName] = {
      input: op.input,
      output: op.output,
      ...(op.hasCtx ? { hasCtx: true } : {}),
    };
  }
  return generated;
}

describe('BUG-APIGEN-029: $ref/definitions dispatch-time dangling on complex/self-referential types — real pipeline', () => {
  it('[apigen-029.1] a self-referential local interface param hoists its definitions to the schema root (no nested definitions left behind)', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = toGeneratedSchemas(operations);
    const input = schemas.schemas['writeWithSelfRef'].input as Record<
      string,
      unknown
    >;
    const props = input['properties'] as Record<string, unknown>;
    const paramFragment = props['params'] as Record<string, unknown>;

    // The per-param fragment must no longer carry its own nested definitions
    // sibling — hoistNestedDefs strips it after merging upward.
    expect(paramFragment).not.toHaveProperty('definitions');
    expect(paramFragment).not.toHaveProperty('$defs');

    // The function-level input schema must carry it at its own root instead.
    const hasDefinitions =
      'definitions' in input &&
      Object.keys(input['definitions'] as Record<string, unknown>).length > 0;
    const hasDollarDefs =
      '$defs' in input &&
      Object.keys(input['$defs'] as Record<string, unknown>).length > 0;
    expect(hasDefinitions || hasDollarDefs).toBe(true);
  });

  it('[apigen-029.2] the composed schema for the self-referential param compiles in AJV without a dangling $ref (pre-fix: "can\'t resolve reference #/definitions/SelfRefParams from id #")', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);

    expect(() => makeValidateLayer(schemas)).not.toThrow();
  });

  it('[apigen-029.3] a real call carrying the self-referential param reaches dispatch instead of crashing at ajv.compile() time', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);
    const dispatchSpy = vi.fn().mockResolvedValue('k1');

    const invoke = createInvoker([makeValidateLayer(schemas)]);
    const result = await invoke(
      'writeWithSelfRef',
      makeCall('writeWithSelfRef', { params: { key: 'k1' } }),
      { fns: { writeWithSelfRef: dispatchSpy }, schemas }
    );

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(result).toBe('k1');
  });

  it('[apigen-029.4] the composed schema for a complex external-type param (better-sqlite3 Database) compiles in AJV (real BACKLOG symptom: this route 500\'d with "can\'t resolve reference #/definitions/BetterSqlite3.Database from id #")', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);

    expect(() => makeValidateLayer(schemas)).not.toThrow();
  });

  it('[apigen-029.5] a real call carrying a complex external-type param (Database) reaches dispatch instead of crashing at ajv.compile() time', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);
    const dispatchSpy = vi.fn().mockResolvedValue([{ id: 1 }]);
    // Shape matches the generated schema's required own-enumerable properties
    // for `BetterSqlite3.Database` in this environment (methods like
    // `prepare`/`exec` are excluded from the schema entirely — see the file
    // doc comment — so they're intentionally absent here too, matching
    // `additionalProperties: false`).
    const fakeDb = {
      memory: false,
      readonly: false,
      name: 'test.db',
      open: true,
      inTransaction: false,
    };

    const invoke = createInvoker([makeValidateLayer(schemas)]);
    const result = await invoke(
      'queryDatabase',
      makeCall('queryDatabase', { db: fakeDb, sql: 'select 1' }),
      { fns: { queryDatabase: dispatchSpy }, schemas }
    );

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(result).toEqual([{ id: 1 }]);
  });

  it('[apigen-029.NEGATIVE] validateComposedRefs (compose-schemas.ts) actually catches a genuinely dangling $ref instead of silently no-op-ing (the pre-fix key-format bug: $defs-only collection + bare-name lookup)', async () => {
    // A hand-built GeneratedSchemas with a dangling $ref and NO matching
    // definitions anywhere — this must throw at composeSchemas() time, not
    // slip through to a live ajv.compile() crash.
    const broken: GeneratedSchemas = {
      metadata: { namespace: '', phase: '' },
      schemas: {
        broken: {
          input: {
            type: 'object',
            properties: { x: { $ref: '#/definitions/Missing' } },
            required: ['x'],
            definitions: { SomethingElse: { type: 'string' } },
          },
          output: {},
        },
      },
    };

    expect(() => composeSchemas(broken, [])).toThrow(/Missing|resolve/i);
  });
});
