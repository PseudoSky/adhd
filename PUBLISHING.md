# Publishing Playbook

How to version, build, and publish packages in this monorepo to npm.

---

## Prerequisites

- `npm login` — confirm with `npm whoami`
- npm account must have 2FA enabled; use an **automation token** for CI (bypasses OTP), or have your authenticator app ready for local publishes

---

## Steps

### 1. Build

```bash
npx nx build <project-name>          # single package
npx nx run-many -t build --all       # everything
```

### 2. Bump version

```bash
cd packages/<path>/<name>
npm version patch   # or minor / major
```

Then rebuild so `dist/` picks up the new version:

```bash
cd <repo-root>
npx nx build <project-name>
```

### 3. Publish

**Preferred — `nx release publish` (enforces a clean build + tests first).**

```bash
npx nx release publish --projects=<name>          # add --dry-run to preview
```

The `nx-release-publish` target has `dependsOn: ["build", "test"]` (see each
publishable project's `project.json`, plus the `nx.json` `targetDefaults`
baseline). Because the `build` target runs with `clean: true` (it wipes `dist/`
and recompiles from source), **publishing always rebuilds from source and runs
the test suite first** — a stray manual edit in `dist/` can never be published,
and a red test suite blocks the release. This is the required path.

**Manual fallback** (only if `nx release` is unavailable — does NOT enforce the
clean-build/test gate, so run the build + tests yourself first):

```bash
npx nx build <name> && npx nx test <name>
npm publish dist/packages/<path>/<name> --access public
# If prompted for OTP: add --otp=<code>
```

### 4. Commit version bump

```bash
git add packages/<path>/<name>/package.json
git commit -m "chore(<name>): bump to <version>"
git push origin main
```

---

## CI publish (automated)

Merging a PR to `main` triggers `.github/workflows/pull-request.yml`, which runs
`npx nx affected -t publish` on affected libraries. This requires `NPM_TOKEN` to
be set as a GitHub Actions secret using an **automation token** (no OTP required).

To create an automation token: npmjs.com → Avatar → Access Tokens → Generate New Token → **Automation**.

---

## Post-publish checklist

After publishing any package, verify it works end-to-end:

- [ ] `npm view @adhd/<name>` shows the new version as `latest`
- [ ] `npx @adhd/<name>@latest --version` (for CLI packages) prints the correct version
- [ ] Check the package's own publishing doc for integration smoke tests:

Each published package maintains a `PUBLISHING.md` in its source directory with
package-specific verification steps. Check there for the full smoke-test procedure.

| Package | Publishing doc |
|---|---|
| `@adhd/agent-mcp` | [`packages/ai/agent-mcp/PUBLISHING.md`](packages/ai/agent-mcp/PUBLISHING.md) |
| `@adhd/agent-mcp-types` | (no integration test required — types only) |

---

## Troubleshooting

| Error | Fix |
|---|---|
| `You cannot publish over the previously published versions` | Forgot to rebuild after `npm version` — run `npx nx build <name>` then republish |
| `EOTP` | Need OTP from authenticator app, or switch to an automation token |
| `E401 Unauthorized` | Run `npm login` first |
| `dist/` has wrong version | Always rebuild after bumping `package.json` |
