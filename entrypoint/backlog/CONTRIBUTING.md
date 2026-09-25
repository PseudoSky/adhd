# Contributing to `@adhd/backlog`

## End-to-end testing strategy: blind multi-agent real-world tests

> **Status (2026-09-24): the `backlog-e2e-*` scripts are not in the repository.**
> No `backlog-e2e-*` file exists in the working tree, and none has ever been
> committed (`git log --all` has no history for those paths). The strategy below
> is retained as the design for that harness — treat it as intent, not a
> runnable procedure, until the scripts are re-added.

Unit tests (`src/**/*.spec.ts`) prove the write/query primitives are correct
in isolation against a real (non-mocked) store. They do not prove the CLI,
the skill doc, and the tool's discoverability actually work for an agent who
has never seen this codebase. That gap is what the workflows in
`.claude/workflows/backlog-e2e-*.js` were built to close, and it has already
found real defects unit tests could not: a `batch action` primitive nobody
discovered, a `claim`/`transition` ownership gap, an unbounded terminal-status
claim, and half a dozen discoverability defects in the live `--help` schema.

### The core principle: agents must be BLIND

Every agent under test is given a real job and a path to the packaged
tarball's binary + its own installed skill doc — nothing else. It is never
told this is a test, never given a verb checklist, never told which behaviors
are being measured. Whether it finds `lookup`, dedupe, embeddings, relations,
`batch`, and claim/release on its own **is** the result. Two enforcement
mechanisms are load-bearing, not optional:

1. **Filesystem isolation.** Each run gets a freshly `mktemp -d`'d directory,
   never a subdirectory with a test-shaped name sitting next to other
   scratch work. An agent that runs `ls ..` must not see anything that
   reads as "this is a harness."
2. **Tool-surface restriction (`agentType: 'core:code-typescript'`).** The
   first version of this test used the workflow default agent type, which
   includes `ListAgents`/`SendMessage`/`ToolSearch`/MCP access. The "blind"
   lead immediately called `ListAgents`, discovered unrelated sibling
   teammates on the machine, and spent its entire budget investigating the
   test harness instead of touching the tracker — zero backlog CLI calls in
   its transcript. Scoping the agent type to `Read/Write/Edit/Bash/Grep/Glob`
   closes that hole structurally; you cannot fix it by asking the agent to
   stay on task.

### Why two separate workflow files, not one

A Workflow script cannot learn its own `runId` from inside itself — the
runId is only assigned after `Workflow()` returns to the caller. Tool
coverage is extracted by scanning that run's own transcript directory by
`runId`, which requires the run to already be finished. So the shape is:

```
Workflow(backlog-e2e-real-world.js)   →  returns lead+impl reports + runId
  → (outside the workflow) extract-coverage.mjs scans that runId's transcripts
Workflow(backlog-e2e-judge.js, args: {..., coverage})  →  3-lens verdict
```

A single combined workflow cannot do the self-referential coverage step; do
not try to collapse this back into one file.

### Tool coverage is measured, never self-reported

`backlog-e2e-extract-coverage.mjs` parses the real `Bash` tool-call
transcripts of every agent flagged `underTest` (via a `model` in its sidecar
`.meta.json` — `opus`/`haiku`/`sonnet` are the tiers currently trusted for
this) and matches commands against the verb grammar
(`\bbacklog\s+(verb1|verb2|...)\b`), excluding `--help` probes (discovery is
not use). This is deliberately NOT LLM-judged and NOT self-reported — an
agent's own "I used claim and transition" claim is not evidence; the
transcript is. Anchor on the verb grammar, never on the binary name/path —
an earlier version anchored on the path and would have silently
under-reported any aliased/npx/absolute-path invocation as "0% coverage,"
indistinguishable from genuine non-use.

### Judge panel: 3 independent blind lenses, not one aggregate score

After the plan/implement/capture phases return, a **separate** judge
workflow (`backlog-e2e-judge.js`) dispatches 3 parallel judges — each given
the raw transcripts and asked to score ONE lens only (`correctness`,
`idiomatic` usage, `discoverability`) — rather than one judge scoring
everything. A single judge asked to cover all three tends to average away
exactly the low-discoverability, high-correctness split that is the most
actionable signal (a tool can be used correctly by an agent who fought hard
to discover it, and that fight is the finding).

**Judge findings are not automatically true.** Cross-check every
`isToolDefect: true` finding against the live tool directly before filing or
fixing anything — see the next section.

### Ground truth beats every self-report — always re-derive from the real store

