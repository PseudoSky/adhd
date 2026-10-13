# tripwire-scaffold — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** port-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-scaffold`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Stand up the second approved package, `@adhd/resilience-core-tripwire`, with the workspace generator (never by hand): the new `resilience` workspace group (D1), the generator output, the ADR-0003 CJS-only manifest at version 0.1.0 with zero dependencies, and a skeleton that builds. The approval is recorded first, so the audit trail exists before any file is generated.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/APPROVAL-tripwire.md` is already authored by the plan builder (verify it, do not rewrite it); MODIFY `.adhd/workspace.json` (add the `resilience` group), `tsconfig.base.json` (the alias, generator-written); CREATE `packages/resilience/resilience-core-tripwire/` (generator output, then the manifest and vite adjustments), `docs/plan/stealth-browser/evidence/tripwire/scaffold-dry-run.txt`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/scaffold.md` and `evidence/scaffold-dry-run.txt` (the stealth-browser precedent: same generator, same dry-run-first discipline); `packages/environment/environment-core-node/package.json` (CJS-only core package precedent, minus its `module` field); ADR-0003 D1.

- **Delta Spec:** Order: (1) confirm `APPROVAL-tripwire.md` quotes the verbatim request and D1-D4; add to `.adhd/workspace.json` `groups` `"resilience": { "description": "Fail-safe primitives - persistent kill-switches and guards that protect callers and upstream services from compounding failures" }` in the shape of its siblings. (2) Run the generator dry-run first and save its transcript (the CREATE list) to `evidence/tripwire/scaffold-dry-run.txt`: `npx nx g @adhd/workspace-codegen-nx:core --name=tripwire --group=resilience --nxLayer=shared --platform=node --access public --publish true --dry-run` (bare name `tripwire`, never the full package name). (3) Run it without `--dry-run`. Expected tags: domain:resilience, pkg-kind:core, pkg-class:foundation, layer:shared, platform:node, access:public. (4) Apply ADR-0003 D1 to the generated manifest: version `0.1.0` (so `^0.1.0` floats patch releases), `main ./dist/index.js`, `type` unset, no `module`, no `exports`, no `bin`, CJS-only vite output (the template may emit `.mjs`/`module`: remove them), `engines.node >=20`, `publishConfig.access public`, `files [dist, CHANGELOG.md]`, `keywords`, `repository.directory`, no dependencies. (5) `nx run resilience-core-tripwire:typecheck` and `:build` exit 0 on the generated skeleton. This state is anchored on `port-fixes` so it never runs concurrently with the owners of `evidence/` as a tree. No alias such as `@adhd/tripwire` is added; no second generator run is allowed.

- **Invariants:** [inv:one-new-package] ([def:tripwire-pkg]) [inv:greenfield] (legacy names and paths are not constraints) [inv:no-features-removed] (every feature F1-F31 is carried or its change is flagged D3) [inv:unit-purity] (no child_process, no network, no real home) [inv:tests-cite] [inv:typed-errors]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-scaffold]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-scaffold` — runs every acceptance criterion below (red until the work is done); `--only tripwire-scaffold.N` runs one. `nx run resilience-core-tripwire:typecheck` and `:build` are the slow gates (.4); `scaffold.5` and `tripwire-scaffold.5` prove exactly two project.json files were added.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-scaffold --only tripwire-scaffold.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-scaffold.1] Approval and domain are recorded before anything is generated: docs/plan/stealth-browser/APPROVAL-tripwire.md quotes the verbatim request `Implement tripwire package in this plan covering all 3`, names the approver and date and decisions D1 to D4, and .adhd/workspace.json has the `resilience` group (with a description) next to the existing groups.
- [tripwire-scaffold.2] The package is generator-built (never hand-built): evidence/tripwire/scaffold-dry-run.txt holds the transcript of `npx nx g @adhd/workspace-codegen-nx:core --name=tripwire --group=resilience --nxLayer=shared --platform=node --access public --publish true --dry-run` with its CREATE list, packages/resilience/resilience-core-tripwire/project.json is named `resilience-core-tripwire`, and its tags contain exactly domain:resilience, pkg-kind:core, pkg-class:foundation, layer:shared, platform:node and access:public.
- [tripwire-scaffold.3] The manifest has the ADR-0003 CJS-only shape: name @adhd/resilience-core-tripwire, version 0.1.0, `main` ./dist/index.js, `type` unset, no `module`, no `exports`, no `bin`, empty or absent `dependencies`, engines.node >= 20, publishConfig.access public, `files` containing dist and CHANGELOG.md; tsconfig.base.json maps the @adhd/resilience-core-tripwire alias; the vite config emits CJS only (no `es` format, no .mjs).
- [tripwire-scaffold.4] The empty skeleton builds: `nx run resilience-core-tripwire:typecheck` and `nx run resilience-core-tripwire:build` exit 0 (only the generated src/index.ts exists at this point).
- [tripwire-scaffold.5] Exactly two project.json files were added since main (stealth-browser and the tripwire package; the same rule as scaffold.5), only owned paths changed by [psm:tripwire-scaffold] commits (the tripwire package directory, tsconfig.base.json, .adhd/workspace.json and evidence/tripwire/), and no other workspace group or project was edited.

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/APPROVAL-tripwire.md", "docs/plan/stealth-browser/SPEC-tripwire.md", "entrypoint/stealth-browser/project.json"]
mutates:    ["packages/resilience/resilience-core-tripwire/", "tsconfig.base.json", ".adhd/workspace.json", "docs/plan/stealth-browser/evidence/tripwire/"]
```

---

## Contract Promise

Added: `packages/resilience/resilience-core-tripwire/` (generator output plus the manifest shape), `evidence/tripwire/scaffold-dry-run.txt`. Modified: `.adhd/workspace.json` (one group), `tsconfig.base.json` (the alias). No other workspace group or project is edited.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-scaffold]`:

- [ ] After the dry-run transcript and the group — commit: `chore(workspace): resilience group and tripwire dry run [psm:tripwire-scaffold]`
- [ ] After the generator run and the ADR-0003 manifest — commit: `feat(resilience-core-tripwire): scaffold the package [psm:tripwire-scaffold]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- The generator may emit files the ADR-0003 shape forbids (`.mjs` output, a `module` field, an `exports` map): remove them in this state; the guard (.3) reads the manifest and the vite config.
- Do not add `bin`: a standalone `tripwire` bin would be a third package and is NOT approved; the CLI lives in consumers (`runUnlockCli` is a library function).
- If the generator rejects the group, the `.adhd/workspace.json` edit is wrong; do not fall back to another group (D1 is decided: `resilience`).
