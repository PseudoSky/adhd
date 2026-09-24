/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `run.e2e.ts`.
 *
 * Resource lane: proc — the moved suite starts real MCP servers on real ports
 * (`net.createServer(...).listen(0)`) and drives them over real HTTP via the
 * `@modelcontextprotocol/sdk` client transports; its negative-control case
 * re-enters a fresh `vitest` child process via `spawnSync`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer binds a
 * port or spawns a child process. This file spawns nothing, embeds nothing and
 * binds no port; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `run.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or a live server.
 */
import { describe, it } from 'vitest';

describe('mocked: run', () => {
  it.todo("[plugin-mcp.4] tools/list returns the canonical names for getUser and listUsers");
  it.todo("[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] (negative control) tools/list no longer registers the OLD raw fn name");
  it.todo("tools/list does NOT include __samples__ or non-function exports");
  it.todo("[round-trip] callTool(<canonical getUser name>) routes through dispatch and returns correct value");
  it.todo("[round-trip] callTool(<canonical listUsers name>) returns correct value");
  it.todo("[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] (negative control) callTool with the OLD raw fn name fails");
  it.todo("[plugin-mcp.abort] abort signal stops the server");
  it.todo("[plugin-mcp.5] run.ts imports dispatch from @adhd/apigen-engine-runtime");
  it.todo('[v2-mcp.env.1] envelope field bound from _meta["x-<pluginId>-<field>"]');
  it.todo("[v2-mcp.env.2] (negative) envelope field in args body (not _meta) is NOT picked up as envelope");
  it.todo("object-shaped output: tools/list outputSchema passes through unwrapped");
  it.todo('union-return output: tools/list outputSchema is wrapped under "result" with oneOf+discriminator intact');
  it.todo('array-return output: tools/list outputSchema is wrapped under "result"');
  it.todo("object-shaped output: tools/call structuredContent equals the raw result (no wrapping)");
  it.todo("union-return output: tools/call structuredContent is wrapped as { result: <value> }");
  it.todo("[parity] registered tool names equal project(op).mcp.name for every op in a representative set");
  it.todo("[round-trip] callTool(<canonical getItem name>) dispatches to the real getItem fn");
  it.todo("[round-trip] callTool(<canonical listItems name>) dispatches to the real listItems fn");
  it.todo('[negative control] callTool with the OLD raw fn name ("getItem") is rejected');
  it.todo("recapture deep-equals the committed golden snapshot");
  it.todo('a REAL sdk client callTool() with missing required "userId" REJECTS (does not silently succeed)');
  it.todo("the rejection surfaces the validate-Layer's own message text (the invalid_argument ApiError, not a generic/unknown-tool error)");
  it.todo("[negative control] a WELL-FORMED call to the SAME tool succeeds and DOES reach the fn — proves the rejection above is validation-specific, not a broken tool registration");
  it.todo("the mount op (_meta/status) is registered as a real MCP tool (tools/list)");
  it.todo("callTool(_meta/status mount) dispatches to the mount handler and returns its value");
  it.todo("the --use LAYER wraps a normal source-op call (layer log records the op.id)");
  it.todo("[fix:mount-through-layers] the --use LAYER ALSO wraps the mount call (dispatchForPlan mount branch flows through the SAME composed invoker)");
  it.todo("__toolTableBuildCount increases by exactly 1 for one run(), regardless of request volume");
  it.todo("applying neg-control/mcp-adapter.patch turns the golden-parity check RED; reverting turns it GREEN");
  it.todo('passes an already-valid {type:"object", ...} schema through unchanged');
  it.todo("falls back to an empty object schema for a genuinely zero-arg mount (health/openapi precedent)");
  it.todo("preserves a real root-level oneOf+discriminator, never collapsing it to {}");
  it.todo("intersects required across branches, dropping any field not required by every branch");
});
