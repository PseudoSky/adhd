# search-tracing-fixes evidence

Specs (test/unit/hosts/): search-tracing-unknown-provider.spec.ts [search-tracing-fixes.1], search-tracing-rejected-flag.spec.ts [search-tracing-fixes.2], search-tracing-single-error.spec.ts [search-tracing-fixes.3].

## Red (untouched source, 7 failed | 1 passed of 8)

RED: [search-tracing-fixes.1] UNKNOWN_PROVIDER cli span: AssertionError: expected 'HOST_FLAG_INVALID: --provider: "not-a...' to contain 'UNKNOWN_PROVIDER'
RED: [search-tracing-fixes.1] UNKNOWN_PROVIDER mcp span: AssertionError: expected { res: { _meta: { ... }, ... } } to have property "err" (the enum rejected the call as an isError tool result before the verb ran)
RED: [search-tracing-fixes.1] provider input enum: AssertionError: search: expected '{"$schema":...,"enum":["duckduckgo","google",...]' not to match /"enum"|"const"|anyOf|oneOf/
RED: [search-tracing-fixes.2] rejected flag span before flag validation: AssertionError: expected [] to deeply equal [ { role: 'cli', logDir } ] (telemetry never started)
RED: [search-tracing-fixes.2] rejected flag span (unknown verb flag): AssertionError: expected [] to deeply equal [ start, error ] (no span)
RED: [search-tracing-fixes.3] duplicate adhd.op.error (CLI): AssertionError: expected [ 'adhd.op.error', ... ] to deeply equal [ 'adhd.stealth/chrome-status.error' ]
RED: [search-tracing-fixes.3] duplicate adhd.op.error op id (layer): AssertionError: expected [ 'adhd.op.error' ] to deeply equal [ 'adhd.stealth/probe.start', 'adhd.stealth/probe.error' ]
(help is not a dispatch passed on the untouched source, as it must: it guards against a regression.)

## Decision

The shared apigen tracing plugin is restored in src/tracing.ts as `makeTracingPlugin({ serviceName: 'adhd' })` (the only file under src naming the service) and mounted in every usePlugins list of the CLI and MCP hosts; the custom span layer is removed. Kept around the plugin: the provider enum dropped from api.ts inputs (the verb raises UNKNOWN_PROVIDER on both hosts), telemetry started before flag validation in cli.ts, and the rejected-flag span run through the plugin's own layer (no second emitter). The plugin records the failure message in `error` and no typed code, so the specs assert the message. The plugin's documented upstream twin `adhd.op.error` is kept: criterion .3 asserts exactly one `adhd.<op>.error` for the real op id and a single `adhd.op.error` twin. Over MCP an unknown provider stays a JSON-RPC rejection (a StealthSearchError is not an ApiError, and an ApiError code cannot carry UNKNOWN_PROVIDER); docs/ERRORS.md says so.

## Green (final tree, plugin restored)

GREEN: test/unit/hosts/search-tracing-*.spec.ts all pass (8 tests); full stealth-search:test passes.
EXIT pnpm nx run stealth-search:lint: 0
EXIT pnpm nx run stealth-search:typecheck: 0
EXIT pnpm nx run stealth-search:typecheck-spec: 0
EXIT pnpm nx run stealth-search:test: 0
EXIT pnpm nx run stealth-search:build: 0
