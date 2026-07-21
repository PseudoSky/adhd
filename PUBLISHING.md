# Publishing Playbook

How to version, build, and publish packages in this monorepo to npm.

**This workflow uses `nx release` for independent per-package versioning.** Each package is versioned independently based on commits since its last `{projectName}@{version}` git tag. Only packages with changes since their last publish are selected for release.

---

## Prerequisites

- `npm login` — confirm with `npm whoami`
- npm account must have 2FA enabled; use an **automation token** for CI (bypasses OTP), or have your authenticator app ready for local publishes

---

## Workflow: Independent per-package versioning

### 1. Version (compute what changed, bump versions, generate changelogs)

```bash
# CHANGED-ONLY (the normal path): NO explicit specifier. Conventional commits
# decide each package's bump; packages with no commits since their tag are SKIPPED.
npx nx release version --dry-run   # preview — only changed packages bump
npx nx release version             # execute (no --dry-run)
```

> ⚠️ **`nx release patch|minor|major` does NOT mean "changed-only".** An **explicit**
> specifier (`patch`/`minor`/`major`) **force-bumps EVERY project in the release group**,
> bypassing change-detection entirely (verified by dry-run 2026-07-20). Use it only when
> you deliberately want to bump everything to the same level. For "only what changed since
> last publish", run the **bare** `npx nx release version` (or the top-level `npx nx release`)
> and let `specifierSource: conventional-commits` pick each package's bump. If you want to
> force a level on *only the changed* packages, combine with `--projects` (see Selective).

**What happens (bare `nx release version`):**
- Scans git history from each project's **last git tag** forward. The tag pattern is
  **`{projectName}@{version}` — the UNSCOPED nx project name**, e.g. `agent-mcp@2.1.1`,
  `apigen-cli@0.1.0` (NOT `@adhd/agent-mcp@…`; the `@adhd/` scope is the npm name, not the tag).
- Projects with zero commits since last tag are **skipped** (`🚫 No changes were detected … Skipping`).
- Projects with commits use **conventional commit analysis** to determine bump: `fix()` → patch, `feat()` → minor, `BREAKING CHANGE` → major.
- Bumps `package.json` version in each affected project; generates per-project + workspace `CHANGELOG.md`.
- Tags each bumped project `{projectName}@{newVersion}` and updates internal cross-project dependencies (`updateDependents: "auto"`).

> **Baseline requirement (one-time):** change-detection needs a `{projectName}@{version}`
> tag per project as its diff baseline. With **no tags**, `currentVersionResolver:git-tag`
> falls back to disk and resolves bumps from the *entire* history → the first release touches
> everything. Baseline tags for all 52 release-group projects were established locally at their
> current disk versions on 2026-07-20 (see `DEBT-RELEASE-BASELINE-TAGS-001`); **they are LOCAL
> until pushed** (`git push --tags`, human-approved) — CI won't see changed-only until then.
> Bootstrapping a fresh clone instead: `npx nx release --first-release`.

### 2. Publish (build, test, verify-dist-load, push to npm)

