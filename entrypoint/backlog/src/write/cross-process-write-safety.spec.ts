/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `cross-process-write-safety.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `cross-process-write-safety.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: cross-process-write-safety", () => {
  it.todo("mocked: CONTROL (immediate — the only mode used in production): two REAL OS processes each createIssue ${N} times into the SAME project persist exactly ${ 2 * N } issues, and every writer's own ok:true count matches what it reports");
  it.todo("mocked: CONTROL (distinct-target — no forced collision): two REAL OS processes each createIssue ${N} times into the SAME project, each call carrying a UNIQUE body, persist exactly ${ 2 * N } issues (SPEC.md §8 AC-22's \"distinct-target\" case, alongside the same-target case above)");
  it.todo("mocked: NEGATIVE CONTROL: ADHD_BACKLOG_UNSAFE_TX_MODE=deferred strips the BEGIN IMMEDIATE CAS guarantee — this proves the CONTROL case above is actually exercising that guarantee, not passing for an unrelated reason");
  it.todo("mocked: NEGATIVE CONTROL (dedupe): ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on re-enables content-hash dedupe — this proves the design choice `write/tx.ts`'s writeNodeTx makes (skipDedupe:true, unconditional, on every entity write) is load-bearing for cross-process safety, not the `immediate` transaction mode above");
});
