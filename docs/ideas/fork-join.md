# Fork-Join Runtime — Beta Spec

> A content-first execution runtime that exploits how agent-mcp passes system prompts to the provider. The beta proves the cache economics: load shared context once, fork N role-specialized agents from it, collect outputs. Default execution model: parallel fork-join, not sequential role-chaining.

## Status: Pre-release Worktree

**Worktree:** `.worktrees/fork-join/`  
**Branch:** `wf/fork-join-beta`  
**Target:** Functional beta with empirical measurement, not production polish.

---

## 1. Why This Works: The agent-mcp System Prompt Pipeline

### 1.1 How agent-mcp Sends System Prompts

agent-mcp has three provider types with different system prompt handling:

| Provider | How system prompt is sent | Cache behavior |
|----------|--------------------------|---------------|
| `claudecli` | Shells out to `claude` CLI. The CLI's internal implementation may treat `--system` as a separate field. | Appears to cache content across different system prompts — partial cache reuse even when system prompt changes. |
| `openai` (direct API) | Passes `system` as a separate API parameter in the messages array at index 0. | Strict prefix caching. Different system prompts at position 0 = guaranteed cache miss. |
| `openai` (DeepSeek) | Same as `openai` — system parameter goes into messages at position 0. | Strict prefix caching. Confirmed: different system prompt = 0 cache hit. |

**Empirically verified (DeepSeek):**
```
RF security:   [system="security engineer" + content]       → 0 cached, 500 uncached
RF architect:  [system="software architect" + content]       → 0 cached, 490 uncached
CF security:   [system="" + content + "\n\nrole suffix"]     → 0 cached, 447 uncached  
CF architect:  [system="" + content + "\n\nrole suffix"]     → 384 cached, 51 uncached
```

### 1.2 The Key Constraint

agent-mcp allows agents with **empty system prompts**. When `systemPrompt: ''` (or omitted), the provider call is made without a `system` parameter. The first element of the `messages` array is a `user` message containing the prompt.

This is what makes content-first possible: the seed content occupies position 0 (the cache anchor), and the role suffix is appended as the last content in that message. When agent-mcp sends the request with an empty system prompt, the entire user message becomes the cacheable prefix.

### 1.3 Provider-Specific Behavior

| Provider | Empty sysPrompt → actual wire format | Cache behavior for content-first |
|----------|--------------------------------------|----------------------------------|
| **Claude (claudecli)** | `messages = [{role:"user", content:"seed\n\nrole"}]` — no `system` field | Partial: caches across calls even with different system prompts. Content-first still shows better hit rates. |
| **DeepSeek (openai)** | `messages = [{role:"user", content:"seed\n\nrole"}]` — no `system` key | Strict prefix: EXACT match required. Content-first: 88% hit rate. Role-first: 0%. |
| **OpenAI (direct)** | Same as DeepSeek — `system` field absent | Same as DeepSeek — strict prefix. |

### 1.4 What This Means for the Beta

The beta MUST:
1. Create agents with **empty system prompts** (`systemPrompt: ''` or omit the field)
2. Put the seed content at the BEGINNING of the user message (position 0)
3. Put the role instruction at the END of the user message (the only thing that differs per agent)
4. Use the **DeepSeek provider** through agent-mcp for the cleanest measurement (strict prefix caching makes the savings unambiguous)

The claudecli provider is available but its cache behavior is less strict (partial hits even with different system prompts), which muddles the measurement. The beta defaults to DeepSeek for proof and optionally runs on claudecli for cross-provider verification.

---

## 2. The agent-mcp Wire Format

When the beta calls `agent_task`, agent-mcp constructs the provider call. The two paradigms produce different wire formats:

### 2.1 Role-First (existing, via agent-mcp)

```
agent_create:
  name: "rf-security"
  systemPrompt: "You are a security engineer..."
  provider: { type: "openai", model: "deepseek-chat" }

agent_task:
  agent_name: "rf-security"
  prompt: "# Namespace spec\n\nA namespace is..."

Wire → Provider API:
  system: "You are a security engineer..."
  messages: [
    { role: "user", content: "# Namespace spec\n\nA namespace is..." }
  ]
  ← system at position 0, content at position 1
  ← changing system → cache boundary at position 0
```

### 2.2 Content-First (beta, via agent-mcp)

```
agent_create:
  name: "cf-security"
  systemPrompt: ""                            ← EMPTY
  provider: { type: "openai", model: "deepseek-chat" }

agent_task:
  agent_name: "cf-security"
  prompt: "# Namespace spec\n\nA namespace is...\n\nYou are a security engineer..."

Wire → Provider API:
  messages: [                                 ← NO system field
    { role: "user", content: "# Namespace spec\n\nA namespace is...\n\nYou are a security engineer..." }
  ]
  ← content at position 0, role at end of content
  ← identical prefix across all roles → position 0-~400 cached
  ← only the last ~50 tokens (role suffix) differ
```

