/**
 * guards: a service whose input references a named definition fails at call time with the run-mode "cannot be resolved" stub error, or buildApigenPackage lets a startup defect (shadowed name, missing function, dangling $ref) through to serving
 * tier: S
 * cites: REMEDIATION-PLAN T-R3 (scenario "a $ref schema dispatches without the run-mode stub error"; buildApigenPackage hard failures); ADR-0019
 * tags: contract
 * teeth: red: make transcodeCtxFor in dispatch.ts return undefined (guarded temporary edit, restored) and run `npx vitest run src/test/build-apigen-package.spec.ts` in packages/apigen/apigen-engine-runtime -> exit 1; the $ref cases fail with "cannot be resolved in run-mode"
 *
 * Not covered here (lives with entrypoint/policy): the policy service IR dispatching `check`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { buildApigenPackage } from '../lib/build-apigen-package';
import { createPackageInvoker } from '../lib/package-invoker';
import { LayerContext, type Call } from '../lib/invoke';
import { dispatch } from '../lib/dispatch';

const seg = (raw: string): Segment => ({ raw, words: [raw] });

function action(name: string, input: Record<string, unknown>, output: Record<string, unknown> = {}, extra: Partial<Operation> = {}): Operation {
  return {
    id: `svc/${name}`,
    host: 'ts',
    namespace: seg('svc'),
    path: [seg(name)],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input,
    output,
    envelope: {},
    typeText: null,
    ...extra,
  } as Operation;
}

const STAMP = {
  type: 'object',
  properties: { at: { type: 'string', format: 'date-time' }, label: { type: 'string' } },
  required: ['at'],
  additionalProperties: false,
};

const stampInput = {
  type: 'object',
  properties: { stamp: { $ref: '#/definitions/Stamp' } },
  required: ['stamp'],
  definitions: { Stamp: STAMP },
};

const call = (name: string, domainArgs: Record<string, unknown>): Call => ({
  operation: { id: name },
  ctx: new LayerContext(),
  envelope: {},
  domainArgs,
  transport: 'cli',
});

describe('buildApigenPackage (T-R3)', () => {
  it('dispatches an operation whose input is a $ref to a named definition, decoding through it', async () => {
    const seen: unknown[] = [];
    const { pkg } = buildApigenPackage({
      id: 'svc',
      version: '1.2.3',
      importPath: './svc',
      operations: [action('record', stampInput, { type: 'string' })],
      fns: {
        record: (stamp: unknown) => {
          seen.push(stamp);
          return 'recorded';
        },
      },
    });
    const invoke = createPackageInvoker(pkg.schemas, []);
    const result = await invoke('record', call('record', { stamp: { at: '2026-01-02T03:04:05.000Z', label: 'x' } }), {
      fns: pkg.fns,
      schemas: pkg.schemas,
    });
    expect(result).toBe('recorded');
    const [stamp] = seen as Array<{ at: unknown; label: string }>;
    expect(stamp.at).toBeInstanceOf(Date); // proves the $ref was resolved and decoded, not passed through
    expect((stamp.at as Date).toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(stamp.label).toBe('x');
  });

  it('encodes a result through a $ref output definition', async () => {
    const output = { $ref: '#/definitions/Stamp', definitions: { Stamp: STAMP } };
    const { pkg } = buildApigenPackage({
      id: 'svc',
      version: '1',
      importPath: './svc',
      operations: [action('now', { type: 'object', properties: {} }, output)],
      fns: { now: () => ({ at: new Date('2026-05-06T07:08:09.000Z'), label: 'n' }) },
    });
    const result = await dispatch(pkg.fns, undefined, pkg.schemas['now'], 'now', {}, {});
    expect(result).toEqual({ at: '2026-05-06T07:08:09.000Z', label: 'n' });
  });

  it('rejects invalid input at the validate layer before the function runs', async () => {
    const fn = vi.fn();
    const { pkg } = buildApigenPackage({
      id: 'svc',
      version: '1',
      importPath: './svc',
      operations: [action('record', stampInput)],
      fns: { record: fn },
    });
    const invoke = createPackageInvoker(pkg.schemas, []);
    await expect(
      invoke('record', call('record', { stamp: { label: 'no timestamp' } }), { fns: pkg.fns, schemas: pkg.schemas })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps the identity, passes createClient through, and returns every operation kind unchanged', () => {
    const createClient = vi.fn();
    const query = action('lookup', { type: 'object', properties: {} }, {}, { kind: 'query' });
    const act = action('record', { type: 'object', properties: {} });
    const { pkg, operations } = buildApigenPackage({
      id: 'svc',
      version: '9.9.9',
      importPath: '@x/svc',
      operations: [query, act],
      fns: { record: () => 1 },
      createClient,
    });
    expect(pkg).toMatchObject({ id: 'svc', version: '9.9.9', importPath: '@x/svc', createClient });
    expect(Object.keys(pkg.schemas)).toEqual(['record']); // the query is not an entry of the function table
    expect(operations.map((o) => o.id)).toEqual(['svc/lookup', 'svc/record']);
  });

  it('omits createClient when none is supplied and records hasCtx on the schema', () => {
    const { pkg } = buildApigenPackage({
      id: 'svc',
      version: '1',
      importPath: './svc',
      operations: [action('record', { type: 'object', properties: {} }, {}, { hasCtx: true })],
      fns: { record: () => 1 },
    });
    expect('createClient' in pkg).toBe(false);
    expect(pkg.schemas['record']).toMatchObject({ hasCtx: true });
  });

  describe('startup defects are ApiError(internal), reported before anything is served', () => {
    const fns = { record: () => 1 };

    it('two operations that dispatch under one name', () => {
      const a = action('record', { type: 'object', properties: {} });
      const b = { ...action('record', { type: 'object', properties: {} }), id: 'other/record' } as Operation;
      expect(() =>
        buildApigenPackage({ id: 'svc', version: '1', importPath: '.', operations: [a, b], fns })
      ).toThrow(expect.objectContaining({ code: 'internal', message: expect.stringMatching(/"svc\/record" and "other\/record" both dispatch as "record"/) as string }) as Error);
    });

    it('an action operation with no function in fns', () => {
      expect(() =>
        buildApigenPackage({
          id: 'svc',
          version: '1',
          importPath: '.',
          operations: [action('missing', { type: 'object', properties: {} })],
          fns,
        })
      ).toThrow(/action operation "svc\/missing" has no function "missing" in fns/);
    });

    it('an action operation whose path names no function', () => {
      const op = { ...action('x', { type: 'object', properties: {} }), path: [] } as Operation;
      expect(() => buildApigenPackage({ id: 'svc', version: '1', importPath: '.', operations: [op], fns })).toThrow(
        /action operation "svc\/x" has no path segment/
      );
    });

    it('a dangling $ref', () => {
      const dangling = { type: 'object', properties: { s: { $ref: '#/definitions/Nope' } }, definitions: { Stamp: STAMP } };
      let error: unknown;
      try {
        buildApigenPackage({ id: 'svc', version: '1', importPath: '.', operations: [action('record', dangling)], fns });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'internal' });
      expect((error as Error).message).toMatch(/^buildApigenPackage\(svc\): .*Nope/s);
    });
  });
});
