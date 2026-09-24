/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `python-env.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer
 * provisions a real venv / runs a real `pip install` (via `spawnSync`), and
 * no longer copies this package's built `dist/` into a temp tree.
 * This file spawns nothing and touches no build output; it exists so the
 * future MOCKED unit-test version of this suite has a home that the default
 * target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `python-env.e2e.ts`); they are the contract a mocked version must
 * satisfy without spawning a subprocess or provisioning a real venv.
 *
 * Resource lane: proc.
 */
import { describe, it } from 'vitest';

describe("mocked: python-env", () => {
  it.todo("mocked: resolvePythonPkgDir locates the apigen_python sources (grpc_server.py + pyproject.toml)");
  it.todo("mocked: resolvePythonPkgDir (DEBT-APIGEN-010) resolves the LIVE monorepo source, not the stale co-located dist copy, when both exist");
  it.todo("mocked: published (outside-monorepo) layout RED — without the co-located probe, both monorepo-relative fallbacks are dead ends");
  it.todo("mocked: published (outside-monorepo) layout GREEN — resolves the bundled co-located copy from the relocated dist dir");
  it.todo("mocked: published (outside-monorepo) layout GREEN — pyproject.toml (and conformance-vector siblings) ship alongside apigen_python/, not just the subpackage");
  it.todo("mocked: ensurePythonEnv provisions a venv whose interpreter can import apigen_python, and reuses it");
  it.todo("mocked: ensurePythonEnv re-provisions when NEW extras are requested, and extras are monotonic (union, never dropped)");
  it.todo("mocked: APIGEN_PYTHON override is used verbatim without provisioning");
  it.todo("mocked: APIGEN_PYTHON override fails loudly when the override path is missing");
});
