# corpus-parser — deterministic parser for the 00-active COMMON FORMAT → full 18-type component set

**Phase:** parse · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/corpus-parser.test.ts`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

A **deterministic** (no LLM) parser for the COMMON FORMAT of the 00-active agent
corpus — YAML frontmatter (`name`, `description`, `tools`, `model`) + a markdown
body of titled `##` sections plus an un-headed opening `You are a…` paragraph.
Each file parses into:

- one `AGENT` shape (`slug` ← `name`, `description`, `model_hint`, tool list);
- an **ordered** list of `PROMPT_COMPONENT` candidates, each mapped onto one of the
  **FULL 18-type set** (`[def:eighteen-types]`): `role`, `identity`, `capability`,
  `rule`, `style`, `personality`, `process`, `invocation`, `success_criteria`,
  `handoff`, `escalation`, `posture`, `boundary`, `convergence`, `deliverable`,
  `evidence`, `context_pull`, `risk_posture`.

The corpus headings are highly heterogeneous (a long tail of one-off `##` titles),
so the parser combines a deterministic heading→type table for the recognizable
forms with an explicit **unmapped-section flag** for anything it cannot confidently
type (the LLM states downstream do the semantic typing of the residue; the parser
never silently drops content). The un-headed opening paragraph maps to `role`.

**Proof teeth (`[corpus-parser.3]`):** run the parser over the REAL corpus (the 46
00-active agent files at `~/dev/ai/claude-agents/categories/00-active/agents/*.md`,
plus the in-repo fixtures) and assert that **every one of the 18 component types is
exercised at least once across the corpus, OR every section that maps to no type is
explicitly recorded in an `unmapped[]` flag list** — there is no third "silently
dropped" outcome. This is what makes the full vocabulary real, not aspirational.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [corpus-parser.1] parses frontmatter (name/description/tools/model) + body sections + un-headed `You are…` -> role, deterministically (no LLM), recoverable shape
- [corpus-parser.2] heading->prompt_type table covers the recognizable 18-type forms; tools mapped via TOOL_PLATFORM_BINDING[claude_code], unknown tools flagged
- [corpus-parser.3] driven over the REAL 00-active corpus: every one of the 18 types is exercised across the corpus OR each unmapped section is explicitly flagged (no silent drop)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/src/parse/agent-parser.ts", "packages/ai/agent-registry-migration/src/parse/component-mapping.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/corpus-parser.test.ts"]
```

---

## References & interfaces

- [fix:frontmatter-mapping] — frontmatter → AGENT/AGENT_TOOL mapping (`_shared.md`).
- [fix:body-mapping] — heading → prompt_type table + position ordering (`_shared.md`).
- [def:eighteen-types] — the full 18 prompt-type vocabulary (`_shared.md`).

---

## Notes for executor

- **Deterministic, no LLM here.** This state is pure parsing — frontmatter via a
  YAML parser, body via a heading splitter. The semantic typing of ambiguous
  sections is the LLM states' job (`haiku-usecase-batch`/`sonnet-consolidation`);
  the parser's contract is to produce a faithful, ordered section list and to FLAG
  what it could not type, never to guess silently.
- **Drive the REAL corpus for `[corpus-parser.3]`.** The 46 00-active files live at
  `~/dev/ai/claude-agents/categories/00-active/agents/*.md` (`[inv:cross-repo]` —
  read-only; the parser READS them, it never writes there). Also exercise the
  in-repo fixtures so the test stays runnable if the external repo is absent (skip
  the corpus-wide assertion with a clear message when the external path is missing,
  but still run the fixture assertions — do not fail CI offline).
- **18-type coverage is the headline.** The whole point of re-authoring this plan is
  that the FULL component vocabulary gets exercised, not just the half-dozen common
  headings. Assert the union of mapped types across the corpus covers all 18, or
  that the residue is in `unmapped[]`. A type that is NEVER produced and NEVER
  flagged is a parser gap — the test must catch it.
- **Position = order of appearance** (1-indexed); `context_condition = null`;
  `version = 1` (`[fix:body-mapping]`).
- Append exports to `src/index.ts` (append-only barrel, `_shared.md`).
