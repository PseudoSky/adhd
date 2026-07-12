# Publishing Strategy Research: `@adhd/agent-mcp` Family (9 packages, first coordinated 2.1.0 release)

Research date: 2026-07-11. Verified against this repo's actual config files AND the installed `nx`/`@nx/js` 18.3.4 source in `node_modules` (not just nx.dev's current docs, which describe Nx v21+/v22+ — see the version caveat in §0, it materially changes the correct config surface).

## 0. Critical version caveat — read this first

nx.dev's *current* (2026) docs describe Nx v21+, where `release.version.generatorOptions` was removed and flattened into `release.version.manifestRootsToUpdate` (an array) at the top level of `version`. Source: [Updating Version References in Manifest Files](https://nx.dev/docs/guides/nx-release/updating-version-references) — "In Nx v21, the implementation details of versioning were rewritten... An automated migration was provided in Nx v21 to update your configuration to the new format."

**This repo pins `nx`/`@nx/js` at `18.3.4`** (`package.json` lines 66, 74, 120), which predates that rewrite. I confirmed directly against the installed code that Nx 18.3.4 does **not** have `manifestRootsToUpdate` at all — the only supported mechanism is the pre-v21 `release.version.generatorOptions.packageRoot`:

- `node_modules/@nx/js/src/generators/release-version/schema.json` — the generator's own schema lists `packageRoot`, `currentVersionResolver` (enum `registry|disk|git-tag`, default `disk`), `specifierSource`, `preid`, etc. No `manifestRootsToUpdate`.
- `node_modules/@nx/js/src/generators/release-version/release-version.js` line 43: `const resolvePackageRoot = createResolvePackageRoot(options.packageRoot);` — this is literally where `packageRoot` is consumed.

