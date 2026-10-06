/**
 * native-tooling-real-ops.e2e.test.ts — ticket 33713d33.
 *
 * ── ENV-GATED (external third-party servers) — APPROVED ─────────────────────
 * Gate: NAT_TOOL_LIVE=1. The qualifying reason (AGENTS.md §7 — the ONLY one):
 * this test drives two REAL external third-party MCP servers and their
 * OS-enforcement wrapper, none of which CI can provide hermetically —
 *   - fs:    `npx -y @modelcontextprotocol/server-filesystem` (fetched from the
 *            npm registry at run time),
 *   - shell: `uvx mcp-shell-server` (tumf/mcp-shell-server, fetched from PyPI),
 *   - srt:   `@anthropic-ai/sandbox-runtime` (wraps BOTH).
 * Approved by: pseudosky (repo owner, skywinstonsk@gmail.com), 2026-10-05,
 * under the owner directive "Finish the project"; the same adoption is recorded
 * in `packages/agent/agent-core-native-tooling/README.md`, this package's
 * `README.md`, and the sibling gated test
 * (`native-tooling-adoption.e2e.test.ts`). This file carries its own copy of the
 * record in its header (the third required place). A MISSING local prerequisite
 * (no `uvx`/`npx`/`srt`, or a server that cannot spawn) FAILS LOUDLY — it never
 * skips silently.
 *
 * What it proves (REAL operations, asserted from the server's real tool results
 * and from bytes on disk — never shape):
 *
 *   T1 — fs single-root (caller cwd): through the srt-wrapped resolved fs
 *        server, `create_directory`, `write_file`, `read_text_file`,
 *        `edit_file`, and `search_files` (glob) all run; the on-disk bytes and
 *        the glob result are asserted.
 *   T2 — fs MULTI-ROOT `fs:{roots:['a','b']}` with a caller `cwd`: a file under
 *        EACH root reads back (`a` and `b`); a path under the caller cwd but
 *        OUTSIDE both roots is DENIED by the server's root scoping.
 *   T3 — shell: an exact allowlisted command (`ALLOW_COMMANDS`) AND a
 *        pattern-matched command (`ALLOW_PATTERNS`) each EXECUTE with their real
 *        stdout; a command matching neither is DENIED.
 *
 * Run: `NAT_TOOL_LIVE=1 npx vitest run --config vite.config.ts \
 *         src/__tests__/integration/native-tooling-real-ops.e2e.test.ts`
 * ────────────────────────────────────────────────────────────────────────────
 */
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveNativeTooling } from '@adhd/agent-core-native-tooling';
import { StdioMcpClient } from '@adhd/agent-engine-orchestrator';
import type { McpServerConfig } from '@adhd/agent-engine-orchestrator';
import type { NativeToolingConfig } from '@adhd/agent-base-types';

import { ensureBinDirOnPath, provisionSrtPolicy } from '../../srt-policy.js';

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;

/** Gate: the real adopted servers are fetched from npm/PyPI at run time (external). */
const isLive = process.env['NAT_TOOL_LIVE'] === '1';

/** Repo root — `entrypoint/agent-mcp/src/__tests__/integration/` → five levels up. */
const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const BIN_DIR = join(REPO_ROOT, 'node_modules', '.bin');

/** Concatenate the text payloads of an MCP `content` array (or stringify). */
function textOf(result: unknown): string {
  if (Array.isArray(result)) {
    return result
      .map((b) =>
        b && typeof b === 'object' && 'text' in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b)
      )
      .join('\n');
  }
  return JSON.stringify(result);
}

