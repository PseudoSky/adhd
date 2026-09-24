/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `embed-drain-real-model.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `embed-drain-real-model.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: embed, proc — real fastembed ONNX model AND the built bin as a child process.
 */
import { describe, it } from 'vitest';

describe("mocked: embed-drain-real-model", () => {
  it.todo("mocked: a fire-and-forget create() through the production seam lands its vector when the store is closed by the drain");
  it.todo("mocked: a spawned `create` (fire-and-forget) exits 0 with no \"unrecorded\" on stderr, and a fresh store finds the vector");
});
