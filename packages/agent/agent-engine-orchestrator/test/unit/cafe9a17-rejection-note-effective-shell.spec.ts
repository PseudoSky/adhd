/**
 * cafe9a17 AC1 (residual): the shell policy-rejection note names only runners the EFFECTIVE shell server allows.
 *
 * The map is built by the REAL resolver (`resolveNativeToolingMap`, the producer the host mounts), and the note
 * is the exact text the host appends to the model's view of a rejected command. The per-adapter proof that the
 * note reaches (anthropic, openai-compatible) or does not reach (claudecli) the model lives in agent-mcp
 * (`cafe9a17-rejection-note-adapters.test.ts`), which owns the host tool-result path.
 *
 * guards: the shell policy-rejection note names a runner the effective shell server does not allow (the default list after an override or a modification), or names runners when the effective config cannot be determined.
 * tier: S
 * cites: cafe9a17 AC1 residual (cited in the describe title).
 */
import { resolveNativeToolingMap, DEFAULT_SHELL_ALLOW_COMMANDS } from '@adhd/agent-core-native-tooling';
import type { McpServerConfig, NativeToolingConfig } from '@adhd/agent-base-types';
import { describe, expect, it } from 'vitest';

import { shellRejectionNote } from '../../src/engine/native-tool-guidance.js';

const resolved = (cfg: NativeToolingConfig): Record<string, McpServerConfig> =>
  resolveNativeToolingMap({ fs: true, ...cfg, dispatch: false }, { cwd: '/w', sandbox: false });

/** The runner list a note names, or `null` when it names none. */
const runnersIn = (note: string): string[] | null => {
  const m = /allowed runner \(([^)]*)\)/.exec(note);
  return m ? m[1].split(', ') : null;
};

describe('cafe9a17 AC1: shellRejectionNote derives its runners from the effective shell server', () => {
  it('names every default runner for the default catalog shell', () => {
    expect(runnersIn(shellRejectionNote('node', resolved({})))).toEqual(['npm', 'pnpm', 'npx', 'nx', 'make', 'uv']);
  });

  it('an overridden allowlist names only the runners it contains, never the defaults', () => {
    expect(runnersIn(shellRejectionNote('node', resolved({ shell: { allowCommands: ['cat', 'make'] } })))).toEqual(['make']);
    const none = shellRejectionNote('node', resolved({ shell: { allowCommands: ['cat', 'ls'] } }));
    expect(none).not.toMatch(/runner/);
    for (const r of ['npm', 'pnpm', 'npx', 'nx', 'make', 'uv']) expect(none).not.toContain(r);
  });

  it('a modified allowlist (default minus one runner, plus an extra) names exactly the remaining runners', () => {
    const allow = [...DEFAULT_SHELL_ALLOW_COMMANDS.filter((c) => c !== 'uv'), 'ls'];
    expect(runnersIn(shellRejectionNote('node', resolved({ shell: { allowCommands: allow } })))).toEqual(['npm', 'pnpm', 'npx', 'nx', 'make']);
  });

  it('fails closed: no runner is named when the effective config cannot be determined', () => {
    const custom = { transport: 'stdio', command: 'my-shell', args: ['--serve'], env: { ALLOW_COMMANDS: 'npm,make' } } as McpServerConfig;
    const http = { transport: 'http', url: 'http://x' } as McpServerConfig;
    const cases: Array<[string, Parameters<typeof shellRejectionNote>[1]]> = [
      ['no second argument', undefined],
      ['an empty map', {}],
      ['no shell server', { fs: resolved({})['fs'] }],
      ['a custom shell server that happens to set ALLOW_COMMANDS', { shell: custom }],
      ['an http shell server', { shell: http }],
      ['an empty allowlist array', []],
      ['a catalog shell with an empty allowlist', resolved({ shell: { allowCommands: [] } })],
      ['a catalog shell allowed by pattern only', resolved({ shell: { allowCommands: [], allowPatterns: ['np.*'] } })],
    ];
    for (const [label, effective] of cases) expect(runnersIn(shellRejectionNote('node', effective)), label).toBeNull();
  });

  it('an explicit allowlist array is honoured as given', () => {
    expect(runnersIn(shellRejectionNote('sed', ['npm', 'cat']))).toEqual(['npm']);
  });

  it('keeps the policy statement, the rejected command and the fs alternatives in every case', () => {
    for (const effective of [undefined, resolved({}), resolved({ shell: { allowCommands: ['cat'] } })]) {
      const note = shellRejectionNote('python3', effective);
      expect(note).toContain('"python3" is rejected by the shell server\'s default security policy');
      expect(note).toContain('fs__edit_file');
    }
  });
});