> ⚠️ **Never call `npx nx release publish` directly when you're passing `--projects=`.**
> `nx release publish --projects=<explicit list>` is a **confirmed upstream Nx bug**
> ([nrwl/nx#22720](https://github.com/nrwl/nx/issues/22720),
> [nrwl/nx#27749](https://github.com/nrwl/nx/issues/27749),
> [nrwl/nx#30552](https://github.com/nrwl/nx/issues/30552)) — it silently skips every
> project's `nx-release-publish.dependsOn` (`build`, `test`, `verify-dist-load`) and
> goes straight to `npm publish`. Reproduced directly in this repo 2026-07-20: with
> `apigen-plugin-mcp`/`apigen-plugin-openapi`'s dist bundles broken,
> `nx release publish --projects=apigen-plugin-mcp,apigen-plugin-openapi --dry-run`
> printed "Would publish" for both — zero build/test/verify-dist-load tasks ran. See
> `BACKLOG.md`/`CHANGELOG.md` `BUG-RELEASE-PUBLISH-GATE-BYPASS-001`. (Unfiltered
> `nx release publish`, with no `--projects`, does not have this problem — but use
> the wrapper below anyway so "which invocation is safe" lives in one place, not in
> every engineer's memory.)
>
> **Always publish through `scripts/release-publish.mjs`** — it routes a `--projects=`
> call through `nx run-many -t nx-release-publish` (which DOES honor `dependsOn`,
> proven both empirically and by the upstream issues above) and an unfiltered call
> through plain `nx release publish` (proven safe). Every other flag passes through
> unchanged, and the exit code is the real gate result — non-zero means nothing
> published.

```bash
node scripts/release-publish.mjs --dry-run   # preview (full release set)
node scripts/release-publish.mjs             # execute (no --dry-run)

node scripts/release-publish.mjs --dry-run --projects=agent-mcp,apigen-cli   # selective preview
node scripts/release-publish.mjs --projects=agent-mcp,apigen-cli            # selective execute
```

**What happens:** For each versioned project:
- Runs `build` target (clean rebuild from source)
- Runs `test` target
- Runs `verify-dist-load` gate (custom build artifact validation)
- Publishes to npm with metadata from CHANGELOG.md
- Git push of tags (if commit flag is enabled; currently set to `false` — manual push required)

If any of `build`/`test`/`verify-dist-load` fails for any selected project,
`scripts/release-publish.mjs` exits non-zero and **nothing is published** — that
includes the projects that passed; nx's task graph fails the whole run rather than
partially publishing.

#### Selective publishing

To version/publish only changed packages in a specific domain:

```bash
npx nx release patch --projects='agent-*' --dry-run
npx nx release patch --projects='agent-*'
node scripts/release-publish.mjs --projects='agent-*' --dry-run
```

### 3. Single-package workflow (for leaf packages with no dependents)

To release one package without cascading:

```bash
npx nx release patch --projects=<exact-project-name> --dry-run
npx nx release patch --projects=<exact-project-name>
node scripts/release-publish.mjs --dry-run
```

For packages that depend on the one you just released, they are **not** automatically versioned. 
Use `updateDependents: "auto"` (already configured) to cascade when needed — re-run version for 
the base package to bump all consumers.

### 4. Manual versioning fallback (only if `nx release` is unavailable)

Do **not** use this unless absolutely necessary. It bypasses the build/test gates:

```bash
npx nx build <name> && npx nx test <name>
npm publish dist/<path>/<name> --access public
# If prompted for OTP: add --otp=<code>
```

---

## How "only what changed" is determined

**Git tags are the source of truth.** When you run `nx release version`, it:

1. **Finds each project's last release tag:** Looks for the most recent tag matching `{projectName}@*` (e.g., `agent-mcp@1.2.3`)
2. **Scans commits since that tag:** Uses git log from that tag to HEAD
3. **Skips projects with zero commits:** If a project has no commits since its tag, it's not included in the release
4. **Analyzes commit type:** Uses the scope and type in conventional commits to determine version bump

**Example:**
- `agent-mcp@1.2.0` tag exists from 2 weeks ago
- Since then: 5 new commits to agent-mcp (2 `fix(...)`, 3 `feat(...)`)
- Result: agent-mcp is bumped to 1.3.0 (minor)

- `apigen-core-client@2.1.5` tag exists from 2 weeks ago
- Since then: zero commits to apigen-core-client
- Result: apigen-core-client is **skipped** in this release (no new version, no publish)

---

## CI publish (automated)

> ⚠️ **This section previously described intended behavior, not actual behavior —
> corrected 2026-07-20.** The CI workflow (`.github/workflows/pull-request.yml`,
> `Publish` step) does **not** call `nx release` at all. It calls the **legacy**
> `nx affected -t version` / `-t publish` targets (the `version`/`publish`
> `targetDefaults` in `nx.json`, which predate the `nx release` migration), and
> those targets' production configuration hardcodes `npm publish dist/libs/core` —
> a path with no corresponding project anywhere in this workspace. If this job
> ever actually ran with affected libraries present, it would fail outright. It
> gets **none** of the `verify-dist-load` gating this doc describes above. See
> `BACKLOG.md` `BUG-CI-PUBLISH-STALE-TARGETS-001` — rewiring CI's `Publish` step to
> call `node scripts/release-publish.mjs` is filed but not yet done (it's a live
> npm-publishing job gated by the `NPM_TOKEN` secret; needs explicit human sign-off
> before changing).
>
> **Until that's fixed, do not rely on CI to publish correctly.** Publish locally
> via `node scripts/release-publish.mjs` (§2 above) and verify the dry-run output
> yourself.

This requires `NPM_TOKEN` to be set as a GitHub Actions secret using an **automation token** (no OTP required).

To create an automation token: npmjs.com → Avatar → Access Tokens → Generate New Token → **Automation**.

---

## Post-publish checklist

After publishing any package, verify it works end-to-end:

- [ ] `npm view @adhd/<name>` shows the new version as `latest`
- [ ] `npx @adhd/<name>@latest --version` (for CLI packages) prints the correct version
- [ ] Verify git tags were created: `git tag | grep @adhd/<name>@` should show `{projectName}@{version}`
- [ ] Check the package's own publishing doc for integration smoke tests:

Each published package maintains a `PUBLISHING.md` in its source directory with
package-specific verification steps. Check there for the full smoke-test procedure.

| Package | Publishing doc |
|---|---|
| `@adhd/agent-mcp` | [`entrypoint/agent-mcp/PUBLISHING.md`](entrypoint/agent-mcp/PUBLISHING.md) |
| `@adhd/apigen-cli` | [`entrypoint/apigen-cli/PUBLISHING.md`](entrypoint/apigen-cli/PUBLISHING.md) |

---

## Troubleshooting

| Error | Fix |
|---|---|
| `You cannot publish over the previously published versions` | Package was already published at that version. Check `npm view @adhd/<name> versions` to confirm. Delete the tag locally with `git tag -d <tag>` and re-run release, or bump to a higher version. |
| `EOTP` | Need OTP from authenticator app, or switch to an automation token. |
| `E401 Unauthorized` | Run `npm login` first. |
| `dist/` missing package.json or has wrong version | `nx release publish` (and `scripts/release-publish.mjs`, when NOT given `--projects`) always rebuilds. If you edited `dist/` manually, delete it and re-run `node scripts/release-publish.mjs`. |
| `No projects to release` | All projects are up-to-date (no commits since last tag). Create a test commit (`chore:` prefix won't trigger a bump, but `fix:` will) or force a specific version with `--force-publish`. |
| `The project X does not have a package.json at dist/...` | Project needs to be built first. The `nx-release-publish` target includes `dependsOn: ["build"]`, so if build fails, publish will fail — but only if you published via `scripts/release-publish.mjs` or unfiltered `nx release publish`. `nx release publish --projects=` skips this dependsOn entirely (`BUG-RELEASE-PUBLISH-GATE-BYPASS-001`) and would instead fail with a raw `ENOENT` reading `dist/.../package.json` — another reason to always use `scripts/release-publish.mjs`. Run `npx nx build <project>` to see the real build error. |
| `updateDependents did not bump dependent packages` | `updateDependents: "auto"` only triggers when versioning a base package. If you bump a leaf package manually and its consumers don't change, consumers stay at their old versions. This is intentional — base packages (e.g., `-base-types`, `-core-policy`) are candidates for auto-cascade. |
