# docs-steward

**Phase:** docs · **Kind:** work · **Depends on:** audit-final · **Guard:** `true`

---

## Goal

Full consumer-facing documentation is written — README, API docs, usage guides with real examples (not just verification-focused demo output). Documents show the `new Environment<Config>({ project, namespace })` pattern, `adhd-env set` workflow, and cross-language usage. All docs reference the demo for acceptance verification.

---

## Acceptance criteria

- [docs-steward.1] Package READMEs exist for environment-core-node, environment-cli, environment-core-py, environment-core-rs
- [docs-steward.2] README includes `new Environment({ project, namespace })` code example with typed config
- [docs-steward.3] README includes `adhd-env set` and `adhd-env build` workflow example
- [docs-steward.4] README links to `docs/plan/adhd-environment/demo/DEMO.md` for acceptance verification
- [docs-steward.5] Python and Rust READMEs show equivalent usage to TypeScript
- [docs-steward.6] All code examples are runnable (not pseudo-code)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/adhd-environment/demo/DEMO.md", "docs/plan/adhd-environment/USE_CASES.md"]
```

---

## Notes for executor

1. Focus on consumer-friendly examples, not verification-focused output.
2. Each example should tell a story: "Samira defines her config → builds → reads at runtime."
3. Cross-reference the demo but don't duplicate it — demo is for verification, docs are for onboarding.
4. Use the actual package names: `@adhd/environment`, `adhd-environment` (PyPI), `adhd-environment` (crates.io).