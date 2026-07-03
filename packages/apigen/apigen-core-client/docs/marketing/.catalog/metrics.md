# Metrics — @adhd/apigen-core-client

## run c8e58de — 2026-07-02T22:35:00-05:00
metric_1_eliminated_reader_searches: 5
metric_2_feature_delta: discovered=19 added=19 deprecated=0
metric_3_doc_junk_ratio: junk=0% redundant=0% undocumented=63%
notes: First catalog run. README covers 7 of 19 capabilities well (generateSchemas, composeSchemas, OutputPlugin, ExtractionSession, caching) but completely omits extract, extractClasses, tokenize, source-language routing, Plugin v2, descriptor types, and schema builders. No CHANGELOG, AGENTS.md, llms.txt, or API reference exist. All 208 tests pass.

## run c8e58de — 2026-07-02T23:53:00-05:00 (after doc steward rewrite)
metric_1_eliminated_reader_searches: 0
metric_2_feature_delta: discovered=19 added=0 deprecated=0
metric_3_doc_junk_ratio: junk=0% redundant=0% undocumented=5%
notes: Post-rewrite follow-up. Doc surface expanded from 1 file (73-line README) to 14 files across Diátaxis quadrants (README 238 lines, CHANGELOG, AGENTS, llms.txt, LICENSE, 7 reference docs, 2 how-to guides). All 208 tests still pass (code unchanged). Two minor factual errors found: README line 7 understates runtime dependencies (omits ts-json-schema-generator), CHANGELOG line 24 says "x-apigen-nominal" instead of "x-apigen-logical" for buildNominalSchema. Single remaining undocumented capability: apigenCore (trivial identity fn, substance: trivial). All dead links resolved. Internal schema builders appropriately documented as internal in CHANGELOG.
