# tracing-log-validation

Validating agent: tracing-log-validation validating agent (claude-sonnet-5-5)
Service: stealth-search, namespace: adhd, validated_at: 2026-10-24T16:52:15.575Z
Scratch HOME: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm
Search code tree: f432792b368f52aec300f9b37085a337400fc5ad660d1ffa78f0e40967ee0952
Op ids seen: stealth/list-providers, stealth/describe-provider, stealth/tripwire-status, stealth/chrome-status
process_spawn_mocked: true, real_chrome_launched: false, tests_added: 0

Both built hosts (dist/bin/cli.js, dist/bin/mcp.js --transport stdio) were rebuilt (`nx run stealth-search:build-bin --skip-nx-cache`) and run end to end against the scratch HOME; the written .jsonl files were read. Sink: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/ (CLI file stealth-search.cli-*.jsonl, MCP file stealth-search.live-service-*.jsonl); --log-dir run: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/logs/. Chrome status used the dead port 19999; no Chrome was launched.

MCP forced error (describeProvider nope): the call returns an isError tool result whose text is `invalid_argument: UNKNOWN_PROVIDER: Unknown provider "nope" ...` (no JSON-RPC rejection); the span `.error` record carries `UNKNOWN_PROVIDER: Unknown provider ...` in its `error` field. CLI forced error: stderr `UNKNOWN_PROVIDER: ...`, exit 70. CLI rejected flag (`chromeStatus --cdp-port abc`): stderr `HOST_FLAG_INVALID: ...`, exit 77, with a start and an error span. `--help` for all eleven operations and the global help wrote no span.

Limitation: Over the CLI the span error record (adhd.<op>.error) carries the failure message in `error` and no typed code; the typed code UNKNOWN_PROVIDER is evidenced by CLI stderr and exit status 70. Over MCP a typed StealthSearchError is an isError tool result carrying the code (invalid_argument: UNKNOWN_PROVIDER: ...), not a JSON-RPC rejection, and the span `.error` record's `error` field begins with UNKNOWN_PROVIDER. The upstream twin event adhd.op.error accompanies each adhd.<op>.error (its adhd.op attribute holds the real op id; no other record carries the name op) and is recorded under no_apigen_events.twin_events. The sibling *.metrics-snapshot-*.jsonl files (event metrics.snapshot) are periodic metrics sinks, not span logs, and are excluded from the span analysis.

## Checks

### cli_pairs: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:10.307Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7CX8V9MMCHFC8F0Y7XQR","pid":59285,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"0ed280ac-42a4-40ff-a30f-0440582f7fd9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"2135b3f6e583c6eb","parent_span_id":null,"otel_trace_id":"bd3ff0f39acfd78410730e6f9706e63b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### cli_forced_error: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:11.274Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7DVD526J1HKNM3GQ6RWZ","pid":59593,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"0ab61b40-bad2-4f83-acd5-5c96264a7ec2","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"1cbb0a5952e92c40","parent_span_id":null,"otel_trace_id":"3844d2ec06a916d8ecc127a42417dd9c"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_pairs: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:14.342Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7GVBQ3S5WAZRMRHY12SA","pid":60003,"adhd.op":"stealth/list-providers","adhd.transport":"mcp","session_id":"09e17b8f-2d0c-49e1-a185-56382046a851","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","span_id":"d6e8f9b58e4cd107","parent_span_id":null,"otel_trace_id":"aa1aa5e551214cea2334d7b0a776c7aa"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### mcp_forced_error: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:14.358Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7GWPYMXCPVBD0MHAST9J","pid":60003,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"09e17b8f-2d0c-49e1-a185-56382046a851","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","span_id":"0079c95cdb26cf8a","parent_span_id":null,"otel_trace_id":"b41ed8de0b6298c864d36db734124ab7"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### transport_attr: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:10.309Z","level":"info","event":"adhd.stealth/list-providers.finish","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7CX8V9MMCHFC8F0Y7XQR","pid":59285,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"0ed280ac-42a4-40ff-a30f-0440582f7fd9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"2135b3f6e583c6eb","parent_span_id":null,"otel_trace_id":"bd3ff0f39acfd78410730e6f9706e63b","duration_ms":2}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### role_attr: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:10.309Z","level":"info","event":"adhd.stealth/list-providers.finish","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7CX8V9MMCHFC8F0Y7XQR","pid":59285,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"0ed280ac-42a4-40ff-a30f-0440582f7fd9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"2135b3f6e583c6eb","parent_span_id":null,"otel_trace_id":"bd3ff0f39acfd78410730e6f9706e63b","duration_ms":2}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### no_apigen_events: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:10.307Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7CX8V9MMCHFC8F0Y7XQR","pid":59285,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"0ed280ac-42a4-40ff-a30f-0440582f7fd9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"2135b3f6e583c6eb","parent_span_id":null,"otel_trace_id":"bd3ff0f39acfd78410730e6f9706e63b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### sink_dir: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:10.307Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7CX8V9MMCHFC8F0Y7XQR","pid":59285,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"0ed280ac-42a4-40ff-a30f-0440582f7fd9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"2135b3f6e583c6eb","parent_span_id":null,"otel_trace_id":"bd3ff0f39acfd78410730e6f9706e63b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### log_dir_flag: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:13.787Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7G9Y5R45CD0D8SHCVYPX","pid":59848,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"de7635ca-613b-4957-bc34-d2be7040c0b9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"9dcd40ef98f54114","parent_span_id":null,"otel_trace_id":"9a230d3ee78317cacb24d56d27f95416"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_stdout_jsonrpc_only: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:14.342Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7GVBQ3S5WAZRMRHY12SA","pid":60003,"adhd.op":"stealth/list-providers","adhd.transport":"mcp","session_id":"09e17b8f-2d0c-49e1-a185-56382046a851","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","span_id":"d6e8f9b58e4cd107","parent_span_id":null,"otel_trace_id":"aa1aa5e551214cea2334d7b0a776c7aa"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### stdin_eof_shutdown: PASS

