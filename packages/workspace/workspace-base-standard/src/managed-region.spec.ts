import { describe, expect, it } from 'vitest';
import { applyManagedRegion, hasManagedRegion } from './managed-region';

describe('managed-region', () => {
  it('inserts the region when absent', () => {
    const original = '# My Doc\n\nSome hand-written intro.\n';
    const result = applyManagedRegion(original, 'section-a', 'first body');

    expect(hasManagedRegion(result, 'section-a')).toBe(true);
    expect(result).toContain('<!-- @workspace:managed:start id="section-a" -->');
    expect(result).toContain('first body');
    expect(result).toContain('<!-- @workspace:managed:end id="section-a" -->');
    // Original content is preserved verbatim.
    expect(result.startsWith(original)).toBe(true);
  });

  it('re-applying twice replaces ONLY the marked region — hand-edited content outside it survives byte-for-byte', () => {
    const original = '# My Doc\n\nHand-written intro paragraph that must survive.\n';

    const afterFirst = applyManagedRegion(original, 'section-a', 'version 1 body');
    // Simulate a human hand-editing content AFTER the managed region between
    // the two applications.
    const handEdited = `${afterFirst}\n\nA hand-added paragraph appended after the first stamp.\n`;

    const afterSecond = applyManagedRegion(handEdited, 'section-a', 'version 2 body — completely different');

    // The new body replaced the old one.
    expect(afterSecond).toContain('version 2 body — completely different');
    expect(afterSecond).not.toContain('version 1 body');

    // Everything outside the marker span survives byte-for-byte: the
    // original intro AND the hand-added paragraph appended between
    // applications.
    expect(afterSecond).toContain('Hand-written intro paragraph that must survive.');
    expect(afterSecond).toContain('A hand-added paragraph appended after the first stamp.');

    // Exactly one region (no duplicate marker pairs).
    const startCount = (afterSecond.match(/@workspace:managed:start id="section-a"/g) ?? []).length;
    const endCount = (afterSecond.match(/@workspace:managed:end id="section-a"/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);

    // Negative-control-style precision check: strip the managed region out
    // of both `handEdited` (before 2nd apply) and `afterSecond` (after) and
    // assert the surrounding text is byte-for-byte identical.
    const stripRegion = (s: string) =>
      s.replace(/<!-- @workspace:managed:start id="section-a" -->[\s\S]*?<!-- @workspace:managed:end id="section-a" -->/, '<REGION>');
    expect(stripRegion(afterSecond)).toBe(stripRegion(handEdited));
  });

  it('hasManagedRegion returns false when the marker id is absent', () => {
    expect(hasManagedRegion('# Doc\n\nplain text\n', 'nope')).toBe(false);
  });

  it('hasManagedRegion distinguishes marker ids', () => {
    const content = applyManagedRegion('', 'id-one', 'body one');
    expect(hasManagedRegion(content, 'id-one')).toBe(true);
    expect(hasManagedRegion(content, 'id-two')).toBe(false);
  });
});
