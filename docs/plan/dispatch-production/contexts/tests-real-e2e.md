# tests-real-e2e — Full lifecycle integration test

## Design

`tests/integration/real-e2e.ts` is a single entrypoint that drives 8 scenarios
sequentially. Each scenario is a self-contained test case with a binary
pass/fail assertion. The test harness starts with an empty `tmp/test-e2e/`
directory and ends with it removed.

Only scenario 4 gates on `DISPATCH_E2E_LIVE=1` (paid third-party LLM call).
All other scenarios use the mock agent runner.

## Mock agent runner

`tests/integration/helpers/mock-agent-runner.ts` implements the
`IDispatchAgentRunner` interface that the orchestrator calls for `fire()` and
`poll()`. It does NOT call a real LLM, but it does exercise the exact same
code path:

```ts
interface IDispatchAgentRunner {
  fire(unit: DispatchUnit): Promise<{ taskId: string }>;
  poll(taskId: string): Promise<TaskResult>;
  cancel(taskId: string): Promise<void>;
  ensureAgent(unit: DispatchUnit): Promise<void>;
}

interface TaskResult {
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  tokens?: { input: number; output: number };
}
```

The mock writes the compiled prompt to `tmp/test-e2e/debug/agent-<slug>.md` so
a human can inspect what the orchestrator would have sent. For `ensureAgent`,
it records the call and returns (useful for asserting the orchestrator created
the right agent definition).

## Test harness

`tests/integration/helpers/test-harness.ts` provides:

```ts
// Creates a clean tmp/test-e2e/ directory, returns the DagClient wired to it
function setupTestEnv(): { client: IDagClient; root: string; cleanup: () => void };

// Builds the full orchestrator with mock agent runner + IO plugin + JSON serializer
function createTestOrchestrator(client: IDagClient, agentRunner?: IDispatchAgentRunner): Orchestrator;

// Helper: get the raw dag.json from disk after client mutations
function readDagOnDisk(root: string): DagJson;

// Helper: run the CLI dispatch command in a subprocess, capture stdout/exit code
function cli(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number };
```

## Test scenarios

### Scenario 1 — Cold start: empty directory

```
setup: tmp/test-e2e/ is empty (no dag.json)
action: cli(["init", "--plan", "test-e2e"], cwd=tmp/test-e2e)
assert: exitCode === 0
assert: readDagOnDisk() has schema_version === 4, milestones === {}, operations === [], dispatch_log === []
action: cli(["status", "--plan", "test-e2e"], cwd=tmp/test-e2e)
assert: stdout contains "Milestones: 0"
assert: stdout contains "Eligible: 0"
```

### Scenario 2 — Author plan via DagClient (simulating MCP tools)

```
setup: DagClient wired to tmp/test-e2e/dag.json via createJsonFileSerializer
action: client.create({ plan_kind: "greenfield", description: "...", terminal: "implement", phases: ["research", "interface", "implement"] })
action: client.milestone_add("embedding-approach-decided", {
  description: "Research: choose embedding model, measure dimensionality and latency",
  phase: "research",
  depends_on: [],
  agent: "workflow:workflow-researcher",
  model: "Sonnet",
  effort: "high",
  guard: "grep -c '^## Decision' contexts/embedding-research.md | awk '{exit ($1 < 2)}'"
})
action: client.milestone_add("embed-interface-defined", {
  description: "Define EmbedWorker interface and Episode type with embedding field",
  phase: "interface",
  depends_on: ["embedding-approach-decided"],
  agent: "workflow:plan-orchestrator",
  model: "Sonnet",
  effort: "medium",
  guard: "npx nx typecheck memory-core"
})
action: client.milestone_add("embed-worker-implemented", {
  description: "Implement FastEmbedWorker and wire into memory-server",
  phase: "implement",
  depends_on: ["embed-interface-defined"],
  agent: "workflow:plan-orchestrator",
  model: "Sonnet",
  effort: "high",
  guard: "npx nx test memory-server"
})
action: client.operation_add({
  id: "embedding-approach-decided.1",
  milestone: "embedding-approach-decided",
  depends_on: [],
  type: "generative",
  action: "create",
  file: "contexts/embedding-research.md",
  shape: { kind: "doc", description: "...", objective: "...", required_sections: ["## Decision", "## Performance"] },
  ki_estimate: 2000, ki_source: "estimate"
})
// ... 4 more operations for the other two milestones
action: client.validate()
assert: valid === true
action: cli(["status", "--plan", "test-e2e"], cwd=tmp/test-e2e)
assert: stdout shows 3 milestones, 1 eligible (research), 5 operations
assert: readDagOnDisk() passes validateDagJson() from @adhd/dispatch-spec
assert: readDagOnDisk().milestones has 3 keys, all with correct depends_on edges
assert: readDagOnDisk().operations has 5 entries, all with valid milestone refs
```

