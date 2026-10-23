/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `run.e2e.ts`.
 *
 * Resource lane: cpu — it runs real ts-morph extraction over the fixture packages (~22s of pure CPU).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `run.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 *
 * NOTE: The `[cli-run-cmd.1 live]` block is currently `describe.skip`’d (CPU-THRASH-SKIP, owner-requested); the running blocks are the real-extraction ones.
 */
import { describe, it } from 'vitest';

describe('mocked: run', () => {
  it.todo("mocked: throws \"does not support run mode\" when plugin has no run()");
  it.todo("mocked: lists the generate-only and run-capable subsets separately in the error");
  it.todo("mocked: reports a near-miss/typo\\");
  it.todo("mocked: does not throw \"does not support run mode\" for an unregistered --type");
  it.todo("mocked: run command's --help lists only run-capable plugin ids, derived from the live registry");
  it.todo("mocked: passes a live fns record and resolves on abort");
  it.todo("mocked: [cli-run-cmd.5] --output is not a registered option on the run command");
  it.todo("mocked: discovers pkg-a and pkg-b and passes them as a single packages array");
  it.todo("mocked: a --use plugin declaring extractLayer actually intercepts extraction for the real `run-registry` command");
  it.todo("mocked: throws when fns is empty");
  it.todo("mocked: error message contains \"0 functions found\"");
  it.todo("mocked: error message contains the source path");
  it.todo("mocked: error message contains actionable hint about wrong source file");
  it.todo("mocked: does NOT throw when fns has at least one entry (negative-control: guard is not blanket-failing)");
  it.todo("mocked: throws when a decimal function is present and the lib is absent");
  it.todo("mocked: error message names the function");
  it.todo("mocked: error message instructs the user to install decimal.js");
  it.todo("mocked: error message names the missing lib");
  it.todo("mocked: does NOT throw when decimal.js is present (resolver succeeds)");
  it.todo("mocked: does NOT throw when no function uses decimal format (lib absence is irrelevant)");
  it.todo("mocked: assertFnsNonEmpty does not fire for a surface with functions (api.ts shape)");
  it.todo("mocked: assertDecimalLibPresent does not fire for a surface with no decimal types");
  it.todo("mocked: calls plugin.run() with importPath set to the source file, no TS compilation");
  it.todo("mocked: serves tools/list with fixture tools over streaming-http");
});
