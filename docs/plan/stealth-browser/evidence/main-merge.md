# main-merge evidence

MAIN-SHA: e21558fc1e735b8eb3c9bfb10d229a48fd8cf9c5
MERGE-SHA: eb6526ed922e2d6cb0226a9215c418ee20d54695
PARENTS: cbf847657445c6f64322af4b723970cf9781d44d (stealth-browser), e21558fc1e735b8eb3c9bfb10d229a48fd8cf9c5 (main)

## Resolutions

- `.adhd/workspace.json`: groups are `environment`, `policy` (main), `resilience` and `stealth` (branch), `ui-react`, `workspace`. Parses as JSON.
- `tsconfig.base.json`: union of main's `@adhd/policy-core-client`, `@adhd/policy`, `@adhd/apigen-plugin-policy` and the branch's `@adhd/resilience-core-tripwire`, `@adhd/stealth-core-browser`, `@adhd/stealth-search`. The main `apigen-engine-runtime/test/helpers/parity-harness.ts` path is kept. Parses as JSON.
- `pnpm-lock.yaml`: taken from main (`git checkout --theirs`), then regenerated with `pnpm install --lockfile-only` (pnpm 8.15.9). The `stealth-core-browser` importer resolves `@adhd/sox-service-proxy` `~0.6.0` to `0.6.0` with integrity `sha512-Mp8eKTr9...`. The lockfile has no `adhd-dev-tarballs` and no `file:/Users` references.
- `package.json`: equals main. The root `pnpm.overrides` has no `@adhd/sox-service-proxy` entry.

## Verification

EXIT pnpm install --frozen-lockfile: 0
EXIT nx run-many -t build -p stealth-core-browser,stealth-search,resilience-core-tripwire: 0
EXIT nx run-many -t typecheck -p stealth-core-browser,stealth-search,resilience-core-tripwire: 0
