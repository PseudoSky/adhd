/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `serve.e2e.ts`.
 *
 * Resource lane: proc — it spawns real `node`/`python3`/`grpcurl` children and binds a real front server on a port.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `serve.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 *
 * NOTE: The `[serve.live]` block is currently `describe.skip`’d (CPU-THRASH-SKIP, owner-requested); the pure-logic blocks that remain are cheap, but the suite is classified by the resource class of its live block.
 */
import { describe, it } from 'vitest';

describe('mocked: serve', () => {
  it.todo("mocked: parses ns=plugin pairs into a record");
  it.todo("mocked: throws on a pair missing the = separator");
  it.todo("mocked: throws on an empty namespace or plugin side");
  it.todo("mocked: strips directory and extension");
  it.todo("mocked: extracts the namespace from the URL path");
  it.todo("mocked: is a no-op for an already-kebab-neutral single word");
  it.todo("mocked: tokenizes camelCase/PascalCase/snake_case into kebab-case");
  it.todo("mocked: routes .ts → api-fastify and .py → py-flask by default");
  it.todo("mocked: honours a --mount override for a namespace");
  it.todo("mocked: sets transport=grpc for py-grpc plugin");
  it.todo("mocked: throws on an unrecognised extension");
  it.todo("mocked: throws on duplicate namespaces (prefix collision)");
  it.todo("mocked: throws on a CANONICAL (kebab) collision even when the raw namespaces differ");
  it.todo("mocked: reports ok when every host is ready");
  it.todo("mocked: reports degraded with the dead host down, others still ready (partial availability)");
  it.todo("mocked: a host that is alive but not yet ready is down");
  it.todo("mocked: returns a positive port number");
  it.todo("mocked: proxies TS + Python calls, isolates a dead host to 503, and leaves zero orphans");
  it.todo("mocked: mounts a gRPC host (py-grpc) on the same front port as HTTP hosts");
  it.todo("mocked: cleans up children on SIGTERM and leaves zero orphan processes");
});
