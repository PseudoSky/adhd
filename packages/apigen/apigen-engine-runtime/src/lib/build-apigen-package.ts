/**
 * buildApigenPackage — the one helper that turns extracted IR (`Operation[]`)
 * plus a live function table into the package entry every apigen host serves
 * (`RunInput['packages'][number]`).
 *
 * REMEDIATION-PLAN R3 / TAXONOMY C2 (owner decision BA-10). Hosts that today
 * hand-build this shape (`entrypoint/policy/src/wrapper/package.ts`,
 * `entrypoint/backlog/src/server.ts`) each re-derive the composed schemas and,
 * because run-mode dispatch could not resolve a `$ref`, each inline every
 * `$ref` first. `dispatch` now resolves `$ref`s against the composed entry's
 * own definitions, so this helper composes the IR's schemas as they are —
 * no dereferencing — exactly as the apigen-cli orchestrator does
 * (`entrypoint/apigen-cli/src/lib/orchestrator.ts`, its Step 5).
 *
 * A helper, not a capability or a contract member.
 */

import { ApiError } from '@adhd/apigen-base-errors';
import { composeSchemas } from '@adhd/apigen-core-client';
import type { GeneratedSchemas, Operation } from '@adhd/apigen-core-client';
import type { CreateClientFn } from './dispatch';
import type { ComposedSchemas } from './types';

/** The input of {@link buildApigenPackage}. */
export interface BuildApigenPackageInput {
  /** The package id (also the composed schemas' namespace). */
  id: string;
  /** The package's real published version (reported in, e.g., the MCP handshake). */
  version: string;
  /** The import path the package's functions come from (provenance; generate mode). */
  importPath: string;
  /** The extracted IR. Only `action` operations are composed and served. */
  operations: readonly Operation[];
  /**
   * The live function table, keyed by each action operation's dispatch name:
   * the raw spelling of its terminal path segment.
   */
  fns: Record<string, (...args: unknown[]) => unknown>;
  /**
   * The `ctx` factory for session middleware and `ctx`-taking functions. It
   * receives `{ signal }` as its second argument when the call has a signal
   * (adhd ADR-0019 D4).
   */
  createClient?: CreateClientFn;
}

/** One servable package: the `RunInput['packages'][number]` shape, with `version` and `fns` always present. */
export interface ApigenPackage {
  /** The package id. */
  id: string;
  /** The package's real published version. */
  version: string;
  /** The import path the package's functions come from. */
  importPath: string;
  /** The composed schemas, keyed by dispatch name. */
  schemas: ComposedSchemas;
  /** The live function table, keyed by dispatch name. */
  fns: Record<string, (...args: unknown[]) => unknown>;
  /** The `ctx` factory, when the input supplied one. */
  createClient?: CreateClientFn;
}

/** The result of {@link buildApigenPackage}. */
export interface BuildApigenPackageResult {
  /** The servable package entry. */
  pkg: ApigenPackage;
  /** The IR, as supplied (every kind, in order) — the descriptor hosts project from. */
  operations: Operation[];
}

/**
 * Build the servable package entry for extracted IR and its live functions.
 *
 * Each `action` operation is keyed by the raw spelling of its terminal path
 * segment (the same flat dispatch-table key the apigen-cli orchestrator
 * uses) and contributes its `input`, `output`, `hasCtx` and `safe` to one
 * `composeSchemas` pass with no envelope middlewares. Schemas are composed as
 * extracted: `$ref`s and their definitions are kept, and `dispatch` resolves
 * them at call time. `query`, `constructor` and `instance-method` operations
 * are not composed (they are not entries of the function table); they stay
 * in the returned `operations`.
 *
 * @param input The package identity, the IR and the live functions.
 * @returns The package entry and the IR.
 * @throws ApiError('internal') when two action operations share a dispatch
 *   name (one would silently shadow the other), when an action operation has
 *   no function in `fns`, or when `composeSchemas` rejects a dangling `$ref`.
 *   All are startup defects, reported before anything is served.
 */
export function buildApigenPackage(input: BuildApigenPackageInput): BuildApigenPackageResult {
  const generated: GeneratedSchemas = {
    metadata: { namespace: input.id, phase: '' },
    schemas: {},
  };
  const sourceOf = new Map<string, string>();
  for (const op of input.operations) {
    if (op.kind !== 'action') continue;
    const fnName = op.path[op.path.length - 1]?.raw;
    if (fnName === undefined || fnName.length === 0) {
      throw new ApiError(
        'internal',
        `buildApigenPackage(${input.id}): action operation "${op.id}" has no path segment to name its function`
      );
    }
    const earlier = sourceOf.get(fnName);
    if (earlier !== undefined) {
      throw new ApiError(
        'internal',
        `buildApigenPackage(${input.id}): operations "${earlier}" and "${op.id}" both dispatch as "${fnName}"`
      );
    }
    if (typeof input.fns[fnName] !== 'function') {
      throw new ApiError(
        'internal',
        `buildApigenPackage(${input.id}): action operation "${op.id}" has no function "${fnName}" in fns`
      );
    }
    sourceOf.set(fnName, op.id);
    generated.schemas[fnName] = {
      input: op.input as Record<string, unknown>,
      output: op.output as Record<string, unknown>,
      ...(op.hasCtx ? { hasCtx: true } : {}),
      safe: op.safe,
    };
  }

  let schemas: ComposedSchemas;
  try {
    schemas = composeSchemas(generated, []);
  } catch (error) {
    throw new ApiError(
      'internal',
      `buildApigenPackage(${input.id}): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    pkg: {
      id: input.id,
      version: input.version,
      importPath: input.importPath,
      schemas,
      fns: input.fns,
      ...(input.createClient !== undefined ? { createClient: input.createClient } : {}),
    },
    operations: [...input.operations],
  };
}