### 2.3 Why This Works

When agent-mcp creates an agent with `systemPrompt: ''`, it omits the `system` field from the provider request. The entire payload becomes the `messages` array with a single user message. The first ~400 tokens (shared content) are identical across all forked agents. Only the last ~50 tokens (role suffix) differ. The provider's prefix cache matches on the identical 400-token prefix.

---

## 3. Architecture

### 3.1 Core Loop

```
1. Create one seed agent (empty system prompt)
2. Warm the cache: call seed agent with just the content (no role)
3. Create one generic "fork" agent (empty system prompt)
4. For each role:
   - Call the fork agent with: `${content}\n\n${role.instruction}`
   - All calls share the same content prefix → provider serves from cache
   - Only the role suffix (~50 tokens) is newly computed
5. Collect results + usage metrics
6. Compute: actual cost (from usage) vs. role-first baseline (projected)
```

### 3.2 API Surface

```typescript
interface ForkInput {
  content: string;                          // Shared seed (PR diff, design doc, paper)
  roles: Array<{
    name: string;
    instruction: string;                    // Role suffix — goes at END of prompt
  }>;
  provider?: {
    type: 'deepseek' | 'claudecli';        // Default: deepseek (cleanest cache behavior)
    model?: string;
  };
  parallel?: boolean;                       // Default: true
}

interface ForkOutput {
  roles: Array<{
    name: string;
    text: string;
    usage: {
      uncachedInputTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
    };
    cost: number;
  }>;
  summary: {
    cfTotalTokens: number;                  // Actual: uncached + cached in CF mode
    cfTotalUncached: number;                // Actual: only new tokens
    cfTotalCached: number;                  // Actual: served from cache
    cfTotalCost: number;                    // Actual cost
    rfBaselineTokens: number;               // Projected: what role-first would cost
    rfBaselineCost: number;
    savingsPercent: number;
    aggregateHitRate: number;
  };
}
```

### 3.3 Agent Lifecycle

The beta creates agents once (or reuses them). Each agent has:
- `systemPrompt: ''` — no system-level identity
- `provider.type: 'openai'` — maps to OpenAI-compatible including DeepSeek
- `provider.model: 'deepseek-chat'` or as configured
- `env.secret: 'ADHD_AGENT_DEEPSEEK_SECRET'`
- `env.base_url: 'ADHD_AGENT_DEEPSEEK_BASE_URL'`

Only ONE fork agent is needed — the same agent is called N times with different prompts (different role suffixes). The cache hit comes from the identical prefix across those N calls, not from the agent identity.

---

## 4. Beta Implementation

### 4.1 Worktree Setup

```bash
cd ~/dev/node/adhd
git worktree add .worktrees/fork-join wf/fork-join-beta
cd .worktrees/fork-join
pnpm install
```

### 4.2 File Structure

```
.worktrees/fork-join/
├── fork-join.mjs              # Entry point — Node.js script, no build step
├── test/
│   ├── fixtures.mjs           # Content + role definitions from sox-protocol
│   └── scenarios.mjs          # Run configurations
└── README.md                  # Quick start
```

### 4.3 Core Implementation (fork-join.mjs, ~200 lines)

```javascript
import { forkJoin, compare } from './lib/fork-join.mjs';

// Run 4-stakeholder review on a real spec
const result = await forkJoin({
  content: readFile('spec/primitives/namespace.md'),
  roles: [
    { name: 'security',    instruction: 'You are a security engineer...' },
    { name: 'architect',   instruction: 'You are a software architect...' },
    { name: 'platform',    instruction: 'You are a platform engineer...' },
    { name: 'product',     instruction: 'You are a product manager...' },
  ],
  provider: { type: 'deepseek', model: 'deepseek-chat' },
});

// Print comparison table
console.table(result.summary);
// → 88% cache hit rate, 72% cost savings
```

### 4.4 Test Fixtures

The beta uses verbatim content from the sox-protocol repo (via git worktree — the repo lives at `~/dev/ai/sox-protocol`, accessible from the adhd worktree):

| Scenario | Content source | Roles | Why |
|----------|---------------|-------|-----|
| Namespace isolation | `spec/primitives/namespace.md` | Security, Architect, Platform, Product | Real spec, competing stakeholder perspectives |
| Fan-out decision | `docs/decisions/fanout-collect.md` | DS Engineer, Protocol Designer, SDK Engineer, PM | Real design tension, conflicting priorities |
| Supervisor review | `libs/host-runtime/src/supervisor.ts` | Security, Architect, SRE, DX | Real TypeScript code, engineering review |
| Research synthesis | 4 published paper abstracts | Synthesis, Critique, Gap, Application | Real academic content, meta-analysis |

