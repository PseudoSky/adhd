import { describe, it, expect } from 'vitest';
import { cliPlugin } from '../lib/plugin';

describe('cli plugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof cliPlugin.id).toBe('string');
    expect(cliPlugin.id).toBe('cli');
    expect(typeof cliPlugin.generate).toBe('function');
  });

  it('has no run() method (generate-only plugin)', () => {
    expect(cliPlugin.run).toBeUndefined();
  });
});
