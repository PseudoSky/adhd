// BUG-APIGEN-MCP-DISCOVERABILITY-001 — proves the schema-driven worked-example
// synthesis (`@adhd/apigen-base-logical`'s `synthesizeExample`) against REAL
// operation schemas from a real, already-built package in this repo
// (`entrypoint/backlog`'s `dist/client.d.ts`), not synthetic test-only
// fixtures — for both calling conventions apigen produces:
//   - a normal extracted operation, composed through `composeSchemas`, which
//     wraps domain params in the `{data:{...}}` envelope (BUG-APIGEN-020), and
//   - a mount-derived operation (`apigen-plugin-batch`'s `_batch/<kind>`
//     synthetic op, built by `buildBatchKindSchema` — see
//     `apigen-core-client/src/lib/batch.ts`), which has NO envelope by design.
//
// For each, the synthesized example is run through the SAME AJV
// configuration `apigen-engine-runtime`'s `validate-layer.ts` uses (allErrors,
// ajv-formats, the `decimal` custom format) and asserted to actually PASS —
// proving the example a caller would see in a tool description or a
// validation-failure message is one that genuinely validates, not just one
// that "looks right".
//
// `entrypoint/backlog` is read-only here (never modified) — its already-built
// `dist/client.d.ts` is the input to `extract()`, exactly mirroring
// `entrypoint/backlog/src/server.ts`'s own `extractClientOperations()`.
//
// DELIBERATE DESIGN CHOICE — real package over a pinned fixture: this suite
// used to hardcode three v1 verb names (`create-item`, `resolve-item`,
// `get-item`). backlog's INTERFACE_v2 consolidation collapsed its whole
// mounted surface to six verbs (`get`, `query`, `create`, `update`, `relate`,
// `admin` — see `entrypoint/backlog/src/client.ts`), `resolve-item` has no v2
// successor verb at all (resolution is now a mode of `update`), and the
// hardcoded names broke. The fragile part was never "this test reads a real
// package" — it was "this test hardcodes verb names owned by a package it
// doesn't control." Pinning to a synthetic fixture instead would fix that
// symptom by discarding the whole point of the file (see the header above):
// it was driving REAL schemas from a REAL already-built package that found a
// genuine cross-package bug (BUG-APIGEN-BATCH-DANGLING-REF-001, below) that a
// hand-written fixture would never have exercised. So this suite now
// iterates over WHATEVER `client.ts` currently exports — selected by
// property (`operations.map(o => o.id)`), never by name — so a future
// backlog verb rename/add/remove changes nothing here.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { synthesizeExample } from '@adhd/apigen-base-logical';
import { extract } from '../lib/extract';
import { composeSchemas } from '../lib/compose-schemas';
import { buildBatchKindSchema, deriveBatchOperationBranch } from '../lib/batch';
import type { GeneratedSchemas } from '../lib/types';
import type { Operation } from '../lib/descriptor';

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  // Mirrors apigen-engine-runtime/src/lib/validate-layer.ts's Ajv setup for
  // apigen's own logical-type formats not shipped by ajv-formats.
  ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);
  // Mirrors validate-layer.ts's advisory-keyword registration — apigen's
  // schema builders tag same-document union branches with an OpenAPI-style
  // `discriminator` object (morph-walk.ts's InlineDiscriminator, used by
  // e.g. buildBatchKindSchema); Ajv 8's strict mode otherwise rejects it as
  // an unknown keyword at compile time.
  ajv.addKeyword({ keyword: 'discriminator', valid: true });
  return ajv;
}

const BACKLOG_CLIENT_DTS = path.join(
  __dirname,
  '../../../../../entrypoint/backlog/dist/client.d.ts'
);

if (!fs.existsSync(BACKLOG_CLIENT_DTS)) {
  throw new Error(
    `[mcp-discoverability.real-ops] ${BACKLOG_CLIENT_DTS} does not exist — ` +
      `run "nx build backlog" first (this test extracts real schemas from the built .d.ts, ` +
      `exactly like entrypoint/backlog/src/server.ts's extractClientOperations()).`
  );
}

// Module-scope, not beforeAll: `it.each` needs the real op ids at TEST
// COLLECTION time (vitest collects `it.each` cases before any `beforeAll`
// runs), and selecting by property instead of hardcoded name is the whole
// point of this rewrite (see header comment).
const operations: Operation[] = await extract({
  sourceFile: BACKLOG_CLIENT_DTS,
  namespace: 'backlog',
  dropFileSegment: true,
});

if (operations.length === 0) {
  throw new Error(
    '[mcp-discoverability.real-ops] extracted zero operations from the real backlog ' +
      'dist/client.d.ts — nothing for this suite to validate against.'
  );
}

