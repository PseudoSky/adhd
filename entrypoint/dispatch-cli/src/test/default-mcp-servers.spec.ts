/**
 * default-mcp-servers.spec.ts — backlog daafe2d3 (backlog wiring) + the
 * cwd-relative-path review finding.
 *
 * `buildProductionAgentMcpRunner()` must create dispatch agents pre-wired with
 * the memory-server and backlog MCP servers, so a dispatched agent can recall
 * prior findings and read/write backlog items without a per-DAG opt-in.
 * `defaultDispatchMcpServers()` is that value; this asserts its wire shape, its
 * environment overrides, and — the review finding this file now guards — that
 * the default backlog entry is resolved to a REAL, ABSOLUTE path that does NOT
 * depend on `process.cwd()`.
 *
 * The pre-fix implementation resolved the backlog entry as
 * `join(process.cwd(), 'entrypoint', 'backlog', 'dist', 'index.js')`: correct
 * only when the caller runs from the monorepo root, broken for every out-of-repo
 * consumer. `resolveBacklogMcpEntry()` now resolves via the installed
 * `@adhd/backlog` package, then this checkout's own `entrypoint/` marker
 * (relative to `import.meta.url`) — never cwd.
 *
 * 1505199b closes the two residual gaps: (1) `@adhd/backlog` is now a DECLARED
 * dependency, so the installed-package branch is reachable out of the box (the
 * "resolves what it declares" test reds if it is removed); and (2) the DEFAULT
 * (no-override) entry's on-disk EXISTENCE is asserted, so a resolver that hands
 * the spawned server a path that 404s is caught. (2) couples this package's
 * `test` target to `backlog:build`; the CI cost is documented in project.json.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultDispatchMcpServers, resolveBacklogMcpEntry } from '../lib/core.js';

/** This worktree's repo root — 3 levels up from `entrypoint/dispatch-cli/src/test/`. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const REPO_BACKLOG_ENTRY = join(REPO_ROOT, 'entrypoint', 'backlog', 'dist', 'index.js');

const tmpDirs: string[] = [];
function mkTmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dispatch-cli-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveBacklogMcpEntry + defaultDispatchMcpServers (daafe2d3)', () => {
  it('wires memory-server (sse) + backlog (stdio serve) as the defaults', () => {
    const servers = defaultDispatchMcpServers({} as NodeJS.ProcessEnv);

    expect(Object.keys(servers).sort()).toEqual(['backlog', 'memory-server']);
    expect(servers['memory-server']).toEqual({
      transport: 'sse',
      url: 'http://localhost:3099/sse',
    });

    const backlog = servers['backlog'] as {
      transport: string;
      command: string;
      args: string[];
    };
    expect(backlog.transport).toBe('stdio');
    expect(backlog.command).toBe('node');
    expect(backlog.args.slice(1)).toEqual(['serve', '--transport', 'mcp']);
  });

  it('resolves the backlog entry to an ABSOLUTE, package-relative path — not a bare cwd guess', () => {
    const entry = resolveBacklogMcpEntry({} as NodeJS.ProcessEnv);

    // The core review fix: absolute (not a relative, cwd-dependent guess) and
    // pointing at THIS checkout's backlog entry, never `<cwd>/entrypoint/...`.
    // (On-disk existence of the default is asserted by the dedicated test below;
    // cwd-independence is the teeth for THIS review finding.)
    expect(entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)).toBe(true);
    expect(entry).toBe(REPO_BACKLOG_ENTRY);
  });

  it('declares @adhd/backlog as a runtime dependency, so the installed-package branch is reachable', () => {
    // Resolving FROM THIS PACKAGE's own directory must find @adhd/backlog: it is
    // declared in entrypoint/dispatch-cli/package.json and installed by pnpm.
    // Without the declaration this throws and resolveBacklogMcpEntry silently
    // degrades to the monorepo walk-up — which does NOT exist for a
    // published/installed dispatch-cli (the residual gap 1505199b). REDS if the
    // dependency is removed from package.json.
    const pkgRequire = createRequire(
      join(REPO_ROOT, 'entrypoint', 'dispatch-cli', 'package.json')
    );
    // Resolve the package MANIFEST (independent of backlog's build) — proves
    // @adhd/backlog is declared + installed for this package, which is what
    // makes `createRequire(entry).resolve('@adhd/backlog')` reachable at runtime.
    const manifest = pkgRequire.resolve('@adhd/backlog/package.json');
    expect(
      manifest.endsWith(join('entrypoint', 'backlog', 'package.json'))
    ).toBe(true);
  });

  it('resolves the DEFAULT backlog entry (no override) to a file that EXISTS — provably spawnable', () => {
    // The `backlog` mcpServers entry spawns `node <entry> serve --transport mcp`.
    // Asserting existence on the DEFAULT closes the original defect class: a
    // resolver that hands the child a path that 404s at spawn time. Requires
    // `backlog:build` (cache:false) — wired into this package's `test` dependsOn
    // in project.json; the CI cost of that coupling is documented there.
    const entry = resolveBacklogMcpEntry({} as NodeJS.ProcessEnv);
    expect(existsSync(entry)).toBe(true);
    // …and it is the BACKLOG entry, not some unrelated file that happens to exist.
    expect(entry.endsWith(join('entrypoint', 'backlog', 'dist', 'index.js'))).toBe(
      true
    );
  });

  it('resolves independent of process.cwd() — the exact defect being fixed', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(mkTmp('cwd-independent'));
      // The pre-fix `join(process.cwd(), 'entrypoint', …)` would have produced
      // `<tmpdir>/entrypoint/backlog/dist/index.js` here. The real resolver
      // must return the SAME checkout path regardless of the caller's cwd.
      expect(resolveBacklogMcpEntry({} as NodeJS.ProcessEnv)).toBe(REPO_BACKLOG_ENTRY);
      expect(defaultDispatchMcpServers({} as NodeJS.ProcessEnv)['backlog']).toEqual({
        transport: 'stdio',
        command: 'node',
        args: [REPO_BACKLOG_ENTRY, 'serve', '--transport', 'mcp'],
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('honours the environment overrides — and the override path is used verbatim', () => {
    const overrideDir = mkTmp('backlog-override');
    const overrideEntry = join(overrideDir, 'custom-backlog', 'index.js');
    mkdirSync(join(overrideDir, 'custom-backlog'), { recursive: true });
    writeFileSync(overrideEntry, '// fake backlog entry\n', 'utf8');

    const servers = defaultDispatchMcpServers({
      ADHD_DISPATCH_MEMORY_MCP_URL: 'http://memory.internal:4123/sse',
      ADHD_DISPATCH_BACKLOG_MCP_ENTRY: overrideEntry,
    } as NodeJS.ProcessEnv);

    expect(servers['memory-server']).toEqual({
      transport: 'sse',
      url: 'http://memory.internal:4123/sse',
    });
    expect((servers['backlog'] as { args: string[] }).args[0]).toBe(overrideEntry);
    // The override is a real, existing file — asserting it exists proves the
    // value flows through untouched and points somewhere spawnable.
    expect(existsSync(overrideEntry)).toBe(true);
  });
});
