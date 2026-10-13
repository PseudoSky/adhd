#!/usr/bin/env node
/**
 * Emits `schema/policy.schema.json` and `schema/compiled.schema.json` from the
 * TypeScript constants (`POLICY_SCHEMA`, `COMPILED_SCHEMA`) as sorted-key JSON.
 *
 * Usage (from the workspace root, TypeScript source is loaded through tsx):
 *   npx tsx --tsconfig tsconfig.base.json packages/policy/policy-core-client/scripts/emit-schemas.mjs
 * The emitted files are checked in; a drift test (Phase C) compares them to the constants.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_SCHEMA } from '../src/spec/schema/policy-schema.ts';
import { COMPILED_SCHEMA } from '../src/spec/schema/compiled-schema.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively sorts object keys so equal schemas always emit equal bytes. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

mkdirSync(join(root, 'schema'), { recursive: true });
for (const [file, schema] of [
  ['policy.schema.json', POLICY_SCHEMA],
  ['compiled.schema.json', COMPILED_SCHEMA],
]) {
  writeFileSync(join(root, 'schema', file), JSON.stringify(sortKeys(schema), null, 2) + '\n');
  console.log(`wrote schema/${file}`);
}
