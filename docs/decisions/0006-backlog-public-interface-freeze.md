# ADR-0006 — Freeze the `@adhd/backlog` public verb, envelope, and naming surface

**Status:** ACCEPTED (2026-10-05). **SUPERSEDED (in part) BY adhd ADR-0007 — see its breaking list** (the eight target deltas it approves; this ADR's frozen current-state surface otherwise stands, is unedited, and remains the record of what ships today). Drafted for blind review, A/B, and the vocabulary-pin check; this ADR records the shipped surface and re-opens no behavior beyond what ADR-0007 explicitly lists.
**Owner:** pseudosky.
**Supersedes:** nothing. This is the first ADR to record the `@adhd/backlog` public surface; it intentionally changes no behavior.
**Drives:** the missing in-repo interface freeze for the `@adhd/backlog` verb/envelope/naming surface; the additive-first rule; SPEC revision `document:3478468a`.
**Grounding:** `entrypoint/backlog/src/api.ts` (the extraction surface — its exported functions ARE the mounted surface), `entrypoint/backlog/skill/SKILL.md` §1–§2 (command surface, envelopes, MCP names), `entrypoint/backlog/SPEC.md`, and the live `adhd-backlog --help` schema (SKILL.md §1 reproduces it; the help output is the authoritative live shape).

## TL;DR for the next agent

**This ADR freezes what `@adhd/backlog` already ships — it does not add, remove, rename, or re-shape anything.** There are **29 verbs** plus the namespaced `batch action` mount; every verb takes exactly one `--input '<json>'` (`embedding-status` takes none). Every verb returns the two-arm outcome envelope below, and a malformed `--input` fails the outer schema and prints an **unwrapped** `{code:"invalid_argument",…}` on **stderr**.

**The change discipline is additive-first.** Adding a new verb, a new optional input field, or a new response field is permitted. **Breaking** the 29-verb surface — removing or renaming a verb, a required input, a return field, an error code, the calling convention, or the naming scheme — requires **explicit owner sign-off** and a superseding ADR; it is never a silent refactor.

**The trap to avoid:** treating this ADR as a redesign mandate. It is a *descriptive freeze of the current surface*. If the shipped surface and this document ever disagree, the **shipped `--help` schema wins** and this document is the stale artifact to correct (`adhd ADR-0002`).

## Context

`entrypoint/backlog` is the reference implementation of `adhd ADR-0001` and the repo's backlog system of record; `AGENTS.md` makes it the single write path (never a hand-edited `BACKLOG.md`). Its public interface — the verb list, the outcome envelope, the error-code taxonomy, and the three naming schemes — is enforced only by source and `SKILL.md` prose. No in-repo ADR records it, so a future edit could remove or rename a verb, widen an input, or change an error code and leave every downstream consumer (CLI, MCP tools, HTTP, in-process library callers, and the `batch` fan-out) silently broken.

`src/api.ts` is the extraction surface: "The exported surface of this file IS the mounted surface … every exported function here becomes a command on the CLI, a tool in MCP `tools/list`, a Fastify route, and a path in the OpenAPI document." That single choke point makes a freeze both necessary and cheap to state.

The surface as shipped (`SKILL.md` §1–§2):

- **29 verbs** — `get`, `query`, `create`, `update`, `transition`, `claim`, `relate`, `delete`, `move`, `merge-project`, `rm-project`, `upsert-project`, `upsert-component`, `upsert-location`, `rm-location`, `add-citation`, `remove-citation`, `spec-append`, `spec-check`, `attest`, `recheck`, `obligate`, `unobligate`, `priority-matrix`, `part-of-rollup`, `open-curve`, `report`, `lookup`, `embedding-status` — plus the namespaced `batch action` mount.
- **Every verb except `embedding-status` takes one `--input '<json>'`**; a per-field flag is rejected with `invalid_argument` (exit 2). `embedding-status` takes no options at all.
- **Two outcome arms on stdout**, and one malformed-input arm on stderr.
- **Ten documented error codes**, each with a derived process exit code.
- **Three naming schemes** — hyphenated CLI verb names, snake_case MCP tool names, and the scoped NPM package name.

## Decision

### D1 — Freeze the verb surface at 29 verbs + `batch action`

The 29 verbs are exactly those enumerated in Context. They are the frozen public verb surface. The namespaced `batch action` mount (operation id `backlog/<verb>`) is a fan-out over the same verbs, not a 30th verb.

**Calling convention (frozen):** every verb except `embedding-status` accepts exactly one `--input` flag carrying one JSON object; **`embedding-status` takes no options at all**. A per-field option (e.g. `get --uid …`, `create --title …`) is rejected with `invalid_argument` (exit 2) and `Unknown option: --<field>. Available: --input`. The CLI accepts a verb with or without its leading `backlog` segment (`get` and `backlog get` are identical). Any verb taking a `uid` also accepts a unique uid prefix of 8+ hex characters.

### D2 — Freeze the outcome envelope

Every verb, on every transport, returns exactly one of two shapes:

```
{ "ok": true,  "data": { … }, "warnings"?: […], "meta"?: { … } }
{ "ok": false, "error": { "code": "<code>", "message": "…", "details": { … } } }
```

The failure arm is for a failure the **verb's own logic** reports; it is printed on **stdout** with a non-zero exit code. A request that fails the **outer schema** — missing required field, unknown property, invalid JSON — never reaches a verb, and prints an **unwrapped** `{ "code": "invalid_argument", "message": "…", "details": [ … ] }` (no `ok` key) on **stderr**, still with the matching `invalid_argument` exit code. A caller that reads only stdout gets nothing for this class and must also read stderr when stdout is empty and the exit code is non-zero.

**The ten error codes and their process exit codes (frozen):**

| code                  | exit | meaning                                                            |
| --------------------- | ---- | ------------------------------------------------------------------ |
| `not_found`           | 4    | a referenced catalog entry does not exist                          |
| `item_not_found`      | 1    | the addressed issue `uid` does not exist                           |
| `ambiguous_reference` | 1    | an abbreviated uid reference resolves to more than one issue       |
| `invalid_argument`    | 2    | malformed flag or parameter shape                                  |
| `validation`          | 2    | schema rejection — unknown filter key, projection field, over-limit |
| `store_busy`          | 1    | store contention; `details.retryable`/`retryAfterMs` govern retry   |
| `rag_not_configured`  | 1    | a semantic read with no embedding backend / empty vector space      |
| `conflict`            | 1    | claim held, single-valued relation taken, or supersede raced        |
| `precondition_failed` | 1    | a gate refused the write (missing citation/note, unverifiable, stale spec base) |
| `internal`            | 1    | unclassified server-side failure                                   |

Success is always exit `0`.

### D3 — Freeze the identity rule

Every mutating verb requires `by`: the acting identity, always `"${agentName}:${instanceId}"`, **never a bare role literal** (`"agent"`). A missing or blank `by` is rejected with `invalid_argument` before any write runs.

### D4 — Freeze the naming surface

1. **CLI verb names are hyphenated** lowercase (kebab-case): `add-citation`, `part-of-rollup`, `upsert-project`, etc. The leading namespace segment is `backlog` (and `batch` for the fan-out).
2. **MCP tool names are snake_case** `backlog_<verb>` with the verb's own words snake_cased (`backlog_add_citation`, `backlog_part_of_rollup`, `backlog_upsert_project`), surfaced by a host prefixed by the host's own MCP namespace convention (e.g. `mcp__backlog__*` in Claude Code, `backlog_` in opencode); the fan-out mounts un-namespaced as `batch_action`. The tool list a session sees is the MCP **server process's** build, which can lag the CLI — restart, do not assume a verb is unmounted.
3. **NPM package name is scoped and hyphenated:** `@adhd/backlog`. The CLI binary is `adhd-backlog` (renamed from the bare `backlog`, which collided with the unrelated public npm package `backlog@1.4.56`).
4. **The `rel` union is CLOSED:** `{ relates_to, supersedes, blocks, duplicate_of, part_of, similar_to }`. `part_of` is **single-valued** (`n:1`) — one `part_of` parent per source; `supersedes` and `duplicate_of` are also `n:1`; the rest are `n:m`.

### D5 — The status catalog is OPEN; the `rel` catalog is closed

A status NAME that is unresolved — `create` `status` or `transition` `toStatus` — is **not an error**: it MINTS a new status (`terminal:false`) and the operation succeeds. This is the frozen contrast with D4.4: the **status catalog is open** (unknown name mints), the **`rel` union is closed** (unknown value is rejected). Only a uid-SHAPED reference resolving to nothing is `not_found`.

### D6 — Additive-first; breaking the 29-verb surface requires explicit owner sign-off

- **Permitted without this ADR changing:** adding a new verb (a new exported function in `api.ts`), adding an **optional** input field, adding a new response field, or adding a new error code as a documented extension. New verbs are additive; they do not renumber or re-shape the frozen 29.
- **Requires explicit owner sign-off and a superseding ADR:** removing a verb; renaming a verb; removing/renaming a required input or a return field; changing the one-`--input` calling convention; removing or re-mapping any of the ten error codes or their exit codes; changing a naming scheme (kebab CLI, snake MCP, scoped NPM); widening or closing the `status`/`rel` catalogs in the opposite direction. Such a change is **never** a silent refactor.

## Consequences

- **The interface has one in-repo home.** `api.ts` is the choke point D1–D5 describe; a reviewer can diff an intended surface change against this ADR.
- **Additive-first is the default regime (D6).** The 29-verb surface, the ten codes, the calling convention, and the naming schemes are frozen against silent drift; a breaking change is an owner decision, not an implementation detail.
- **Absent verb — no SPEC-revision fragment read-back.** There is **NO verb that reads a SPEC-revision fragment back** (a reader cannot retrieve `spec-append`'s fragment body through the surface). Tracked as backlog item `34b69c69`. `spec-append` appends; `spec-check` compares a token; the `spec` field projects the pointer — none returns the fragment. This is a recorded gap, not a frozen feature.
- **Absent verb — no citation-by-path enumeration.** There is **NO citation-by-path enumeration verb**; citations are reachable only per-issue (the `citations` field on `get`) and mutated by `add-citation`/`remove-citation`. A "which issues cite this file?" read has no verb.
- **Absent verb — no issue-level absorb/merge and no `consolidated_into` pointer.** There is **NO issue-level absorb/merge verb** and **NO `consolidated_into` pointer**. Project-level consolidation exists (`merge-project`), but issues have no absorb/merge operation and no field pointing an absorbed issue at its survivor (the `SUPERSEDES` body-edit redirect is a different mechanism).
- **Known read asymmetry — `related` excludes `supersedes`/`duplicate_of`.** `get fields:["related"]` **EXCLUDES** `supersedes` and `duplicate_of` links. The only available read path for the full relation picture is the **`auditTrail`** pseudo-field (plus `similar` for `similar_to` and `partOf` for `part_of`). `auditTrail` is an append-only mutation event log, and its `from`/`to` fields are overloaded across verbs (`relate`, `update`, `transition`); reconstructing a current relation therefore requires replaying the `add`/`remove` events rather than reading a relation projection. This ADR records `related` as intentionally partial and names `auditTrail` the only available read path — it does **not** imply `related` is complete.
- **`ambiguous_reference` is in the frozen set (D2).** The shipped CLI's uid-prefix path refuses an ambiguous prefix with `ambiguous_reference` (exit 1) — see `src/api.ts`'s `ERROR_CLASS_TO_ENVELOPE_CODE` and `src/envelope.ts`'s `BACKLOG_ERROR_CODES`. It is one of the ten documented codes of D2, not a surface outsider.
- **Consumers bind to the envelope, not the payload.** `batch action` returns each item's result as the same outcome envelope, so a batched item's own `ok`/`error.code` still applies.

## Alternatives considered

- **Do nothing; leave the surface documented only in `SKILL.md`/`SPEC.md`.** **REJECTED.** Prose files are not decision records; they can be rewritten by any agent, and a rename in `api.ts` ships to four transports with no gate. This ADR adds the missing durable record without changing behavior.
- **Freeze only the verb list and skip the envelope/naming.** **REJECTED.** The envelope and the ten codes are the actual consumer contract — a verb kept while its error codes are re-mapped still breaks every caller. The three frozen axes stand or fall together.
- **Adopt a closed enum for `status` (making it fixed like `rel`).** **REJECTED.** That would be a *breaking* change to the shipped open-catalog behavior (D5) and is precisely the class D6 reserves for explicit owner sign-off. This ADR records the surface as shipped; it does not re-design the catalog policy.

## What does NOT change

- **Behavior.** This ADR is descriptive. It changes no verb, no input, no return, no code, no exit code, and no naming.
- **`adhd ADR-0004` compatibility.** `adhd ADR-0004` ("MCP tool output is the flat payload on `content`; no `{result}` envelope", ACCEPTED 2026-09-25) is compatible with this ADR: the `{ok,data}` outcome envelope described here **IS** the tool's own flat return value, not a transport wrapper, so it is exactly what ADR-0004 D3 requires on `content`.
- **`adhd ADR-0001`, `adhd ADR-0002`, `adhd ADR-0003`, `adhd ADR-0004`, `adhd ADR-0005`** — all untouched. `adhd ADR-0002` governs: if this document and the shipped surface disagree, correct the source of truth (the shipped `--help` schema and `api.ts`), never work around it.
- **The store substrate and concurrency contract** (`adhd ADR-0001`, `sox ADR-0012`) — out of scope; this ADR freezes the transport-facing interface only.
- **`SPEC.md` and `SKILL.md`** — this ADR cites them; it does not supersede or rewrite them. Where they are more specific (per-field schemas, worked examples), they remain authoritative detail.

## References

- `entrypoint/backlog/src/api.ts` — the extraction surface; the mounted 29 verbs + `batch`.
- `entrypoint/backlog/skill/SKILL.md` §1 (29 verbs + `batch`, one-`--input` convention), §2 (outcome envelope, ten error codes + exit codes, MCP tool names), §3 (`by` identity rule), §7 (registry), §8 (`batch action`).
- `entrypoint/backlog/SPEC.md` — application-layer specification (FEAT-017).
- `adhd-backlog --help` — the authoritative live schema.
- Backlog item `34b69c69` — the absent SPEC-revision fragment read-back.
- `adhd ADR-0002` — correct the source, never work around.
