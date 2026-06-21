import { describe, it, expect } from 'vitest';
import { jsonschemaPlugin } from '../lib/plugin';

describe('jsonschema plugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof jsonschemaPlugin.id).toBe('string');
    expect(jsonschemaPlugin.id).toBe('jsonschema');
    expect(typeof jsonschemaPlugin.generate).toBe('function');
  });

  it('has no run() method (generate-only plugin)', () => {
    expect(jsonschemaPlugin.run).toBeUndefined();
  });
});
