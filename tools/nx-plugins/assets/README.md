# @adhd/nx-assets

`assets` target (`dependsOn:["build"]`, cached): copies README.md + CHANGELOG.md (if present) + any files
listed in the package's own `package.json` `"assets"` array into `{projectRoot}/dist`, flattening every
destination to its basename — declared in `package.json` (data), not `project.json`.

**Why this exists:** `@adhd/nx-build:publish` runs `npm publish {projectRoot}/dist` — npm treats that
directory itself as the package root, so a source-root README.md is invisible to it. Nothing ships
without physically living inside `dist/` first.

**Consumers (must depend on this, not just `build`):** `version` (its bump decision diffs `dist/`
against the published npm tarball — a bare `build` alone is missing docs the tarball already has,
which reads as a false "changed") and `dist-manifest` (whose own consumers, `publish-hygiene` and
`publish`, inherit the dependency transitively). See
[`tools/nx-plugins/build/README.md`](../build/README.md) for the full target chain.
