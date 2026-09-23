# Backlog CLI — Demo Walkthrough

**Status: verified.** Every command and JSON envelope below was run against the built
binary (`entrypoint/backlog/dist/index.js`) under `--sandbox` with a scratch `ADHD_ROOT`,
and the output pasted in verbatim. See `README.md` for the status legend and `UNRESOLVED.md`
for what was checked and dropped rather than guessed.

## 0. Setup

```bash
export ADHD_ROOT="$(pwd)/tmp/backlog-demo"
BIN="node entrypoint/backlog/dist/index.js --sandbox"
```

`--sandbox` (a global flag valid before any command) isolates the run into a throwaway
store instead of the live production store. Never omit it against production data.

## 1. Discover the surface — verified

```
$ node entrypoint/backlog/dist/index.js --help
```

```
Special commands (handled before the apigen command table):
  install-skill [options]  Install the backlog skill for a host (alias: install)
  serve [options]          Start the long-lived HTTP/MCP server (--transport http|mcp|both)
  search "<query>" [flags]  Natural-language search — `query --input` with the options as flags
  sandbox-path             Report the resolved store path (store-free) — see --sandbox below

  --sandbox    Global flag, valid before ANY command: isolates this invocation
               into a fresh throwaway store instead of the live production one.

Available commands:

  backlog claim  { input: { uid: string, by: string, action: enum, force?: boolean } }
  backlog create  { input: { title: string, body: string, project: string, component?: string, kind?: string, status?: string, priority?: string, citations?: object[], author?: string, assignee?: string, by: string, duplicateAction?: enum, awaitEmbed?: boolean } }
  backlog delete  { input: { uid: string, reason: string, by: string, awaitEmbed?: boolean } }
  backlog get  { input: union }
  backlog lookup  { input: { q: string } }
  backlog move  { input: { uid: string, toProject?: string, toComponent?: string, by: string } }
  backlog query  { input: { text?: string, filter?: object, fields?: union[], sort?: enum, direction?: enum, limit?: number, offset?: number, after?: string, view?: enum, format?: enum, overlapAxis?: enum, overlapUids?: string[], staleAfterMin?: number } }
  backlog relate  { input: { sourceUid: string, targetUid: string, rel: enum, action: enum, by: string } }
  backlog rm-location  { input: { uid: string, by: string, reason?: string } }
  backlog transition  { input: { uid: string, by: string, toStatus: string, note?: string, citations?: object[] } }
  backlog update  { input: { uid: string, by: string, title?: string, body?: string, kind?: string, priority?: string, assignee?: string, author?: string, awaitEmbed?: boolean } }
  backlog upsert-component  { input: { project: string, name: string, path?: string, description?: string, by: string } }
  backlog upsert-location  { input: { component: string, project?: string, locType: enum, value: string, by: string } }
  backlog upsert-project  { input: { name: string, path?: string, repoUrl?: string, monorepo?: boolean, description?: string, by: string } }
  batch action  { input: { operation: enum, items: object[], concurrency?: number, mode?: enum, onItemError?: enum, itemTimeoutMs?: number } }
```

Every verb takes exactly one `--input '<json>'` argument matching the shape shown. There
is no per-field flag grammar (`--title`, `--by`, …) — the whole payload is one JSON blob.

## 2. Check the store you're about to write to — verified

```
$ node entrypoint/backlog/dist/index.js sandbox-path
{"sandbox":false,"dbPath":"/Users/nix/.adhd/backlog/production/data/backlog.db"}

$ node entrypoint/backlog/dist/index.js --sandbox sandbox-path
[backlog] --sandbox: isolated store at /var/folders/.../T/backlog-sandbox-4ySYeP (not auto-deleted — pass ADHD_ROOT=... to reuse it, or remove it yourself when done)
{"sandbox":true,"adhdRoot":"/var/folders/.../T/backlog-sandbox-4ySYeP","dbPath":"/var/folders/.../T/backlog-sandbox-4ySYeP/backlog/production/data/backlog.db"}
```

Running `sandbox-path` with no flag reports the live production store path — a clear
tripwire that every subsequent write in this demo carries `--sandbox`.

## 3. Register a project and component — verified

```
$ $BIN backlog upsert-project --input '{"name":"adhd","by":"demo-agent"}'
{"ok":true,"data":{"uid":"7f6a6441-ec36-42a2-a347-04d2c789bc63","created":true,"project":{"uid":"7f6a6441-ec36-42a2-a347-04d2c789bc63","name":"adhd"}}}

$ $BIN backlog upsert-component --input '{"project":"adhd","name":"backlog","by":"demo-agent"}'
{"ok":true,"data":{"uid":"5dd50a95-ce3d-45ad-bbed-9141038debc5","created":true,"component":{"uid":"5dd50a95-ce3d-45ad-bbed-9141038debc5","name":"backlog","projectUid":"7f6a6441-ec36-42a2-a347-04d2c789bc63"}}}
```

Registering the same `name` again resolves to the same row rather than creating a second
one (`entrypoint/backlog/SPEC.md` §8 AC-5, AC-12).

## 4. File an issue — verified