describe('[mcp-discoverability.real-ops] synthesized examples validate against REAL repo schemas', () => {
  it('extracted at least the v2 backlog surface (sanity floor, not a name list)', () => {
    // INTERFACE_v2 collapsed backlog to six mounted verbs; this is a floor,
    // not an exact-count pin, so a future seventh verb doesn't break it.
    expect(operations.length).toBeGreaterThanOrEqual(6);
  });

  // ---------------------------------------------------------------------
  // Real extracted operations, composed through composeSchemas — the
  // `{data:{...}}`-enveloped convention. Runs for EVERY real operation
  // backlog's client.ts currently exports, selected by id, never hardcoded.
  // ---------------------------------------------------------------------

  it.each(operations.map((o) => o.id))(
    '[mcp-discoverability.real-ops.1] %s: synthesized example passes real AJV validation',
    (opId) => {
      const op = operations.find((o) => o.id === opId);
      if (!op) {
        throw new Error(`operation "${opId}" must exist in the real extracted set`);
      }
      // composeSchemas keys its map by bare function name, not the
      // namespaced op id (e.g. "backlog/create" -> "create").
      const opName = opId.split('/').pop() as string;

      const generated: GeneratedSchemas = {
        metadata: { namespace: 'backlog', phase: '' },
        schemas: {
          [opName]: {
            input: op.input as Record<string, unknown>,
            output: op.output as Record<string, unknown>,
          },
        },
      };
      const composed = composeSchemas(generated, []);
      const inputSchema = composed[opName].input;

      const example = synthesizeExample(inputSchema);
      const ajv = makeAjv();
      const validate = ajv.compile(inputSchema);
      const valid = validate(example);

      expect(
        valid,
        `synthesized example ${JSON.stringify(example)} must validate against the real ` +
          `${opId} composed schema; ajv errors: ${JSON.stringify(validate.errors)}`
      ).toBe(true);

      // BUG-APIGEN-020: domain params land under "data" — but composeSchemas
      // only lists "data" in the outer `required` array when the function
      // actually has >=1 required domain param (FEAT-APIGEN-023). A
      // zero-required-domain-param op's synthesized example can legitimately
      // omit the optional "data" wrapper, so the assertion tracks the
      // schema's own required-ness rather than blanket-asserting the field.
      const outerRequired = (inputSchema as { required?: string[] }).required ?? [];
      if (outerRequired.includes('data')) {
        expect(
          example,
          `${opId}'s composed schema requires "data" but the synthesized example omitted it: ` +
            JSON.stringify(example)
        ).toHaveProperty('data');
      }
    }
  );

  // ---------------------------------------------------------------------
  // A real mount-derived operation set (batch's per-kind synthetic mount) —
  // the flat, non-enveloped convention (see batch.ts's branchInputSchema).
  // Built from the REAL backlog 'action'-kind operations, not a fixture.
  // ---------------------------------------------------------------------

  it('[mcp-discoverability.real-ops.2] batch _batch/action mount (real backlog ops): synthesized example passes real AJV validation', () => {
    const actionOps = operations.filter((o) => o.kind === 'action');
    expect(actionOps.length).toBeGreaterThan(1);

    const { input: batchInputSchema } = buildBatchKindSchema(actionOps);
    const example = synthesizeExample(batchInputSchema);
    const ajv = makeAjv();
    const validate = ajv.compile(batchInputSchema);
    const valid = validate(example);

    expect(
      valid,
      `synthesized batch example ${JSON.stringify(example)} must validate against the real ` +
        `_batch/action schema (derived from ${actionOps.length} real backlog operations); ` +
        `ajv errors: ${JSON.stringify(validate.errors)}`
    ).toBe(true);

    // The genuinely different, non-enveloped convention (§4 of the task):
    // no "data" wrapper — a flat {operation, items} shape instead.
    expect(example).not.toHaveProperty('data');
    expect(example).toHaveProperty('operation');
    expect(example).toHaveProperty('items');
  });

  // ---------------------------------------------------------------------
  // BUG-APIGEN-BATCH-DANGLING-REF-001 (found BY this suite, driving real
  // backlog schemas): `backlog/query`'s real input schema carries its own
  // top-level `definitions` (IStatusSelector, Priority, ...) with bare
  // `#/definitions/<Name>` $refs, hoisted there by extract.ts's
  // `hoistNestedDefs`. Before batch.ts's `buildBatchKindSchema` hoisted
  // every batched op's own `definitions`/`$defs` up to the shared
  // `_batch/<kind>` document root, embedding that operation's schema several
  // levels deep inside a `oneOf` branch left its `$ref`s dangling — AJV
  // resolves a bare `#/definitions/...` ref against the document root it was
  // actually asked to compile, never the nearest ancestor object that
  // happens to carry a `definitions` key. This negative control reproduces
  // the pre-fix construction directly (rather than reverting product code)
  // to prove real-ops.2 above actually has teeth: it fails the same way the
  // unfixed code did, and the real, fixed `buildBatchKindSchema` output does
  // not.
  // ---------------------------------------------------------------------

  it('[mcp-discoverability.real-ops.3] batch mount definitions-hoisting: negative control proves real-ops.2 has teeth', () => {
    const actionOps = operations.filter((o) => o.kind === 'action');
    const queryOp = actionOps.find((o) => o.id === 'backlog/query');
    if (!queryOp) {
      throw new Error('operation "backlog/query" must exist in the real extracted set');
    }
    expect(
      Object.keys((queryOp.input as { definitions?: Record<string, unknown> }).definitions ?? {})
        .length
    ).toBeGreaterThan(0);

    const branches = actionOps.map(deriveBatchOperationBranch);
    // Exactly the pre-fix shape: each branch's raw `itemsSchema` (== op.input,
    // definitions and all) embedded several levels deep, with NOTHING hoisted
    // to the document root.
    const brokenSchema = {
      oneOf: actionOps.map((op, i) => ({
        type: 'object',
        required: ['operation', 'items'],
        properties: {
          operation: { type: 'string', enum: [op.id] },
          items: { type: 'array', items: branches[i].itemsSchema },
        },
      })),
    };
    const ajv1 = makeAjv();
    expect(
      () => ajv1.compile(brokenSchema),
      'the un-hoisted construction was expected to reproduce the dangling-$ref compile failure ' +
        '(if this no longer throws, the underlying bug class this test guards may have changed shape)'
    ).toThrow(/can't resolve reference/);

    // The real, fixed mount schema compiles cleanly.
    const { input: fixedSchema } = buildBatchKindSchema(actionOps);
    const ajv2 = makeAjv();
    expect(() => ajv2.compile(fixedSchema)).not.toThrow();
  });
});
