/**
 * guards: `buildPolicyPackage` serves a package whose extracted IR disagrees with the live function table (an action operation with no function, two operations dispatching under one name, a dangling `$ref`) instead of rejecting at startup with `ApiError('internal')`; and a healthy IR stops composing.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R9 (startup-failure contract; replaces the deleted E9 dereference tests), §3 R9 `package.ts`
 * red-run: 2026-10-21 negative control: the same IR without the injected defect (first test) composes and the three defect variants each reject with ApiError internal naming the defect; the guards live in apigen-engine-runtime build-apigen-package.ts (another package, not edited here) so the control is the variant pair, not a source revert.
 */
import type { Operation } from '@adhd/apigen-core-client';
import { isApiError } from '@adhd/apigen-base-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPolicyOperations as realExtract } from '../../wrapper/ir';

// The IR the package is built from is the one injected seam: every test hands buildPolicyPackage a (possibly
// deliberately wrong) IR. The real extraction, the real function table and the real buildApigenPackage run.
const injected = vi.hoisted(() => ({ operations: undefined as unknown[] | undefined }));
vi.mock('../../wrapper/ir', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../wrapper/ir')>();
  return {
    ...real,
    extractPolicyOperations: async (...args: Parameters<typeof real.extractPolicyOperations>) =>
      injected.operations ?? (await real.extractPolicyOperations(...args)),
  };
});

import { buildPolicyPackage } from '../../wrapper/package';

const ctx = {} as never;

async function realOperations(): Promise<Operation[]> {
  injected.operations = undefined;
  return (await realExtract()).map((op) => structuredClone(op));
}

async function rejection(): Promise<unknown> {
  try {
    await buildPolicyPackage(ctx);
  } catch (error) {
    return error;
  }
  throw new Error('buildPolicyPackage resolved; expected a startup rejection');
}

describe('buildPolicyPackage - startup-failure contract (T-R9)', () => {
  beforeEach(() => {
    injected.operations = undefined;
  });

  it('a consistent IR composes: every action operation is served under its dispatch name', async () => {
    const { pkg, operations } = await buildPolicyPackage(ctx);
    expect(Object.keys(pkg.schemas).sort()).toEqual(['check', 'compile', 'doctor', 'draft', 'evaluate', 'explain', 'narrow', 'resolve', 'show', 'verify']);
    expect(typeof pkg.fns['check']).toBe('function');
    expect(operations.map((op) => op.id)).toContain('policy/check');
  });

  it('an action operation with no function in the table rejects with ApiError internal naming the operation', async () => {
    const ops = await realOperations();
    const check = ops.find((op) => op.id === 'policy/check') as Operation;
    const ghost = structuredClone(check);
    ghost.id = 'policy/ghost';
    ghost.path = [{ raw: 'ghost', words: ['ghost'] }] as Operation['path'];
    injected.operations = [...ops, ghost];
    const error = await rejection();
    expect(isApiError(error) && error.code).toBe('internal');
    expect((error as Error).message).toContain('policy/ghost');
    expect((error as Error).message).toContain('no function "ghost"');
  });

  it('two operations dispatching under one name reject instead of one silently shadowing the other', async () => {
    const ops = await realOperations();
    const check = ops.find((op) => op.id === 'policy/check') as Operation;
    const twin = structuredClone(check);
    twin.id = 'policy/other/check';
    injected.operations = [...ops, twin];
    const error = await rejection();
    expect(isApiError(error) && error.code).toBe('internal');
    expect((error as Error).message).toMatch(/both dispatch as "check"/);
  });

  it('a dangling $ref in an operation schema rejects with ApiError internal before anything is served', async () => {
    const ops = await realOperations();
    const check = ops.find((op) => op.id === 'policy/check') as Operation;
    (check.input as { properties: Record<string, unknown> }).properties['input'] = { $ref: '#/definitions/Nowhere' };
    injected.operations = ops;
    const error = await rejection();
    expect(isApiError(error) && error.code).toBe('internal');
    expect((error as Error).message).toContain('Nowhere');
  });
});
