# tracing-log-validation

Validating agent: tracing-log-validation validating agent (claude-sonnet-5-5)
Service: stealth-search, namespace: adhd, validated_at: 2026-10-24T02:17:02.603Z
Scratch HOME: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u
Search code tree: 3c93f20be98050d388f3a3d08f726cc05532b5c0e2dc306320ca4783f10384a8
Op ids seen: stealth/list-providers, stealth/describe-provider, stealth/tripwire-status, stealth/chrome-status
process_spawn_mocked: true, real_chrome_launched: false, tests_added: 0

Both built hosts (dist/bin/cli.js, dist/bin/mcp.js --transport stdio) were run end to end against the scratch HOME and the written .jsonl files were read. Sink: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/ (CLI file stealth-search.cli-*.jsonl, MCP file stealth-search.live-service-*.jsonl); --log-dir run: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/logs/.

Limitation: the plugin error record carries the message in `error` but no typed error_code. The typed code UNKNOWN_PROVIDER is evidenced by CLI stderr (`UNKNOWN_PROVIDER: Unknown provider "nope"...`, exit 70) and the span error text; over MCP it is a JSON-RPC rejection (-32603) whose message names the provider. The upstream twin event adhd.op.error (its adhd.op attribute holds the real op id) accompanies each adhd.<op>.error; it is the only record whose name contains .op., and no record carries the op id op.

## Checks

### cli_pairs: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:06.858Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZ1ENHTG2QAS31BDFVPF","pid":64769,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"c43242e0-d8fe-4f49-9407-4615d5b1c592","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"ff45c30822abc9f7","parent_span_id":null,"otel_trace_id":"d6262a178bb22afe6d6a1661edaa7c16"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### cli_forced_error: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:07.806Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZZ1P1FFK12PDD9J1CWT","pid":65017,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"5cb7e5c9-e82b-41c9-b569-cba6e5953d26","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"8671269c6dfe5243","parent_span_id":null,"otel_trace_id":"c490525ec24e0ed6704422edfddfde9f"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_pairs: PASS

First sample line:

```
{"ts":"2026-10-24T02:16:18.152Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":null},"trace_id":"01M5NV3MEC0AJDTYCP746EPW9J","pid":70438,"adhd.op":"stealth/list-providers","adhd.transport":"mcp","session_id":"a771aa2f-5bff-4b92-9dab-a8c8de5b658f","worktree":"none","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"e7ba35e1d5b5df20","parent_span_id":null,"otel_trace_id":"3518ac0e771af92faa3201d0027989be"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### mcp_forced_error: PASS

First sample line:

```
{"ts":"2026-10-24T02:16:18.165Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":null},"trace_id":"01M5NV3MFN17TKAGRKNSF13B3F","pid":70438,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"a771aa2f-5bff-4b92-9dab-a8c8de5b658f","worktree":"none","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"0f27f14e75372eb4","parent_span_id":null,"otel_trace_id":"05c45aff9afe0fd4d1b9449d40146c16"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### transport_attr: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:06.858Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZ1ENHTG2QAS31BDFVPF","pid":64769,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"c43242e0-d8fe-4f49-9407-4615d5b1c592","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"ff45c30822abc9f7","parent_span_id":null,"otel_trace_id":"d6262a178bb22afe6d6a1661edaa7c16"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### role_attr: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:06.859Z","level":"info","event":"adhd.stealth/list-providers.finish","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZ1ENHTG2QAS31BDFVPF","pid":64769,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"c43242e0-d8fe-4f49-9407-4615d5b1c592","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"ff45c30822abc9f7","parent_span_id":null,"otel_trace_id":"d6262a178bb22afe6d6a1661edaa7c16","duration_ms":2}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### no_apigen_events: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:07.569Z","level":"info","event":"adhd.stealth/chrome-status.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZQEYMYDX36K2SGQC9A3","pid":64956,"adhd.op":"stealth/chrome-status","adhd.transport":"cli","session_id":"45fa577f-276c-4e8f-acdd-2ffc3ada869c","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"31ec085cfa6f4021","parent_span_id":null,"otel_trace_id":"7a81bb6250ba2da048ba74c5d859a780"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/logs/stealth-search.cli-2026-10-24.jsonl

