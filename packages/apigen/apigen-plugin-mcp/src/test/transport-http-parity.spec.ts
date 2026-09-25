/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `transport-http-parity.e2e.ts`.
 *
 * Resource lane: proc — the moved suite starts real `run()` servers bound to
 * real ports (`net.createServer(...).listen(0)`) and drives them over real
 * HTTP with the `@modelcontextprotocol/sdk` `SSEClientTransport` /
 * `StreamableHTTPClientTransport` clients; its negative-control case re-enters
 * a fresh `vitest` child process via `spawnSync`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer binds a
 * port or spawns a child process. This file spawns nothing, embeds nothing and
 * binds no port; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `transport-http-parity.e2e.ts`); they are the contract a mocked version
 * must satisfy without touching a subprocess, a port, or a live server.
 */
import { describe, it } from 'vitest';

describe('mocked: transport-http-parity', () => {
  // [mcp-adapter.10] sse transport — real SSEClientTransport parity
  it.todo("[sse] handshake: connects and lists the expected tool");
  it.todo("[sse] session routing: TWO independent SSE sessions against the SAME server BOTH work");
  it.todo("[sse] dod.15 graceful-error-no-teardown: an erroring call is followed by a successful call on the SAME session");
  it.todo("[sse] abort/shutdown: aborting the signal resolves run() and the server stops accepting connections");
  // [mcp-adapter.10] streaming-http transport — real StreamableHTTPClientTransport parity
  it.todo("[streaming-http] handshake: connects and lists the expected tool");
  it.todo("[streaming-http] session routing: TWO independent concurrent connections against the SAME server BOTH work (no cross-request state leakage)");
  it.todo("[streaming-http] dod.15 graceful-error-no-teardown: an erroring call is followed by a successful call on the SAME session");
  it.todo("[streaming-http] abort/shutdown: aborting the signal resolves run() and the server stops accepting connections");
  // [mcp-adapter.10] negative control — sse session routing actually gates
  it.todo("[negative control] reverting the per-session Server fix (mcp-adapter.patch hunk 2) breaks the SECOND SSE session's handshake; reverting the patch fixes it");
});
