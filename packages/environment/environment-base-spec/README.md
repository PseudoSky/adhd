# @adhd/environment-base-spec (`environment-base-spec`)

The shared type/schema spec for the `@adhd/environment` family — the platform-neutral
foundation the Node, Python, and Rust runtimes implement against.

```bash
npm install @adhd/environment-base-spec
```

## Building & testing

- Build: `nx build environment-base-spec`
- Test:  `nx test environment-base-spec`

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
`environment-environment-base-spec`.
