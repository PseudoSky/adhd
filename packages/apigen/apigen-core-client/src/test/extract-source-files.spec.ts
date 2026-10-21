/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `extract-source-files.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer builds real ts-morph programs over temp source trees (measured 9.5 s / 3 cases).
 * This file compiles nothing and spawns nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `extract-source-files.e2e.ts`); they are the contract a mocked version must
 * satisfy without compiling a real TypeScript program.
 *
 * guards: the extract-source-files.e2e.ts suite is deleted or renamed out of the e2e lane while the unit lane stays green.
 * tier: S (placeholders only; no program build)
 * cites: backlog f3683008 AC3; docs/decisions/0009-test-lanes-unit-vs-e2e.md amendment 2026-10-15
 *
 * Resource lane: cpu.
 */
import { describe, it } from 'vitest';

describe("mocked: extract-source-files", () => {
  it.todo("mocked: [AC1] an ordinary tree: entry plus transitive local imports, sorted; another package stays out");
  it.todo("mocked: [AC1] an installed package: entry plus transitive local imports, sorted; another package stays out");
  it.todo("mocked: [AC1] the list does not change how the result reads as Operation[]");
});
