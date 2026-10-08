/**
 * Listen-host policy shared by every apigen TypeScript host (fastify, express,
 * mcp). Defaults to IPv4 loopback; binding anything else is a deliberate
 * override (`--opt host=…` / `options.host`) and logs a warning. Node's
 * `listen(port)` with no host — or with an empty string — binds ALL
 * interfaces, so the empty/whitespace case is treated as unset.
 *
 * Pure (no sockets), so the default is unit-testable without binding a port.
 */

/** Default listen address for every apigen host: IPv4 loopback. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** True for `localhost`, `127.0.0.0/8`, `::1` and IPv4-mapped loopback. */
export function isLoopbackListenHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}

/**
 * Resolve the effective listen host from the plugin `host` option. Non-string,
 * empty and whitespace-only values fall back to {@link DEFAULT_LISTEN_HOST}.
 */
export function resolveListenHost(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_LISTEN_HOST;
  const trimmed = raw.trim();
  return trimmed === '' ? DEFAULT_LISTEN_HOST : trimmed;
}

/**
 * Emit a warning when `host` is not loopback (unauthenticated-by-default
 * hosts become network-reachable). Returns whether it warned.
 */
export function warnIfNonLoopbackListen(
  host: string,
  label: string,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): boolean {
  if (isLoopbackListenHost(host)) return false;
  logger?.warn(
    { host, host_kind: label },
    `${label} binding non-loopback host "${host}": the server will be reachable from the network. Omit the host option to bind ${DEFAULT_LISTEN_HOST}.`
  );
  return true;
}
