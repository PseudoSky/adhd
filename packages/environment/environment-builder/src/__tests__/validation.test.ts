import { describe, expect, it } from 'vitest';
import { generateFieldSchema } from '@adhd/environment-base-spec';

import { ValidationError, validateConfig } from '../validation';

describe('validateConfig', () => {
  it('passes silently for a config that satisfies the schema', () => {
    const schema = generateFieldSchema({ 'server.port': { type: 'integer', minimum: 1, maximum: 65535 } });
    expect(() => validateConfig({ server: { port: 4000 } }, schema)).not.toThrow();
  });

  it('throws ValidationError aggregating every field violation, not just the first', () => {
    const schema = generateFieldSchema({
      'server.port': { type: 'integer', minimum: 1024 },
      'logging.level': { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
    });
    let caught: ValidationError | undefined;
    try {
      validateConfig({ server: { port: 1 }, logging: { level: 'verbose' } }, schema);
    } catch (err) {
      caught = err as ValidationError;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught?.fieldErrors.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a null/undefined schema as "nothing to validate"', () => {
    expect(() => validateConfig({ anything: 'goes' }, null)).not.toThrow();
    expect(() => validateConfig({ anything: 'goes' }, undefined)).not.toThrow();
  });

  it('treats an empty-properties schema as trivially valid (zero declared fields)', () => {
    const schema = generateFieldSchema({});
    expect(() => validateConfig({}, schema)).not.toThrow();
  });
});
