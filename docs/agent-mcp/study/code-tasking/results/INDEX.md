# Run index (auto-generated from results/runs.jsonl)

Chronological. `tc`=tool_call_count, `mc`=model_calls, `out`=output_tokens, `ms`=latency. Join to request bodies via the prompt text in the matching `tests/test-*/mcp.jsonl`.

| created_at | agent | provider | model | status | tc | mc | out | ms | prompt |
|---|---|---|---|---|---|---|---|---|---|
| 2026-06-09 00:46:10 | — | — | — | failed | — | — | — | — | What is 2 + 2? Reply in one sentence. |
| 2026-06-09 01:00:24 | — | — | — | completed | — | — | — | — | What is 2 + 2? Reply in one sentence. |
| 2026-06-09 01:01:32 | — | — | — | completed | — | — | — | — | Ask the test-worker to explain what a binary search tree is in o… |
| 2026-06-09 01:01:48 | — | — | — | completed | — | — | — | — | Explain what a binary search tree is in one sentence. |
| 2026-06-09 01:01:48 | — | — | — | completed | — | — | — | — | Explain what a binary search tree is in one sentence. |
| 2026-06-10 03:45:33 | at-worker | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 8 | 562 | What is the capital of France? |
| 2026-06-15 19:11:56 | smoke-101 | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 4 | 10770 | What is 12 multiplied by 12? Reply with only the number. |
| 2026-06-15 19:12:18 | smoke-101 | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 2 | 423 | What is the capital of France? One word. |
| 2026-06-15 19:19:23 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 283 | 10037 | Bug report. An MCP server (stdio JSON-RPC on stdout) also starts… |
| 2026-06-15 19:19:56 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 248 | 8085 | Bug report. We have a SQLite database (accessed via Drizzle ORM)… |
| 2026-06-15 19:20:26 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 209 | 7795 | Bug report (SQLite + Drizzle ORM). Migration 0005 recreates the … |
| 2026-06-15 19:21:04 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 251 | 8862 | Bug report (Python audit script). This check is supposed to veri… |
| 2026-06-15 19:22:02 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 188 | 7000 | Bug + constraints (SQLite + Drizzle better-sqlite3 migrator). Mi… |
| 2026-06-15 19:27:59 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 248 | 9658 | Bug: after our DB migrations run on an existing populated databa… |
| 2026-06-15 19:28:34 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 269 | 10529 | Bug: this process is primarily a Model Context Protocol server s… |
| 2026-06-15 19:29:12 | code-fixer | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 292 | 11403 | Bug: this Python audit check is supposed to verify that, in orch… |
| 2026-06-15 19:34:52 | ts-pro | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 790 | 27554 | Bug: after our DB migrations run on an existing populated databa… |
| 2026-06-15 19:35:56 | ts-pro | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 961 | 33075 | Bug: after our DB migrations run on an existing populated databa… |
| 2026-06-15 19:37:20 | ts-pro | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 990 | 38639 | Bug: this process is primarily an MCP server speaking JSON-RPC o… |
| 2026-06-15 19:45:01 | synth-coder | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 539 | 19156 | DIAGNOSE this bug (do not write the fix yet).  SQLite via Drizzl… |
| 2026-06-15 19:45:36 | synth-coder | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 607 | 18947 | Now CODE the fix based on your diagnosis. Remember: only `db` is… |
| 2026-06-15 19:46:59 | architect | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 738 | 24836 | Adversarially review this diagnosis and produce a corrected impl… |
| 2026-06-15 19:49:20 | lead | lmstudio | qwen2.5-14b-instruct | completed | 6 | 4 | 2284 | 163615 | Bug report to fix (orchestrate it): SQLite via Drizzle (better-s… |
| 2026-06-15 19:50:07 | synth-coder | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 688 | 21515 | DIAGNOSE this bug (do not code): SQLite via Drizzle (better-sqli… |
| 2026-06-15 19:50:49 | synth-coder | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 912 | 29042 | SQLite via Drizzle (better-sqlite3). After runMigrations() appli… |
| 2026-06-16 00:55:28 | code-impl | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 180 | 17101 | Small feature. Add an optional `is_ephemeral` filter to a task-l… |
| 2026-06-16 00:56:06 | code-impl | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 179 | 6403 | Small feature. `startSseServer(taskStore)` always binds the port… |
| 2026-06-16 00:56:29 | code-impl | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 124 | 4363 | Small change. Add two new task statuses, `waiting` and `awaiting… |
| 2026-06-16 00:56:46 | code-impl | lmstudio | qwen2.5-14b-instruct | completed | 0 | 1 | 124 | 4568 | Small change. `client.ts` keeps the raw connection module-privat… |
| 2026-06-16 01:02:59 | fixer-anthropic | anthropic | claude-sonnet-4-6 | completed | 0 | 1 | 987 | 19512 | Bug: after our DB migrations run on an existing populated databa… |
| 2026-06-16 01:03:46 | fixer-anthropic | anthropic | claude-sonnet-4-6 | completed | 0 | 1 | 660 | 11371 | Bug: this process is primarily a Model Context Protocol server s… |
| 2026-06-16 01:04:21 | fixer-anthropic | anthropic | claude-sonnet-4-6 | completed | 0 | 1 | 429 | 8053 | Bug: this Python audit check is supposed to verify that, in orch… |
| 2026-06-16 01:04:46 | fixer-anthropic | anthropic | claude-sonnet-4-6 | completed | 0 | 1 | 1045 | 20919 | Bug report. We have a SQLite database (accessed via Drizzle ORM)… |
| 2026-06-16 01:05:50 | impl-anthropic | anthropic | claude-sonnet-4-6 | completed | 0 | 1 | 236 | 5341 | Small change. `client.ts` keeps the raw connection module-privat… |