### Scenario 3 — Snapshot and optimize on authored plan

```
setup: continue from scenario 2
action: cli(["optimize", "--plan", "test-e2e"], cwd=tmp/test-e2e)
assert: exitCode === 0
// parse stdout for the dispatch plan (it prints JSON or a summary table)
assert: dispatch units === 1 (only research is eligible)
assert: unit.milestones === ["embedding-approach-decided"]
assert: unit.prompt !== null (generative doc op)
assert: unit.fits_context_window === true
assert: unit.tokens_estimated > 0 (B cold-start defaults are seeded, ki_estimate is authored)
assert: unit.sentinel_role === "solo" (N=1, no fanout possible)
assert: unit.agent_name === "workflow-researcher" (namespace prefix stripped)
assert: unit.provider.type === "claudecli"
assert: unit.resolved_max_tokens === 8192 (effort=high)

// Verify the compiled prompt contains expected content
assert: unit.prompt.includes("## Milestone: embedding-approach-decided")
assert: unit.prompt.includes("Research: choose embedding model")
assert: unit.prompt.includes("- [embedding-approach-decided.1] create contexts/embedding-research.md")
assert: unit.prompt.includes("## Decision")  // from shape.ops
assert: unit.prompt.includes("### Guard: grep -c")

// Verify snapshot determinism (two calls produce identical non-timestamp output)
const snap1 = JSON.parse(cli(["snapshot", "--plan", "test-e2e"], cwd).stdout)
const snap2 = JSON.parse(cli(["snapshot", "--plan", "test-e2e"], cwd).stdout)
assert: deepEqual(normalizeTimestamps(snap1), normalizeTimestamps(snap2))

// Verify snapshot structure
assert: snap1.milestones["embedding-approach-decided"].eligible === true
assert: snap1.milestones["embedding-approach-decided"].wave === 0
assert: snap1.milestones["embed-interface-defined"].eligible === false (dep not complete)
assert: snap1.milestones["embed-worker-implemented"].eligible === false
assert: snap1.open_questions.length === 0 (no pending fields set)
```

### Scenario 4 — Real dispatch via agent-mcp Haiku (LIVE gate)

```
gate: process.env.DISPATCH_E2E_LIVE !== "1" → skip with "SKIP (LIVE gate)"
       documented in README.md, CLAUDE.md, and this file's header

setup: a real agent-mcp instance is running (precondition — the test checks and fails
       with a clear message if agent-mcp is unreachable)
setup: the orchestrator is configured with a real IDispatchAgentRunner that wraps
       the agent-mcp task + result APIs

action: orchestrator runs one cycle — snapshot() → optimize() → fire research unit
        → poll for completion → append dispatch_log → re-snapshot
assert: the Haiku agent created contexts/embedding-research.md at the expected path
assert: the file has ≥ 2 sections (## Decision, ## Performance)

// Verify dispatch_log was appended correctly
const dag = readDagOnDisk()
const lastEntry = dag.dispatch_log[dag.dispatch_log.length - 1]
assert: lastEntry.kind === "execution"
assert: lastEntry.provider === "claudecli"
assert: lastEntry.agent === "workflow-researcher"
assert: lastEntry.turns.length > 0
assert: lastEntry.turns.reduce((s,t) => s + t.input_tokens + t.output_tokens, 0) > 0
assert: lastEntry.results[0].op_id === "embedding-approach-decided.1"
assert: lastEntry.completed_at !== null

// Verify milestone state after real dispatch
const snap = snapshot(readDagOnDisk(), deps)
assert: snap.milestones["embedding-approach-decided"].status === "complete"
assert: snap.milestones["embedding-approach-decided"].eligible === false
assert: snap.milestones["embedding-approach-decided"].tokens_actual > 0

// Verify guard ran and passed
assert: snap.milestones["embedding-approach-decided"].guard_result === "pass"
assert: snap.milestones["embedding-approach-decided"].completed_at !== null
```