describe.skipIf(!isLive)(
  'native tooling real operations — resolved fs + shell servers via real MCP (NAT_TOOL_LIVE=1 only)',
  () => {
    let root = '';
    let home = '';
    let srtSettings = '';
    let originalPath = '';

    beforeAll(async () => {
      const scratchRoot = join(REPO_ROOT, 'tmp', 'agent-mcp');
      await mkdir(scratchRoot, { recursive: true });
      root = await mkdtemp(join(scratchRoot, 'real-ops-'));
      home = join(root, 'home');
      await mkdir(home, { recursive: true });
      // A hermetic srt policy: the wrapped servers may write their caches + the
      // scratch cwd; the network allow-list (npm registry + PyPI) is seeded by
      // `provisionSrtPolicy`'s defaults.
      srtSettings = join(root, 'srt-settings.json');
      provisionSrtPolicy({ settingsPath: srtSettings, allowWrite: [home, root] });
      // The host owns PATH: `srt` is a LOCAL dependency bin, not globally
      // installed, so make it resolvable for the spawned child (and its npx/uvx).
      originalPath = process.env['PATH'] ?? '';
      process.env['PATH'] = ensureBinDirOnPath(originalPath, BIN_DIR) ?? originalPath;
    });

    afterAll(async () => {
      if (originalPath) process.env['PATH'] = originalPath;
      if (root) await rm(root, { recursive: true, force: true });
    });

    /** Resolve through the REAL resolver, srt-wrapped, rooted at `cwd`. */
    function resolve(cfg: NativeToolingConfig, cwd: string): Stdio[] {
      return resolveNativeTooling(cfg, {
        cwd,
        env: { HOME: home, PATH: process.env['PATH'] ?? '' },
        srtSettingsPath: srtSettings,
      }).filter((s): s is Stdio => s.transport === 'stdio');
    }

    it('T1: fs single-root executes create/write/read/edit/glob with real bytes on disk', async () => {
      const cwd = join(root, 't1');
      await mkdir(cwd, { recursive: true });
      const servers = resolve({ fs: true, shell: false, dispatch: false }, cwd);
      expect(servers).toHaveLength(1);
      const fs = servers[0];
      // ADR-0008 D7: the builtin fs server is srt-wrapped and rooted at the cwd.
      expect(fs?.command).toBe('srt');
      expect(fs?.args).toEqual([
        '-s',
        srtSettings,
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        cwd,
      ]);

      const client = new StdioMcpClient('fs', fs);
      await client.connect();
      try {
        const tools = (await client.listTools()).map((t) => t.name);
        for (const required of [
          'create_directory',
          'write_file',
          'read_text_file',
          'edit_file',
          'search_files',
          'list_allowed_directories',
        ]) {
          expect(tools, `fs server tool surface must include ${required}`).toContain(required);
        }

        const token = `P1-FS-TOKEN-${Date.now()}`;
        const dir = join(cwd, 'sub');
        const file = join(dir, 'note.txt');

        await client.callTool('create_directory', { path: dir });
        await client.callTool('write_file', { path: file, content: `hello ${token}\n` });
        // REAL outcome: the bytes are on disk.
        expect(await readFile(file, 'utf8')).toBe(`hello ${token}\n`);

        const readBack = textOf(await client.callTool('read_text_file', { path: file }));
        expect(readBack).toContain(token);
        expect(readBack).toContain('hello');

        const edited = textOf(
          await client.callTool('edit_file', {
            path: file,
            edits: [{ oldText: 'hello', newText: 'HELLO' }],
          })
        );
        expect(edited).toMatch(/HELLO/);
        expect(await readFile(file, 'utf8')).toBe(`HELLO ${token}\n`);

        const globbed = textOf(
          await client.callTool('search_files', { path: cwd, pattern: '**/note.txt' })
        );
        expect(globbed).toContain('note.txt');

        const allowed = textOf(await client.callTool('list_allowed_directories', {}));
        expect(allowed).toContain(cwd);
      } finally {
        await client.close();
      }
    }, 180_000);

    it('T2: fs multi-root — a file under EACH root reads; a path outside both is DENIED', async () => {
      const cwd = join(root, 't2');
      const a = join(cwd, 'a');
      const b = join(cwd, 'b');
      const outside = join(cwd, 'outside');
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await mkdir(outside, { recursive: true });
      const tokenA = `P1-ROOT-A-${Date.now()}`;
      const tokenB = `P1-ROOT-B-${Date.now()}`;
      const tokenOut = `P1-ROOT-OUT-${Date.now()}`;
      writeFileSync(join(a, 'f.txt'), `${tokenA}\n`, 'utf8');
      writeFileSync(join(b, 'f.txt'), `${tokenB}\n`, 'utf8');
      writeFileSync(join(outside, 'f.txt'), `${tokenOut}\n`, 'utf8');

      const servers = resolve({ fs: { roots: ['a', 'b'] }, shell: false, dispatch: false }, cwd);
      expect(servers).toHaveLength(1);
      const fs = servers[0];
      // BOTH resolved roots are one argv entry each (multi-root), after the module name.
      expect(fs?.args).toEqual([
        '-s',
        srtSettings,
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        a,
        b,
      ]);

      const client = new StdioMcpClient('fs', fs);
      await client.connect();
      try {
        const allowed = textOf(await client.callTool('list_allowed_directories', {}));
        expect(allowed).toContain(a);
        expect(allowed).toContain(b);
        expect(allowed).not.toContain(outside);

        // A file under EACH root reads back.
        expect(textOf(await client.callTool('read_text_file', { path: join(a, 'f.txt') }))).toContain(
          tokenA
        );
        expect(textOf(await client.callTool('read_text_file', { path: join(b, 'f.txt') }))).toContain(
          tokenB
        );

        // A path under the caller cwd but OUTSIDE both roots is DENIED by the
        // server's own root scoping (the srt policy allows the cwd read at the OS
        // layer, so this denial is unambiguously the fs server's).
        await expect(
          client.callTool('read_text_file', { path: join(outside, 'f.txt') })
        ).rejects.toThrow(/outside|not allowed|allowed directories|denied/i);
        // And the outside bytes were never leaked back.
        await expect(
          client.callTool('read_text_file', { path: join(outside, 'f.txt') })
        ).rejects.not.toThrow(tokenOut);
      } finally {
        await client.close();
      }
    }, 180_000);

    it('T3: shell runs an exact-allowlisted AND a pattern-matched command; a non-matching command is DENIED', async () => {
      const cwd = join(root, 't3');
      await mkdir(cwd, { recursive: true });
      const servers = resolve(
        { fs: false, shell: { allowCommands: ['echo'], allowPatterns: ['pw.*'] }, dispatch: false },
        cwd
      );
      expect(servers).toHaveLength(1);
      const shell = servers[0];
      expect(shell?.command).toBe('srt');
      expect(shell?.args).toEqual(['-s', srtSettings, 'uvx', 'mcp-shell-server']);
      // D5/D7: the allow-lists are a passthrough of the adopted server's env.
      expect(shell?.env?.['ALLOW_COMMANDS']).toBe('echo');
      expect(shell?.env?.['ALLOW_PATTERNS']).toBe('pw.*');

      const client = new StdioMcpClient('shell', shell);
      await client.connect();
      try {
        const tools = (await client.listTools()).map((t) => t.name);
        expect(tools).toContain('shell_execute');

        const token = `P1-SHELL-TOKEN-${Date.now()}`;
        // EXACT allow-list (ALLOW_COMMANDS) — real stdout asserted.
        const exact = textOf(
          await client.callTool('shell_execute', { command: ['echo', token] })
        );
        expect(exact).toContain(token);

        // PATTERN allow-list (ALLOW_PATTERNS, re.fullmatch over the NAME) — `pwd` matches `pw.*`.
        const patterned = textOf(await client.callTool('shell_execute', { command: ['pwd'] }));
        expect(patterned).toContain(cwd);

        // A NAME matching neither is DENIED by the real server.
        await expect(
          client.callTool('shell_execute', { command: ['frobnicate', '--x'] })
        ).rejects.toThrow(/not allowed|rejected/i);
      } finally {
        await client.close();
      }
    }, 180_000);

    it('preconditions are present (fails loudly, never a silent skip)', () => {
      // Reached only when NAT_TOOL_LIVE=1; assert the real prerequisites exist so
      // a missing tool surfaces as a red test rather than a skipped one.
      const srt = join(BIN_DIR, 'srt');
      expect(existsSync(srt), `srt must be installed at ${srt}`).toBe(true);
      expect(
        (process.env['PATH'] ?? '').split(delimiter).includes(BIN_DIR),
        'the node_modules/.bin dir (srt) must be on PATH'
      ).toBe(true);
    });
  }
);
