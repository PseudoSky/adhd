import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeSchemas, type Operation } from '@adhd/apigen-core-client';
import { policyOperations, type IPolicyCtx } from '@adhd/policy-core-client';
import { dereferenceSchema } from './dereference';
import { extractPolicyOperations, locateClientApi, policyDistDir } from './ir';

/** The version in this package's own `package.json` (next to the bundle once published, one level up from `dist/` in the repo); the manifest must be `@adhd/policy`'s own. */
export function readPolicyVersion(): string {
  for (const candidate of [join(policyDistDir(), 'package.json'), join(policyDistDir(), '..', 'package.json')]) {
    try {
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
        if (manifest.name === '@adhd/policy' && typeof manifest.version === 'string') return manifest.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

/**
 * Builds the apigen-ready package descriptor for the client's operations.
 * `ctx` may be a ready context or a thunk; `createClient` calls the thunk
 * FRESH on every dispatch, so `--help` and argument errors never resolve a
 * policy file (IN-14). The operations and schemas are derived from the
 * declarations alone and never touch `ctx`.
 */
export async function buildPolicyPackage(ctx: IPolicyCtx | (() => IPolicyCtx | Promise<IPolicyCtx>)): Promise<{
  pkg: {
    id: string;
    version: string;
    schemas: ReturnType<typeof composeSchemas>;
    importPath: string;
    fns: Record<string, (...args: unknown[]) => unknown>;
    createClient: () => Promise<IPolicyCtx>;
  };
  operations: Operation[];
}> {
  const getCtx: () => IPolicyCtx | Promise<IPolicyCtx> = typeof ctx === 'function' ? ctx : () => ctx;
  const operations = await extractPolicyOperations();
  const generated = {
    metadata: { namespace: 'policy', phase: '' },
    schemas: Object.fromEntries(
      operations
        .filter((op) => op.kind === 'action')
        .map((op) => [
          op.path[op.path.length - 1]?.raw ?? '',
          {
            input: dereferenceSchema(op.input) as Record<string, unknown>,
            output: dereferenceSchema(op.output) as Record<string, unknown>,
            hasCtx: op.hasCtx,
            safe: op.safe,
          },
        ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  return {
    pkg: {
      id: 'policy',
      version: readPolicyVersion(),
      schemas,
      importPath: locateClientApi()?.apiDts ?? '@adhd/policy-core-client',
      fns: policyOperations as unknown as Record<string, (...args: unknown[]) => unknown>,
      createClient: async () => getCtx(),
    },
    operations,
  };
}
