import { describe, it, expect } from 'vitest';
import { mcpPlugin } from '../lib/plugin';

describe('mcp plugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof mcpPlugin.id).toBe('string');
    expect(mcpPlugin.id).toBe('mcp');
    expect(typeof mcpPlugin.generate).toBe('function');
  });

  it('has run() method', () => {
    expect(typeof mcpPlugin.run).toBe('function');
  });
});

describe('mcp plugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(mcpPlugin.language).toBe('ts');
  });
});