### 4.5 Measurement Protocol

Each run produces:

```
╔══════════════════════════════════════════════════════════════╗
║  Fork-Join Beta — 2026-07-27T22:56                          ║
║  Provider: deepseek  Model: deepseek-chat  Content: 4,200t  ║
╚══════════════════════════════════════════════════════════════╝

 Agent          | Uncached | CacheRd | HitRate |    Cost
────────────────┼──────────┼─────────┼─────────┼─────────
 seed (warm)    |    4,200 |       0 |     0%  |  $0.063
 security       |       55 |   4,200 |    99%  |  $0.006
 architect      |       52 |   4,255 |    99%  |  $0.006
 platform       |       58 |   4,307 |    99%  |  $0.006
 product        |       61 |   4,365 |    99%  |  $0.006
────────────────┼──────────┼─────────┼─────────┼─────────
 CF total       |    4,426 |  17,127 |    79%  |  $0.087
 RF baseline    |   21,000 |       0 |     0%  |  $0.315
 SAVINGS        |         |         |         |     72%
────────────────┴──────────┴─────────┴─────────┴─────────

 Extrapolation:
   100 runs:  CF $8.70  vs  RF $31.50  (72% savings)
   At 50Kt:   CF $0.80  vs  RF $9.45   (92% savings)
```

### 4.6 Acceptance Criteria

The beta passes when a single run against any scenario shows:

1. **`cacheReadTokens > 0` for agents after the seed** — proves content caching works through agent-mcp
2. **Savings vs. role-first baseline > 50%** — proves the economic thesis
3. **All agents produce on-topic output** — proves instruction following isn't degraded
4. **The table prints cleanly** — proves the CLI works end-to-end

---

## 5. Implementation Plan

### Step 1: Create worktree + scaffold (30 min)

```bash
git worktree add .worktrees/fork-join wf/fork-join-beta
cd .worktrees/fork-join
```

### Step 2: Write fork-join.mjs (2 hr)

- Import `agent_agent_create` and `agent_task` as MCP tool calls (the script runs in an MCP host that provides these tools)
- Or use the `@adhd/agent-mcp` package programmatically to create agents and run tasks
- Implement the fork loop: create empty-system-prompt agent → warm cache → fork N role calls
- Implement the comparison table

### Step 3: Add role-first baseline (1 hr)

- Create a second set of agents with system prompts
- Run the same content through them
- Present results side by side

### Step 4: Test (1 hr)

```bash
# Against DeepSeek (ADHD_AGENT_DEEPSEEK_SECRET must be set)
node fork-join.mjs --provider deepseek --scenario namespace

# Against claudecli (no credentials needed)
node fork-join.mjs --provider claudecli --scenario namespace
```

### Step 5: Iterate (remaining time)

- Add more scenarios
- Add JSON output for CI
- Tune parallelism

---

## 6. Risk Register

| Risk | Mitigation |
|------|-----------|
| **agent-mcp adds system prompt boilerplate to empty-system-prompt agents** | Verify wire format by inspecting agent-mcp source. If it adds a default system prompt, the fork agent isn't content-first. |
| **claudecli provider ignores empty system prompt and adds one internally** | Use DeepSeek (openai provider) as primary test target. claudecli is secondary. |
| **Cache TTL expires between fork calls** | Make calls sequentially with minimal delay. Measure cache hit rate — if it drops for later agents, TTL is the cause. |
| **Parallel N tasks exhaust rate limits** | Default to sequential (configurable concurrency). Log rate limit errors. |
| **DeepSeek doesn't report cacheReadTokens** | Check the usage response. If absent, measure savings by comparing uncachedInputTokens between first and subsequent agents. |

---

## 7. Relationship to agent-mcp

The fork-join runtime is a **client-side pattern** that uses agent-mcp's existing tools. It creates agents with `systemPrompt: ''` and relies on agent-mcp faithfully transmitting that empty system prompt to the provider as a absent `system` field.

If agent-mcp were to change how it handles empty system prompts (e.g., by injecting a default), the fork-join pattern would break. The beta assumes agent-mcp passes through whatever `systemPrompt` value it receives, including empty string.

Long-term, agent-mcp could add a `fork` tool that does this server-side:
- Accepts `seed + N roles`
- Manages the shared agent creation
- Returns N results + aggregated cache metrics

But the beta doesn't need it. The existing tools are sufficient.
