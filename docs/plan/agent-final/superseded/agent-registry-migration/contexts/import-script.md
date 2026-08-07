# import-script — crystallize the pipeline into a reusable public registry-write entrypoint (closes FEAT-007)

**Phase:** import · **Kind:** work · **Depends on:** dataset-build · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/import-script.test.ts`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

Crystallize the whole ingestion pipeline (parse → haiku fan-out → sonnet
consolidation → dataset-build) into a **single reusable public registry-write
entrypoint** — `importCorpus(...)` exported from `src/index.ts` and exposed as a CLI
bin — so the corpus import is a re-runnable operation, not a one-off notebook. **This
closes FEAT-007** (`packages/ai/agent-mcp/BACKLOG.md`): "no public registry-write
entrypoint for ingest" — the gap DEMO.md §6 / CLOSEOUT.md §5 flagged as the one
genuine seeding blocker.

`importCorpus` also folds in **skills migration**: each `.claude/skills/*/SKILL.md`
is imported as a `PROMPT_COMPONENT` of type `process` or `invocation` (the existing
`[def:retire]`/skills behavior), through the same entrypoint.

**The default registry target is the live server's prompt DB (F-P6-11).** With no
explicit target, `importCorpus` writes the corpus to **`~/.adhd/agent-mcp/registry.db`**
— the exact path the default-on agent-mcp server resolves prompts against
(`packages/ai/agent-mcp/src/index.ts`: `registryDbPath ??
path.join(os.homedir(), ".adhd", "agent-mcp", "registry.db")`). If the import wrote
anywhere else, the default resolver would see an empty registry forever (the corpus
would be invisible to every real session). The target is overridable for tests/CI
(an explicit `dbPath`/`--db` arg or `AGENT_MCP_REGISTRY_DB_PATH`), but the **default
resolves to that home path** so a plain `importCorpus()` lands the corpus where the
server actually reads it.

**The first pass is LLM-driven; the script captures/replays the methodology.** The
LLM stages run once to produce the consolidated artifact; the script persists a
**replayable record** of that consolidation so a later `importCorpus` run reproduces
the same dataset deterministically (and CI runs the replay offline). This is the
"crystallize the pipeline into a reusable script" the owner asked for — the
methodology is captured, not re-paid on every run.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [import-script.1] a single public importCorpus(...) entrypoint (lib export + CLI bin) runs parse->ingest->dataset-build end to end and persists components+use-cases+links recoverable after reopen — the FEAT-007 public registry-write entrypoint
- [import-script.2] importCorpus folds in SKILL.md import: each skill -> a process/invocation PROMPT_COMPONENT recoverable after reopen
- [import-script.3] the LLM methodology is captured as a replayable record so a re-run reproduces the dataset deterministically offline (first pass LLM-driven, replay deterministic)

- [import-script.4] importCorpus with no explicit target defaults to ~/.adhd/agent-mcp/registry.db (the live default-on server resolver DB); proven by redirecting HOME, running importCorpus() with no dbPath, and REOPENING $HOME/.adhd/agent-mcp/registry.db to recover the corpus rows (F-P6-11)
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/src/import/import-corpus.ts", "packages/ai/agent-registry-migration/src/import/import-skill.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/import-script.test.ts"]
```

---

## References & interfaces

- [def:import] — `importCorpus(...)`, the public registry-write entrypoint (`_shared.md`).
- [fix:store-usage] — write rows via the published `@adhd/agent-registry` stores (`_shared.md`).
- [def:retire] / skills behavior — SKILL.md → process/invocation component (`_shared.md`).
- [inv:reopen-proves-persistence] — prove persistence by REOPEN (`_shared.md`).

---

## Notes for executor

- **One public entrypoint closes FEAT-007.** `importCorpus` must be a real exported
  function AND a CLI bin (`bin` in package.json) — the public registry-write door
  CLOSEOUT.md §5 / DEMO.md §6 said was missing. File the FEAT-007 closure note in
  `packages/ai/agent-mcp/BACKLOG.md` when this lands.
- **Default target = the live resolver DB (F-P6-11, `import-script.4`).** When no
  `dbPath`/`--db`/`AGENT_MCP_REGISTRY_DB_PATH` is given, the default MUST resolve to
  `path.join(os.homedir(), ".adhd", "agent-mcp", "registry.db")` — byte-identical to
  the path `agent-mcp/src/index.ts` opens. Prove it in `import-script.test.ts` by
  redirecting `HOME` to a tmp dir, running `importCorpus()` with NO explicit target,
  and asserting the corpus rows are recoverable by REOPENING
  `$HOME/.adhd/agent-mcp/registry.db` (not the in-memory handle). Negative control:
  point the default at a sibling path and the reopen-at-the-server-path assertion
  goes red. This is the coupling that makes the default-on resolver actually see the
  corpus — do not hardcode a different default.
- **Replay, not re-pay.** Capture the sonnet-consolidated artifact as a checked-in
  record; `importCorpus --replay` reproduces the dataset deterministically with no
  model call (this is what runs in CI). A fresh `importCorpus --live` re-runs the
  LLM stages (gated, `corpus-ingest-llm`). Prove the replay path is deterministic by
  running it twice and deep-equalling the read-back rows.
- **Skills fold in here** — reuse the `process`/`invocation` typing; do not split
  skills into a separate state (the old `skills-migration` state was merged into
  this entrypoint).
- **Reopen proves persistence** (`[inv:reopen-proves-persistence]`); trust exit
  codes (project memory: better-sqlite3 vitest teardown segfault).
- Append exports to `src/index.ts` (append-only barrel).
