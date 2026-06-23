# compiler-design — RESOLVE CONSUMPTION + HEADER + JOIN DECISIONS

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-compiler/scripts/audit_compiler.py --phase architecture`

---

## Goal

The open design questions for `@adhd/agent-compiler` are RESOLVED and recorded in
`decisions.md` before any code is frozen: (1) how the compiler CONSUMES the
context-condition precedence rule frozen upstream, (2) the per-platform header
builder contract (`yaml_frontmatter` field set vs. `json_object` shape vs.
`none`), (3) the single-DB cross-package join strategy, and (4) the
`composed_prompts` cache-key (`context_hash`) computation. After this state every
later state has a binding answer, so the engine is not redesigned mid-build.

This state exists FIRST because `DATA_MODEL.md` Domain 1 "Composed Prompts" and
`USAGE.md` are intent docs, not a contract, and because the compiler's correctness
hinges on consuming plan 1's precedence decision rather than inventing one.

---

## Semantic Distillation

- **Primitive:** WRITE `decisions.md` — the architecture decision record. No code.
- **Reference Pattern:** `[inv:one-db-handle]`, `[inv:context-precedence-consumed]`,
  `[def:header-format]`, `[ref:compile-agent]`, `[up:registry]`/`[up:tools]`/
  `[up:provider]`/`[up:policy]`.
- **Delta Spec — `decisions.md` must answer, each with a rationale:**
  1. **Context-condition precedence consumption** — quote the precedence rule from
     `agent-registry-schema/decisions.md` (which component wins when two rows share
     a `position` with different conditions) and state that the compiler delegates
     to `resolveComposition(agentSlug, context)` rather than re-evaluating. The
     prose MUST contain the literal token `context.condition` / `precedence` /
     `last wins` / `all included` so `compiler-design.2` greps it.
  2. **Per-platform header builder contract** — for each `header_format`
     (`SEED_DATA.md` §5): `yaml_frontmatter` (claude_code) = `name`,
     `description`, `tools:` (resolved aliases), `model:` (resolved alias), then a
     `---` fence and the markdown body; `json_object` (claude_api/openai) = a JSON
     object with `systemPrompt` (flat body) + a structured `tools` array (shaped
     via `provider_tool_formats`); `none` = body only. The prose MUST contain
     `yaml_frontmatter` / `json_object` / `header builder`.
  3. **Cross-package join strategy** — confirm `[inv:one-db-handle]`: ONE handle,
     query `registry_*` / `tool_*` / `provider_*` / `policy_*`, no `ATTACH`, no
     cross-package FK. Cite plan 1's `decisions.md`. The prose MUST contain a
     topology token (`table-name prefix` / a `*_` prefix / `single SQLite` /
     `one DB`).
  4. **Composed-prompt cache key** — `context_hash` = canonical hash over the
     `(context, resolved component-version set)`; a context change or version-pin
     change misses the cache. Define the canonicalization (sorted-key JSON).
- Escalate to the requester (planner-class amendment) if a decision changes the
  DAG — e.g. discovering plan 1 left precedence under-specified forces an upstream
  amendment before this plan can proceed.

---

## Acceptance criteria

- [compiler-design.1] decisions.md exists
- [compiler-design.2] context-condition precedence consumption recorded (matches agent-registry)
- [compiler-design.3] per-platform header builder contract recorded
- [compiler-design.4] single-DB cross-package join topology cited

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-compiler/decisions.md", "docs/plan/agent-compiler/contexts/compiler-design.md"]
```

---

## Commit points

- After writing `decisions.md`: `docs(agent-compiler): record compiler architecture decisions`.
- Post-guard mandatory commit recorded by `state-transition.js --complete`.

## Notes for executor

- This is a judgment state. Read `USAGE.md` (the whole intended end-state),
  `DATA_MODEL.md` Domain 1 "Composed Prompts" + Domain 5, `SEED_DATA.md`
  §5/§6/§7/§14, and `agent-registry-schema/decisions.md` (for the precedence +
  topology rules this plan consumes) in full. Have `architect-reviewer` sign off on
  `decisions.md` before advancing (README Execution model assigns it as reviewer).
- The DB topology is INHERITED, not re-decided — cite plan 1, don't re-open it.
- `compiler-design.2/3/4` grep `decisions.md` for the tokens above; the prose must
  literally contain them so the coupling cannot be silently dropped.
