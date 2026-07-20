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
# Patch bumps (patch) on all packages with changes since last tag
npx nx release patch --dry-run   # preview
npx nx release patch             # execute (no --dry-run)

# Minor/major bumps (specify if needed)
npx nx release minor --dry-run
npx nx release major --dry-run
```

**What happens:** `nx release version` does the following:
- Scans git history from each project's **last git tag** (`{projectName}@{version}`) forward
- Projects with zero commits since last tag are **skipped** (not re-released)
- Projects with commits use **conventional commit analysis** to determine bump: `fix()` → patch, `feat()` → minor, `BREAKING CHANGE` → major
- Bumps `package.json` version in each affected project
- Generates per-project `CHANGELOG.md` and workspace `CHANGELOG.md` from commit messages
- Tags each project with its new tag: `@adhd/agent-mcp@1.2.3`, `@adhd/apigen-cli@2.0.0`, etc.
- Updates internal cross-project dependencies (`updateDependents: "auto"`)

### 2. Publish (build, test, verify-dist-load, push to npm)

```bash
npx nx release publish --dry-run   # preview
npx nx release publish             # execute (no --dry-run)
```

**What happens:** For each versioned project:
- Runs `build` target (clean rebuild from source)
- Runs `test` target
- Runs `verify-dist-load` gate (custom build artifact validation)
- Publishes to npm with metadata from CHANGELOG.md
- Git push of tags (if commit flag is enabled; currently set to `false` — manual push required)

#### Selective publishing

To version/publish only changed packages in a specific domain:

```bash
npx nx release patch --projects='agent-*' --dry-run
npx nx release patch --projects='agent-*'
npx nx release publish --projects='agent-*' --dry-run
```

### 3. Single-package workflow (for leaf packages with no dependents)

To release one package without cascading:

```bash
npx nx release patch --projects=<exact-project-name> --dry-run
npx nx release patch --projects=<exact-project-name>
npx nx release publish --dry-run
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

The CI workflow (`.github/workflows/pull-request.yml`) runs:

```bash
npx nx release version --dry-run
npx nx release publish --dry-run  # if version succeeded
```

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
| `dist/` missing package.json or has wrong version | `nx release publish` always rebuilds. If you edited `dist/` manually, delete it and re-run `npx nx release publish`. |
| `No projects to release` | All projects are up-to-date (no commits since last tag). Create a test commit (`chore:` prefix won't trigger a bump, but `fix:` will) or force a specific version with `--force-publish`. |
| `The project X does not have a package.json at dist/...` | Project needs to be built first. The `nx-release-publish` target includes `dependsOn: ["build"]`, so if build fails, publish will fail. Run `npx nx build <project>` to see the real error. |
| `updateDependents did not bump dependent packages` | `updateDependents: "auto"` only triggers when versioning a base package. If you bump a leaf package manually and its consumers don't change, consumers stay at their old versions. This is intentional — base packages (e.g., `-base-types`, `-core-policy`) are candidates for auto-cascade. |
