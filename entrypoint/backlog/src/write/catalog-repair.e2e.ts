/**
 * catalog-repair.e2e.ts — the requested `catalog-repair` path, in the opt-in
 * resource lane.
 *
 * WHY THE CANONICAL SUITE LIVES IN THE SIBLING `catalog-repair.spec.ts`.
 * This repo separates the DEFAULT `test` lane (`*.spec.ts`, run by
 * `nx affected -t test`) from the opt-in RESOURCE `e2e` lane (`*.e2e.ts`, run
 * only by `nx run backlog:e2e` — see `vite.config.ts`'s `include:
 * ['src/**\/*.spec.ts']`, `project.json`'s `test.inputs` excluding
 * `**\/*.e2e.ts`, and `vitest.e2e.config.ts`'s REACHABILITY GUARD). This suite
 * is cheap — an in-process real store via `openTestIssueStore`, no subprocess,
 * no embedding model, no bound port — so it belongs in the DEFAULT lane, and
 * placing the assertion with teeth there is what makes it run on every
 * `nx affected -t test`.
 *
 * This file therefore does not duplicate the suite: it re-runs the exact same
 * registration from the default-lane spec, so the reproduction executes in the
 * opt-in e2e lane too. There is exactly one source of assertions.
 */
import './catalog-repair.spec.js';
