/**
 * default-mcp-producer.guard.test.ts — NAT-TOOL-4 "one producer" guard.
 *
 * The user-facing concern this encodes: "we're not creating duplicate
 * functionality slightly different functioning." Before NAT-TOOL-4 there were
 * TWO producers of the builtin fs/shell MCP servers:
 *
 *   1. `packages/agent/agent-core-native-tooling/src/lib/catalog.ts`
 *      (via `resolveNativeTooling`) — keys `fs`/`shell`, commands
 *      `node <pinned server-filesystem bin>` / pinned `uvx mcp-shell-server==1.1.12`.
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
  resolveFsServerLaunch,
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
// Test + fixture scaffolding is excluded: `__tests__`/`fixtures` dirs, the
// `test/` dir convention (dispatch-cli), and `*.spec.*`/`*.test.*` files. Tests
// legitimately pin expected values (including launcher argv).
const TEST_PATH =
  /(^|\/)(__tests__|test|fixtures)(\/|$)|\.(spec|test)\.[cm]?ts$/;

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
  // A2: dispatch-cli historically authored a SECOND agent-mcp self config
  // (`buildDispatchSelfServer`/`resolveAgentMcpLaunch`). Scanning its source is
  // what makes a reappearing third producer go RED.
  resolve(repoRoot, 'entrypoint', 'dispatch-cli', 'src'),
];

/** The ONE production file allowed to own the agent-mcp self launch config. */
const DISPATCH_SELF = resolve(
  repoRoot,
  'packages',
  'agent',
  'agent-core-native-tooling',
  'src',
  'lib',
  'dispatch-self.ts'
);

const PROD = SCAN_ROOTS.flatMap(productionFiles);

const filesMatching = (files: string[], re: RegExp): string[] =>
  files
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f));

describe('NAT-TOOL-4 — exactly ONE producer of the builtin fs/shell servers', () => {
  it('AC1: the fs package literal is constructed ONLY in catalog.ts, and no production source launches it via `npx -y` (c9f0a791)', () => {
    const pinned = /packageName:\s*['"]@modelcontextprotocol\/server-filesystem['"]/;
    expect(filesMatching(PROD, pinned)).toEqual([relative(repoRoot, CATALOG)]);
    const npxForm = /['"]-y['"]\s*,\s*['"]@modelcontextprotocol\/server-filesystem['"]/;
    expect(filesMatching(PROD, npxForm)).toEqual([]);
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

  it('A2: the agent-mcp self launch config has exactly ONE producer (default argv + buildDispatchSelf)', () => {
    // The canonical default argv `['-y', '@adhd/agent-mcp@latest']` lives ONLY in
    // the shared producer. If a second host re-authors it (e.g. dispatch-cli
    // hard-codes `['-y', '@adhd/agent-mcp@latest']` again) this goes RED.
    const canonicalArgv = /['"]-y['"]\s*,\s*['"]@adhd\/agent-mcp@latest['"]/;
    expect(filesMatching(PROD, canonicalArgv)).toEqual([
      relative(repoRoot, DISPATCH_SELF),
    ]);

    // The OLD divergent argv (`@adhd/agent-mcp` with no `@latest`) must not
    // exist in production source at all — its presence means a producer
    // re-appeared with a different default than the canonical one.
    const divergentArgv = /['"]-y['"]\s*,\s*['"]@adhd\/agent-mcp['"]/;
    expect(filesMatching(PROD, divergentArgv)).toEqual([]);

    // The producer FUNCTION is defined in exactly one production file.
    const producerDef = /export function buildDispatchSelf\s*\(/;
    expect(filesMatching(PROD, producerDef)).toEqual([
      relative(repoRoot, DISPATCH_SELF),
    ]);

    // The new scan root is genuinely wired: dispatch-cli source is in scope, so
    // a third producer there would be caught (not silently ignored).
    expect(
      PROD.some((f) =>
        relative(repoRoot, f).startsWith('entrypoint/dispatch-cli/src/')
      )
    ).toBe(true);
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
    expect(fs.args).toContain(resolveFsServerLaunch().args[0]);
    expect(shell.args).toContain(SHELL_SERVER.args[1]);
  });
});
