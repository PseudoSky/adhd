# @adhd/environment-builder (`environment-builder`)

The builder utilities for the `@adhd/environment` family — constructs and validates
environment definitions against `@adhd/environment-base-spec`.

```bash
npm install @adhd/environment-builder
```

## Building & testing

- Build: `nx build environment-builder`
- Test:  `nx test environment-builder`

## Layer resolution and spawned processes

`resolveConfig` applies every file layer that is present, in the order system → global
→ project → local (`src/config-resolver.ts:128-133`, applied in the loop at `:163-170`).
The resolver does not gate layers: the global layer is applied whenever its file exists.
A missing, unreadable or unparseable layer file is skipped without an error
(`readLayerFile` in `src/layer-files.ts:70-83` returns `undefined`; "every layer is optional").

A process spawned from a test or tool inherits the parent's `HOME`, and so reads the same
global layer as the parent. Spawned processes must redirect `HOME` to a throwaway root:

- Inside `entrypoint/backlog`, route the spawn through the test helpers
  `spawn-isolated-bin` or `spawn-backlog-bin` (`entrypoint/backlog/src/test/helpers/`).
  They are repo-internal test helpers: the published `@adhd/backlog` package ships only
  `dist`, `CHANGELOG` and `skill`, so other packages cannot import them.
- Everywhere else, set `HOME` explicitly in the child env of the spawn call, for example
  `spawn(process.execPath, [bin], { env: { ...process.env, HOME: tmpHome } })`.

The repo-wide guard `tools/nx-plugins/test/executors/wiring/check-spawn-isolation.mjs`
(rule 9 of the lane-reachability check) judges each spawn call of a Node bin
(`process.execPath`, `node`, `fork(module)`) in a spec, test or e2e file of an
`@adhd/environment`-family package: the call itself must carry a `HOME` override or an
isolation-helper use. A `HOME` key elsewhere in the file does not count. Spawn sites that
predate the guard are recorded per file, with a site count, in `spawn-isolation.baseline.json`
(19 files at the time of writing). A file with more unrouted sites than its recorded count
fails the check, as does a recorded count that is higher than the sites that remain, so a
fixed site must be removed from the baseline; adding a file or raising a count is a
reviewed edit of that JSON.

## `@adhd/environment` family — naming map

| directory | nx project name | distribution name | registry | import specifier |
|-----------|-----------------|-------------------|----------|------------------|
| `packages/environment/environment-base-spec` | `environment-base-spec` | `@adhd/environment-base-spec` | npm | `@adhd/environment-base-spec` |
| `packages/environment/environment-builder` | `environment-builder` | `@adhd/environment-builder` | npm | `@adhd/environment-builder` |
| `packages/environment/environment-core-node` | `environment-core-node` | `@adhd/environment` | npm | `@adhd/environment` |
| `packages/environment/environment-core-py` | `environment-core-py` | `adhd-environment` | PyPI | `import adhd_environment` |
| `packages/environment/environment-core-rs` | `environment-core-rs` | `adhd-environment` | crates.io | `use adhd_environment;` (crate `adhd-environment`) |
| `entrypoint/environment-cli` | `environment-cli` | `@adhd/environment-cli` | npm | `@adhd/environment-cli` |

`environment-core-node` publishes to npm under the deliberate unprefixed alias
`@adhd/environment`; the PyPI/crates.io runtimes mirror it as `adhd-environment`.
Full rationale in the headline package README
(`packages/environment/environment-core-node/README.md`).

### Renames performed in this task

**None** — all names already conformed. `environment-core-py` and
`environment-core-rs` had their `project.json` (nx project name) assigned for the
first time; this README's header was also corrected from the stock doubled name
`environment-environment-core-builder`.
