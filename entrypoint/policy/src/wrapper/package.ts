import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Operation } from '@adhd/apigen-core-client';
import { buildApigenPackage, type ApigenPackage } from '@adhd/apigen-engine-runtime';
import { policyOperations, type IPolicyCtx } from '@adhd/policy-core-client';
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
 * Builds the apigen-ready package descriptor for the client's operations with
 * `buildApigenPackage`. `ctx` may be a ready context or a thunk; `createClient`
 * calls the thunk FRESH on every dispatch, so `--help` and argument errors never
 * resolve a policy file (IN-14). The operations and schemas are derived from the
 * declarations alone and never touch `ctx`. Schemas are composed as extracted
 * (`$ref`s stay; dispatch resolves them).
 *
 * Startup-failure contract: an action operation in the extracted IR with no
 * matching function in `policyOperations`, a duplicate dispatch name, or a
 * dangling `$ref` makes this reject with `ApiError('internal')` before anything is
 * served; no caller catches it.
 *
 * @param ctx A ready policy context or a thunk resolving one.
 * @returns The servable package entry and the IR it was built from.
 * @throws ApiError('internal') when the IR and the function table disagree.
 */
export async function buildPolicyPackage(ctx: IPolicyCtx | (() => IPolicyCtx | Promise<IPolicyCtx>)): Promise<{
  pkg: ApigenPackage;
  operations: Operation[];
}> {
  const getCtx: () => IPolicyCtx | Promise<IPolicyCtx> = typeof ctx === 'function' ? ctx : () => ctx;
  const extracted = await extractPolicyOperations();
  return buildApigenPackage({
    id: 'policy',
    version: readPolicyVersion(),
    importPath: locateClientApi()?.apiDts ?? '@adhd/policy-core-client',
    operations: extracted,
    fns: policyOperations as unknown as Record<string, (...args: unknown[]) => unknown>,
    createClient: async () => getCtx(),
  });
}
