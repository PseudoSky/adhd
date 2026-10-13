/**
 * Redaction of the consumer context before it is persisted.
 *
 * The default redactor drops values whose key looks like a credential,
 * strips secret-looking query parameters from URL strings, truncates long
 * strings and coerces the result to plain JSON. `responseBody` is never
 * persisted, whatever a custom redactor returns.
 */
import type { JsonValue, Redactor, TripContext } from './types.js';

/** Keys whose values are dropped (headers, cookies, tokens, passwords). */
export const REDACT_KEY_PATTERN =
  /authorization|cookie|set-cookie|token|secret|password|x-auth/i;

/** Query parameter names treated as secrets. */
export const SECRET_PARAM_PATTERN =
  /token|secret|passw|pwd|auth|api[-_]?key|^key$|sig|session|^sid$|^code$|credential|cookie|bearer|jwt/i;

/** Strings longer than this are truncated. */
export const MAX_STRING_CHARS = 2048;

/** Context keys that are never persisted (memory-only response data). */
export const NEVER_PERSISTED_KEYS: readonly string[] = [
  'responseBody',
  'responseStatus',
];

const MAX_DEPTH = 8;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

function truncate(s: string): string {
  if (s.length <= MAX_STRING_CHARS) return s;
  const dropped = s.length - MAX_STRING_CHARS;
  return `${s.slice(0, MAX_STRING_CHARS)}...[truncated ${dropped} chars]`;
}

/** Remove secret-looking query parameters from a URL string. */
export function stripSecretParams(value: string): string {
  if (!URL_RE.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const names = [...new Set([...url.searchParams.keys()])];
  const secret = names.filter((n) => SECRET_PARAM_PATTERN.test(n));
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  } else if (secret.length === 0) {
    return value;
  }
  for (const n of secret) url.searchParams.delete(n);
  return url.toString();
}

/** Origin and path of a URL (no query, no fragment), else undefined. */
export function urlWithoutQuery(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL_RE.test(value)) return undefined;
  try {
    const url = new URL(value);
    return truncate(`${url.origin}${url.pathname}`);
  } catch {
    return undefined;
  }
}

function clean(value: unknown, depth: number): JsonValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
  case 'string':
    return truncate(stripSecretParams(value));
  case 'number':
    return Number.isFinite(value) ? value : null;
  case 'boolean':
    return value;
  case 'object':
    break;
  default:
    return undefined;
  }
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) {
    return value.map((v) => {
      const c = clean(v, depth + 1);
      return c === undefined ? null : c;
    });
  }
  return cleanObject(value as Record<string, unknown>, depth + 1);
}

function cleanObject(
  obj: Record<string, unknown>,
  depth: number,
): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEY_PATTERN.test(k) || NEVER_PERSISTED_KEYS.includes(k)) {
      continue;
    }
    const c = clean(v, depth);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * The default redactor: drops values for keys matching
 * {@link REDACT_KEY_PATTERN} (at any depth), strips secret-looking URL
 * query parameters and URL credentials, truncates strings over
 * {@link MAX_STRING_CHARS} characters and drops non-JSON values.
 */
export function defaultRedactor(): Redactor {
  return (context) => cleanObject(context, 0);
}

/**
 * The redactor an instance applies: the default first, then `custom`,
 * then a final pass that removes {@link NEVER_PERSISTED_KEYS} and
 * non-JSON values a custom redactor may have introduced.
 */
export function composeRedactor(custom?: Redactor): Redactor {
  const base = defaultRedactor();
  return (context) => {
    const first = base(context);
    if (!custom) return first;
    const out = cleanObject(custom(first) as Record<string, unknown>, 0);
    return out as TripContext;
  };
}
