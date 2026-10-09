---
name: backlog-usage
description: 'Use whenever filing, reading, claiming, transitioning, relating, or resolving a backlog issue — or registering a project/component/location — in ANY repo on this machine, via the `adhd-backlog` CLI / `mcp__backlog__*` tools, never by hand-editing a `BACKLOG.md` file. Examples: "log this bug", "file a debt item for the flaky test", "claim that issue", "what''s still open in this repo", "where does this tool live".'
---

# `adhd-backlog` quick reference

Every verb takes ONE flag, `--input '<json>'` (a bare params object, not an
`{input:…}` envelope; same params as `mcp__backlog__*`). Per-field flags do not
exist. Only `search "<text>"` and `get <uid>` accept positionals. `<uid>` is a
full uid or a unique 8+ hex-char prefix. Success is `{"ok":true,"data":…}`;
failure is `{"ok":false,"error":{code,message}}` with a non-zero exit. Each
line below is run by a test, so it is copy-paste correct.

```
adhd-backlog get <uid>
adhd-backlog get --input '{"uid":"<uid>"}'
adhd-backlog search "flaky test" --limit 5
adhd-backlog query --input '{"filter":{"status":"open","project":"demo"},"limit":10}'
adhd-backlog create --input '{"title":"Fix the flaky test","body":"Why and where.","project":"demo","by":"claude:1"}'
adhd-backlog claim --input '{"uid":"<uid>","by":"claude:1","action":"claim"}'
adhd-backlog transition --input '{"uid":"<uid>","by":"claude:1","toStatus":"in-progress","note":"started"}'
adhd-backlog update --input '{"uid":"<uid>","by":"claude:1","priority":"high"}'
adhd-backlog relate --input '{"sourceUid":"<uid>","targetUid":"<uid2>","rel":"blocks","action":"add","by":"claude:1"}'
adhd-backlog transition --input '{"uid":"<uid>","by":"claude:1","toStatus":"done","note":"fixed in abc123"}'
```

Rules that bite:

- `by` is a real identity, `"name:instance"` (e.g. `"claude:1"`); a bare
  role word like `"agent"` is refused.
- File with the right `project` (and `component`); search before filing so you
  update an existing item instead of duplicating it.
- `update` with a `body` mints a successor uid (the old one reports a
  `conflict` naming the live one); re-read the uid from the result.
- Never edit `BACKLOG.md`; the graph is the source of truth.
- A wrong `--input` shape fails with `invalid_argument` and prints the exact
  working invocation; `adhd-backlog --help` lists every verb's live schema.

Other verbs: `add-citation attest delete embedding-status lookup merge-project
move obligate open-curve part-of-rollup priority-matrix recheck remove
remove-citation report restore rm-location rm-project spec-append spec-check
timeline unobligate upsert-component upsert-location upsert-project` and
`batch action`.

## Long reference (read only when the above is not enough)

`REFERENCE.md`, in this directory next to this file, holds the complete 32-verb
reference: outcome envelopes and MCP tool names (§2), worked examples for every
issue verb (§3), obligations and the actionability verdict (§4), spec revisions
(§5), read views and catalogs (§6), the project/component/location registry and
filing rules (§7), batch (§8), citations (§9), verifying writes (§10), stats
(§11), and sessions and reservations (§13). Read only the section you need
(`rg -n '^## ' REFERENCE.md` lists them), never the whole file.
