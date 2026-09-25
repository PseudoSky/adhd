/**
 * query-output-codec.spec.ts — regression guard for
 * BUG-APIGEN-RUNMODE-IMPLICIT-DISCRIMINATOR-ADMISSIBILITY-001, as it manifests
 * on `@adhd/backlog`'s `query` verb.
 *
 * `query` returns `IOutcomeEnvelope<IIssueQueryResult>`: a `oneOf` union whose
 * success arm carries `data: IIssueQueryResult`, itself a `oneOf` over every
 * `view` member. `composeSchemas()` publishes that output schema unchanged
 * (only the INPUT is `data`-wrapped), so the run-mode transcoder must select
 * the correct union member for every result shape — and the MCP host then
 * re-validates the transcoded value against the SAME schema.
 *
 * This test drives the REAL production composition path
 * (`buildBacklogApigenPackage`, the function `startBacklogServer` mounts),
 * encodes real envelopes through the REAL run-mode transcoder, and validates
 * the result against the REAL MCP `outputSchema` under the exact ajv config
 * `@modelcontextprotocol/sdk`'s client uses (`strict:false`, `allErrors:true`).
 * It is deliberately NOT a mock: the bug it guards shipped precisely because
 * unit tests called the functions directly and never crossed the mount.
 *
 * The markdown case is the load-bearing one: `IIssueMarkdownResult` is the one
 * `IIssueQueryResult` member whose `view` is a MULTI-valued enum, so the
 * implicit-discriminator scan used to resolve a markdown value's `view:'list'`
 * to the FIRST single-literal `view:'list'` branch and prune `format`/`markdown`
 * — producing `{"view":"list"}`, which satisfies none of the `data` oneOf
 * members and fails MCP structuredContent validation with `-32602`.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  buildTranscoder,
  createRegistry,
  registerWellKnown,
} from '@adhd/apigen-base-logical';
import {
  buildMcpOutputSchema,
  wrapMcpStructuredContent,
} from '@adhd/apigen-engine-runtime';
import { buildBacklogApigenPackage } from './server.js';

/** Mirrors `@modelcontextprotocol/sdk`'s `AjvJsonSchemaValidator` default config. */
function sdkAjv(): Ajv {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(ajv);
  return ajv;
}

describe('BUG-APIGEN-RUNMODE-IMPLICIT-DISCRIMINATOR-ADMISSIBILITY-001 — backlog query output codec', () => {
  it('every real query envelope survives the run-mode codec and validates against the real MCP outputSchema', async () => {
    // The real composed schema — the exact object `startBacklogServer` hands
    // the MCP transport. The thunk is never called: schema derivation only
    // reads the built `dist/api.d.ts`, never opens the store.
    const { pkg } = await buildBacklogApigenPackage(() => {
      throw new Error('ctx must not be opened for schema derivation');
    });
    const queryOutput = pkg.schemas['query']?.output as Record<string, unknown>;
    expect(queryOutput, 'backlog/query output schema must be present').toBeTruthy();

    const registry = createRegistry();
    registerWellKnown(registry);
    const transcoder = buildTranscoder(registry.freeze());

    const { outputSchema, wrapped } = buildMcpOutputSchema(queryOutput);
    // The union root is not `type:'object'`, so the MCP adapter wraps it under
    // `result` on BOTH the declared schema and the emitted structuredContent.
    expect(wrapped).toBe(true);
    const ajv = sdkAjv();
    const validate = ajv.compile(outputSchema);

    const envelopes: Record<string, unknown>[] = [
      // The bug: markdown member — `view` is a multi-valued enum here, and it
      // is the ONLY member whose data carries `format`/`markdown`.
      {
        ok: true,
        data: { view: 'list', format: 'markdown', markdown: '# hello\n' },
        meta: { total: 1, returned: 1, limit: 50 },
      },
      // A plain list member (regression guard for the fix's own boundary).
      {
        ok: true,
        data: {
          view: 'list',
          items: [
            { uid: 'i1', title: 't', kind: 'issue', status: 'open' },
          ],
          hasMore: false,
        },
        meta: { total: 1, returned: 1, limit: 50 },
      },
      // A registry view (the sibling fix BUG-BACKLOG-QUERY-REGISTRY-VIEW-STRIPPED-001).
      {
        ok: true,
        data: {
          view: 'projects',
          items: [{ uid: 'p1', name: 'demo', path: '/tmp/demo' }],
        },
      },
      // The failure arm — must remain selectable.
      {
        ok: false,
        error: { code: 'validation', message: 'bad', details: { retryable: false } },
      },
    ];

    for (const env of envelopes) {
      const encoded = transcoder.encode(env, queryOutput);
      // No field pruning: the value the function returned is what goes on the wire.
      expect(encoded, `encoded envelope drifted: ${JSON.stringify(encoded)}`).toEqual(env);

      const structuredContent = wrapMcpStructuredContent(wrapped, encoded);
      expect(structuredContent).toBeTruthy();
      const valid = validate(structuredContent);
      expect(
        valid,
        `structuredContent must match the real MCP outputSchema; ajv: ${ajv.errorsText(
          validate.errors ?? []
        )}`
      ).toBe(true);
    }
  }, 120_000);
});
