import { describe, it, expect } from 'vitest';
import { throwawayAdd } from './throwaway';

describe('throwawayAdd (pre-commit hook validation, deleted immediately after)', () => {
  it('adds two numbers', () => {
    expect(throwawayAdd(2, 3)).toBe(5);
  });
});
