/**
 * default-mcp-producer.guard.test.ts — NAT-TOOL-4 "one producer" guard.
 *
 * The user-facing concern this encodes: "we're not creating duplicate
 * functionality slightly different functioning." Before NAT-TOOL-4 there were
 * TWO producers of the builtin fs/shell MCP servers:
 *
 *   1. `packages/agent/agent-core-native-tooling/src/lib/catalog.ts`
 *      (via `resolveNativeTooling`) — keys `fs`/`shell`, commands
 *      `npx …server-filesystem` / `uvx mcp-shell-server`.
 *   2. `entrypoint/agent-mcp/src/defaults.ts` (via `buildDefaultMcpServers`) —
 *      keys `filesystem`/`shell`, commands `npx …server-filesystem` /
 *      `node <retired homegrown shell>`.
 *
 * NAT-TOOL-4 deletes producer (2): `defaults.ts` authors NOTHING and consumes
 * the keyed projection `resolveNativeToolingMap`. These assertions FAIL if a
 * second producer reappears — by editing `defaults.ts` back to a hand-built map,
 * by adding a new fs/shell construction elsewhere, by reinstating the retired
 * shell resolver, or by restoring the retired homegrown server file.
 *
 * (This file is excluded from its own content scans — it necessarily names the
 * symbols it searches for. It is a TEST, never a producer.)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  resolveNativeToolingMap,
  FS_SERVER,
  SHELL_SERVER,
  DISPATCH_SERVER_KEY,
} from '@adhd/agent-core-native-tooling';
import type { McpServerConfig } from '@adhd/agent-engine-orchestrator';

import { buildDispatchSelf, withDefaultMcpServers } from '../defaults.js';

const SELF = fileURLToPath(import.meta.url);
const here = dirname(SELF);
const repoRoot = resolve(here, '..', '..', '..', '..');

/** The ONE file allowed to construct builtin fs/shell server configs. */
const CATALOG = resolve(
  repoRoot,
  'packages',
  'agent',
  'agent-core-native-tooling',
  'src',
  'lib',
  'catalog.ts'
);

const SOURCE_EXT = /\.(ts|mts|mjs|js|cjs)$/;
const TEST_PATH = /(^|\/)(__tests__|fixtures)(\/|$)|\.(spec|test)\.[cm]?ts$/;

/**
 * Production source files only (`.ts`/`.mjs`/`.js`), excluding tests + fixtures.
 * Tests legitimately pin expected values (and assert a retired symbol's absence),
 * so a `not.toContain("…")` assertion is not a "reference"; the invariant this
 * guard proves is about PRODUCERS, which live in production source.
 */
function productionFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = join(dir, entry);
      if (full === SELF) continue; // never scan this guard against itself
      const rel = relative(repoRoot, full);
      const st = statSync(full);
      if (st.isDirectory()) {
        visit(full);
      } else if (SOURCE_EXT.test(full) && !TEST_PATH.test(rel)) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

const SCAN_ROOTS = [
  resolve(repoRoot, 'entrypoint', 'agent-mcp', 'src'),
  resolve(repoRoot, 'packages', 'agent'),
];

const PROD = SCAN_ROOTS.flatMap(productionFiles);

const filesMatching = (files: string[], re: RegExp): string[] =>
  files
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f));

describe('NAT-TOOL-4 — exactly ONE producer of the builtin fs/shell servers', () => {
  it('AC1: the fs argv literal `-y @modelcontextprotocol/server-filesystem` exists ONLY in catalog.ts', () => {
    const re = /['"]-y['"]\s*,\s*['"]@modelcontextprotocol\/server-filesystem['"]/;
    expect(filesMatching(PROD, re)).toEqual([relative(repoRoot, CATALOG)]);
  });

  it('AC1: no production source constructs the builtin shell outside catalog.ts', () => {
    // The adopted shell command is `uvx mcp-shell-server`; its construction
    // (`command: 'uvx'`) must be catalog-only. (The bare server name also
    // appears in doc comments, so match the command literal, not the string.)
    const re = /command:\s*['"]uvx['"]/;
    expect(filesMatching(PROD, re)).toEqual([relative(repoRoot, CATALOG)]);
  });

  it('AC3: the retired shell resolver, env var, and homegrown server file are GONE', () => {
    // Built from fragments so this guard does not match its own literals.
    const retiredResolver = new RegExp('resolveShell' + 'ServerPath');
    const retiredEnv = new RegExp('ADHD_AGENT_SHELL_' + 'MCP_PATH');
    const retiredModule = new RegExp('mcp-shell' + '/' + 'server\\.mjs');
    expect(filesMatching(PROD, retiredResolver)).toEqual([]);
    expect(filesMatching(PROD, retiredEnv)).toEqual([]);
    expect(filesMatching(PROD, retiredModule)).toEqual([]);
    expect(existsSync(join(repoRoot, 'tools', 'mcp-shell', 'server.mjs'))).toBe(false);
  });

  it('AC2: the default map has EXACTLY the catalog keys fs/shell/agent-mcp', () => {
    const map = withDefaultMcpServers(
      { mcpServers: {} },
      { cwd: process.cwd(), dispatchSelf: buildDispatchSelf({}) }
    ).mcpServers;
    expect(Object.keys(map).sort()).toEqual(
      [DISPATCH_SERVER_KEY, FS_SERVER.key, SHELL_SERVER.key].sort()
    );
  });

  it('AC2: the resolved default map is byte-equal to resolveNativeToolingMap — not a hand-built map', () => {
    const ctx = { cwd: process.cwd(), dispatchSelf: buildDispatchSelf({}) };
    const expected = resolveNativeToolingMap({ fs: true, shell: true, dispatch: true }, ctx);
    expect(withDefaultMcpServers({ mcpServers: {} }, ctx).mcpServers).toEqual(expected);

    // Teeth: the fs/shell commands come from the catalog, not a literal here.
    type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
    const map = withDefaultMcpServers({ mcpServers: {} }, ctx).mcpServers;
    const fs = map[FS_SERVER.key] as Stdio;
    const shell = map[SHELL_SERVER.key] as Stdio;
    // srt-wrapped by default (ADR-0008 D7): the real command is still in argv.
    expect(fs.args).toContain(FS_SERVER.args[FS_SERVER.args.length - 1]);
    expect(shell.args).toContain(SHELL_SERVER.args[0]);
  });
});
