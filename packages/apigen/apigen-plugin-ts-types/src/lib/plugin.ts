// @adhd/apigen-plugin-ts-types — generate-only apigen output plugin
// (FEAT-APIGEN-TS-TYPE-CODEGEN-001, SPEC §6.1).
//
// Emits one TypeScript type-declaration file per exported function per package
// (`<pkgId>/<fnName>.ts`), derived from the function's JSON-Schema IR via the
// hand-rolled emitter in `./emit-types`. Generate-only: no `run()` — the CLI
// derives `list-types`/`run` capability from this absence automatically.

import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core-client';
import * as path from 'node:path';
import { emitFnTypes, pkgPrefixFor, unwrapDataWrapper } from './emit-types';

type Pkg = PluginInput['packages'][number];

/**
 * Resolve the `{ input, output }` schema pair for every function of one
 * package. `input.operations` (the v2 descriptor, SPEC §4 data-wrapper-dissolved
 * — populated by `orchestrateGenerate`) is PRIMARY; `pkg.schemas[fnName]` is the
 * fallback for fn names not already present (hand-built `PluginInput` /
 * non-TS-extraction paths), with the composed `data` envelope unwrapped so the
 * emitted `Input` type is the true params object, never `{ data: … }`.
 * Operations win on name collision.
 */
function fnSchemasFor(
  pkg: Pkg,
  input: PluginInput
): Array<[string, { input: unknown; output: unknown }]> {
  const schemas = new Map<string, { input: unknown; output: unknown }>();

  if (Array.isArray(input.operations)) {
    for (const op of input.operations) {
      const fnName =
        op.path.length > 0
          ? op.path[op.path.length - 1].raw
          : op.id.split('/').pop();
      if (!fnName) continue;
      schemas.set(fnName, { input: op.input, output: op.output });
    }
  }

  for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
    if (schemas.has(fnName)) continue; // operations win on name collision
    schemas.set(fnName, {
      input: unwrapDataWrapper(fnSchema.input),
      output: fnSchema.output,
    });
  }

  return Array.from(schemas.entries());
}

export const tsTypesPlugin: OutputPlugin = {
  id: 'ts-types',
  description: 'Emit one TypeScript type-declaration file per function per package',
  language: 'ts',
  optionsSchema: { type: 'object', properties: {} },
  generate(input: PluginInput): PluginOutput {
    const files: PluginOutput['files'] = [];
    for (const pkg of input.packages) {
      const pkgPrefix = pkgPrefixFor(pkg.id);
      for (const [fnName, schema] of fnSchemasFor(pkg, input)) {
        files.push({
          path: path.join(pkg.id, `${fnName}.ts`),
          content: emitFnTypes(pkgPrefix, fnName, schema),
        });
      }
    }
    return { files };
  },
};

export default tsTypesPlugin;
