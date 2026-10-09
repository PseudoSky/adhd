/**
 * The ONE place the engine falls back from an injected {@link WireSeams} to the plain globals
 * (backlog c536ce29, TRC-AC16). Every provider / MCP-client egress goes through these helpers, so
 * the egress-site guard test only has to allowlist this file: a raw `fetch(`, `spawn(` or MCP
 * transport construction anywhere else in the engine is a regression.
 *
 * With no `wire` every helper returns exactly what the caller used before, so behaviour (and the
 * options object handed to an SDK) is byte-identical when tracing is off.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { EngineConfig } from '../interfaces.js';

type ConfigWithWire = Pick<EngineConfig, 'wire'> | undefined;

/** `{ fetch }` to spread into an SDK client's options; `{}` when no seam is installed. */
export function sdkFetchOption(config: ConfigWithWire): { fetch?: typeof fetch } {
  const f = config?.wire?.fetch;
  return f ? { fetch: f } : {};
}

/** The `fetch` to call: the traced seam, else the global. */
export function wireFetch(config: ConfigWithWire): typeof fetch {
  return config?.wire?.fetch ?? globalThis.fetch;
}

/** The `spawn` to call: the traced seam, else `node:child_process` `spawn`. */
export function wireSpawn(config: ConfigWithWire): typeof nodeSpawn {
  return config?.wire?.spawn ?? nodeSpawn;
}

/** Wraps an MCP client transport for raw JSON-RPC logging; the identity when no seam is installed. */
export function wrapMcpTransport(
  config: ConfigWithWire,
  transport: Transport,
  meta: { server: string; transport: string }
): Transport {
  return config?.wire ? config.wire.wrapTransport(transport, meta) : transport;
}
