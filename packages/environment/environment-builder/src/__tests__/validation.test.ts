import { describe, expect, it } from 'vitest';
import { validateConfig, ValidationError } from '../validation';
import { generateFieldSchema } from '../json-schema-gen';

describe('validateConfig', () => {
  it('passes for a valid config', () => {
    const schema = generateFieldSchema({ 'server.port': { type: 'integer', minimum: 1024, maximum: 65535 } });
    expect(() => validateConfig({ server: { port: 3000 } }, schema)).not.toThrow();
  });

  it('throws on a minimum violation', () => {
    const schema = generateFieldSchema({ 'server.port': { type: 'integer', minimum: 1024 } });
    expect(() => validateConfig({ server: { port: 80 } }, schema)).toThrow(ValidationError);
  });

  it('throws on a maximum violation', () => {
    const schema = generateFieldSchema({ 'server.port': { type: 'integer', maximum: 65535 } });
    expect(() => validateConfig({ server: { port: 100000 } }, schema)).toThrow(ValidationError);
  });

  it('throws on an enum violation', () => {
    const schema = generateFieldSchema({ 'log.level': { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } });
    expect(() => validateConfig({ log: { level: 'verbose' } }, schema)).toThrow(ValidationError);
  });

  it('throws on a pattern violation', () => {
    const schema = generateFieldSchema({ 'log.level': { type: 'string', pattern: '^[a-z]+$' } });
    expect(() => validateConfig({ log: { level: 'INVALID123' } }, schema)).toThrow(ValidationError);
  });

  it('collects every field-level violation (allErrors), not just the first', () => {
    const schema = generateFieldSchema({
      'server.port': { type: 'integer', minimum: 1024 },
      'log.level': { type: 'string', enum: ['debug', 'info'] },
    });
    try {
      validateConfig({ server: { port: 1 }, log: { level: 'nope' } }, schema);
      expect.fail('expected validateConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.fieldErrors.length).toBeGreaterThanOrEqual(2);
      const fields = validationError.fieldErrors.map((e) => e.field);
      expect(fields).toContain('server.port');
      expect(fields).toContain('log.level');
    }
  });

  it('skips validation for a null schema', () => {
    expect(() => validateConfig({ anything: 'goes' }, null)).not.toThrow();
  });

  it('skips validation for an undefined schema', () => {
    expect(() => validateConfig({ anything: 'goes' }, undefined)).not.toThrow();
  });

  it('skips validation for an empty fieldSchema (no declared config fields)', () => {
    const schema = generateFieldSchema({});
    expect(() => validateConfig({}, schema)).not.toThrow();
  });

  it('does not error on a field missing from the resolved config (no "required" is ever generated — absence is a warning-level concern for callers, not a validation error)', () => {
    const schema = generateFieldSchema({ 'providers.openai.model': { type: 'string' } });
    expect(() => validateConfig({}, schema)).not.toThrow();
  });
});