### Scenario 5 — Second cycle: next milestone becomes eligible

```
setup: continue from scenario 4 (or scenario 2 if LIVE gate was skipped)
setup: mock agent runner is configured to succeed the interface milestone (writes
       the expected type files to tmp, simulating what the real agent would do)

action: orchestrator runs its next cycle
assert: 2 dispatch_log entries now (research + interface)
assert: snap.milestones["embed-interface-defined"].status === "complete"
assert: snap.milestones["embed-interface-defined"].eligible === false
assert: snap.milestones["embed-interface-defined"].guard_result === "pass"

// Verify the orchestrator did NOT inject a replan milestone
// (pending was null from the start — the plan was authored complete)
const dagAfter = readDagOnDisk()
const replanMilestones = Object.entries(dagAfter.milestones)
  .filter(([_, m]) => m.triggered_by !== null)
assert: replanMilestones.length === 0

// Verify third milestone is now eligible
const snapAfter = snapshot(dagAfter, deps)
assert: snapAfter.milestones["embed-worker-implemented"].eligible === true
assert: snapAfter.milestones["embed-worker-implemented"].status === "pending"
```

### Scenario 6 — Guard failure and correction injection

```
setup: mock agent runner is configured to make the implementation agent produce
       output that fails the guard (e.g., writes the wrong file or missing export)
setup: the guard for "embed-worker-implemented" is set to:
       "grep -q 'export class FastEmbedWorker' libs/memory-core/src/embedWorker.ts"

action: orchestrator cycle fires implementation → guard fails
action: orchestrator detects guard failure, appends a warn note to dispatch_log

// Verify failure is recorded
const dagAfterFail = readDagOnDisk()
const failEntry = dagAfterFail.dispatch_log[dagAfterFail.dispatch_log.length - 1]
assert: failEntry.results.some(r => r.guard_result === "fail")
assert: failEntry.notes.some(n => n.level === "error")

// Verify orchestrator injected correction milestones
const snapFail = snapshot(dagAfterFail, deps)
const injected = Object.entries(dagAfterFail.milestones)
  .filter(([_, m]) => m.triggered_by !== null)
assert: injected.length >= 1
assert: injected[0][1].triggered_by === failEntry.id
assert: injected[0][1].phase === "implement"
assert: injected[0][1].depends_on.includes("embed-interface-defined")

// Verify the failing milestone is now pending-surfaced
assert: snapFail.milestones["embed-worker-implemented"].status === "failed"
// (the correction milestone's existence means pending-surfaced, but status failed takes precedence)

// Verify open_questions surfaced
assert: snapFail.open_questions.length >= 1
assert: snapFail.open_questions.some(q => q.surfaced === true)
```

### Scenario 7 — Correction resolves and retry succeeds

```
setup: continue from scenario 6
setup: mock agent runner is configured to:
       (a) review milestone: write a 2-line correction note to contexts/review-impl.md
       (b) replan: call dag.operation_add to add the missing op, then dag.pending_clear
       (c) implementation retry: succeed the guard this time

action: orchestrator continues cycling
       → review fires → completes (guard: file exists)
       → replan fires → clears pending, adds operation, replan guard: validateDag passes
       → implementation re-dispatched → guard passes

assert: snap.milestones["embed-worker-implemented"].status === "complete"
assert: snap.milestones["embed-worker-implemented"].guard_result === "pass"

// Verify full dispatch log
const dagEnd = readDagOnDisk()
assert: dagEnd.dispatch_log.length >= 4  // research, interface, review, replan, implementation, +1 failure
// Count entries per milestone
const counts = {};
for (const e of dagEnd.dispatch_log) {
  for (const opId of e.operations) {
    const slug = opId.split(".")[0];
    counts[slug] = (counts[slug] || 0) + 1;
  }
}
assert: counts["embed-worker-implemented"] === 2  // one failed, one succeeded

// Verify terminal milestone is now eligible
const snapEnd = snapshot(dagEnd, deps)
assert: snapEnd.milestones["embed-worker-implemented"].eligible === false
// The plan has 3 milestones, all complete — nothing is eligible (terminal reached)

// Verify tokens are tracked
const totalTokens = dagEnd.dispatch_log.reduce(
  (sum, e) => sum + e.turns.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0),
  0
)
assert: totalTokens > 0

// Verify no milestones have pending set (all were resolved)
assert: Object.values(dagEnd.milestones).every(m => m.pending === null)
```

