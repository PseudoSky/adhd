# Release order

Evidence for every value below is in `docs/plan/stealth-browser/release-readiness/` and the cutover evidence.

1. Publish `@adhd/apigen-engine-runtime` first. The registry's 0.3.5 lacks `buildApigenPackage`, while the worktree's 0.3.5 has it (`packages/apigen/apigen-engine-runtime/src/lib/build-apigen-package.ts`, re-exported from `src/index.ts`). Evidence: `docs/plan/stealth-browser/evidence/cutover/tarballs.json` (`cutover-apigen-engine-runtime-0.3.5.tgz`) and graph item `c4afebb0`.
2. Bump `entrypoint/stealth-search`'s `@adhd/apigen-engine-runtime` range from `CURRENT-RANGE` to `PLANNED-RANGE`, before publishing `@adhd/stealth-core-browser` and `@adhd/stealth-search`. Then `pnpm check:release-ranges` must exit 0. The current range `^0.3.3` admits the broken registry 0.3.5, so this bump is mandatory.

REGISTRY-VERSION: 0.3.5
WORKTREE-VERSION: 0.3.5
CURRENT-RANGE: ^0.3.3
PLANNED-VERSION: UNRESOLVED
PLANNED-RANGE: UNRESOLVED

`PLANNED-VERSION` is unresolved because `release-readiness/release-dry.log.md` (extracted from the `pnpm release:dry` run, exit 0) contains no `bumping to` or `would write` line and no version for `@adhd/apigen-engine-runtime`. `PLANNED-RANGE` follows it as `^<PLANNED-VERSION>`.
