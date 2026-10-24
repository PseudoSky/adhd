#!/usr/bin/env node
/**
 * Bakes the operations of the shipped `dist/api.d.ts` into `dist/operations.baked.json` (I-35), so a cold
 * start of either host reads the file instead of running a ~13 s TypeScript extraction.
 *
 * Runs as the last step of `build-bin` (the declarations come from `build`, the compiled server module
 * from the tsc pass of `build-bin`). Usage: `node scripts/bake-operations.mjs [<dist directory>]`; the
 * default is the `dist/` next to this script's package. Exit 0 on success, 1 with one `<CODE>: <message>`
 * line on stderr otherwise.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(process.argv[2] ?? join(here, '..', 'dist'))
const require = createRequire(import.meta.url)

try {
  const { bakeOperations, BAKED_OPERATIONS_FILE } = require(join(dist, 'src', 'server.js')) // dist/src/server.js
  const baked = await bakeOperations({ apiSource: join(dist, 'api.d.ts'), outFile: join(dist, BAKED_OPERATIONS_FILE) })
  process.stdout.write(`bake-operations: ${baked.count} operations -> ${baked.file}\n`)
} catch (e) {
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : 'HOST_BOOT_FAILED'
  process.stderr.write(`${code}: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
