/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `run-cli-integration.e2e.ts`.
 *
 * Resource lane: proc — it spawns the real built `entrypoint/apigen-cli/dist/index.js`
 * via `execFile`, and spawns a real `node <harness>` child process against the
 * real built `@adhd/apigen-plugin-cli-output` dist.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, and loads no built artifact;
 * it exists so the future MOCKED unit-test version of this suite has a home
 * that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `run-cli-integration.e2e.ts`); they are the contract a mocked version
 * must satisfy without touching a subprocess or a built dist.
 */
import { describe, it } from 'vitest';

describe('mocked: run-cli-integration', () => {
  // [cli-output.run.live] apigen run --type cli — real subprocess, real built bin
  it.todo('mocked: accepts --type cli for run (previously rejected as generate-only) and dispatches a real command');
  it.todo('mocked: accepts a native `-- <command> <args>` positional passthrough (DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001) — no --opt argv= needed');
  it.todo('mocked: native `--` passthrough takes precedence over a stale --opt argv= when both are supplied');
  it.todo('mocked: a validation failure (missing required --id) exits non-zero with the ApiError CLI_EXIT_CODE (2), never crashes');
  it.todo('mocked: a JSON-typed (array) param round-trips through a real command line');
  it.todo('mocked: [contrast] a real generate-only plugin (jsonschema) still cannot run — proves the acceptance is specific to cli, not a global relaxation');
  // [cli-parity] TransportAdapter/OpPlan golden-snapshot parity gate
  it.todo('mocked: recapture deep-equals the committed golden snapshot');
  it.todo('mocked: a streaming:true command is rejected as invalid_argument, the target fn is never called');
  // [cli-adapter.6] dod.11 — --use layer + mount capability
  it.todo("mocked: a --use layer wraps a SOURCE op's result");
  it.todo('mocked: a --use mount op ("meta ping") is a real dispatchable command, ALSO wrapped by the layer');
  it.todo('mocked: [negative control] the mount command does NOT exist without --use loaded');
});
