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
The resolver does not gate layers: the global layer is applied whenever its file exists,
and an absent global file resolves silently.

A process spawned from a test or tool inherits the parent's `HOME`, and so reads the same
global layer as the parent. Spawned processes must redirect `HOME`: route the spawn through
an isolation helper (`spawn-isolated-bin` or `spawn-backlog-bin` in `@adhd/backlog`), or set
`HOME` explicitly in the child env. The repo-wide guard
`tools/nx-plugins/test/executors/wiring/check-spawn-isolation.mjs` (rule 9 of the
lane-reachability check) fails any spec or e2e file that spawns a Node bin in an
`@adhd/environment`-family package without one of these.

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