### Scenario 8 — CLI resume and calibration

```
setup: clean test env with the completed dag.json from scenario 7
       Write it to tmp/test-e2e/dag.json
       Delete the last 2 dispatch_log entries to simulate mid-cycle crash
action: cli(["status", "--plan", "test-e2e"], cwd=tmp/test-e2e)
assert: stdout shows 2 complete (research, interface), 1 pending (implementation)

action: cli(["run", "--plan", "test-e2e", "--cycle", "1"], cwd=tmp/test-e2e)
assert: exitCode === 0
assert: stdout shows "Dispatching: embed-worker-implemented"

// Verify orchestrator did NOT re-dispatch completed milestones
const dagAfter = readDagOnDisk()
const researchDispatches = dagAfter.dispatch_log.filter(e =>
  e.operations.some(op => op.startsWith("embedding-approach-decided"))
)
assert: researchDispatches.length === 1  // not 2

// Verify calibration command
action: cli(["calibrate", "Sonnet"], cwd=tmp/test-e2e)
// Mock agent runner records the null-task dispatch
assert: exitCode === 0
// Verify ~/.adhd/dispatch-calibration.json exists and has Sonnet key
const cal = JSON.parse(fs.readFileSync(os.homedir() + "/.adhd/dispatch-calibration.json"))
assert: typeof cal.Sonnet === "number" && cal.Sonnet > 0
```

## Assertions with teeth

Each scenario must FAIL when the code under test is broken. The test file includes
comments marking negative controls:

```ts
// NEGATIVE-CONTROL: revert the D-07 fix → scenario 2 assert "eligible=1" fails
// NEGATIVE-CONTROL: revert attempt_count stub → scenario 4 assert "turns>0" fails
// NEGATIVE-CONTROL: revert normalizeOperations() type default → scenario 3 assert
//   "prompt !== null" fails (all ops treated as tool-call, prompt = null)
// NEGATIVE-CONTROL: revert atomic write → scenario 1 assert "dag exists" either
//   passes (lucky, no crash) or fails with corrupted JSON
// NEGATIVE-CONTROL: revert Sentinel-Fanout → scenario 3 assert sentinel_role === "prewarm"
//   (N=1 with fanout enabled→solo designation unchanged; but N≥2 test would flip from
//   "payload" to "solo" if fanout disabled)
// NEGATIVE-CONTROL: remove guard failure detection → scenario 6 assert injected.length
//   >= 1 fails (no correction milestones injected)
```

## File inventory

| File | Purpose |
|---|---|
| `tests/integration/real-e2e.ts` | Scenario runner (8 scenarios, sequential) |
| `tests/integration/helpers/test-harness.ts` | setupTestEnv, createTestOrchestrator, cli, readDagOnDisk |
| `tests/integration/helpers/mock-agent-runner.ts` | IDispatchAgentRunner for scenarios 1-8 (except live scenario 4) |
| `tests/integration/fixtures/test-e2e-plan.ts` | The 3-milestone plan definition used across all scenarios |
| `tmp/test-e2e/` | Ephemeral test root — created by setup, removed by cleanup |

## Live test gate (scenario 4 only)

Per the live-testing policy in CLAUDE.md §6, scenario 4 is the single qualifying
exception — it calls a paid third-party LLM. The gate is:

- Env var: `DISPATCH_E2E_LIVE=1`
- Documented in: this file, README.md, CLAUDE.md, and the test file header
- Named owner: plan-builder (workflow:plan-builder)
- When gated: scenario 4 auto-skips with `SKIP (scenario 4: DISPATCH_E2E_LIVE not set)`
- All other scenarios (1-3, 5-8) run by default, no gate, no skip