First sample line:

```
{"event":"stdin_eof","exit_code":0,"signal":null}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### every_command_spanned: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:10.307Z","level":"info","event":"adhd.stealth/list-providers.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7CX8V9MMCHFC8F0Y7XQR","pid":59285,"adhd.op":"stealth/list-providers","adhd.transport":"cli","session_id":"0ed280ac-42a4-40ff-a30f-0440582f7fd9","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"2135b3f6e583c6eb","parent_span_id":null,"otel_trace_id":"bd3ff0f39acfd78410730e6f9706e63b"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl, /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### cli_unknown_provider_span: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:11.274Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7DVD526J1HKNM3GQ6RWZ","pid":59593,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"0ab61b40-bad2-4f83-acd5-5c96264a7ec2","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"1cbb0a5952e92c40","parent_span_id":null,"otel_trace_id":"3844d2ec06a916d8ecc127a42417dd9c"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### mcp_unknown_provider_span: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:14.358Z","level":"info","event":"adhd.stealth/describe-provider.start","service":"stealth-search","role":"live-service","release":{"version":null,"artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7GWPYMXCPVBD0MHAST9J","pid":60003,"adhd.op":"stealth/describe-provider","adhd.transport":"mcp","session_id":"09e17b8f-2d0c-49e1-a185-56382046a851","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:d81309df54d1d96773ea74eca90238aeb1aedfdb097c2331455ad56e2bd7fe80","span_id":"0079c95cdb26cf8a","parent_span_id":null,"otel_trace_id":"b41ed8de0b6298c864d36db734124ab7"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.live-service-2026-10-24.jsonl

### cli_rejected_flag_span: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:11.493Z","level":"info","event":"adhd.stealth/chrome-status.start","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7E2NNGZZ3JAA10RJZZVX","pid":59671,"adhd.op":"stealth/chrome-status","adhd.transport":"cli","session_id":"fc36d835-9559-48d5-941c-938b6cfe2203","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span_id":"c8882dcb1a76821a","parent_span_id":null,"otel_trace_id":"284719f5729f0a81f2edc950f2c6f0e5"}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl

### help_is_not_a_dispatch: PASS

First sample line:

```
{"ts":"2026-10-24T16:52:11.276Z","level":"error","event":"adhd.op.error","service":"stealth-search","role":"cli","release":{"version":null,"artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4"},"trace_id":"01M5QD7DVD526J1HKNM3GQ6RWZ","pid":59593,"adhd.op":"stealth/describe-provider","adhd.transport":"cli","session_id":"0ab61b40-bad2-4f83-acd5-5c96264a7ec2","worktree":"linked","release.git_sha":"5fbc84a53c1b73adbe0a977af3304964b7355cd4","release.artifact_sha256":"sha256:599b9574b46f60cb855f8daf93724bc11664559f55b32a764744274f2f1e9f44","span":"adhd.stealth/describe-provider","duration_ms":31,"err":"Unknown provider \"nope\". Available: duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch — Use one of the registered provider ids (see the providers list), then retry."}
```

Log files: /private/tmp/claude-502/-Users-nix-dev-ai-scratch/6ed1c5fc-cf8b-4543-8ae7-2172feed2026/scratchpad/tlv3/home.uxNiHm/.adhd/sox-ecosystem/stealth-search/logs/stealth-search.cli-2026-10-24.jsonl
