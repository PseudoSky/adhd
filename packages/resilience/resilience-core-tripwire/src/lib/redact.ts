/**
 * Redaction of the consumer context before it is persisted.
 *
 * The default redactor drops values whose key looks like a credential,
 * strips secret-looking query parameters and the fragment from URL strings,
 * truncates long strings and coerces the result to plain JSON. `responseBody` is never
 * persisted, whatever a custom redactor returns.
 */
import type { JsonValue, Redactor, TripContext } from './types.js';

/**
 * Words that mark a name (a context key or a URL query parameter) as a
 * credential. A name is split into words at camelCase, digit and
 * punctuation boundaries (`accessToken`, `x-auth-token`, `api_key` ->
 * access/token, x/auth/token, api/key), so `design` or `signal` are not
 * mistaken for a `sig` secret the way a substring match would.
 */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'authorization', 'auth', 'oauth', 'cookie', 'cookies', 'token', 'tokens',
  'secret', 'secrets', 'password', 'passwd', 'passphrase', 'pwd', 'bearer',
  'jwt', 'credential', 'credentials', 'apikey',
]);

/** Words that are secrets only as the whole name of a URL query parameter (too common as context keys). */
const PARAM_SECRET_WORDS: ReadonlySet<string> = new Set([
  'key', 'sig', 'signature', 'sid', 'code',
]);

/** A trailing word that makes the name a measurement or label of a credential, not the credential (`tokenCount`). */
const NON_SECRET_SUFFIXES: ReadonlySet<string> = new Set([
  'count', 'counts', 'length', 'size', 'total', 'limit', 'max', 'min', 'ms',
  'bytes', 'type', 'ttl', 'name',
]);

function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

function hasSecretWord(words: readonly string[], param: boolean): boolean {
  const last = words[words.length - 1];
  if (words.length > 1 && last !== undefined && NON_SECRET_SUFFIXES.has(last)) {
    return false;
  }
  // A bare session handle (`session`, `sessionId`, `session_id`) is a credential; a qualified id such as
  // `browserSessionId` (a browser target) is not. In a URL parameter any session word is one.
  const first = words[0];
  if (first === 'session' && (words.length === 1 || (words.length === 2 && words[1] === 'id'))) return true;
  if (param && words.some((w) => w === 'session' || w.endsWith('sessionid') || w === 'phpsessid')) return true;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    if (SECRET_WORDS.has(w) || w === 'sessionid') return true;
    if (w === 'api' && words[i + 1] === 'key') return true;
    // `x-amz-signature`, `X-Goog-Sig`: a signature word is a secret in any position of a parameter name.
    if (param && (w === 'sig' || w === 'signature')) return true;
  }
  // `?key=`, `?sid=`, `?code=`: too common as words of a context key, secrets only as the whole parameter name.
  return param && words.length === 1 && PARAM_SECRET_WORDS.has(words[0] as string);
}

/** True when a context key names a credential (headers, cookies, tokens, passwords, sessions, API keys). */
export function isSecretKey(name: string): boolean {
  return hasSecretWord(wordsOf(name), false);
}

/** True when a URL query parameter name names a credential. */
export function isSecretParam(name: string): boolean {
  return hasSecretWord(wordsOf(name), true);
}

/** Assign an own enumerable property even for names such as `__proto__`, which a plain assignment would turn into a prototype change. */
export function setOwn<T>(target: { [k: string]: T }, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

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

/** Remove secret-looking query parameters (and secret-looking `name=value` pairs of the fragment) and URL credentials from a URL string. */
export function stripSecretParams(value: string): string {
  if (!URL_RE.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const names = [...new Set([...url.searchParams.keys()])];
  const secret = names.filter(isSecretParam);
  // A fragment that carries parameters (`#access_token=...`, an OAuth implicit-flow redirect) is read like a query.
  const frag = url.hash.startsWith('#') && url.hash.includes('=') ? new URLSearchParams(url.hash.slice(1)) : null;
  const secretFrag = frag ? [...new Set([...frag.keys()])].filter(isSecretParam) : [];
  const hadCredentials = Boolean(url.username || url.password);
  if (!hadCredentials && secret.length === 0 && secretFrag.length === 0) return value;
  url.username = '';
  url.password = '';
  for (const n of secret) url.searchParams.delete(n);
  if (frag && secretFrag.length > 0) {
    for (const n of secretFrag) frag.delete(n);
    const rest = frag.toString();
    url.hash = rest === '' ? '' : `#${rest}`;
  }
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
    if (isSecretKey(k) || NEVER_PERSISTED_KEYS.includes(k)) {
      continue;
    }
    const c = clean(v, depth);
    if (c !== undefined) setOwn(out, k, c);
  }
  return out;
}

/**
 * The default redactor: drops values for keys matching
 * {@link isSecretKey} (at any depth), strips secret-looking URL
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
