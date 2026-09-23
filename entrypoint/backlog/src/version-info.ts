/**
 * version-info.ts — the STORE-FREE reading path behind `backlog version`.
 * Extracted from `client.ts`'s `version()` so `cli.ts`'s `runBacklogCli` can
 * short-circuit the `version` command BEFORE ever building the apigen
 * package/opening the backing store adapter
 * (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001): `version` reads `package.json`,
 * never the graph store, so it must not pay the open+close of a real store
 * the way a genuinely store-needing command (e.g. `list-items`) does.
 *
 * This file is deliberately NOT an apigen extraction surface (only
 * `client.ts` is — see `server.ts`'s `extractClientOperations()`), so adding
 * `readBacklogVersionInfo` here introduces no new CLI/MCP/HTTP command the
 * way an extra `client.ts` export would.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves this MODULE's own `package.json`, probing the exact SAME two
 * layouts (in the same sibling-first order) `install-skill.ts`'s
 * `installSkillToHosts` and `server.ts`'s `backlogDistDir()` already probe
 * for this file — reused, not reinvented, per that precedent's own doc
 * comment:
 *
 *  1. PUBLISHED / DEV-BUILT (`dist/client.js` next to `package.json`, either
 *     as the packed npm root or this repo's own `nx build backlog` output):
 *     `package.json` is a SIBLING of this module's own directory.
 *  2. VITEST (`src/client.ts` transformed and run in place, never built):
 *     `package.json` is one level UP from `src/` (the package root) — the
 *     `join(here, '..', 'package.json')` fallback.
 */
function resolveOwnPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'package.json');
  if (existsSync(sibling)) return sibling;
  return join(here, '..', 'package.json');
}

/**
 * Reports this running package's own real `name`/`version`, read fresh from
 * `package.json` on every call (never a compiled-in constant, so a
 * republished build can never drift from what this reports). Store-free —
 * callable by `client.ts`'s `version()` (apigen-dispatched, ctx-carrying) and
 * by `cli.ts`'s `version` short-circuit (never opens the store) identically.
 * Returns the same `{ name, version }` shape `client.ts`'s `BacklogVersionInfo`
 * declares; the return type is deliberately structural (not an import of that
 * interface) so `client.ts`'s own extraction surface (`client.d.ts`) is
 * byte-for-byte unchanged by this extraction.
 */
export function readBacklogVersionInfo(): { name: string; version: string } {
  const pkgJsonPath = resolveOwnPackageJsonPath();
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    name: string;
    version: string;
  };
  return { name: pkg.name, version: pkg.version };
}
