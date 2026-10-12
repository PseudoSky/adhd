import { describe, expect, it } from 'vitest';
import { DEFAULT_SHELL_ALLOW_COMMANDS } from '@adhd/agent-core-native-tooling';
import {
  NATIVE_TOOL_GUIDANCE,
  SHELL_UNAVAILABLE_COMMANDS,
  shellGuidance,
  withNativeToolGuidance,
} from '../engine/native-tool-guidance.js';

const schema = { type: 'object', properties: {} } as const;

describe('R5-WEB-SIMPLE AC4 native tool guidance', () => {
  it('appends the shell constraints (curl, no interpreters) to shell__shell_execute', () => {
    const [t] = withNativeToolGuidance([{ name: 'shell__shell_execute', description: 'Run a command', inputSchema: schema }]);
    expect(t.description).toMatch(/^Run a command\n\n/);
    expect(t.description).toContain('curl -fsSL');
    expect(t.description).toMatch(/NOT available[^;]*sed/);
    expect(t.description).toContain('[exit status: N]');
  });

  it('tells the model write_file does not create parent directories and names the real create_directory tool', () => {
    const [t] = withNativeToolGuidance([{ name: 'fs__write_file', description: 'Write', inputSchema: schema }]);
    expect(t.description).toContain('NOT create missing parent directories');
    expect(t.description).toContain('fs__create_directory');
  });

  it('leaves every other tool untouched (negative control)', () => {
    const input = [{ name: 'fs__read_file', description: 'Read', inputSchema: schema }];
    expect(withNativeToolGuidance(input)).toEqual(input);
    expect(Object.keys(NATIVE_TOOL_GUIDANCE).sort()).toEqual(['fs__write_file', 'shell__shell_execute']);
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
