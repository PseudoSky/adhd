# @adhd/environment-cli (`environment-cli`)

The CLI entrypoint for the `@adhd/environment` family — scaffolds and drives
environment definitions from the terminal.

```bash
npm install @adhd/environment-cli
```

## Building & testing

- Build: `nx build environment-cli`
- Test:  `nx test environment-cli`

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
first time; no name was changed.
