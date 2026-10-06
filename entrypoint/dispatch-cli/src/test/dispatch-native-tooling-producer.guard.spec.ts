/**
 * dispatch-native-tooling-producer.guard.spec.ts — NAT-TOOL-5 AC4: the dispatch
 * host must NOT become a SECOND producer of the builtin fs/shell MCP servers.
 *
 * The dispatch host resolves its native toolset via
 * `resolveNativeToolingMap` (`@adhd/agent-core-native-tooling`) — the ONE
 * producer (NAT-TOOL-4). This guard fails if a hand-built fs/shell config
 * reappears anywhere in this package's production source (e.g. someone inlines
 * `['-y','@modelcontextprotocol/server-filesystem']` or `command:'uvx'` into
 * `core.ts` instead of reusing the resolver).
 *
 * Mirrors `entrypoint/agent-mcp/src/__tests__/default-mcp-producer.guard.test.ts`
 * for the dispatch host. Excludes tests/fixtures (they legitimately reference
 * the resolver, and this file names the literals it searches for).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SELF = resolve(__dirname, 'dispatch-native-tooling-producer.guard.spec.ts');
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const SRC = resolve(repoRoot, 'entrypoint', 'dispatch-cli', 'src');

const SOURCE_EXT = /\.(ts|mts|mjs|js|cjs)$/;
const TEST_PATH = /(^|\/)(__tests__|test|fixtures)(\/|$)|\.(spec|test|e2e\.test)\.[cm]?ts$/;

function productionFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (full === SELF) continue;
      const rel = relative(repoRoot, full);
      if (statSync(full).isDirectory()) visit(full);
      else if (SOURCE_EXT.test(full) && !TEST_PATH.test(rel)) out.push(full);
    }
  };
  visit(root);
  return out;
}

const PROD = productionFiles(SRC);
const filesMatching = (re: RegExp): string[] =>
  PROD.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(repoRoot, f));

describe('NAT-TOOL-5 — the dispatch host is not a second fs/shell producer', () => {
  it('does not construct the builtin fs server outside the resolver catalog', () => {
    const re = /['"]-y['"]\s*,\s*['"]@modelcontextprotocol\/server-filesystem['"]/;
    expect(filesMatching(re)).toEqual([]);
  });

  it('does not construct the builtin shell command outside the resolver catalog', () => {
    const re = /command:\s*['"]uvx['"]/;
    expect(filesMatching(re)).toEqual([]);
  });

  it('resolves the native toolset through the resolver package (import present)', () => {
    const core = readFileSync(resolve(SRC, 'lib', 'core.ts'), 'utf8');
    expect(core).toContain('resolveNativeToolingMap');
    expect(core).toContain('@adhd/agent-core-native-tooling');
  });
});
