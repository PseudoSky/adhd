import { describe, expect, it } from 'vitest';
import { NATIVE_TOOL_GUIDANCE, withNativeToolGuidance } from '../engine/native-tool-guidance.js';

const schema = { type: 'object', properties: {} } as const;

describe('R5-WEB-SIMPLE AC4 native tool guidance', () => {
  it('appends the shell constraints (curl, no interpreters) to shell__shell_execute', () => {
    const [t] = withNativeToolGuidance([{ name: 'shell__shell_execute', description: 'Run a command', inputSchema: schema }]);
    expect(t.description).toMatch(/^Run a command\n\n/);
    expect(t.description).toContain('curl -fsSL');
    expect(t.description).toMatch(/no sed/);
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
