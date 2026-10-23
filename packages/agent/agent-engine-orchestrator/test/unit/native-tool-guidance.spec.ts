/**
 * guards: the native-tool guidance appended to shell and fs tool descriptions drifts from the real allowlist (an unavailable command listed as available, or the default list not matching DEFAULT_SHELL_ALLOW_COMMANDS), touches other tools, or omits the write_file and create_directory constraints.
 * tier: S
 * cites: R5-WEB-SIMPLE AC4, R7-guidance AC2, R10 S4 P3/P4 (cited in the describe titles).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHELL_ALLOW_COMMANDS, resolveNativeToolingMap } from '@adhd/agent-core-native-tooling';
import {
  NATIVE_TOOL_GUIDANCE,
  nativeGuidanceContextOf,
  SHELL_UNAVAILABLE_COMMANDS,
  shellGuidance,
  shellRejectionNote,
  withNativeToolGuidance,
} from '../../src/engine/native-tool-guidance.js';

const schema = { type: 'object', properties: {} } as const;
/** The guidance context of the host's default agent: catalog fs + shell, exit shim active. */
const defaultCtx = nativeGuidanceContextOf(
  resolveNativeToolingMap({}, { cwd: '/w', exitShim: { dir: '/shim/abc', origPath: '/usr/bin' } })
);

describe('R5-WEB-SIMPLE AC4 native tool guidance', () => {
  it('appends the shell constraints (curl, no interpreters) to shell__shell_execute', () => {
    const [t] = withNativeToolGuidance(
      [{ name: 'shell__shell_execute', description: 'Run a command', inputSchema: schema }],
      defaultCtx
    );
    expect(t.description).toMatch(/^Run a command\n\n/);
    expect(t.description).toContain('curl -fsSL');
    expect(t.description).toMatch(/NOT available[^;]*sed/);
    expect(t.description).toContain('[exit status: N]');
  });

  it('tells the model write_file does not create parent directories and names the real create_directory tool', () => {
    const [t] = withNativeToolGuidance([{ name: 'fs__write_file', description: 'Write', inputSchema: schema }], defaultCtx);
    expect(t.description).toContain('NOT create missing parent directories');
    expect(t.description).toContain('fs__create_directory');
  });

  it('leaves every other tool untouched (negative control)', () => {
    const input = [{ name: 'fs__read_file', description: 'Read', inputSchema: schema }];
    expect(withNativeToolGuidance(input, defaultCtx)).toEqual(input);
    expect(Object.keys(NATIVE_TOOL_GUIDANCE).sort()).toEqual([
      'fs__edit_file',
      'fs__read_multiple_files',
      'fs__read_text_file',
      'fs__write_file',
      'shell__shell_execute',
    ]);
  });
});

describe('R7-guidance shell guidance', () => {
  const text = NATIVE_TOOL_GUIDANCE['shell__shell_execute'];
  const available = /Available commands: ([^.]*)\. /.exec(text)?.[1].split(' ') ?? [];
  const unavailable = /NOT available \(always rejected\): ([^;]*);/.exec(text)?.[1].split(', ') ?? [];

  it('R7-guidance AC2: the available list is exactly DEFAULT_SHELL_ALLOW_COMMANDS (drift test)', () => {
    expect(available).toEqual([...DEFAULT_SHELL_ALLOW_COMMANDS]);
    for (const c of DEFAULT_SHELL_ALLOW_COMMANDS) expect(available, c).toContain(c);
  });

  it('R7-guidance AC2: no unavailable command is listed as available, and node/python3/sed are named unavailable', () => {
    for (const c of SHELL_UNAVAILABLE_COMMANDS) {
      expect(available, c).not.toContain(c);
      expect(DEFAULT_SHELL_ALLOW_COMMANDS, c).not.toContain(c);
    }
    expect(unavailable).toEqual([...SHELL_UNAVAILABLE_COMMANDS]);
    for (const c of ['node', 'python3', 'sed']) expect(unavailable).toContain(c);
  });

  it('R7-guidance AC2: the drift test has teeth (a changed allowlist changes the text; a wrongly listed command is caught)', () => {
    const changed = shellGuidance([...DEFAULT_SHELL_ALLOW_COMMANDS, 'node']);
    const listed = /Available commands: ([^.]*)\. /.exec(changed)?.[1].split(' ') ?? [];
    expect(listed).toContain('node');
    expect(listed).not.toEqual([...DEFAULT_SHELL_ALLOW_COMMANDS]);
    expect(shellGuidance(DEFAULT_SHELL_ALLOW_COMMANDS.filter((c) => c !== 'curl'))).not.toContain(' curl ');
  });

  it('R7-guidance AC2: names the file tools to use for edits', () => {
    for (const n of ['fs__edit_file', 'fs__write_file', 'fs__create_directory']) expect(text).toContain(n);
  });

  it('R7-guidance AC1: curl returns raw HTML; title and heading recipes; missing element must be reported, not invented', () => {
    expect(text).toContain('RAW HTML');
    expect(text).toContain('"grep","-o","<title>[^<]*"');
    expect(text).toContain('"grep","-oE","<h[12][^>]*>[^<]*"');
    expect(text).toMatch(/is missing from the page, say it is missing and quote what the page does contain/);
    expect(text).toContain('never invent content');
  });

  it('R7-guidance AC3: write_file parent-directory guidance is kept', () => {
    expect(NATIVE_TOOL_GUIDANCE['fs__write_file']).toContain('NOT create missing parent directories');
    expect(NATIVE_TOOL_GUIDANCE['fs__write_file']).toContain('fs__create_directory');
  });
});

