# 376fe07f — numbered offset/limit file read: BLOCKED ON HUMAN (package-creation approval)

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
item user-request (verbatim, from the item): "If we have a concrete problem that needs to be solved we should research alternative tools and test them. if we come to the conclusion that building it ourself has the ROI then that's okay"
items: 376fe07f-ee3a-4f88-a065-7044abb57cbc (feature, HIGH, project adhd; part_of plan 9ed453c1-b113-473d-8c35-fc6dc2541306)
dor: blocked-on-human — check: AGENTS.md Rules: "You never create a new package (any tier, any generator) without explicit human approval recorded in your ticket or prompt; `--dry-run` is for inspection only." The item's scope scaffolds `@adhd/agent-core-native-read` via `workspace-codegen-nx:core`; no approval is recorded in the item or the dispatch prompt. No implementation is specced here by instruction.

## Facts established (O = opened)
- O: the item's placement plan creates a new package and mounts it from `/Users/nix/dev/node/adhd/packages/agent/agent-core-native-tooling/src/lib/catalog.ts` (`resolveFsServerLaunch` at l.69; the item cites l.36-101). `packages/agent/agent-core-native-tooling` already exists and already owns catalog + launch resolution, EOL, permissions, exit-shim modules.
- O: ADR-0008 Amendment A1 (accepted, `docs/decisions/0008-agent-mcp-native-tooling.md:342`) permits building a native tool after evaluation; it does not approve a package creation.
- O: gx/ADR constraints that any answer must keep: ADR-0009 (stdio-server tests are `*.e2e.test.ts`, tier P), platform isolation (`platform:node`), reuse-before-create (AGENTS §8, "two-use" rule).

## The question for the human (one decision)
May a NEW package `@adhd/agent-core-native-read` (tier `core`, group `agent`, layer `logic`, platform `node`, `--access public --publish true`) be created, or must the read tool live inside the existing `packages/agent/agent-core-native-tooling` package?

Options and consequences (no recommendation is pre-committed; the architect would spec whichever is approved):
1. Approve the new package as written in the item (publishable, own versioning and bin; two packages need `verify-dist-load` per AC8; cost: one more published surface, README/AGENTS/CHANGELOG, release-pipeline wiring).
2. Host the stdio server inside `agent-core-native-tooling` as a second entry (no new package; shared catalog; cost: that package gains a second bin and its publish surface grows; item AC8 reduces to one package).
3. Decline the build and instead propose the numbering as a post-processing note in the existing fs server wrapper (no new server) — would need its own evaluation; conflicts with ADR-0008 A1's conclusion that no adoptable server gives native-Read output.

When approved, record the approval text in the item (`adhd-backlog update` note) and re-dispatch architect for a full spec: AC1-AC10 in the item are already stable and testable; open questions to carry into that spec: the claudecli bridge deny path is unverified (must be proven by a test, per item), and the tool-result-cap interaction (AC7).

## Product revision
dor (product): blocked-on-human (unchanged; product cannot grant package-creation approval).
Product recommendation for the user's one decision: Option 2 (host the stdio server inside the existing `agent-core-native-tooling`). Reasons: AGENTS section 8 reuse-before-create and the two-use rule (that package already owns catalog and launch resolution, so a second package would immediately import it back), one less published surface, and AC8 collapses to a single `verify-dist-load`. Option 1 only if the read tool must version and publish independently of the catalog. Option 3 conflicts with ADR-0008 A1's conclusion and is not recommended.
Priority: P3, rank 11 (blocked; value is a native-Read-shaped output, not a defect).
