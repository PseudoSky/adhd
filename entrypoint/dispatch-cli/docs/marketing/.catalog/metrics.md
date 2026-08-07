# dispatch-cli Documentation Metrics

## run 936d50dc — 2026-07-24T22:01:35-05:00

metric_1_eliminated_reader_searches: 1
- **1 fallback:** README.md references stale paths (`packages/dispatch/` instead of `entrypoint/`). The `cli-smoke.spec.ts` file had to be read to discover the actual path to the generated CLI artifact (`dist/entrypoint/dispatch-cli/cli/cli.ts`) because the README cites `dist/packages/dispatch/dispatch-cli/cli/cli.ts`.

metric_2_feature_delta: discovered=12 added=12 deprecated=0
- All 12 capabilities are newly cataloged (first run). None existed in a prior `capabilities.json`.

metric_3_doc_junk_ratio: junk=8% redundant=8% undocumented=15%
- 1 of 3 existing docs has stale paths (JUNK)
- 1 doc (CHANGELOG.md) is version-bump boilerplate only (REDUNDANT)
- 2 of 5 ideal docs are missing entirely (UNDOCUMENTED: SPEC.md, DESIGN.md)
- Coverage of ideal doc set: 40% (2 of 5)
- The single existing substantive doc (README.md) is high-quality

notes: First catalog run for dispatch-cli scope. All 30 tests pass. 7 CLI operations verified working through bin/cli.ts. apigen-generated CLI is a partial surface (2/7 commands). No bin entry in package.json prevents npx usage. README is comprehensive but has stale path references. No docs/ directory exists under the package.