describe('R10 S4 P3/P4 guidance text', () => {
  const shell = NATIVE_TOOL_GUIDANCE['shell__shell_execute'];

  it('R10 S4 AC3: shell guidance leads with the argv sentence, then the NOT-available sentence naming the policy and the alternatives', () => {
    expect(shell.startsWith('Default shell: the command is an argv list, not a shell line;')).toBe(true);
    const argvAt = shell.indexOf('argv list');
    const notAt = shell.indexOf('NOT available (always rejected):');
    const availAt = shell.indexOf('Available commands:');
    expect(argvAt).toBeGreaterThanOrEqual(0);
    expect(notAt).toBeGreaterThan(argvAt);
    expect(availAt).toBeGreaterThan(notAt);
    expect(shell).toContain("default security policy");
    expect(shell).toMatch(/allowed runner \(npm, pnpm, npx, nx, make, uv\)/);
    // no repo-specific target is named
    expect(shell).not.toMatch(/make test|npm test|npm run/);
  });

  it('R10 W1 AC1: the shell guidance states, verbatim, that same-turn shell calls run one after another and how to overlap them', () => {
    const sentence =
      'Shell calls in one turn run one after another; to overlap independent long commands use one command that does it (e.g. `make -j2 test lint`) or a tasks_batch.';
    expect(shellGuidance()).toContain(sentence);
    expect(NATIVE_TOOL_GUIDANCE['shell__shell_execute']).toContain(sentence);
    // exactly once, whatever the allowlist (the sentence is not part of the generated command list)
    expect(shellGuidance(['cat', 'ls']).split(sentence).length - 1).toBe(1);
    expect(shellGuidance().split(sentence).length - 1).toBe(1);
  });

  it('R10 S4 AC3: a runner absent from the allowlist is never named (generated, not hand-typed)', () => {
    expect(shellGuidance(['cat', 'ls', 'curl'])).not.toMatch(/allowed runner/);
    expect(shellGuidance(['cat', 'npm'])).toContain('allowed runner (npm)');
  });

  it('R10 S4 AC3: the rejection recovery note names the policy, the command, the unavailable set and the alternatives', () => {
    const note = shellRejectionNote('python3', DEFAULT_SHELL_ALLOW_COMMANDS);
    expect(note).toContain('"python3" is rejected by the shell server\'s default security policy');
    for (const c of SHELL_UNAVAILABLE_COMMANDS) expect(note).toContain(c);
    expect(note).toContain('fs__edit_file');
    expect(note).toMatch(/allowed runner \(npm, pnpm, npx, nx, make, uv\)/);
    expect(note).not.toMatch(/make test|npm test|npm run|node -e/);
  });

  it('R10 S4 P3: write_file keeps the accurate parent-directory statement (no same-turn claim before ordering ships) and says no read-back is needed', () => {
    const w = NATIVE_TOOL_GUIDANCE['fs__write_file'];
    expect(w).toContain('Does NOT create missing parent directories: call `fs__create_directory`');
    expect(w).not.toMatch(/same turn|same reply|one turn/i);
    expect(w).toContain('needs no read-back');
  });

  it('R10 S4 P3: the edit and read tools carry the line-ending sentence, free of display claims', () => {
    for (const k of ['fs__edit_file', 'fs__read_text_file', 'fs__read_multiple_files']) {
      const t = NATIVE_TOOL_GUIDANCE[k];
      expect(t, k).toMatch(/CRLF and LF (files )?alike/);
      expect(t, k).toContain('`\\r`');
      expect(t, k).not.toMatch(/shown|displayed|visible/);
    }
    expect(NATIVE_TOOL_GUIDANCE['fs__edit_file']).toContain('needs no read-back');
  });
});
