// version.ts — default `extractorVersion` resolution (FEAT-002 Revision 2,
// design doc R2.2's `IrCacheOptions.extractorVersion` doc comment: "defaults
// to `@adhd/apigen-core-client`'s own `package.json` version"). Same
// mechanism `entrypoint/backlog/src/server.ts`'s `CORE_CLIENT_VERSION`
// already uses (`createRequire` + reading the dependency's `package.json`),
// reused here so both `./index.ts`'s default `irCachePlugin` and
// `./target.ts`'s ARTIFACT-mode `generate()` agree on the same fallback.
//
// `import.meta.url` is deliberately NOT used: this package's `tsc` project
// reference (type-check only) compiles under `module: commonjs`
// (`tsconfig.json`), which rejects `import.meta` syntax outright, even
// though the actual shipped bundle also has an ESM (`.mjs`) build. Instead,
// mirror the existing `typeof __dirname !== 'undefined' ? __dirname :
// process.cwd()` fallback `apigen-engine-conformance/src/lib/gate.ts`
// already uses for the identical CJS/ESM-dual-output problem: `__dirname`
// is defined in the CJS bundle; `process.cwd()` is the accepted fallback for
// the ESM bundle (this monorepo's own node_modules resolution chain from
// the CLI's working directory).

import { createRequire } from 'node:module';
import { join } from 'node:path';

const base = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
const requirePkg = createRequire(join(base, 'noop.js'));

let cachedVersion: string | undefined;

/**
 * The installed `@adhd/apigen-core-client` version — the default
 * `extractorVersion` stamped into a cache entry when the caller doesn't
 * supply an explicit override. Memoized: `package.json` doesn't change
 * within a process lifetime.
 */
export function readDefaultExtractorVersion(): string {
  cachedVersion ??= (
    requirePkg('@adhd/apigen-core-client/package.json') as { version: string }
  ).version;
  return cachedVersion;
}
