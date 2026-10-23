/**
 * dispatch-native-tooling-producer.guard.spec.ts — NAT-TOOL-5 rework: the
 * dispatch host must NOT author (or resolve) the builtin fs/shell MCP servers.
 *
 * Under ADR-0008 D4/D8 the host STORES only a DECLARATIVE `nativeTooling`; the
 * fs/shell/`dispatch` builtins are resolved at task time by the spawned
 * agent-mcp child (the ONE producer, `@adhd/agent-core-native-tooling`), against
 * the child's cwd. This guard fails if (a) a hand-built fs/shell config
 * reappears anywhere in this package's production source, or (b) `core.ts`
 * reintroduces host-side `resolveNativeToolingMap` resolution (baking a root).
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
    // c9f0a791: the pinned-dep launch has ONE producer too (the resolver catalog).
    const pinned = /packageName:\s*['"]@modelcontextprotocol\/server-filesystem['"]/;
    expect(filesMatching(pinned)).toEqual([]);
  });

  it('does not construct the builtin shell command outside the resolver catalog', () => {
    const re = /command:\s*['"]uvx['"]/;
    expect(filesMatching(re)).toEqual([]);
  });

  it('does not resolve the native toolset into the stored map (the child resolves at task time)', () => {
    const core = readFileSync(resolve(SRC, 'lib', 'core.ts'), 'utf8');
    // The dispatch host must NOT bake a resolved fs/shell root into a stored
    // `mcpServers`: it stores the DECLARATIVE `nativeTooling` and lets the
    // spawned agent-mcp child resolve it at task time (ADR-0008 D4/D8).
    // NEGATIVE CONTROL: reintroducing `resolveNativeToolingMap` in core.ts
    // (the pre-rework host-side resolution) makes this red.
    expect(core).not.toContain('resolveNativeToolingMap');
    expect(core).toContain('nativeTooling');
  });
});
