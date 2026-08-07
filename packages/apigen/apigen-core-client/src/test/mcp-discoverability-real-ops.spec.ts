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

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { synthesizeExample } from '@adhd/apigen-base-logical';
import { extract } from '../lib/extract';
import { composeSchemas } from '../lib/compose-schemas';
import { buildBatchKindSchema } from '../lib/batch';
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

describe('[mcp-discoverability.real-ops] synthesized examples validate against REAL repo schemas', () => {
  let operations: Operation[];

  beforeAll(async () => {
    if (!fs.existsSync(BACKLOG_CLIENT_DTS)) {
      throw new Error(
        `[mcp-discoverability.real-ops] ${BACKLOG_CLIENT_DTS} does not exist — ` +
          `run "nx build backlog" first (this test extracts real schemas from the built .d.ts, ` +
          `exactly like entrypoint/backlog/src/server.ts's extractClientOperations()).`
      );
    }
    operations = await extract({
      sourceFile: BACKLOG_CLIENT_DTS,
      namespace: 'backlog',
      dropFileSegment: true,
    });
    expect(operations.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // Real extracted operations, composed through composeSchemas — the
  // `{data:{...}}`-enveloped convention.
  // ---------------------------------------------------------------------

  it.each(['create-item', 'resolve-item', 'get-item'])(
    '[mcp-discoverability.real-ops.1] backlog/%s: synthesized example passes real AJV validation',
    (opName) => {
      const op = operations.find((o) => o.id === `backlog/${opName}`);
      if (!op) {
        throw new Error(`operation "backlog/${opName}" must exist in the real extracted set`);
      }

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
          `backlog/${opName} composed schema; ajv errors: ${JSON.stringify(validate.errors)}`
      ).toBe(true);

      // The convention actually documented (BUG-APIGEN-020): domain params
      // land under "data".
      expect(example).toHaveProperty('data');
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
});
