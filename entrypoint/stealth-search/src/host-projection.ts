/**
 * @adhd/stealth-search: src/host-projection.ts
 *
 * The one projection both hosts share. `redactCookieValues` is the single redaction site of the
 * `getPageContext` verb: a page description may carry cookie names and counts, never cookie
 * values. The verb calls it on every result, so neither the CLI nor the MCP host can leak a
 * value, whatever the core returns.
 *
 * The launch allowlist of the other projection concern is inherited, not re-implemented: the
 * core's `LaunchChromeInput` is `{port, userDataDir}` only, so no host can pass a binary path or
 * extra process arguments.
 *
 * Inventory rows: I-16 (verb projection over the core chrome verbs).
 * Ticket 8468f7b1 · plan state search-verbs · [search-verbs.3]
 */

/** The property that carries a cookie's value; the one property redaction removes. */
const VALUE_KEY = 'value'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A cookie-shaped object: a string `name` next to a `value`. */
function isCookie(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && typeof v['name'] === 'string' && VALUE_KEY in v
}

/** Copy `node`, removing the `value` of every cookie-shaped object at any depth: the root, an array element, a property of any key. */
function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk)
  if (!isRecord(node)) return node
  const strip = isCookie(node)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (strip && k === VALUE_KEY) continue
    out[k] = walk(v)
  }
  return out
}

/**
 * A copy of `value` with every cookie value removed. Cookie names, hosts, every other attribute
 * and every count (`cookieCount`, the length of a `cookies` array) are kept. A cookie is an
 * object with a string `name` and a `value`; one found anywhere (the root, an array element under any key,
 * a nested property) loses its `value`. The input is never modified.
 */
export function redactCookieValues<T>(value: T): T {
  return walk(value) as T
}
