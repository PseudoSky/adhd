/**
 * guards: an optional primitive param (`limit?: number`) extracted under a strict tsconfig is emitted as oneOf [null, number] and must still hoist to GET (x-apigen-safe), as the isPrimitiveOnlyInputSchema contract documents
 * tier: S
 * cites: backlog 59c34223 (GET routing rejects optional primitive params) - AC1 optional primitives route GET; AC2 a union of two primitives or an object param stays POST
 *
 * Consumer path: a real temp TypeScript source + a real strict tsconfig go through the real `extract()`, then the real
 * `composeSchemas()` that every HTTP transport reads `x-apigen-safe` from. Nothing is mocked.
 *
 * red run (before the fix, the predicate rejected every oneOf): AC1 failed with `expected false to be true` at
 * `safeByName['optionalNumber']`; AC2 passed (it pins the boundary the fix must not cross).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extract } from '../../src/lib/extract';
import { composeSchemas } from '../../src/lib/compose-schemas';
import { isPrimitiveOnlyInputSchema } from '../../src/lib/get-safety';
import type { GeneratedSchemas } from '../../src/lib/types';

let dir: string;
let safeByName: Record<string, unknown>;
let inputByName: Record<string, Record<string, unknown>>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-optprim-'));
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs', moduleResolution: 'node' },
      include: ['*.ts'],
    })
  );
  const src = path.join(dir, 'api.ts');
  fs.writeFileSync(
    src,
    [
      'export async function requiredNumber(limit: number): Promise<string[]> { return []; }',
      'export async function optionalNumber(limit?: number): Promise<string[]> { return []; }',
      'export async function optionalString(name: string, q?: string): Promise<string[]> { return []; }',
      'export async function nullableNumber(limit: number | null): Promise<string[]> { return []; }',
      'export async function numberOrString(v: number | string): Promise<string[]> { return []; }',
      'export async function optionalObject(opts?: { a: number }): Promise<string[]> { return []; }',
      '',
    ].join('\n')
  );
  const ops = await extract({
    sourceFile: src,
    namespace: 'x',
    tsconfig: path.join(dir, 'tsconfig.json'),
  });
  const schemas: GeneratedSchemas['schemas'] = {};
  inputByName = {};
  for (const op of ops) {
    const name = op.path[op.path.length - 1].raw;
    schemas[name] = { input: op.input, output: op.output } as GeneratedSchemas['schemas'][string];
    inputByName[name] = op.input as Record<string, unknown>;
  }
  const composed = composeSchemas({ metadata: { namespace: 'x', phase: '' }, schemas }, []);
  safeByName = Object.fromEntries(
    Object.entries(composed).map(([k, v]) => [k, (v as Record<string, unknown>)['x-apigen-safe']])
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('optional primitive params route GET (59c34223)', () => {
  it('[AC1] required, optional and nullable primitives are all GET-safe', () => {
    expect(safeByName['requiredNumber']).toBe(true);
    expect(safeByName['optionalNumber']).toBe(true);
    expect(safeByName['optionalString']).toBe(true);
    expect(safeByName['nullableNumber']).toBe(true);
    expect(isPrimitiveOnlyInputSchema(inputByName['optionalNumber'])).toBe(true);
  });

  it('[AC2] a union of two primitives and an optional object param stay POST', () => {
    expect(safeByName['numberOrString']).toBe(false);
    expect(safeByName['optionalObject']).toBe(false);
  });
});
