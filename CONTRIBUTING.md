# Contributing to @adhd

Thank you for your interest in contributing! This document outlines the process for submitting changes.

## Development Workflow

1. **Fork and clone** the repository
2. **Create a feature branch** from `main`
3. **Make your changes** following the conventions in [AGENTS.md](AGENTS.md)
4. **Run tests** — all tests must pass (`pnpm test`)
5. **Submit a pull request** with a clear description of your changes

## Code Standards

- Follow the naming conventions in [AGENTS.md §9](AGENTS.md#-9-code-style--standards)
- All public functions must have JSDoc comments
- Write tests for new features using the verification standard in [AGENTS.md §7](AGENTS.md#-7-testing-protocol)
- Run `pnpm lint` to check your code style

## Package Scaffolding

Use the workspace generator to create new packages:

```bash
npx nx g @adhd/workspace-codegen-nx:<tier> \
  --name=<name> --group=<domain> \
  --nxLayer=<layer> --platform=<platform> \
  --dry-run
```

See [AGENTS.md §1](AGENTS.md#-1-package-scaffolding--always-use-adhd-workspace-codegen-nx) for details.

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for the version-bump and publish workflow.

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](LICENSE)).
