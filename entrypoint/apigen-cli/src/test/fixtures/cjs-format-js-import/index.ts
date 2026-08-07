// Regression fixture for BUG-APIGEN-IMPORT-SOURCE-CJS-JS-EXT.
//
// Reproduces the exact shape that broke `importSource()` against a real
// workspace lib (@adhd/sox-memory-core): a package with NO `"type": "module"`
// in its package.json (see ./package.json), whose entry directly exports a
// callable function (so the static extractor has something to find) that in
// turn depends on a sibling module reached only through a NodeNext-style
// `.js` specifier that exists on disk solely as `.ts` — mirroring
// memory-core's `export async function write(...)` (a directly-declared
// export) internally using `import { openDb } from './db.js'` (`db.ts` on
// disk). A pure re-export shape (`export { x } from './helper.js'`) does NOT
// reproduce the bug: the static extractor only picks up directly-declared
// exports, so it never reaches the dynamic import path at all.
//
// Under `node dist/entrypoint/apigen-cli/index.js run --source index.ts ...`
// (a plain `node` process, no `tsx` CLI wrapper), Node's ESM loader detects
// this file's format as CommonJS (no "type": "module" in the nearest
// package.json) and routes its relative import through its CJS translator,
// which performs a real `require('./helper.js')`. `importSource()` must
// register BOTH `tsx/esm/api` and `tsx/cjs/api` for that require to resolve
// `./helper.js` -> `./helper.ts`; registering only the ESM hook throws
// `Cannot find module './helper.js'` even though `helper.ts` sits right next
// to this file.
import { buildGreeting } from './helper.js';

export async function greet(name: string): Promise<string> {
  return buildGreeting(name);
}

export const __samples__: Record<string, Record<string, unknown>> = {
  greet: { name: 'world' },
};
