/**
 * Loader for the plain-.mjs parity instrument modules (entrypoint/agent-mcp/parity/, private, unpublished). The modules are
 * untyped JS, so the unit tests here receive them as `any` through one audited seam instead of per-file ts-ignores.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path of entrypoint/agent-mcp/parity. */
export const PARITY_DIR = path.resolve(HERE, '..', '..', '..', 'parity');

/** Import `parity/<rel>` (e.g. `oracle.mjs`, `golden/r4/oracle.r4.frozen.mjs`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadParity(rel: string): Promise<any> {
  return import(/* @vite-ignore */ pathToFileURL(path.join(PARITY_DIR, rel)).href);
}
