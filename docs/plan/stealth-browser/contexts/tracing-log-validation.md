# tracing-log-validation — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** search-hosts, search-tracing-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tracing-log-validation`
**Executor:** `general-purpose` (sonnet/medium), tools Bash, Read, Write — one validating agent, no tests, no code edits · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

A single agent proves with its own eyes that the stealth-search CLI and MCP host write the tracing logs the user expects: it runs both hosts end to end against a scratch HOME, reads the written `*.jsonl`, and records the apigen namespace `adhd` start/finish/error spans, the transport and role attributes and the sink location. This replaces the retired tracing-namespace-proof and adds no test.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/evidence/tracing-log-validation.json` and `evidence/tracing-log-validation.md` only. Modify no source, spec, package or plan file.

- **Reference Pattern:** SPEC-stealth-search.md section 4 ([ref:stealth-search-spec]); `packages/sox-telemetry/README.md` (sink layout); `entrypoint/backlog/src/index.ts` (initTelemetry precedent).

- **Delta Spec:** Steps: (1) `H=$(mktemp -d)`; `nx run stealth-search:build-bin`. (2) Read the sox-telemetry dist source to learn the real sink dir; expected `$H/.adhd/sox-ecosystem/stealth-search/logs/*.jsonl` with `HOME=$H`; repeat once with `--log-dir $H/logs`. (3) CLI: `--help` for all eleven operations and these calls (no Chrome): `listProviders`, `describeProvider --provider duckduckgo`, `tripwireStatus --data-dir $H/data`, `chromeStatus --cdp-port 19999` (success `running:false`), and the forced error `describeProvider --provider nope` (typed `UNKNOWN_PROVIDER`). (4) MCP: a throwaway stdio client in the scratchpad (MCP SDK `Client` + `StdioClientTransport`) spawns `node dist/bin/mcp.js --transport stdio` with `HOME=$H`, lists tools, repeats the five calls, closes stdin and waits for exit 0. (5) Read every `*.jsonl`. Write `tracing-log-validation.json`: `{service:'stealth-search', namespace:'adhd', agent, home, search_code_tree (the guard's code_tree of entrypoint/stealth-search at validation time: `git ls-tree -r HEAD -- src bin package.json project.json` sha256), commands_run:[...], mcp_calls:[...], op_ids_seen:[literal ids], log_files_detail:[{path,bytes}], log_dir_flag_dir, tests_added:0, checks:[{name,status:'PASS',sample_lines:[verbatim jsonl lines],log_files:[...]}]}` with the twelve check names of criterion 2 (`mcp_stdout_jsonrpc_only` also carries `non_jsonrpc_stdout_lines: 0`, `stdin_eof_shutdown` carries `exit_code: 0`), and a `.md` listing each check name with PASS and its first sample line verbatim. Pass means: files non-empty before process exit; a `.start` plus `.finish` (or `.error`) per dispatched call, same `trace_id`, event matching `^adhd\..+\.(start|finish|error)$`; attributes `adhd.op`, `adhd.transport` (`cli`/`mcp`), `trace_id`, `duration_ms`, `session_id`, `role` (`cli`/`live-service`), `worktree`; zero `apigen.` events; any CLI path that returns without a span is a FAIL naming the command.

- **Invariants:** [inv:trace-namespace] [inv:search-over-core]. On FAIL: stop, write nothing as PASS, report the root cause to the dispatcher; a separate implementer fixes it (this agent patches nothing). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tracing-log-validation]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tracing-log-validation` runs every acceptance criterion below (red until the work is done); `--only tracing-log-validation.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tracing-log-validation --only tracing-log-validation.N`, loaded from `scripts/guards/search_b.py`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tracing-log-validation.1] evidence/tracing-log-validation.json and .md exist; the json records service stealth-search, namespace adhd, the validating agent, the scratch HOME (a temp directory, not the real home), and the stealth-search code tree it validated, which equals the current code tree (the run is not stale).
- [tracing-log-validation.2] Every required check is present with status exactly PASS, non-empty sample_lines and non-empty log_files: cli_pairs, cli_forced_error, mcp_pairs, mcp_forced_error, transport_attr, role_attr, no_apigen_events, sink_dir, log_dir_flag, mcp_stdout_jsonrpc_only, stdin_eof_shutdown, every_command_spanned.
- [tracing-log-validation.3] Every sample line of the span checks is a JSON log record whose `event` matches ^adhd\..+\.(start|finish|error)$, none begins with `apigen.`, and the literal operation ids seen are recorded under `op_ids_seen` (no guessed id).
- [tracing-log-validation.4] Spans pair: in cli_pairs and mcp_pairs every trace_id has an `.start` and a `.finish` of the same operation, in the forced-error checks a `.start` and an `.error` carrying the typed code UNKNOWN_PROVIDER, finish/error records carry a numeric duration_ms, and no sample line lacks trace_id.
- [tracing-log-validation.5] Attributes are right per host: records of CLI checks carry adhd.transport = cli and role = cli, records of MCP checks adhd.transport = mcp and role = live-service, all carry adhd.op, session_id and worktree, and the `transport_attr` and `role_attr` checks sample both hosts.
- [tracing-log-validation.6] The sinks are the real ones: every recorded log file ends .jsonl, lives under <home>/.adhd/sox-ecosystem/stealth-search/logs/ (default run) or the --log-dir directory (flag run), was non-empty before the process exited (log_files_detail with bytes > 0), and the real home directory's stealth-search log directory was not written by the run.
- [tracing-log-validation.7] Coverage is complete and observed: `commands_run` lists --help for each of the eleven operations plus listProviders, describeProvider, tripwireStatus, chromeStatus (dead port) and the forced describeProvider error through the CLI, and the same five calls through the MCP stdio client; `mcp_stdout_jsonrpc_only` and `stdin_eof_shutdown` samples record that every MCP stdout line parsed as JSON-RPC and the process exited 0 after stdin closed; `tests_added` is 0.
- [tracing-log-validation.8] evidence/tracing-log-validation.md states PASS for every required check name next to its first recorded sample line (verbatim from the json) and names the validating agent; it records no FAIL line.
- [tracing-log-validation.9] Only owned paths changed by [psm:tracing-log-validation] commits (the two evidence files; no source, no spec, no test).

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/evidence/tracing-log-validation.md", "docs/plan/stealth-browser/evidence/tracing-log-validation.json"]
```

---

## Contract Promise

Added: the two evidence files. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tracing-log-validation]`:

- [ ] After the validation run — commit: `chore(stealth-browser): tracing log validation evidence [psm:tracing-log-validation]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- The run happens against a scratch HOME so the real `~/.adhd` is never written (guard `.6`).
- `search_code_tree` must equal the committed tree when you finish: commit the evidence only after the last source commit of `search-hosts`; if source changes later, re-run.
- Observable-file assertions only: the guard validates structure and content of your two files, it does not re-run your process.


---

## Re-run constraints (amendment 2026-10-23)

The first run failed: UNKNOWN_PROVIDER was unreachable from MCP and the CLI, a rejected flag left no span, and a duplicate `adhd.op.error` event carried the bogus op id `op`. `search-tracing-fixes` fixed the sources; this state now re-runs and stays ONE validating agent, no tests, no code edits.

- Depends on `search-tracing-fixes` (complete) and everything upstream of it: the evidence is only valid when `validated_at` is later than that state's `done_at` ([tracing-log-validation.10]).
- Mock any process spawn: no real Chrome is launched, port 9222 is never touched or named in a command ([inv:live-chrome]); record `process_spawn_mocked: true`, `real_chrome_launched: false`.
- Pass every MCP input inside the `data.input` envelope.
- Add the checks `cli_unknown_provider_span`, `mcp_unknown_provider_span`, `cli_rejected_flag_span` (a rejected flag still produces a start and an error span) and `help_is_not_a_dispatch` (`--help` writes no span); no sample line may carry the op id `op` ([tracing-log-validation.11]).