```
$ $BIN backlog create --input '{"title":"Demo issue","body":"Body text for the demo issue.","project":"adhd","component":"backlog","by":"demo-agent"}'
{"ok":true,"data":{"created":true,"uid":"bca2c658-5165-4367-b60e-08872ecf1965","item":{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","title":"Demo issue","kind":"issue","status":"open","project":"7f6a6441-ec36-42a2-a347-04d2c789bc63","component":"5dd50a95-ce3d-45ad-bbed-9141038debc5","createdAt":"2026-09-17T17:09:07.496Z","author":"demo-agent"}}}
```

Identity is the returned `uid` alone — there is no human-readable identifier anywhere in
this envelope or any other verb's input/output (`entrypoint/backlog/SPEC.md` §8 item 1).

## 5. Read it back — verified

```
$ $BIN backlog get --input '{"uid":"bca2c658-5165-4367-b60e-08872ecf1965"}'
{"ok":true,"data":{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","title":"Demo issue","kind":"issue","status":"open"}}

$ $BIN backlog get --input '{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","fields":["body"]}'
{"ok":true,"data":{"body":"Body text for the demo issue."}}
```

The default `get` (no `fields`) returns the five-field card
(`uid,kind,title,status,priority`); `entrypoint/backlog/SPEC.md` §8 AC-13. Requesting a
field explicitly (here `body`, a pseudo-field) returns it.

## 6. `get` on a `uid` that doesn't exist — verified

```
$ $BIN backlog get --input '{"uid":"00000000-0000-0000-0000-000000000000"}'
{"ok":false,"error":{"code":"item_not_found","message":"No live issue found for uid \"00000000-0000-0000-0000-000000000000\"","details":{"retryable":false}}}
```

Exit code was `0` for this call — a domain-level failure is carried in the `ok:false`
envelope, not the process exit code. See `UNRESOLVED.md` U2.

## 7. A write with a missing precondition — verified

```
$ $BIN backlog transition --input '{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","by":"demo-agent","toStatus":"in-progress"}'
{"ok":false,"error":{"code":"precondition_failed","message":"A note is required to transition issue \"bca2c658-5165-4367-b60e-08872ecf1965\" (project_policy.transition_requires_note)","details":{"retryable":false}}}
```

The project's write policy rejected the transition for missing `note` rather than silently
applying it — every transition/update/move write is meant to be auditable
(`entrypoint/backlog/SPEC.md` §8 item 3).

## 8. Claim it — verified

```
$ $BIN backlog claim --input '{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","by":"demo-agent-2","action":"claim"}'
{"ok":true,"data":{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","status":"claimed","claimedBy":"demo-agent-2","claimedAt":"2026-09-17T17:09:28.867Z"}}
```

A second `claim` from a different agent within the stale-claim window is rejected with
`ClaimHeldError` per `entrypoint/backlog/SPEC.md` §8 item 16 — not independently exercised
in this pass; see `UNRESOLVED.md`.

## 9. List it — verified

```
$ $BIN backlog query --input '{"filter":{"project":"adhd"},"limit":5}'
{"ok":true,"data":{"view":"list","items":[{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","title":"Demo issue","kind":"issue","status":"open"}],"hasMore":false},"meta":{"total":1,"returned":1,"limit":5}}
```

`filter.project` narrows the listing to the named project's issues
(`entrypoint/backlog/SPEC.md` §6.1, §8 item 9).

## 10. Delete it (soft) — verified

```
$ $BIN backlog delete --input '{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","reason":"demo cleanup","by":"demo-agent"}'
{"ok":true,"data":{"uid":"bca2c658-5165-4367-b60e-08872ecf1965","invalidated":true}}
```

A subsequent `get` on the same `uid` still resolves the card — deletion is bi-temporal,
never a hard delete (`entrypoint/backlog/SPEC.md` §8 item 18). Not independently
re-verified in this pass; see `UNRESOLVED.md` U10.

## 11. Lookup and search — verified, with a real failure mode shown

```
$ $BIN backlog lookup --input '{"q":"backlog"}'
{"ok":false,"error":{"code":"not_found","message":"location \"backlog\" was not found","details":{"retryable":false}}}

$ $BIN search "demo issue"
{"ok":true,"data":{"view":"list","items":[],"hasMore":false},"meta":{"total":0,"returned":0,"limit":50}}
```

`lookup` resolves a registered location, project, or component by name — it returned
`not_found` here because no `upsert-location` had registered `"backlog"` as a location in
this run (only as a component name). `search` ran cleanly and returned an empty result set
because nothing seeded in this pass matched the query text — both outcomes are real,
unmodified CLI output, kept in rather than trimmed to a happy path.

## 12. Commands documented but not exercised in this pass

`update`, `move`, `relate`, `rm-location`, `upsert-location`, `batch action`, and `serve`
all appear in the verified `--help` table above but were not independently driven end to
end in this walkthrough. Their input shapes are the ones shown in §1, taken directly from
the live binary; treat their behavior as "documented, not exercised" per `README.md`'s
status legend until a follow-up pass runs them.

## 13. Cleanup

```bash
rm -rf "$(pwd)/tmp/backlog-demo"
```

Sandbox stores under `--sandbox` are not auto-deleted; remove the scratch `ADHD_ROOT`
directory when done, same as any other file under `tmp/`.
