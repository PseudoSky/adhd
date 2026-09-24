/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `bug-apigen-033-anonymous-default-dispatch.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` as a real `node` child and drives it over real MCP stdio.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `bug-apigen-033-anonymous-default-dispatch.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: bug-apigen-033-anonymous-default-dispatch', () => {
  it.todo("mocked: Shape 5 (`export default (n) => ...`) is listed AND callable — tools/call returns the real result, not a dispatch crash");
  it.todo("mocked: Shape 4 anonymous sub-case (`export default function(n){...}`) is listed AND callable");
  it.todo("mocked: negative control: a NAMED default export (Shape 4, declared name) is unaffected by this fix");
});
