/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `install-skill-usage.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `install-skill-usage.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: install-skill-usage", () => {
  it.todo("mocked: --help prints usage and exits 0 (was: `unknown argument \"--help\"` on a stack trace)");
  it.todo("mocked: -h is accepted the same way as --help");
  it.todo("mocked: an invalid --scope exits 2 with a machine-readable envelope and NO stack frames");
  it.todo("mocked: an unknown argument exits 2 with no stack frames");
  it.todo("mocked: an invalid --host exits 2 with no stack frames");
  it.todo("mocked: `install` accepts --help anywhere in argv, not only at argv[0]");
  it.todo("mocked: `install` usage errors are also enveloped, not stack traces");
  it.todo("mocked: a real (non-usage) fault is NOT swallowed into a usage message");
});
