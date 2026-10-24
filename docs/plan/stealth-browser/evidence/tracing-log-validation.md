# tracing-log-validation

Validating agent: tracing-log-validation validating agent (claude-sonnet-5-5)
Service: stealth-search, namespace: adhd, validated_at: 2026-10-24T10:41:12.312Z
Scratch HOME: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi
Search code tree: 5861ebd0e90df21c5a0e7b88985fe164e8b6b1d8cb69fde29ff0551eb3590107
Op ids seen: stealth/list-providers, stealth/describe-provider, stealth/tripwire-status, stealth/chrome-status
process_spawn_mocked: true, real_chrome_launched: false, tests_added: 0

Both built hosts (dist/bin/cli.js, dist/bin/mcp.js --transport stdio) were rebuilt (`nx run stealth-search:build-bin --skip-nx-cache`) and run end to end against the scratch HOME; the written .jsonl files were read. Sink: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/ (CLI file stealth-search.cli-*.jsonl, MCP file stealth-search.live-service-*.jsonl); --log-dir run: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/logs/. Chrome status used the dead port 19999; no Chrome was launched.

MCP forced error (describeProvider nope): the call returns an isError tool result whose text is `invalid_argument: UNKNOWN_PROVIDER: Unknown provider "nope" ...` (no JSON-RPC rejection); the span `.error` record carries `UNKNOWN_PROVIDER: Unknown provider ...` in its `error` field. CLI forced error: stderr `UNKNOWN_PROVIDER: ...`, exit 70. CLI rejected flag (`chromeStatus --cdp-port abc`): stderr `HOST_FLAG_INVALID: ...`, exit 77, with a start and an error span. `--help` for all eleven operations and the global help wrote no span.

Limitation: Over the CLI the span error record (adhd.<op>.error) carries the failure message in `error` and no typed code; the typed code UNKNOWN_PROVIDER is evidenced by CLI stderr and exit status 70. Over MCP a typed StealthSearchError is an isError tool result carrying the code (invalid_argument: UNKNOWN_PROVIDER: ...), not a JSON-RPC rejection, and the span `.error` record's `error` field begins with UNKNOWN_PROVIDER. The upstream twin event adhd.op.error accompanies each adhd.<op>.error (its adhd.op attribute holds the real op id; no other record carries the name op) and is recorded under no_apigen_events.twin_events. The sibling *.metrics-snapshot-*.jsonl files (event metrics.snapshot) are periodic metrics sinks, not span logs, and are excluded from the span analysis.

## Checks

