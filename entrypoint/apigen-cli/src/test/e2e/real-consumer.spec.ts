/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `real-consumer.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` over real MCP stdio and real HTTP.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `real-consumer.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 *
 * NOTE: Every block in the real file is currently `describe.skip`’d (CPU-THRASH-SKIP, owner-requested); it is retained here because the e2e lane is its correct home and the documented place to re-enable it.
 */
import { describe, it } from 'vitest';

describe('mocked: real-consumer', () => {
  it.todo("mocked: tools/list == transform exports; callTool deep-equals in-process ground truth");
  it.todo("mocked: GET /<id>/<fn> deep-equals in-process ground truth over real HTTP");
  it.todo("mocked: a real MCP client lists + calls a real transform tool; result == in-process ground truth");
});
