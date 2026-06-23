# frontmatter-parser — PARSE YAML FRONTMATTER → AGENT + AGENT_TOOL + model_hint

**Phase:** parse · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/frontmatter.test.ts`

---

## Goal

A `parseFrontmatter(md)` function reads an agent `.md` file's YAML frontmatter and
returns the data the importer needs: `slug` (from `name:`), `description`, the
list of canonical `tool` ids (from the `tools:` comma list resolved through the
claude_code binding), and a `modelHint` (from `model:`). Tested against the real
`code-reviewer.md` fixture.

---

## Semantic Distillation

- **Primitive:** ADD `src/parse/frontmatter.ts` + `frontmatter.test.ts`.
  Contributes to `[dod.2]` (the agent + tool rows the importer persists).
- **Reference Pattern:** `[fix:frontmatter-mapping]`. SEED_DATA §0 steps 1-3.
- **Delta Spec:**
  - Split the file at the leading `---` YAML fence; parse the block with a YAML
    parser (`yaml`).
  - `name:` → `slug`; `description:` → `description`.
  - `tools:` — split the comma list into tokens; for each token look up
    `TOOL_PLATFORM_BINDING` where `platform_tool_name = token AND platform =
    claude_code` (via the published tool-registry store) → canonical tool id.
    Unknown tokens are collected into a `flagged` list (may be an MCP tool needing
    a new `MCP_SERVER` row) — never silently dropped.
  - `model:` → resolve via `MODEL_PLATFORM_BINDING[claude_code]` (agent-provider)
    → `modelHint`; unknowns flagged.
  - `frontmatter.test.ts` — parse the `code-reviewer.md` fixture and assert:
    `slug === "code-reviewer"`, the `tools:` tokens (`Read`, `Write`, `Bash`, …)
    resolve to canonical ids, `modelHint` resolves from `sonnet`, and an unknown
    tool token lands in `flagged`.

---

## Acceptance criteria

- [frontmatter-parser.1] frontmatter parse test passes (name/desc/tools/model -> rows)
- [frontmatter-parser.2] maps tools: via TOOL_PLATFORM_BINDING[claude_code]

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md"]
mutates:    ["packages/ai/agent-registry-migration/src/parse/frontmatter.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/frontmatter.test.ts"]
```

---

## Commit points

- `feat(agent-registry-migration): parse agent frontmatter to AGENT + AGENT_TOOL + model_hint`

## Notes for executor

- The binding lookups are real DB reads against the published tool-registry /
  provider stores — seed the relevant binding rows in the test setup so the
  resolution is exercised, not stubbed (`[inv:real-deps-not-mocks]`).
- Flagging unknown tools is load-bearing for the corpus: do not drop them.
