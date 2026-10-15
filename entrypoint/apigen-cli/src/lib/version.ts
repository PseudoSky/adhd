import { createRequire } from 'node:module';

/** The npm name of this package; a manifest that is not this one is never trusted. */
const PACKAGE_NAME = '@adhd/apigen-cli';

/**
 * Manifest locations, relative to the executing module, in the order tried:
 *  - `./package.json`     published layout: the generated manifest sits next to the bundle
 *                         (`dist/index.js` is the package root once published from `dist/`).
 *  - `../package.json`    in-repo build output (`dist/index.js` -> project root).
 *  - `../../package.json` source (`src/lib/version.ts` -> project root).
 */
const MANIFEST_CANDIDATES = ['./package.json', '../package.json', '../../package.json'];

/**
 * Reads the real version of `@adhd/apigen-cli` from its own `package.json`, so the
 * CLI never reports a hand-maintained literal. Works from source (vitest/tsx) and from
 * the built CJS/ESM bundle, published or in-repo.
 *
 * @param requireFrom the caller's `import.meta.url` (module URL or absolute path) to resolve candidates against
 * @returns the semver string from the manifest
 * @throws when no manifest named `@adhd/apigen-cli` with a string `version` is found
 */
export function readPackageVersion(requireFrom: string): string {
  const req = createRequire(requireFrom);
  for (const rel of MANIFEST_CANDIDATES) {
    try {
      const manifest = req(rel) as { name?: unknown; version?: unknown };
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // candidate absent; try the next
    }
  }
  throw new Error(`apigen: unable to determine version (no ${PACKAGE_NAME} package.json found)`);
}
