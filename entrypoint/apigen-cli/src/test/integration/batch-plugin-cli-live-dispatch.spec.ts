/**
 * Real end-to-end proof for `@adhd/apigen-plugin-batch`'s hostBridge wiring on
 * the CLI-output LIVE dispatch path (`@adhd/apigen-plugin-cli-output`'s
 * exported `run()`, `packages/apigen/apigen-plugin-cli-output/src/lib/run.ts`).
 *
 * Mirrors `batch-plugin-e2e.spec.ts` (the fastify proof) byte-for-byte on the
 * fixture side — same `catalog.getItem` domain package/Operation/schemas, the
 * same REAL `loadUsePlugins(['batch'])` resolution path — but drives the
 * batch mount through `run()`'s REAL CLI argv → `matchCommand` →
 * `parseArgs`/`readCall` → `dispatchForPlan` → `hostBridge` path instead of a
 * live fastify HTTP request. No mocking of `CliTransportAdapter`,
 * `dispatchForPlan`, `createPackageInvoker`, or the hostBridge — this is
 * `run()` exactly as `apigen run --type cli --use batch -- batch action ...`
 * would invoke it.
 *
 * REGISTERED COMMAND: `run()` registers the batch mount at CLI path
 * `batch action` (`_batch/action` → `project()`'s CLI projection: the
 * synthetic namespace `_batch` has its leading underscores stripped to the
 * bare word `batch`, `toKebab` on `['batch','action']` → `['batch',
 * 'action']`), confirmed by reading `apigen-core-client/src/lib/plugin.ts`'s
 * `syntheticOp` + `apigen-engine-naming/src/lib/naming.ts`'s `project()`.
 *
 * BUG-APIGEN-CLI-OUTPUT-001 (FIXED — this spec previously asserted the real
 * broken-state error text and is rewritten here to prove the fix instead,
 * per that item's verification requirement): `run.ts`'s mount-registration
 * loop now projects `MountedOperation.input` into a CLI-flag-compatible
 * schema (`./mount-cli-flags.ts`'s `projectMountInputSchema`) before calling
 * `buildOpPlan`, so `plan.cliFlags` is populated with real
 * `operation`/`items`/`concurrency`/`mode`/`onItemError`/`itemTimeoutMs`
 * flags — the exact set `@adhd/apigen-plugin-batch`'s own handler
 * (`parseBatchRequest`) reads off `call.data`. This spec now proves the
 * REAL, previously-impossible happy path: a real 3-item batch (2
 * fulfilled + 1 rejected) dispatched via real CLI argv, through the real
 * unmocked `CliTransportAdapter`/`dispatchForPlan`/hostBridge, with the same
 * index-ordered, partial-failure (`onItemError: 'continue'`) semantics
 * already proven for fastify/express/mcp.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { run as runCli } from '@adhd/apigen-plugin-cli-output';
import type { Operation, RunInput } from '@adhd/apigen-core-client';
import type { ComposedSchemas } from '@adhd/apigen-engine-runtime';
import { loadUsePlugins } from '../../lib/commands/run';

// ---------------------------------------------------------------------------
// Real domain package: catalog.getItem(id) — same fixture as the fastify e2e
// proof (batch-plugin-e2e.spec.ts), copied verbatim so both specs prove the
// SAME domain shape over different transports.
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  name: string;
}

function getItem(id: string): Item {
  if (id === 'missing') throw new Error(`no such item: ${id}`);
  return { id, name: `Item ${id}` };
}

const getItemOp: Operation = {
  id: 'catalog/getItem',
  host: 'ts',
  namespace: { raw: 'catalog', words: ['catalog'] },
  path: [{ raw: 'getItem', words: ['get', 'item'] }],
  kind: 'action',
  async: false,
  streaming: false,
  safe: false,
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  output: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' } },
    required: ['id', 'name'],
  },
  envelope: {},
  typeText: null,
};

const catalogSchemas: ComposedSchemas = {
  getItem: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: ['data'],
    },
    output: getItemOp.output,
    'x-apigen-safe': false,
  } as unknown as ComposedSchemas[string],
};

function buildRunInput(argv: string[], usePlugins: unknown[]): RunInput {
  return {
    packages: [
      {
        id: 'catalog',
        schemas: catalogSchemas,
        importPath: '',
        fns: { getItem: getItem as (...a: unknown[]) => unknown },
      },
    ],
    operations: [getItemOp],
    outputDir: '',
    options: { argv, usePlugins },
  };
}

let logSpy: ReturnType<typeof vi.spyOn> | undefined;
let errorSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  logSpy?.mockRestore();
  errorSpy?.mockRestore();
  logSpy = undefined;
  errorSpy = undefined;
  process.exitCode = undefined;
});

describe('[BATCH_0.0.1.md §2/§F1] apigen-plugin-batch — real CLI live-dispatch proof (apigen-plugin-cli-output run())', () => {
  it('dispatches a real 3-item batch via real CLI argv and returns real, ordered fulfilled/rejected results (partial-failure honored)', async () => {
    // The REAL `--use batch` resolution path apigen-cli's `run`/`serve`
    // command uses — identical to the fastify proof.
    const usePlugins = await loadUsePlugins(['batch']);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const items = JSON.stringify([{ id: 'a' }, { id: 'missing' }, { id: 'b' }]);
    // The exact intended invocation: `apigen run --type cli --use batch --
    // batch action --operation catalog/getItem --items '[...]' --concurrency 2
    // --on-item-error continue` — i.e. the CLI analogue of the fastify test's
    // `POST /_batch/action` body.
    const argv = [
      'batch',
      'action',
      '--operation',
      'catalog/getItem',
      '--items',
      items,
      '--concurrency',
      '2',
      '--on-item-error',
      'continue',
    ];

    await runCli(buildRunInput(argv, usePlugins));

    // No error was ever reported — the command dispatched cleanly all the
    // way through the batch handler.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [rawResultJson] = (logSpy as NonNullable<typeof logSpy>).mock
      .calls[0] as [string];
    const results = JSON.parse(rawResultJson) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);

    // (1) fulfilled — the REAL getItem(id) really ran through the REAL
    // Layer stack + hostBridge, over the REAL CLI dispatch path.
    expect(results[0]).toMatchObject({
      index: 0,
      status: 'fulfilled',
      value: { id: 'a', name: 'Item a' },
    });
    // (2) rejected — the REAL thrown error surfaced as a per-item rejection,
    // WITHOUT aborting the batch (`--on-item-error continue`), with a real
    // `ApiError` reason shape surviving the round trip (BUG-APIGEN-047
    // parity — see `batch-plugin-e2e.spec.ts`'s identical assertion).
    expect(results[1]).toMatchObject({ index: 1, status: 'rejected' });
    const reason = (results[1] as { reason?: { message?: string; code?: string } })
      .reason;
    expect(reason).toBeDefined();
    expect(reason?.message).toBe('no such item: missing');
    expect(reason?.code).toBe('internal');
    // (3) fulfilled — proves item #2 was NOT skipped after item #1's failure.
    expect(results[2]).toMatchObject({
      index: 2,
      status: 'fulfilled',
      value: { id: 'b', name: 'Item b' },
    });
  });

  it('rejects an "operation" that is not one of this mount\'s real batchable ops (proves the mount is bound to THIS descriptor, not a hardcoded stub) — real CLI flags reach the handler\'s own validation', async () => {
    const usePlugins = await loadUsePlugins(['batch']);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const argv = [
      'batch',
      'action',
      '--operation',
      'not/a-real-op',
      '--items',
      '[]',
    ];

    await runCli(buildRunInput(argv, usePlugins));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [rawErrorJson] = (errorSpy as NonNullable<typeof errorSpy>).mock
      .calls[0] as [string];
    const body = JSON.parse(rawErrorJson) as { code: string; message: string };
    expect(body.code).toBe('invalid_argument');
    expect(body.message).toContain('not/a-real-op');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('[negative control — proves cliFlags are real, not vacuously present] omitting the required "--operation"/"--items" flags reaches the handler\'s own "operation must be a non-empty string" validation, not an "Unknown option" parse failure', async () => {
    const usePlugins = await loadUsePlugins(['batch']);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const argv = ['batch', 'action'];

    await runCli(buildRunInput(argv, usePlugins));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [rawErrorJson] = (errorSpy as NonNullable<typeof errorSpy>).mock
      .calls[0] as [string];
    const body = JSON.parse(rawErrorJson) as { code: string; message: string };

    // Proves the fix reaches the handler at all (not an argv-parse failure) —
    // `@adhd/apigen-plugin-batch`'s own `parseBatchRequest` rejects the
    // missing `operation` field.
    expect(body.code).toBe('invalid_argument');
    expect(body.message).toMatch(/"operation" must be a non-empty string/);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
