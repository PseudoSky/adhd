# Metrics — @adhd/apigen-cli

## run e06cd25 — 2026-07-03T02:36:43-05:00

metric_1_eliminated_reader_searches: 6
metric_2_feature_delta: discovered=21 added=21 deprecated=0
metric_3_doc_junk_ratio: junk=8% redundant=5% undocumented=40%
notes: Initial catalog run. No prior capabilities.json to diff against (all 21 are 'added'). README stale: old monorepo paths, missing `serve` command, missing `--use`/`--config`/`--v2` flags. 6 reader searches required source fallback — primarily around undocumented serve command and --use/--v2/--config flags.

### Breakdown of reader searches (per-file fallback):
1. `src/index.ts` — to discover all plugin types (py-flask, py-grpc undocumented in README)
2. `src/lib/commands/serve.ts` — entire serve command undocumented
3. `src/lib/commands/run.ts` (loadUsePlugins) — --use flag behavior undocumented
4. `src/lib/orchestrator.ts` — --v2 flag behavior undocumented
5. `src/lib/orchestrator.ts` (loadOverrideConfig) — --config flag behavior undocumented
6. `src/lib/scaffold.ts` — --link-workspace behavior undocumented

## run e06cd25 — 2026-07-03T02:36:43-05:00 (post-rewrite assessment)

metric_1_eliminated_reader_searches: 0
metric_2_feature_delta: discovered=21 added=0 deprecated=0
metric_3_doc_junk_ratio: junk=0% redundant=<5% undocumented=0%
notes: Post-rewrite assessment. All 6 original reader searches ELIMINATED. All 21 capabilities now documented in README. Doc conformance: ALL docs assessed — 0% junk across surface, <5% intentional redundancy (AGENTS.md/llms.txt overlap with README by design for different audiences), 0% undocumented capabilities. The steward's rewrite closed all gaps: serve command section, --use/--config/--v2/--link-workspace coverage, full plugin table with py-flask/py-grpc, fail-fast guards section, architectural details. No new source fallbacks required. Minor observation: logging flags declared on all commands but serve.ts action handler does not call buildCliLogger() — the flags are on the root Commander program and technically accessible via inheritance but not consumed by serve. This is a very minor implementation gap, not a doc gap.

### Original 6 searches — now all eliminated:
1. ~~`src/index.ts` — plugin types~~ → README plugin table has all 7 types ✓
2. ~~`src/lib/commands/serve.ts` — serve command~~ → README serve section has full docs ✓
3. ~~`src/lib/commands/run.ts` — --use flag~~ → README `--use` section with examples ✓
4. ~~`src/lib/orchestrator.ts` — --v2 flag~~ → README `--v2` section with pipeline steps ✓
5. ~~`src/lib/orchestrator.ts` — --config flag~~ → README `--config` section with precedence ✓
6. ~~`src/lib/scaffold.ts` — --link-workspace~~ → README `--link-workspace` section ✓
