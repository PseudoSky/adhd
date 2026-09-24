/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `install.published-layout.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `install.published-layout.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { describe, it } from 'vitest';

describe("mocked: install.published-layout", () => {
  it.todo("mocked: FIX A precondition: the real built dist/ actually contains skill/SKILL.md before this test even flattens it");
  it.todo("mocked: RED-state proof: the pre-FIX-B escaped path (one level above the flattened package root) is categorically absent — the real bug this test guards against");
  it.todo("mocked: install-skill --host opencode --scope project succeeds (exit 0) and writes the real packaged SKILL.md, never the escaped-path ENOENT");
  it.todo("mocked: install --skill-only on the published layout behaves identically to install-skill (same underlying installSkillToHosts call)");
});
