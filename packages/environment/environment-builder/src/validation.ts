/**
 * `validation.ts` — Pipeline step 13 (validate resolved config against the
 * generated `fieldSchema`).
 *
 * `validateConfig(config, schema)` is an `ajv` wrapper that throws a single
 * `ValidationError` aggregating every field-level violation (not just the
 * first) when `config` fails to satisfy `schema`. An empty/absent schema is
 * treated as "nothing to validate" (skip), matching the `mergeFieldDefinitions`
 * "empty scopes are valid" invariant — a project with zero declared config
 * fields validates trivially.
 */

import Ajv from 'ajv';
import type { ErrorObject } from 'ajv';

/** A single field-level validation failure. */
export interface FieldValidationError {
  /** Dot-path to the offending field (e.g. `"server.port"`), or `"(root)"`. */
  field: string;
  message: string;
  /** The `ajv` keyword that failed (`"minimum"`, `"enum"`, `"required"`, ...). */
  keyword: string;
}

/**
 * Thrown by `validateConfig` on schema violation. Carries every field-level
 * error `ajv` found (`allErrors: true`), not just the first.
 */
export class ValidationError extends Error {
  constructor(readonly fieldErrors: FieldValidationError[]) {
    super(
      fieldErrors.length > 0
        ? `Config validation failed: ${fieldErrors.map((e) => `${e.field} ${e.message}`).join('; ')}`
        : 'Config validation failed',
    );
    this.name = 'ValidationError';
  }
}

/**
 * Validates `config` (the resolved, nested config object —
 * `SnapshotData.config`) against a generated `fieldSchema`
 * (`json-schema-gen.ts`'s `generateFieldSchema` output). Throws
 * `ValidationError` with every field-level violation on failure. A `null`/
 * `undefined`/empty schema is treated as valid (nothing declared to
 * validate).
 */
export function validateConfig(config: Record<string, unknown>, schema: object | null | undefined): void {
  if (!schema) return;
  const schemaRecord = schema as Record<string, unknown>;
  const properties = schemaRecord.properties as Record<string, unknown> | undefined;
  if (properties !== undefined && Object.keys(properties).length === 0) return;

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schemaRecord);
  const valid = validate(config);

  if (!valid) {
    throw new ValidationError(toFieldErrors(validate.errors ?? []));
  }
}

function toFieldErrors(errors: ErrorObject[]): FieldValidationError[] {
  return errors.map((error) => ({
    field: normalizeFieldPath(error),
    message: error.message ?? 'is invalid',
    keyword: error.keyword,
  }));
}

function normalizeFieldPath(error: ErrorObject): string {
  const instancePath = (error.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
  if (instancePath) return instancePath;
  const missingProperty = (error.params as { missingProperty?: string } | undefined)?.missingProperty;
  return missingProperty ?? '(root)';
}
