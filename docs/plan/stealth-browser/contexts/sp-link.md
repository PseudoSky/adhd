# sp-link — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** port-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-link`
**Executor:** `devops-engineer` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Declare the final dependency once: `@adhd/sox-service-proxy` `~0.6.0` in the stealth-browser manifest (the manifest is FINAL from day one; no `file:` ever appears in a published manifest) and resolve the unreleased 0.6.0 through a root `pnpm.overrides` entry that points at the dev tarball built in the sox-ecosystem `sp-lifecycle` worktree. This is the only state that edits the proxy dependency line, so `chrome-lifecycle` (step `lifecycle/sp.ts`), `surface-hosts`, `sp-reaper-smoke` and `tripwire-pack` serialize the stealth `package.json` and `pnpm-lock.yaml` owners through it.

---

## Semantic Distillation

- **Primitive:** MODIFY `entrypoint/stealth-browser/package.json` (the one dependency line), root `package.json` (`pnpm.overrides` entry), `pnpm-lock.yaml`; CREATE `docs/plan/stealth-browser/smoke/sp-link.md`.

- **Reference Pattern:** Root `package.json` existing `pnpm.overrides` keys (`@adhd/sox-store-adapter`, `@tursodatabase/database`) are the precedent for the override; `docs/publishing/release-flow.md` section 2 (tilde ranges for 0.x); `SPEC-single-pass-lifecycle.md` section 4.1 (this state is its step list).

- **Delta Spec:** (1) Prove in a scratch copy of the root manifest that pnpm 8.15.9 accepts a `file:` tarball as an override value in this hoisted workspace; if it is rejected record `FALLBACK: dependency-value` and put the same `file:` spec as the dependency value in the stealth manifest instead (still one line to change at the switch, no source change). (2) Locate the dev tarball `/Users/nix/.cache/adhd-dev-tarballs/adhd-sox-service-proxy-0.6.0-<sha8>[-prerelease].tgz`; it is built by the sox-ecosystem integrator with `pnpm nx build service-proxy` then `pnpm pack` in `libs/service-proxy` (NEVER `npm pack`: `pnpm pack` rewrites `workspace:^`; `npm pack` would leave a literal `workspace:^`). Record `TARBALL_SHA256:`, `TARBALL_VERSION: 0.6.0` and `TARBALL_BUILD: pnpm pack`. If 0.6.0 is already published (`npm view @adhd/sox-service-proxy@0.6.0 version` exits 0) record `REGISTRY: published`, skip the override and `sp-switch` becomes verification-only. (3) Set `dependencies["@adhd/sox-service-proxy"] = "~0.6.0"` in the stealth manifest; add the root override; `pnpm install` through the plan's real worktree install; confirm the lockfile, `node_modules/@adhd/sox-service-proxy/package.json` version 0.6.0 and that it exports every name `lifecycle/sp.ts` will re-export (`ensureBackend, serveBackend, dialBackend, backendSocketPath, ensurePrivateSocketDir, readProcessStartToken, isSameProcess, createIdleRetirer, createCircuitBreaker`). (4) `nx run stealth-browser:build` exits 0 and `dist/index.js` keeps a `require` of the package (external, not inlined). If the tarball does not exist yet the state halts and the dispatcher holds it (human blocker `hb-sp-release`); do not fabricate a tarball.

- **Invariants:** [inv:pnpm-only] [inv:node-modules] [inv:greenfield] [inv:no-features-removed] (this state changes no source). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:sp-link]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-link` — runs every acceptance criterion below (red until the work is done); `--only sp-link.N` runs one. `nx run stealth-browser:build` is the slow gate (.4).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py sp-link --only sp-link.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [sp-link.1] The stealth-browser manifest is FINAL from day one: entrypoint/stealth-browser/package.json `dependencies["@adhd/sox-service-proxy"]` is exactly `~0.6.0` (tilde: patch floats, a 0.x minor does not) and no `file:` / `link:` / `portal:` specifier appears in it (the sole recorded fallback, `FALLBACK: dependency-value` in smoke/sp-link.md, puts the `file:` tarball spec in this one dependency value instead of the root override).
- [sp-link.2] The unreleased 0.6.0 resolves from a recorded dev tarball (or the registry once published): root package.json `pnpm.overrides["@adhd/sox-service-proxy"]` is `file:/Users/nix/.cache/adhd-dev-tarballs/adhd-sox-service-proxy-0.6.0-<sha8>[-prerelease].tgz`, that file exists and smoke/sp-link.md records `TARBALL_SHA256:` equal to its real sha256, `TARBALL_VERSION: 0.6.0` equal to the version inside the tarball, and `TARBALL_BUILD: pnpm pack` (never `npm pack`, which would leave a literal `workspace:^`); if 0.6.0 is already published the evidence records `REGISTRY: published`, the override is absent and the sp-switch state is verification-only.
- [sp-link.3] The install is real: pnpm-lock.yaml resolves @adhd/sox-service-proxy to 0.6.0, the worktree's node_modules/@adhd/sox-service-proxy/package.json is version 0.6.0, and it exports every name lifecycle/sp.ts re-exports (ensureBackend, serveBackend, dialBackend, backendSocketPath, ensurePrivateSocketDir, readProcessStartToken, isSameProcess, createIdleRetirer, createCircuitBreaker).
- [sp-link.4] The dist keeps the proxy external: after `nx run stealth-browser:build` exits 0, dist/index.js contains a `require` (or dynamic `import()`) of `@adhd/sox-service-proxy` and no inlined definition of ensureBackend, serveBackend or dialBackend (vite.config.ts keeps `externalizeRealDeps(__dirname)`).
- [sp-link.5] Only owned paths changed by [psm:sp-link] commits (the stealth-browser package.json, the root package.json, pnpm-lock.yaml and smoke/sp-link.md); the stealth-browser package.json diff of those commits touches the one `@adhd/sox-service-proxy` dependency line only, and no file under entrypoint/stealth-browser/src is modified.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/", "entrypoint/stealth-browser/vite.config.ts"]
mutates:    ["entrypoint/stealth-browser/package.json", "package.json", "pnpm-lock.yaml", "docs/plan/stealth-browser/smoke/sp-link.md"]
```

---

## Contract Promise

Modified: `entrypoint/stealth-browser/package.json` (one dependency line), root `package.json` (one override entry), `pnpm-lock.yaml`. Added: `smoke/sp-link.md`. No source file changes.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:sp-link]`:

- [ ] After the manifest, the override and the lockfile resolve — commit: `build(stealth-browser): depend on @adhd/sox-service-proxy ~0.6.0 via the dev tarball [psm:sp-link]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- The override value is a `file:` absolute path and is intentionally NOT in any published manifest; `sp-switch` deletes it once 0.6.0 is on the registry.
- `pnpm-lock.yaml` has one owner at a time: `tripwire-pack` depends on this state so the two never run concurrently.
- The tarball is produced by a different repository and a human release step (`hb-sp-release`); this state consumes it and never builds it.
