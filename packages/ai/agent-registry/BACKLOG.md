# @adhd/agent-registry — BACKLOG

Tracked, non-blocking follow-ups. Surfaced by the code-review sign-off (`docs/plan/agent-registry-schema/review.md`, VERDICT: APPROVED). None block the schema package merge — the real ship gates (`nx build`, `nx test`) are green.

## NB-1 — `nx typecheck` fails (repo-wide tsconfig, pre-existing)
- **What:** `nx typecheck agent-registry` fails. The reviewer verified the **identical failure reproduces on the sibling `agent-mcp` package** — an inherited copy-paste tsconfig convention across `packages/ai/*`, not introduced by agent-registry.
- **Investigation:** the reviewer's suggested one-line fix (`"composite": true` in `tsconfig.lib.json`) is **insufficient** — adding it surfaced 13 further typecheck errors (and `build` already passes without it), so it was reverted. This is a real cross-cutting cleanup, not a leaf fix.
- **Impact:** none on shipping (build + test pass; `build` invokes `tsconfig.lib.json` directly and compiles clean). Affects the `typecheck` target only.
- **Action:** route as a **repo-wide `packages/ai/*` tsconfig/typecheck cleanup** (align `composite`/project-references config across the AI packages, resolve the 13 errors at root). Do NOT fix agent-registry in isolation — it diverges from `agent-mcp` and the others.

## NB-2 — stale comment in `src/seed/index.ts`
- **What:** a comment describes behavior that has since changed; the actual code behavior is still correct.
- **Impact:** cosmetic / documentation only.
- **Action:** update the comment to match the current implementation.

## NB-3 — `decisions.md` ↔ code prose drift (context_rules merge location)
- **What:** `decisions.md` Decision 3 prose can read as if `resolveComposition` already merges free-standing `context_rules`, but the code correctly defers the rules∪junction merge to `@adhd/agent-compiler` (per the per-state plan). Code is right; the contract prose is ambiguous.
- **Impact:** risk that an `agent-compiler` author skips implementing the union, expecting the registry to have done it.
- **Action:** add a one-line clarification in `decisions.md` (and/or the `agent-compiler` plan's context) stating the merge lives in the compiler, not `resolveComposition`.