### cli_pairs: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:07.240Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PQZZMB78YYCE1N897QQBXN","pid":42270,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"5b326a27-4037-4130-8b1e-c7dd1071c710","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"27ed120900af6e61","parent_span_id":null,"otel_trace_id":"1f35667073ca36d858352a69e638c79b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### cli_forced_error: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:08.212Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR00HSCHYAGWQT5R60BNY5","pid":42525,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"5ad0d707-be67-4c69-964a-f058c73928c1","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"863cde181f97cd39","parent_span_id":null,"otel_trace_id":"aaafea66b4d2b803d239a798b8bfd1bc"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_pairs: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:11.174Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR03F75762BZHQ922R7EV2","pid":43053,"adhd.op":"stealth/list-providers","adhd.transport":"mcp","session_id":"e48e9684-d891-4caf-ad51-5d51f6c453c2","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"3ad07d4592f05da4","parent_span_id":null,"otel_trace_id":"38aafd21716567b66b295245a9b09f67"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### mcp_forced_error: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:11.191Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR03GQ1DMYJ9P0CAP6YWHA","pid":43053,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"e48e9684-d891-4caf-ad51-5d51f6c453c2","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"b784626f7eb192b8","parent_span_id":null,"otel_trace_id":"8067849233f7859a173aa749bf081b37"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### transport_attr: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:07.242Z","level":"info","event":"adhd.stealth/list-providers.finish","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PQZZMB78YYCE1N897QQBXN","pid":42270,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"5b326a27-4037-4130-8b1e-c7dd1071c710","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"27ed120900af6e61","parent_span_id":null,"otel_trace_id":"1f35667073ca36d858352a69e638c79b","duration_ms":2}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### role_attr: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:07.242Z","level":"info","event":"adhd.stealth/list-providers.finish","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PQZZMB78YYCE1N897QQBXN","pid":42270,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"5b326a27-4037-4130-8b1e-c7dd1071c710","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"27ed120900af6e61","parent_span_id":null,"otel_trace_id":"1f35667073ca36d858352a69e638c79b","duration_ms":2}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### no_apigen_events: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:07.240Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PQZZMB78YYCE1N897QQBXN","pid":42270,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"5b326a27-4037-4130-8b1e-c7dd1071c710","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"27ed120900af6e61","parent_span_id":null,"otel_trace_id":"1f35667073ca36d858352a69e638c79b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### sink_dir: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:07.240Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PQZZMB78YYCE1N897QQBXN","pid":42270,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"5b326a27-4037-4130-8b1e-c7dd1071c710","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"27ed120900af6e61","parent_span_id":null,"otel_trace_id":"1f35667073ca36d858352a69e638c79b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### log_dir_flag: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:10.624Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR02Y4MSCK1A7DDVW1Y6D4","pid":42927,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"743d7308-d09a-4787-9f47-e3e78848210d","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"458693912ef06635","parent_span_id":null,"otel_trace_id":"164278fabb4fa5075a1a35eeb6dd2aaf"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_stdout_jsonrpc_only: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:11.174Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR03F75762BZHQ922R7EV2","pid":43053,"adhd.op":"stealth/list-providers","adhd.transport":"mcp","session_id":"e48e9684-d891-4caf-ad51-5d51f6c453c2","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"3ad07d4592f05da4","parent_span_id":null,"otel_trace_id":"38aafd21716567b66b295245a9b09f67"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### stdin_eof_shutdown: PASS

First sample line:

```
{"event":"stdin_eof","exit_code":0,"signal":null}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### every_command_spanned: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:07.240Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PQZZMB78YYCE1N897QQBXN","pid":42270,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"5b326a27-4037-4130-8b1e-c7dd1071c710","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"27ed120900af6e61","parent_span_id":null,"otel_trace_id":"1f35667073ca36d858352a69e638c79b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### cli_unknown_provider_span: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:08.212Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR00HSCHYAGWQT5R60BNY5","pid":42525,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"5ad0d707-be67-4c69-964a-f058c73928c1","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"863cde181f97cd39","parent_span_id":null,"otel_trace_id":"aaafea66b4d2b803d239a798b8bfd1bc"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_unknown_provider_span: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:11.191Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR03GQ1DMYJ9P0CAP6YWHA","pid":43053,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"e48e9684-d891-4caf-ad51-5d51f6c453c2","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:8fecc238551835534f4c8273a902edffcc0ab87e16785f71210c0b5d7a9bf56f","span_id":"b784626f7eb192b8","parent_span_id":null,"otel_trace_id":"8067849233f7859a173aa749bf081b37"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### cli_rejected_flag_span: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:08.425Z","level":"info","event":"adhd.stealth/chrome-status.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR00SSPQTEMYNMS02WSV5Y","pid":42589,"adhd.op":"stealth/chrome-status","adhd.transport":"cli","session_id":"c31aa233-bcb6-4ef7-be71-2a0b2eda170c","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"1cc27e68d3d067b3","parent_span_id":null,"otel_trace_id":"48c4cd0f33c3eb51874e2df8e60990a5"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### help_is_not_a_dispatch: PASS

First sample line:

```
{"ts":"2026-10-24T10:41:08.214Z","level":"error","event":"adhd.op.error","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489"},"trace_id":"01M5PR00HSCHYAGWQT5R60BNY5","pid":42525,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"5ad0d707-be67-4c69-964a-f058c73928c1","worktree":"linked","release.git_sha":"e97e82c99c4ad2164f8ebffba8473e3f04160489","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span":"adhd.stealth/describe-provider","duration_ms":61,"err":"Unknown provider \"nope\". Available: duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch — Use one of the registered provider ids (see the providers list), then retry."}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tlv2/home.qZ6xxi/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl
