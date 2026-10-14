import type { AttributeKind, AttributeValue } from '../../spec';

/**
 * True when `value` has the shape an attribute of `kind` requires:
 * `name` a string, `names`/`paths` a list of strings, `number` a finite number.
 */
export function valueMatchesKind(kind: AttributeKind, value: unknown): value is AttributeValue {
  switch (kind) {
    case 'name':
      return typeof value === 'string';
    case 'names':
    case 'paths':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return false;
  }
}