Agent self-reports (both the lead/implementer's own summaries and the
judges' analysis) have been directly contradicted by the real audit trail
more than once in this test's history. Example: one implementer believed it
had "cleanly closed" an item; a second agent's report attributed the same
close to a different engineer; the real `backlog get --fields auditTrail`
output showed a third sequence entirely (the first agent had already
released its claim before writing the transition, while a different agent
held the live claim at that moment) — which is what actually surfaced the
claim/transition ownership bug. **Before treating any agent-reported finding
as real, re-derive it from `backlog get --input '{"uid":...,"fields":
["auditTrail","status"]}'` against the actual store**, not from what any
agent — under test or judging — says happened.

### Multi-project / multi-repo coverage

The plan brief seeds a scenario with **three separate repos** (`api-platform`,
`mobile-app`, `platform-infra`), each registered as its own project, with a
genuine cross-project dependency (mobile-app's push-notification work cannot
start until api-platform's daily summary endpoint is ready) that the lead must record with a real
`relate` edge across project boundaries — not just a same-project
convenience relation. This exists because a tool that only gets exercised
against a single toy project can hide bugs in project-scoping,
cross-project `relate`, and query filters that only show up once more than
one repo is really in play.

### Concurrency: contention is a first-class test dimension, not an
afterthought

A sequential lead-then-implementer run proves nothing about concurrent
multi-agent correctness — it is a sequential, one-agent-at-a-time scenario
dressed up as multi-agent. Two distinct techniques are both required, because
they prove different things:

1. **Raw forced contention** (no LLM in the loop): launch N real OS
   processes with `&`, collect every PID, and `wait` each one explicitly —
   `for i in ...; do ( cmd & ); done; wait` is a bug, not a test: the inner
   `( ... & )` subshell backgrounds `cmd` and the outer subshell exits
   immediately, so the outer `wait` returns before `cmd` finishes. All N
   processes target the literal same item uid. This is what proves (or
   disproves) the store's actual write-serialization guarantee under worst-
   case simultaneity — `backlog-e2e-concurrency.js`'s ground-truth phase
   ran 15-, 20-, and 30-way simultaneous `claim` attempts on a single fresh
   item each round; every round produced exactly one winner and correct
   `conflict` responses for the rest, verified against the real audit trail
   (not just the CLI's returned exit status).
2. **Organic multi-agent contention** (real blind agents, real concurrency):
   several engineer agents (mixed models — at least one `haiku` — never
   `opus` in a Workflow dispatch) working the same shared store
   simultaneously via `parallel()`, told the true scenario (several
   engineers are on the same shift) without being told it's a test. This
   surfaces usage-pattern bugs raw contention tests cannot (e.g. an agent
   releasing a claim and then still successfully transitioning the item
   afterward) because it depends on realistic agent behavior sequences, not
   synthetic simultaneity.

### Where the scripts live and how to run them

All e2e workflow scripts live in `.claude/workflows/`, not under
`entrypoint/backlog/` itself and not under a generic `tools/` directory —
they orchestrate multiple Claude Code subagents via the `Workflow` tool and
belong alongside this repo's other workflow scripts
(`backlog-adversarial-loop.js`, `backlog-grooming.js`).

- `backlog-e2e-seed.mjs` — seeds a handful of vague, half-formed notes (the
  "founder already wrote something down and doesn't remember what"
  scenario) into a fresh sandboxed store before the lead runs.
- `backlog-e2e-real-world.js` — Plan → Implement → Capture. Requires
  `args: {bin, root, skill, outDir}` pointing at a packaged tarball install,
  never source.
- `backlog-e2e-extract-coverage.mjs` — deterministic transcript parser, run
  standalone against the finished run's `runId` transcript directory
  (`.claude/workflows/backlog-e2e-extract-coverage.test.mjs` is its unit
  test suite — run it directly with `node` before trusting a coverage number
  from a workflow edit).
- `backlog-e2e-judge.js` — the 3-lens judge panel. Requires
  `args: {lead, impl, capture, coverage, bin, root, skill}` — the outputs of
  the real-world run plus the extracted coverage, never re-derived from
  scratch.
- `backlog-e2e-concurrency.js` — the multi-agent contention test described
  above. Requires `args: {bin, root, skill, uids, blockerUid}` against a
  pre-seeded shared store with a real `blocks` dependency already wired in
  (seed it directly with the CLI — a Workflow script has no filesystem
  access, so all sandbox setup happens in the dispatching shell before the
  workflow is invoked, and every path is passed in via `args`).

Always test against a **packaged tarball install**, never the repo's own
`src/` via ts-node/tsx — a source-mode run proves nothing about what a real
consumer installing from npm actually gets (see this repo's own
`PUBLISHING.md` for how to produce that tarball).

### Never opus in a Workflow dispatch

Every `agent()` call inside any of these scripts uses `sonnet` or `haiku`,
never `opus`. This is a hard rule for this repo's Workflow-tool usage, not a
cost optimization left to judgment per script.