**Do not blindly apply nx.dev's current "manifestRootsToUpdate" recipe to this repo.** The correct, version-matched config is `release.version.generatorOptions.packageRoot`, exactly as already used in 8 of this repo's 9 packages (see §3). If/when this repo upgrades Nx past v21, `nx migrate` will auto-rewrite this config to the new format (per the docs above) — that migration is out of scope here and requires separate human-approved planning (Nx major upgrades need explicit approval per this repo's CLAUDE.md).

## 1. Where `packageRoot` belongs, and the exact token syntax

There are **two independent config surfaces**, both named `packageRoot`, that must both be set — they are easy to conflate:

| Surface | Location | Controls | Executor/generator |
|---|---|---|---|
| **Version** | `project.json` → `release.version.generatorOptions.packageRoot` (per-project) | Where `nx release version` reads the current version from and writes the bumped version + rewrites dependents' ranges | `@nx/js:release-version` generator |
| **Publish** | `project.json` → `targets.nx-release-publish.options.packageRoot` | Where `nx release publish` / `npm publish` packs from | `@nx/js:release-publish` executor |

Both accept the interpolation tokens `{projectRoot}` and `{projectName}` (confirmed: `@nx/js/src/executors/release-publish/schema.json` description: *"The root directory of the directory (containing a manifest file at its root) to publish. Defaults to the project root."*; identical wording in the version generator's schema).

**Per-project `project.json` is the correct place** (not `nx.json` `targetDefaults`, and not `release.version` at the nx.json root) — because `packageRoot` must resolve to a *different* literal path per project (`dist/{projectRoot}` interpolates differently for `packages/agent/agent-store-runtime` vs `entrypoint/agent-mcp`), and because Nx batches `nx release version` generator invocations by exact deep-equality of merged `generatorOptions` across projects in a release group (see §4's batching mechanism) — putting the *token template* `"dist/{projectRoot}"` in each project's own `project.json` is what lets every project resolve its own dist path while still sharing an identical config for batching purposes. A `targetDefaults` entry in `nx.json` for `nx-release-publish.options.packageRoot` also works for the **publish** side alone (it's just a default merged in per-project), but it does *not* address the version-side `generatorOptions.packageRoot`, which has no `targetDefaults`-equivalent slot — it must be set under each project's own `release.version.generatorOptions` (or, for a release *group*, under that group's `version.generatorOptions` in `nx.json`, which is uniform for the whole group).

### Exact snippet already used successfully by 8 of the 9 packages (e.g. `packages/agent/agent-store-runtime/project.json`)

```jsonc
{
  "release": {
    "version": {
      "generatorOptions": {
        "packageRoot": "dist/{projectRoot}",
        "currentVersionResolver": "git-tag"
      }
    }
  },
  "targets": {
    "nx-release-publish": {
      "dependsOn": ["build", "test"],
      "options": {
        "packageRoot": "dist/{projectRoot}"
      }
    }
  }
}
```

**`entrypoint/agent-mcp/project.json` is currently missing this entire block** — it has no `release` key at all, and its `nx-release-publish` target isn't even defined (it inherits only the workspace `targetDefaults.nx-release-publish: { dependsOn: ["build","test"] }` from `nx.json`, with no `packageRoot` override, so `packageRoot` defaults to the project root — the source directory).

**This is the exact, complete root cause of the reported bug**: `packageRoot` defaulting to the project root for `agent-mcp` means `nx release publish` packs `entrypoint/agent-mcp/` (source, containing `src/index.ts`), not `dist/entrypoint/agent-mcp/` (compiled `src/index.js`). Confirmed by reading the executor schema directly: `node_modules/@nx/js/src/executors/release-publish/schema.json` → `packageRoot` description: *"Defaults to the project root."*

**The fix is to add the identical block above to `entrypoint/agent-mcp/project.json`** (same `packageRoot: "dist/{projectRoot}"` and `currentVersionResolver: "git-tag"` as its 8 dependencies — the exact-match matters; see §4's batching gotcha for why).

Note also: fixing `packageRoot` **also resolves the "`main: ./src/index.js` points at a nonexistent `.js`" symptom** without touching `package.json` at all — `main` is resolved relative to the manifest's directory, which *becomes* `dist/entrypoint/agent-mcp/` once `packageRoot` is corrected, and `dist/entrypoint/agent-mcp/src/index.js` does exist (verified: `dist/entrypoint/agent-mcp/package.json` already exists with correct compiled-package shape). See §5.

## 2. Avoiding the dist-scan conflict (`ProjectsWithConflictingNamesError`)

### Root cause, fully isolated

I confirmed by globbing the entire `dist/` tree (`dist/**/project.json`) that **`dist/entrypoint/agent-mcp/project.json` is the only stray `project.json` anywhere under `dist/` in this repo.** No other package (of the 8 correctly-configured deps, nor the other Nx-managed entrypoints `dispatch-cli`/`decompile-cli`/`apigen-cli`) has this problem.

Cause: `entrypoint/agent-mcp/project.json`'s `build.assets` array includes the **bare glob** `"entrypoint/agent-mcp/*.json"`. This glob is anchored at the *directory*, not a specific filename, so it matches **every** `.json` file sitting directly in `entrypoint/agent-mcp/` — which includes not just `package.json` (presumably the intent) but also `project.json` itself (and any stray `tsconfig*.json` in that same directory). Compare with the sibling entrypoints, all of which scope assets to `*.md` only:
- `entrypoint/decompile-cli/project.json`: `"assets": ["entrypoint/decompile-cli/*.md"]`
- `entrypoint/dispatch-cli/project.json`: `"assets": ["entrypoint/dispatch-cli/*.md"]`
- `entrypoint/apigen-cli/project.json`: `"assets": ["entrypoint/apigen-cli/*.md"]`

The `*.json` asset entry for `agent-mcp` is **also redundant even for its intended purpose**: `@nx/js:tsc`'s `generatePackageJson` option **defaults to `true`** (confirmed: nx.dev tsc executor reference — *"Generate package.json file in the output folder... default `true`"*), and I confirmed `dist/entrypoint/agent-mcp/package.json` already exists with an extra `"module": "./src/index.js"` field that is **not present** in the source `package.json` — the unmistakable signature of `generatePackageJson`'s auto-merge, not a raw asset copy. So the dist `package.json` is already being correctly generated independent of the `assets` glob; the glob is only there accidentally sweeping in `project.json`.

### Fix

1. Delete the stray file: `dist/entrypoint/agent-mcp/project.json` (single literal path, safe to remove directly — it's a build artifact under a gitignored `dist/`, not tracked source).
2. Remove `"entrypoint/agent-mcp/*.json"` from `entrypoint/agent-mcp/project.json`'s `build.assets` array entirely (it's redundant given `generatePackageJson` defaults to `true`).
3. Rebuild (`npx nx build agent-mcp`) and confirm `dist/entrypoint/agent-mcp/project.json` does not reappear, while `dist/entrypoint/agent-mcp/package.json` still does (generated, not asset-copied).

### On `.nxignore` / `workspaceLayout` / excluding `dist/` generally

- `.nxignore` **does not affect project discovery** — only `affected` calculation. Source: [.nxignore reference](https://nx.dev/docs/reference/nxignore) — *"Changes to that file are not taken into account in the `affected` calculations."* Confirmed by community reports too (GitHub discussion #21126, issue #20945): `.nxignore` is explicitly documented as *not* a project-detection exclusion mechanism, despite the name suggesting otherwise. **This repo's existing `.nxignore` (which lists `.claude` for the worktree-duplication reason) does not protect against the `dist/` case at all** — it happens to work for `.claude/` for an unrelated reason (see below), not because `.nxignore` excludes `dist/`.
- The actual mechanism Nx uses to *not* re-discover a normal `dist/` as duplicate projects is that Nx's workspace file-scanning **respects `.gitignore`** when a `.git` directory is present (this repo does have `.git`, and `dist` **is** gitignored — confirmed in `.gitignore` line 4). This is corroborated by nrwl/nx issue #26567 (*"MultipleProjectsWithSameNameError... occurs when Nx encounters a gitignored `dist` directory containing `project.json` files while the `.git` folder is absent"* — i.e. the failure mode is specifically triggered by `.git` being *missing*, implying gitignore-based exclusion is the normal/working path when `.git` is present, as it is here) and issue #20959 (*"Exclude Folders from Project Detection"* — closed not-planned; the Nx team's position is that this should already be handled via workspace-config/gitignore respecting, and they declined to add a first-class dedicated project-exclusion mechanism).
- **Given `dist` is already correctly gitignored and `.git` is present in this repo, the stray `dist/entrypoint/agent-mcp/project.json` should not by itself be enough to trigger `ProjectsWithConflictingNamesError` under normal `.gitignore`-respecting discovery** — meaning the `*.json` assets-glob bug (§2 above) is very likely the complete, sufficient explanation on its own, and the reported error's timing coincidence with editing `targetDefaults` was almost certainly just "that was the next command that forced a full project-graph recomputation," not a causal link to the `targetDefaults` edit itself.
- **NEEDS EMPIRICAL VERIFICATION** (I do not have shell/Bash access in this research session): run `npx nx show projects` on a clean tree *before* making any nx.json edits, with the stray `dist/entrypoint/agent-mcp/project.json` still present, to confirm it alone reproduces `ProjectsWithConflictingNamesError` independent of any `targetDefaults` change. Then delete it per the fix above and re-run to confirm the error clears. This isolates whether the `.gitignore`-respecting discovery path is actually active for this Nx version/invocation mode (Project Crystal's inference-based discovery, introduced "reinforced" in Nx 19 per the Nx 19 blog post, may behave differently pre-19 vs this repo's 18.3.4 — I could not find version-specific documentation confirming exact discovery behavior for 18.3.4 and had no way to execute `nx show projects` myself in this session).
- Belt-and-suspenders recommendation regardless: add `dist` to `.nxignore` too. It won't hurt (worst case, no-op for discovery), and it keeps `dist/` fully out of `affected`-graph consideration as well, which is good hygiene independent of this bug.

## 3. Dependency version rewriting when publishing from dist

**Yes** — `nx release version` with `updateDependents: "auto"` **does** rewrite the intra-family `^2.1.0` workspace deps in the **dist** `package.json`, *provided* the dependent project's own `packageRoot` is configured identically to the bumped project's batch (see the critical batching gotcha in §4 — this is the part that is currently silently broken for `agent-mcp`).

Mechanism, read directly from the installed generator source (`node_modules/@nx/js/src/generators/release-version/release-version.js`):
- Line 65: `const packageJsonPath = join(packageRoot, 'package.json')` — the generator reads/writes the manifest at `packageRoot` (which is `dist/{projectRoot}/package.json` once configured), **not** the source `package.json`, for any project it processes in that invocation.
- Lines 260–268: it resolves `localPackageDependencies` (the intra-workspace dependency graph) and filters for `dependentProjects` — other projects in *this same generator invocation's project list* that depend on the project currently being bumped.
- Lines 294–318: for each dependent, it looks up `dependentPackageRoot = projectNameToPackageRootMap.get(dependentProject.source)` and calls `updateJson(tree, join(dependentPackageRoot, 'package.json'), ...)`, rewriting `json[dependentProject.dependencyCollection][packageName] = versionPrefix + newVersion`. This writes into **whichever `packageRoot` that dependent project itself configured** — i.e., the dist copy, if that's what the dependent's own `project.json` says.

So: how the dist `package.json` is produced in the first place is via `@nx/js:tsc`'s `generatePackageJson: true` (default) + (where configured) `updateBuildableProjectDepsInPackageJson: true` / `buildableProjectDepsInPackageJsonType: "dependencies"` (both present on `entrypoint/decompile-cli/project.json`'s build target as the pattern to follow — `agent-mcp`'s build target currently does **not** set these two flags explicitly, but since `generatePackageJson` already defaults `true` and produces a correct package.json carrying `dependencies`/`main`/`bin` per the verified `dist/entrypoint/agent-mcp/package.json` content, this is not currently broken — just worth setting explicitly for clarity/parity with the other entrypoints). The `files`/`main` fields **do** carry over — confirmed: `dist/entrypoint/agent-mcp/package.json` already has the correct `bin`, `main: "./src/index.js"`, `dependencies`, `license`, `repository`, etc., merged from source plus an auto-added `module` field.

`nx.json`'s existing `release.version.preVersionCommand: "npx nx run-many -t build"` is exactly the correct mechanism ensuring the dist package.json exists on disk *before* the version generator tries to read/write it (the generator hard-errors — `release-version.js` line 70-73 — if no `package.json` exists at the resolved `packageRoot`). Keep this.

## 4. Best practice for the first coordinated multi-package publish

### The critical, non-obvious batching gotcha (verified from installed source, not docs)

`nx release version` batches projects for a single `@nx/js:release-version` generator invocation by **deep-equality** of each project's fully-merged `(generator, generatorOptions)` — confirmed in `node_modules/nx/src/command-line/release/utils/batch-projects-by-generator-config.js`:

```js
const generatorOptions = {
  ...releaseGroup.version.generatorOptions,
  ...project.data.release?.version?.generatorOptions,  // per-project project.json overrides
};
// projects with identical (generator, generatorOptions) share ONE invocation
```

And crucially, `node_modules/nx/src/command-line/release/version.js` (~line 273) passes **only that batch's own project list** as `options.projects` to the generator — *not* the whole release group. This means the cross-project "rewrite my dependents' package.json" logic (§3 above) can only see and touch dependents that are **in the same batch**.

**Consequence for this repo, right now**: because `entrypoint/agent-mcp/project.json` has no `release.version.generatorOptions` at all (empty `{}`), it does **not** deep-equal the 8 dependencies' shared config (`{packageRoot: "dist/{projectRoot}", currentVersionResolver: "git-tag"}`) — so `agent-mcp` gets batched *separately*, using the *default* `packageRoot` (source). The practical effect: **`updateDependents: "auto"` (already set globally in this repo's `nx.json`) will silently fail to cascade a version bump from any of the 8 dependencies into `agent-mcp`'s dependency ranges** — not with an error, just silently skipped, because `agent-mcp` was never in the batch whose `projectNameToPackageRootMap` gets consulted for dependent-rewriting.

This doesn't bite on *this* release only because every package's version is already hand-aligned at `2.1.0` — but it **will** silently break on the very next release where only some of the 8 deps get bumped and `agent-mcp`'s dependency range needs auto-cascading. **Fix now, as part of this same change**: give `agent-mcp` the byte-identical `release.version.generatorOptions` block as its 8 deps (§1's snippet) so it batches together and participates correctly in future dependent-cascades. This is not optional polish — it is a latent correctness bug in the cascade mechanism that should be closed in the same PR as the dist-publish fix, not deferred.

### `--first-release` flag

Confirmed via `node_modules/nx/src/command-line/release/command-object.js`: `--first-release` is registered on the parent `nx release` yargs command (inherited by `version`/`publish`/`changelog` subcommands). Passing it also auto-forces `fallbackCurrentVersionResolver: 'disk'` for that invocation (`release-version.js`: `if (options.firstRelease) options.fallbackCurrentVersionResolver = 'disk'`) — you do not need to separately configure a different `currentVersionResolver` just for the first release; `git-tag` (already configured on the 8 deps) plus `--first-release`'s disk fallback is the correct combination, since there are no prior git tags for this family yet.

Per nx.dev: *"The first time you release with Nx Release in your monorepo, you will need to use the `--first-release` option... tells Nx Release not to expect the existence of any git tags, changelog files, or published packages... After the first release, the `--first-release` option will no longer be required."*

### Ordering / half-published-family risk

`projectsRelationship: "independent"` is already correctly set in this repo's `nx.json`. Release groups (or, absent explicit groups, the whole `release.projects` set) are processed with **topological ordering** — dependencies before dependents — per nx.dev's release-groups docs: *"Groups with no dependencies are processed first... Within each group, projects follow the same topological sorting. This guarantees that dependencies are always versioned and published before their dependents."* This means a single `nx release publish` invocation covering all 9 packages will publish the 8 deps before `agent-mcp` automatically — you do not need a hand-rolled ordering script.

**However**, nx.dev's docs do **not** explicitly document a mechanism to make the *whole* publish step atomic/transactional (i.e. guarantee no external consumer ever observes a partially-published state where dep 3 of 8 is on npm but dep 4 isn't yet, mid-run). Given all 9 packages already publish under one `nx release publish` (or `nx release`) invocation with topological ordering, the exposure window is just the wall-clock duration of that single command — there is no documented atomic-multi-publish primitive beyond that. **This is a real but low residual risk** for a repo this size; if it matters, the standard external mitigation is to publish under a non-`latest` dist-tag first (`nx release publish --tag next`) then promote to `latest` only after all 9 succeed (e.g. `npm dist-tag add @adhd/agent-mcp@2.1.0 latest` per package once the whole batch is confirmed green) — I did not find this exact recipe documented for `nx release` itself; it would be a manual wrapper around it. Flagging as **needs decision, not guessing**: it is compatible with the `tag` option already present on both the version-side (release CLI's own `--tag`... actually the publish executor's `tag` option, see schema in §1) and could be layered in without changing the underlying nx.json/project.json config in §1.

### Recommended command sequence (see §6 for the full checklist)

```bash
npx nx build agent-mcp                                    # sanity: confirm dist/entrypoint/agent-mcp/src/index.js exists post-fix
npx nx show projects                                      # confirm no ProjectsWithConflictingNamesError after §2's fix
npx nx release --first-release --dry-run                  # full dry run: version + changelog + publish preview
# inspect the dry-run output's publish step for each of the 9 packages — confirm every "npm publish" line
# shows a dist/... path, not a source path (entrypoint/agent-mcp/... or packages/agent/.../  without dist/ prefix)
npx nx release --first-release                             # execute for real once dry-run looks correct
```

(`nx release` alone runs version → changelog → publish in one invocation with a confirmation prompt; use `--yes` to skip the prompt in CI, or split into `nx release version --first-release` then `nx release publish --first-release` if you want a manual checkpoint between versioning and publishing.)

## 5. Is `main: ./src/index.js` sane?

**Yes, given `packageRoot: dist/{projectRoot}` is correctly configured** — this is not a design flaw, it just looked broken because `packageRoot` was defaulting to source. Once `packageRoot` resolves to `dist/entrypoint/agent-mcp/`, `main: "./src/index.js"` (resolved relative to the manifest's own directory) correctly points at the compiled `dist/entrypoint/agent-mcp/src/index.js`, which exists because `@nx/js:tsc`'s output preserves the project's internal directory structure (source root `entrypoint/agent-mcp/src/index.ts` → output `dist/entrypoint/agent-mcp/src/index.js`). **No `package.json` change is required to fix the reported bug.**

Tradeoffs worth noting for a future, separate decision (not required for this release):
- **Current pattern (`main` + nested `src/`)**: simple, matches the existing 8 dependency packages exactly (uniformity across the family), works fine for a single default entrypoint.
- **`exports` map alternative**: would let the package explicitly declare only its public entrypoints (`"."`, plus any `bin`-adjacent subpaths) and block deep-path imports like `require('@adhd/agent-mcp/src/internal-thing.js')` — Node.js docs: *"As soon as you use `exports`, it black-boxes your package — no subpaths are accessible by default unless explicitly specified."* None of the 9 packages currently use `exports` (verified: `agent-store-runtime`'s package.json is the only one with an `exports` map among those inspected; `agent-mcp` and `agent-base-types` use bare `main`/`module`/`typings`). This is an inconsistency worth resolving *across the whole family* in a future pass, not a blocker for 2.1.0 — do **not** rewrite `agent-mcp`'s manifest shape unilaterally while leaving 7 of 8 deps on the old pattern; that would just trade one inconsistency for another.
- **`publishConfig`**: already correctly used by the 8 deps (`"publishConfig": {"access": "public"}`) to set public access without a CLI flag (the installed `@nx/js:release-publish` executor schema has no `access` option at all in this Nx version — see §6). `agent-mcp`'s package.json currently has **no `publishConfig`** — worth checking whether the scope `@adhd` needs `access: public` set the same way as its siblings (it's already on npm at 2.0.1, so this was presumably handled correctly before, likely via an npm org default or a one-time `--access public` flag on the very first `npm publish`; for parity and to avoid relying on an implicit npm-org default, add the identical `publishConfig` block to `agent-mcp`'s package.json too).

## 6. Step-by-step first-release sequence with dry-run checkpoints

1. **Fix `entrypoint/agent-mcp/project.json`** — add the `release` block from §1 (identical `packageRoot`/`currentVersionResolver` to the 8 deps) and remove the `"entrypoint/agent-mcp/*.json"` assets glob per §2.
2. **Delete `dist/entrypoint/agent-mcp/project.json`** (the stray file) — single literal path, no variable, no chained removal.
3. **Add `publishConfig: {"access": "public"}` to `entrypoint/agent-mcp/package.json`** for parity with its 8 siblings (§5).
4. `npx nx build agent-mcp` — confirm clean rebuild, and confirm `dist/entrypoint/agent-mcp/project.json` does *not* reappear while `dist/entrypoint/agent-mcp/package.json` does.
5. `npx nx show projects` — **checkpoint**: confirm no `ProjectsWithConflictingNamesError`.
6. `npx nx run-many -t build test --all` — confirm all 9 packages build/test green (this is also what `preVersionCommand` will run).
7. `npx nx release --first-release --dry-run` — **checkpoint**: read the full dry-run output.
   - Confirm the version step shows all 9 packages resolving a current version (via `git-tag` + disk fallback under `--first-release`) and bumping in lock-step or independently as intended.
   - Confirm the version step's dependent-rewrite lines show `agent-mcp`'s dependency ranges being updated when a dep bumps (this exercises the §4 batching fix — if `agent-mcp` doesn't appear as an updated dependent here, the batching config in step 1 didn't take).
   - Confirm the publish step's "would publish from ..." path for **every** package, especially `agent-mcp`, shows a `dist/...` path.
8. `npx nx release --first-release` (or `--yes` in CI) — execute for real.
9. **Post-publish checklist** (per this repo's existing `PUBLISHING.md`): `npm view @adhd/agent-mcp` shows `2.1.0` as `latest`; `npx @adhd/agent-mcp@latest --version` prints the right version; spot-check 2–3 of the 8 deps the same way; run each package's own smoke test per `PUBLISHING.md`'s table.

## 7. Risks / gotchas summary

- **[Fixed by this plan] Publish-from-source** — `agent-mcp` missing `nx-release-publish.options.packageRoot` (§1).
- **[Fixed by this plan] Dist-scan project conflict** — stray `dist/entrypoint/agent-mcp/project.json` from an overly-broad `*.json` assets glob unique to `agent-mcp` (§2).
- **[Fixed by this plan, previously latent/undetected] Silent dependent-cascade miss** — `agent-mcp` batching separately from its 8 deps during `nx release version`, silently defeating `updateDependents: "auto"` for it specifically (§4). This was not asked about directly but is a real, code-verified bug that would have surfaced on the *next* release, not this one, since all 9 versions currently happen to be hand-aligned at 2.1.0.
- **[Needs empirical verification, no Bash access in this research session]** Whether the stray `dist/project.json` file alone (independent of any `targetDefaults` edit) is sufficient to reproduce `ProjectsWithConflictingNamesError` given `dist` is gitignored and `.git` is present — run `npx nx show projects` before and after deleting the stray file to confirm (§2).
- **[Not addressed by any nx.dev doc I could find]** No documented atomic/transactional guarantee across a multi-package `nx release publish` run beyond topological ordering — the exposure window for a "half-published family" is the wall-clock duration of one command, not zero (§4). Flagged as a decision point (dist-tag staging), not a code fix.
- **[Deferred, correctly, per explicit instruction]** `main: ./src/index.js` vs. an `exports` map — not changed, since 7 of 8 deps use the same pattern and rewriting only `agent-mcp` would create a new inconsistency (§5).
- **[Version-mismatch trap for future readers]** Do not follow nx.dev's *current* `manifestRootsToUpdate` guidance against this repo's Nx 18.3.4 install — verify against `node_modules/@nx/js/.../schema.json` directly whenever nx.dev's docs and this repo's pinned version might have drifted (§0).

## Sources

- [Updating Version References in Manifest Files](https://nx.dev/docs/guides/nx-release/updating-version-references) — v21+ `manifestRootsToUpdate` config (does NOT apply to this repo's pinned 18.3.4 — see §0)
- [Nx Release](https://nx.dev/docs/guides/nx-release) — overview
- [.nxignore Reference](https://nx.dev/docs/reference/nxignore) — confirms `.nxignore` only affects `affected`, not project discovery
- [Release Groups](https://nx.dev/docs/guides/nx-release/release-groups) — topological publish ordering, fixed vs independent
- [Update Dependents](https://nx.dev/docs/guides/nx-release/update-dependents) — `updateDependents` semantics (note: current docs describe v22+ defaults, `"always"`; this repo's 18.3.4 default/behavior was verified against installed source instead, §4)
- nrwl/nx GitHub issue [#26567](https://github.com/nrwl/nx/issues/26567) — dist-directory project-name conflicts tied to `.git` absence / gitignore-respecting discovery
- nrwl/nx GitHub issue [#20959](https://github.com/nrwl/nx/issues/20959) — "Exclude Folders from Project Detection," closed not-planned, confirms no dedicated exclusion mechanism beyond gitignore-respecting discovery
- nrwl/nx GitHub issue [#27887](https://github.com/nrwl/nx/issues/27887) — custom dist dir + independent + conventional-commits interaction pitfalls (different failure mode, useful context)
- Installed source (most authoritative for this repo, since it exactly matches the pinned version): `node_modules/@nx/js/src/executors/release-publish/schema.json`, `node_modules/@nx/js/src/generators/release-version/schema.json`, `node_modules/@nx/js/src/generators/release-version/release-version.js`, `node_modules/nx/src/command-line/release/{version,command-object}.js`, `node_modules/nx/src/command-line/release/utils/batch-projects-by-generator-config.js`
- This repo: `nx.json`, `entrypoint/agent-mcp/project.json`, `entrypoint/agent-mcp/package.json`, `packages/agent/agent-store-runtime/project.json` (+ 7 sibling `project.json` files, uniformly configured), `dist/entrypoint/agent-mcp/project.json` (the stray file), `dist/entrypoint/agent-mcp/package.json`, `dist/packages/agent/*/package.json`, `.gitignore`, `.nxignore`, `PUBLISHING.md`
