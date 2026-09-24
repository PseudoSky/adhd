/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `extraction-session.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer builds real ts-morph Projects and schema generators over on-disk fixtures (measured ~41s / 13 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `extraction-session.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: extraction-session", () => {
  it.todo("mocked: two extract() passes of the same file build ONE Project and ONE generator");
  it.todo("mocked: two sources share one Project; generator cache holds ≤1 entry per file");
  it.todo("mocked: descriptor built with a shared session deep-equals one built session-less");
  it.todo("mocked: session cannot be used after dispose()");
  it.todo("mocked: a second session over the unchanged file builds 0 Projects and 0 generators");
  it.todo("mocked: editing the file is picked up by the next session (no stale schemas)");
  it.todo("mocked: editing an IMPORTED (non-entry) file is picked up even though the entry file itself never changes");
  it.todo("mocked: two sessions over an UNCHANGED entry+imported-file pair still hit the persistent cache (no regression to always-miss)");
  it.todo("mocked: anonymous-type resolution leaves the SourceFile text unchanged");
  it.todo("mocked: returns the entry file plus every LOCAL transitive import, sorted, node_modules excluded");
  it.todo("mocked: entry with no local imports returns only the entry itself");
  it.todo("mocked: is deterministic: identical input yields identical output across calls");
  it.todo("mocked: picks up a NEW import edge after the entry file is edited on disk (refresh-before-descend)");
});
