import { describe, it, expect } from 'vitest';
import { apiExpressPlugin } from '../lib/plugin';

describe('api-express plugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof apiExpressPlugin.id).toBe('string');
    expect(apiExpressPlugin.id).toBe('api-express');
    expect(typeof apiExpressPlugin.generate).toBe('function');
  });

  it('has run() method', () => {
    expect(typeof apiExpressPlugin.run).toBe('function');
  });
});