### sink_dir: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:06.858Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZ1ENHTG2QAS31BDFVPF","pid":64769,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"c43242e0-d8fe-4f49-9407-4615d5b1c592","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"ff45c30822abc9f7","parent_span_id":null,"otel_trace_id":"d6262a178bb22afe6d6a1661edaa7c16"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### log_dir_flag: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:40.346Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTWZQZQ6JQ2T0DZTTARRM7","pid":65842,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"427172ed-c1ac-41c7-bdf0-2a65083a22b6","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"eaca0aecdcb989db","parent_span_id":null,"otel_trace_id":"99ffb15fe2c6034f0c6c12ee41fc5d5e"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_stdout_jsonrpc_only: PASS

First sample line:

```
{"ts":"2026-10-24T02:16:18.152Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":null},"trace_id":"01M5NV3MEC0AJDTYCP746EPW9J","pid":70438,"adhd.op":"stealth/list-providers","adhd.transport":"mcp","session_id":"a771aa2f-5bff-4b92-9dab-a8c8de5b658f","worktree":"none","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"e7ba35e1d5b5df20","parent_span_id":null,"otel_trace_id":"3518ac0e771af92faa3201d0027989be"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### stdin_eof_shutdown: PASS

First sample line:

```
{"ts":"2026-10-24T02:16:18.166Z","level":"error","event":"adhd.stealth/describe-provider.error","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":null},"trace_id":"01M5NV3MFN17TKAGRKNSF13B3F","pid":70438,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"a771aa2f-5bff-4b92-9dab-a8c8de5b658f","worktree":"none","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"0f27f14e75372eb4","parent_span_id":null,"otel_trace_id":"05c45aff9afe0fd4d1b9449d40146c16","duration_ms":0,"error":"Unknown provider \"nope\". Available: duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch — Use one of the registered provider ids (see the providers list), then retry."}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### every_command_spanned: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:06.858Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZ1ENHTG2QAS31BDFVPF","pid":64769,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"c43242e0-d8fe-4f49-9407-4615d5b1c592","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"ff45c30822abc9f7","parent_span_id":null,"otel_trace_id":"d6262a178bb22afe6d6a1661edaa7c16"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### cli_unknown_provider_span: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:07.806Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTVZZ1P1FFK12PDD9J1CWT","pid":65017,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"5cb7e5c9-e82b-41c9-b569-cba6e5953d26","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"8671269c6dfe5243","parent_span_id":null,"otel_trace_id":"c490525ec24e0ed6704422edfddfde9f"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_unknown_provider_span: PASS

First sample line:

```
{"ts":"2026-10-24T02:16:18.165Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":null},"trace_id":"01M5NV3MFN17TKAGRKNSF13B3F","pid":70438,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"a771aa2f-5bff-4b92-9dab-a8c8de5b658f","worktree":"none","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"0f27f14e75372eb4","parent_span_id":null,"otel_trace_id":"05c45aff9afe0fd4d1b9449d40146c16"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### cli_rejected_flag_span: PASS

First sample line:

```
{"ts":"2026-10-24T02:12:08.024Z","level":"info","event":"adhd.stealth/chrome-status.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c"},"trace_id":"01M5NTW06A983P4SDTJEE291D0","pid":65078,"adhd.op":"stealth/chrome-status","adhd.transport":"cli","session_id":"096c9738-728a-408a-b45c-580211cd3591","worktree":"linked","release.git_sha":"9db13b7e0f3770777d4399f580a8f820963aaf4c","release.artifact_sha256":"sha256:9577e3912e1d900bd124d7bc03f64f58f27f267901336211a0fb2b509a8c9361","span_id":"c1d26d4fc56be14b","parent_span_id":null,"otel_trace_id":"3d370873f659121c2046e5d6c64bae20"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### help_is_not_a_dispatch: PASS

First sample line:

```
HOME /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u was empty after 11 per-operation --help, -h and no-argument invocations (ls -A printed nothing; no .adhd directory)
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tmp.4WjXTioW7u/logs/stealth-search.cli-2026-10-24.jsonl

