import { describe, it, expect } from 'vitest';
import { apiFastifyPlugin } from '../lib/plugin';

describe('api-fastify plugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof apiFastifyPlugin.id).toBe('string');
    expect(apiFastifyPlugin.id).toBe('api-fastify');
    expect(typeof apiFastifyPlugin.generate).toBe('function');
  });

  it('has run() method', () => {
    expect(typeof apiFastifyPlugin.run).toBe('function');
  });
});
