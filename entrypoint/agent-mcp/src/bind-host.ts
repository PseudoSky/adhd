/**
 * Bind-host policy for every listening socket agent-mcp opens (host-default-localhost).
 *
 * The MCP / SSE / OpenAI-gateway surface is unauthenticated, so the default
 * bind is loopback and binding anything else must be a deliberate, visible
 * operator choice. Node's `listen(port)` with no host (or an empty host) binds
 * ALL interfaces, so every `listen` in this package must go through
 * {@link resolveBindHost}.
 *
 * `127.0.0.1` (not `localhost`/`::1`) is the default: it is a single concrete
 * IPv4 address (no DNS-order ambiguity between ::1 and 127.0.0.1) and matches
 * the URLs the repo advertises (`http://127.0.0.1:<port>/`).
 */

/** The default bind address: IPv4 loopback. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Minimal logger surface needed for the non-loopback warning. */
export interface IBindWarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * True when `host` only accepts local connections: `localhost`, any `127.0.0.0/8`
 * address, `::1`, or an IPv4-mapped loopback (`::ffff:127.x.y.z`). Wildcards
 * (`0.0.0.0`, `::`) and any LAN/public address are NOT loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}

/**
 * Resolve the effective bind host from a configured value. Empty / whitespace /
 * undefined fall back to {@link DEFAULT_BIND_HOST} (an empty string would
 * otherwise make Node bind every interface). Logs a warning when the result is
 * not loopback.
 *
 * @param configured the value from the config cascade (`transport.host` / `sse.host`)
 * @param label which listener this is (for the log line)
 * @param logger receives the non-loopback warning
 */
export function resolveBindHost(
  configured: string | undefined,
  label: string,
  logger?: IBindWarnLogger
): string {
  const trimmed = configured?.trim();
  const host = trimmed ? trimmed : DEFAULT_BIND_HOST;
  if (!isLoopbackHost(host)) {
    logger?.warn(
      { host, listener: label },
      `${label} binding non-loopback host "${host}": this server is unauthenticated and will be reachable from the network. Unset the host override (ADHD_AGENT_HOST / ADHD_AGENT_SSE_HOST) to bind 127.0.0.1.`
    );
  }
  return host;
}
