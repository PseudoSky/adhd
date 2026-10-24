# sp-switch — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** chrome-lifecycle, core-seam, tripwire-pack, search-hosts · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-switch`
**Executor:** `devops-engineer` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Remove the dev-tarball indirection with no source change once `@adhd/sox-service-proxy` 0.6.0 is on the registry, so no published manifest or lockfile carries a `file:` specifier. If 0.6.0 was already published before `sp-link`, this state is a verification-only no-op.

---

## Semantic Distillation

- **Primitive:** MODIFY root `package.json` (delete the single `pnpm.overrides["@adhd/sox-service-proxy"]` entry) and `pnpm-lock.yaml`; CREATE `docs/plan/stealth-browser/smoke/switch.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/smoke/sp-link.md` (what was installed and how), `SPEC-single-pass-lifecycle.md` section 4.1 (SWITCH).

- **Delta Spec:** Precondition: `npm view @adhd/sox-service-proxy@0.6.0 version` exits 0 and prints `0.6.0`; the release is a human step (`hb-sp-release`), so the dispatcher holds this state until the blocker is resolved. Then: delete the override, `pnpm install`, assert no `@adhd/*` dependency or override in the root, stealth-core-browser or tripwire manifests starts with `file:`, `link:` or `portal:`, assert `pnpm-lock.yaml` mentions neither `adhd-dev-tarballs` nor a `file:/Users` resolution and resolves the proxy 0.6.x with an integrity hash, assert the core manifest's `@adhd/sox-service-proxy` specifier is the published range (`^0.6.0` or `~0.6.0`), assert `git diff` of `packages/stealth/stealth-core-browser/src` since the state start is empty, and run `nx run stealth-core-browser:build` and `nx run stealth-core-browser:test -- src/test/unit/lifecycle`. Record `PUBLISHED:`, `BUILD: exit=0` and `LIFECYCLE-UNIT: exit=0` in `smoke/switch.md` (or `NOOP: published before sp-link`). It depends on `tripwire-pack` only to serialize the `pnpm-lock.yaml` owners.

- **Invariants:** [inv:pnpm-only] [inv:greenfield] [inv:no-features-removed]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:sp-switch]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-switch` — runs every acceptance criterion below (red until the work is done); `--only sp-switch.N` runs one. The lifecycle unit lane (`nx run stealth-core-browser:test -- src/test/unit/lifecycle`) is the regression proof (.3).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py sp-switch --only sp-switch.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [sp-switch.1] 0.6.0 is on the registry: smoke/switch.md records `PUBLISHED: npm view @adhd/sox-service-proxy@0.6.0 version exit=0` with the printed version `0.6.0` (the human release go is hb-sp-release); when the state is a verification-only no-op the evidence says `NOOP: published before sp-link`.
- [sp-switch.2] The dev-tarball indirection is gone with no source change: root package.json `pnpm.overrides` has no `@adhd/sox-service-proxy` key, no @adhd/* dependency or override in the root, stealth-core-browser or tripwire manifests starts with `file:`, `link:` or `portal:`, pnpm-lock.yaml mentions neither `adhd-dev-tarballs` nor a `file:/Users` resolution and resolves @adhd/sox-service-proxy 0.6.x with an integrity hash, `git diff` of packages/stealth/stealth-core-browser/src since the state start is empty, and the core manifest's `@adhd/sox-service-proxy` specifier is a published semver range (`^0.6.0` or `~0.6.0`).
- [sp-switch.3] The registry build passes the same gates: after the switch `nx run stealth-core-browser:build` and `nx run stealth-core-browser:test -- src/test/unit/lifecycle` exit 0, and smoke/switch.md records `BUILD: exit=0` and `LIFECYCLE-UNIT: exit=0`.
- [sp-switch.4] Only owned paths changed by [psm:sp-switch] commits (the root package.json, pnpm-lock.yaml and smoke/switch.md); the root package.json diff removes the single `@adhd/sox-service-proxy` override line and adds nothing else.
- [sp-switch.5] The built dist requires the proxy from the registry build: with no dev-tarball override or local specifier left, `src/lib/lifecycle/sp.ts` exists, `nx run stealth-core-browser:build` exits 0, dist/index.js contains a `require` (or dynamic `import()`) of `@adhd/sox-service-proxy` and no inlined definition of ensureBackend, serveBackend or dialBackend.

---

## Contract Promise

Modified: root `package.json` (one removed override line), `pnpm-lock.yaml`. Added: `smoke/switch.md`. No source change.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:sp-switch]`:

- [ ] After the switch is green — commit: `build(stealth-core-browser): resolve @adhd/sox-service-proxy from the registry [psm:sp-switch]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Do not publish anything here: publishing 0.6.0 is the sox-ecosystem release step behind `hb-sp-release`.
- If `npm view` fails, stop and report; never keep or re-add a `file:` specifier to make a gate pass.
