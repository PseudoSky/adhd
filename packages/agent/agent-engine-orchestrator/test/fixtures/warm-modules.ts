/**
 * Cold-start warm-up shared by tests that reach the claudecli provider graph through a dynamic
 * `await import(...)` inside the test body (qa-variance, docs/discovery/qa-test-variance-tail-orchestrator-a.md).
 *
 * Why: the provider module graph is large (provider, tool bridge, session registry, wire parsers). Its first
 * dynamic import is charged to whichever test happens to run first in the worker, so that one test measures
 * 100-300 ms of module loading under parallel nx load instead of its own work. Awaiting the graph once in a
 * `beforeAll` (with an explicit budget) moves that cost out of every test body. It does not change what any
 * test asserts: later `await import()` calls resolve from the module cache, and `vi.mock` registrations made by
 * the calling file apply to these imports too (the mock registry is per test file, not per call site).
 *
 * guards: a cold module load lands inside the first test's measured time and makes its duration vary 5-10x between runs.
 * tier: S
 * cites: qa-variance (dispatch-1014); same remedy as 9ed453c1 HARD-H2 in claudecli-temp-root.test.ts.
 */

/** Budget for the one-time cold import; generous because it is paid once per file, outside any test. */
export const COLD_IMPORT_TIMEOUT_MS = 60_000;

/**
 * Loads the claudecli provider module graph (and optionally the provider factory) once.
 *
 * @param opts.factory also load `providers/factory.js` (tests that call `createProvider`)
 */
export async function warmClaudeCliModules(opts: { factory?: boolean } = {}): Promise<void> {
  await import("../../src/providers/claudecli.js");
  await import("../../src/providers/claudecli-session.js");
  if (opts.factory === true) await import("../../src/providers/factory.js");
}

/**
 * Forces the `gpt-tokenizer` ranks to load. The first `encode` call in a process decodes the BPE table; without
 * this it is charged to the first test that counts tokens.
 */
export async function warmTokenizer(): Promise<void> {
  const { encode } = await import("gpt-tokenizer");
  encode("warm");
}
