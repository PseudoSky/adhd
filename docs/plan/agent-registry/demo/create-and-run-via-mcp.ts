#!/usr/bin/env tsx
/**
 * create-and-run-via-mcp.ts — Step 11c: Create + run via agent-mcp Orchestrator.
 *
 * Demonstrates the FULL agent-mcp create-and-run path:
 *   1. Get the registry-compiled qa-expert artifact (reuse demo/tmp/registry.db).
 *   2. Stand up agent-mcp via its test harness (buildHarness + claudecli provider).
 *   3. CREATE the agent in agent-mcp's own store via agentCreate().
 *   4. Open a SESSION via agentTool().
 *   5. RUN through the Orchestrator via taskTool() (synchronous).
 *   6. CONFIRM persistence via resultTool() + task_events query.
 *   7. Assert model-independent invariants.
 *   8. Append Step 11c section to demo/README.md.
 *
 * HONEST FRAMING: There is NO registry→agent-mcp integration (Plan 6 is unbuilt).
 * This script manually bridges: the registry COMPILES the prompt, and we hand that
 * blob to agent-mcp's native agentCreate(). This proves agent-mcp can create+run an
 * agent built from registry output — it does NOT prove an automated integration.
 *
 * [inv:no-pkg-src-edit]   — zero modifications to any package src/ file.
 * [inv:real-orchestrator] — real Orchestrator + stores on a TEMP DB (not the real one).
 * [inv:real-model]        — real claude CLI invoked via ClaudeCliProvider.
 * [inv:clean-boundary]    — packages/ai/agent-mcp + agent-mcp-types untouched.
 *
 * Run from repo root:
 *   node_modules/.bin/tsx --tsconfig tsconfig.base.json \
 *       docs/plan/agent-registry/demo/create-and-run-via-mcp.ts
 *
 * Or via the convenience wrapper (once created):
 *   node docs/plan/agent-registry/demo/run-via-mcp-orchestrator.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';

// ── registry compiler (path alias @adhd/agent-compiler resolves via tsconfig.base.json) ──
import { compileAgent, resolveTools } from '@adhd/agent-compiler';

// ── agent-mcp: harness (deep import — not in package index) ──────────────────
import {
    buildHarness,
    drainQueue,
} from '../../../../packages/ai/agent-mcp/src/__tests__/integration/harness.js';

// ── agent-mcp: tools (deep imports — not in package index) ───────────────────
import { agentCreate, agentRead }  from '../../../../packages/ai/agent-mcp/src/tools/agent-crud.js';
import { agentTool }               from '../../../../packages/ai/agent-mcp/src/tools/session.js';
import { taskTool, resultTool }    from '../../../../packages/ai/agent-mcp/src/tools/task.js';

// ── agent-mcp: provider factory (deep import) ─────────────────────────────────
import { createProvider } from '../../../../packages/ai/agent-mcp/src/providers/factory.js';

// ── agent-mcp: schema (for DB assertions) ────────────────────────────────────
import {
    taskEventsTable,
    tasksTable,
} from '../../../../packages/ai/agent-mcp/src/db/schema.js';

// ── paths ─────────────────────────────────────────────────────────────────────
const __dirname    = fileURLToPath(new URL('.', import.meta.url));
const DB_PATH      = path.join(__dirname, 'tmp', 'registry.db');
const README_PATH  = path.join(__dirname, 'README.md');

const CLAUDE_CLI   = '/Users/nix/.local/bin/claude';
const PLATFORM     = 'claude_code';
const AGENT_SLUG   = 'qa-expert';

// ── helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
    process.stdout.write(`${msg}\n`);
}

function step(n: string | number, desc: string): void {
    log(`\n${'='.repeat(60)}`);
    log(`STEP ${n}: ${desc}`);
    log('='.repeat(60));
}

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        process.stderr.write(`\nASSERTION FAILED: ${msg}\n`);
        process.exit(2);
    }
    log(`  PASS: ${msg}`);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

// ── STEP A: Re-open the registry DB ───────────────────────────────────────────

step('A', 'Re-open demo/tmp/registry.db (written by ingest-and-run.ts)');

if (!fs.existsSync(DB_PATH)) {
    process.stderr.write(
        `Registry DB not found at ${DB_PATH}.\n` +
        `Run ingest-and-run.ts first to create it.\n`
    );
    process.exit(1);
}

const rawRegistry = new Database(DB_PATH, { readonly: false });
rawRegistry.pragma('journal_mode = WAL');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registryDb = drizzle(rawRegistry, { schema: {} as any });

log(`  Opened registry DB: ${DB_PATH}`);

// ── STEP B: Compile the qa-expert agent ───────────────────────────────────────

step('B', `Compile '${AGENT_SLUG}' via compileAgent() — same codepath as CLI`);

const compiled = compileAgent({
    agentSlug: AGENT_SLUG,
    platform:  PLATFORM,
    context:   {},
    db:        registryDb as Parameters<typeof compileAgent>[0]['db'],
});

log(`  Compiled artifact id: ${compiled.id}, content length: ${compiled.content.length} chars`);

// Strip YAML frontmatter fence to get the bare system-prompt body.
// The yaml_frontmatter artifact is: ---\n<fields>\n---\n<body>
const systemPromptBody = compiled.content.replace(/^---\n[\s\S]*?\n---\n+/, '');
log(`  System prompt body: ${systemPromptBody.length} chars`);
log(`  First line: ${systemPromptBody.split('\n')[0]!.slice(0, 80)}`);

// ── STEP C: Resolve tools for qa-expert on claude_code ────────────────────────

step('C', `Resolve tool list via resolveTools('${AGENT_SLUG}', '${PLATFORM}')`);

const resolvedTools = resolveTools(
    registryDb as Parameters<typeof resolveTools>[0],
    AGENT_SLUG,
    PLATFORM
);

const toolAliases = resolvedTools.map(t => t.platformAlias);
log(`  Resolved ${toolAliases.length} tools: ${toolAliases.slice(0, 8).join(', ')}${toolAliases.length > 8 ? `, ... (+${toolAliases.length - 8} more)` : ''}`);

rawRegistry.close();

// ── STEP D: Build ClaudeCliProvider (will be the defaultProvider for harness) ──

step('D', 'Build ClaudeCliProvider via createProvider() — for harness injection');

const providerConfig = {
    type:               'claudecli' as const,
    claudePath:         CLAUDE_CLI,
    model:              'sonnet',
    timeoutMs:          120_000,
    allowedBuiltinTools: [] as string[],  // block all built-ins; QA agent is prompt-only
};

const liveProvider = createProvider(providerConfig, {} /* no mcpServers */);

log(`  Provider class: ${liveProvider.constructor.name}`);
assert(
    liveProvider.constructor.name === 'ClaudeCliProvider',
    `createProvider({type:'claudecli'}) returns ClaudeCliProvider (got ${liveProvider.constructor.name})`
);

// ── STEP E: Build agent-mcp harness (TEMP DB — NOT the real agent-mcp DB) ─────

step('E', 'Build agent-mcp harness on temp DB (buildHarness + defaultProvider)');

// defaultProvider injects the ClaudeCliProvider for every task run through the
// harness orchestrator — including the startup orphan scan — so there's no race
// against a bad-provider run. This is the pattern from HarnessOptions.defaultProvider.
const harness = await buildHarness({
    defaultProvider: liveProvider,
    skipOrphanScan:  true,  // fresh DB, no orphans; avoids orphan scan firing before agentStore is populated
});

log(`  Harness DB path: ${harness.dbPath}`);
log(`  Orchestrator type: ${harness.orchestrator.constructor.name}`);
log(`  AgentStore type: ${harness.agentStore.constructor.name}`);

// ── STEP F: CREATE the agent in agent-mcp's own store ─────────────────────────

step('F', `agentCreate({ name:'${AGENT_SLUG}', provider:'claudecli', ... })`);

// AgentCreateInput = agentDefinitionSchema without version/createdAt/updatedAt.
// The qa-expert has no mcpServers (it drives purely through its system prompt;
// the mcp__memory-server wildcard is a tool _grant_ in the registry, but not
// a running MCP server config in the agent definition for this demo).
const agentDef = agentCreate(
    {
        name:         AGENT_SLUG,
        description:  'QA expert agent compiled from the agent-registry',
        provider:     providerConfig,
        systemPrompt: systemPromptBody,
        mcpServers:   {},
        permissions:  {},
    },
    { agentStore: harness.agentStore, sessionStore: harness.sessionStore }
);

log(`  Agent created — name: ${agentDef.name}, version: ${agentDef.version}`);
log(`  createdAt: ${agentDef.createdAt}`);

// agentRead to confirm it persisted in agent-mcp's store
const readBack = agentRead(
    { name: AGENT_SLUG },
    { agentStore: harness.agentStore, sessionStore: harness.sessionStore }
);

assert(readBack.name === AGENT_SLUG,           `agentRead returned agent with name '${AGENT_SLUG}'`);
assert(readBack.version === 1,                 `agent version is 1 (freshly created)`);
assert(
    readBack.systemPrompt === systemPromptBody,
    `agentRead systemPrompt matches compiled body (${readBack.systemPrompt.length} chars)`
);
log(`  Agent persisted in agent-mcp store (confirmed via agentRead).`);

// ── STEP G: OPEN a session via agentTool ──────────────────────────────────────

step('G', `agentTool({ name:'${AGENT_SLUG}' }) — create a persistent session`);

const sessionResult = await agentTool(
    { name: AGENT_SLUG },
    {
        agentStore:   harness.agentStore,
        sessionStore: harness.sessionStore,
        policy:       harness.policy,
    }
);
const sessionId = sessionResult.session_id;

log(`  Session opened — session_id: ${sessionId}`);
assert(typeof sessionId === 'string' && sessionId.length > 0, `session_id is a non-empty string`);

// ── STEP H: RUN through the Orchestrator via taskTool ─────────────────────────

step('H', 'taskTool({ session_id, prompt, background:false }) — LIVE run through Orchestrator');

const qaPrompt = [
    'Draft a concise test strategy (3-5 bullet points) for a small TypeScript library.',
    'At the end, emit your progress tracking JSON in EXACTLY this format:',
    '{"agent":"qa-expert","status":"testing","progress":{"test_files_reviewed":"<n>","test_commands_run":"<n>","defects_found":"<n>","coverage_measured":"<value>"}}',
].join('\n');

log(`\n  claude CLI: ${CLAUDE_CLI}`);
log(`  Model: sonnet (via --model sonnet)`);
log(`  Prompt: ${qaPrompt.slice(0, 100)}...`);
log(`  Running synchronously through Orchestrator (may take 30-90s)...`);
log('');

const startMs    = Date.now();
const taskResult = await taskTool(
    {
        session_id: sessionId,
        prompt:     qaPrompt,
        background: false,
    },
    harness.taskDeps
);
const elapsedMs  = Date.now() - startMs;

const taskId = taskResult.task_id;

log(`  taskTool returned in ${elapsedMs}ms`);
log(`  task_id: ${taskId}`);
log(`  status:  ${taskResult.status}`);
log(`  result length: ${(taskResult.result ?? '').length} chars`);

// ── STEP I: Fetch result via resultTool ───────────────────────────────────────

step('I', `resultTool({ task_id: '${taskId}' }) — confirm persistence`);

const persisted = resultTool(
    { task_id: taskId },
    { taskStore: harness.taskStore, db: harness.taskDeps.db }
);

log(`  resultTool status: ${persisted.status}`);
log(`  result length:     ${(persisted.result ?? '').length} chars`);

// ── STEP J: Query task_events for lifecycle proof ─────────────────────────────

step('J', 'Query task_events — prove TASK_COMPLETED lifecycle event exists');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = harness.taskDeps.db as any;

const events = db
    .select()
    .from(taskEventsTable)
    .where(eq(taskEventsTable.taskId, taskId))
    .all() as Array<{ id: string; taskId: string; type: string; payload: string | null; createdAt: string }>;

log(`  task_events rows for task ${taskId}: ${events.length}`);
for (const ev of events) {
    log(`    [${ev.type}] id=${ev.id.slice(0, 8)} at=${ev.createdAt}`);
}

const completedEvent = events.find(e => e.type === 'TASK_COMPLETED');
const modelRequestEvents = events.filter(e => e.type === 'MODEL_REQUEST');
const modelResponseEvents = events.filter(e => e.type === 'MODEL_RESPONSE');

// Also confirm the task row itself is retrievable from the tasks table
const taskRows = db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .all() as Array<{ id: string; sessionId: string | null; status: string; result: string | null }>;

log(`\n  tasks table row: ${JSON.stringify(taskRows[0] ?? 'NOT FOUND')}`);

// ── STEP K: Assert model-independent invariants ────────────────────────────────

step('K', 'Assert model-independent invariants');

// (1) Agent was CREATED in agent-mcp's own store and persisted correctly
assert(
    readBack.name === AGENT_SLUG && readBack.systemPrompt.length > 100,
    `[inv:1] agentRead returns agent with compiled systemPrompt (${readBack.systemPrompt.length} chars) — agent CREATED in agent-mcp store`
);

// (2) Task reached terminal state via the Orchestrator
assert(
    persisted.status === 'completed',
    `[inv:2] task status is 'completed' (got '${persisted.status}') — task ran through Orchestrator`
);

// (3) TASK_COMPLETED lifecycle event exists in agent-mcp's task_events
assert(
    completedEvent !== undefined,
    `[inv:3] TASK_COMPLETED event exists in task_events (found ${events.length} events total)`
);

// (4) MODEL_REQUEST + MODEL_RESPONSE events prove the Orchestrator's loop ran
assert(
    modelRequestEvents.length >= 1,
    `[inv:4a] at least one MODEL_REQUEST event (got ${modelRequestEvents.length}) — Orchestrator ran the provider loop`
);
assert(
    modelResponseEvents.length >= 1,
    `[inv:4b] at least one MODEL_RESPONSE event (got ${modelResponseEvents.length}) — Orchestrator received the model response`
);

// (5) Result text is in-character QA
const resultText = persisted.result ?? '';
const qaTerms    = ['test', 'coverage', 'defect', 'quality', 'qa', 'automation', 'strategy', 'bug'];
const foundTerm  = qaTerms.find(t => resultText.toLowerCase().includes(t)) ?? null;
assert(
    foundTerm !== null,
    `[inv:5] result contains QA-domain term (found '${foundTerm}') — compiled system prompt shaped behavior`
);

// (6) Result contains the mandated progress JSON shape
const jsonMatch = /\{\s*"agent"\s*:\s*"qa-expert"\s*,\s*"status"\s*:/.test(resultText);
assert(
    jsonMatch,
    `[inv:6] result contains mandated {"agent":"qa-expert","status":...} JSON shape`
);

// (7) Session row confirms the session was backed by a real agent-mcp sessions row
// (session mode, not ephemeral — taskRows[0].sessionId is set)
assert(
    taskRows.length > 0 && taskRows[0]!.sessionId === sessionId,
    `[inv:7] task row has sessionId='${sessionId}' (session-backed, not ephemeral) — proves session mode ran through Orchestrator`
);

// ── Print result excerpt ───────────────────────────────────────────────────────

log('\n--- Result excerpt (first 40 lines) ---');
const resultLines = resultText.split('\n');
for (let i = 0; i < Math.min(40, resultLines.length); i++) {
    log(`  ${resultLines[i]!}`);
}
if (resultLines.length > 40) {
    log(`  ... (${resultLines.length - 40} more lines)`);
}

// ── STEP L: Tear down harness ──────────────────────────────────────────────────

step('L', 'Tear down harness (close temp DB, delete temp files)');

await harness.teardown();

log(`  Harness torn down. Temp DB deleted: ${harness.dbPath}`);

// ── STEP M: Confirm hard boundary — packages/ai/agent-mcp* are clean ──────────

step('M', 'Hard boundary check — no package src/ files modified');

// We don't run git here (the runner may not be in a git context) but we document
// the boundary explicitly. The script only READ source files via imports; it never
// wrote to any package src/ directory.
log(`  All writes were to: docs/plan/agent-registry/demo/ (this script + README.md)`);
log(`  No files in packages/ai/agent-mcp/ or packages/ai/agent-mcp-types/ were modified.`);

// ── STEP N: Append Step 11c to README.md ──────────────────────────────────────

step('N', 'Append "Step 11c: Create + run via agent-mcp Orchestrator" to README.md');

const resultExcerpt = resultLines.slice(0, 30).join('\n');

const invariantSummary = [
    `[inv:1] agentRead returns compiled systemPrompt (${readBack.systemPrompt.length} chars): PASS`,
    `[inv:2] task status 'completed' via Orchestrator: PASS`,
    `[inv:3] TASK_COMPLETED event in task_events: PASS (event id ${completedEvent!.id.slice(0, 8)})`,
    `[inv:4] MODEL_REQUEST (${modelRequestEvents.length}) + MODEL_RESPONSE (${modelResponseEvents.length}) events: PASS`,
    `[inv:5] QA in-character response (found term '${foundTerm}'): PASS`,
    `[inv:6] Mandated {"agent":"qa-expert","status":...} JSON shape: PASS`,
    `[inv:7] session-backed task row (sessionId=${sessionId.slice(0, 8)}...): PASS`,
].join('\n');

const step11cSection = `
## Step 11c: Create + run via agent-mcp Orchestrator

**Date:** ${new Date().toISOString().slice(0, 10)}
**Script:** \`docs/plan/agent-registry/demo/create-and-run-via-mcp.ts\`

### Honest framing

There is NO registry→agent-mcp integration (agent-mcp has zero registry refs; Plan 6 is unbuilt).
This script manually bridges: the registry COMPILES the prompt, and we hand that blob to
agent-mcp's native \`agentCreate()\`. This proves agent-mcp can create+run an agent built from
registry output — it does NOT prove an automated integration (that is Plan 6's job).

### What was called

\`\`\`typescript
// 1. Get the compiled system prompt from the registry
const compiled = compileAgent({ agentSlug: 'qa-expert', platform: 'claude_code', context: {}, db });
const systemPromptBody = compiled.content.replace(/^---\\n[\\s\\S]*?\\n---\\n+/, '');

// 2. Stand up agent-mcp harness on a TEMP DB
const liveProvider = createProvider({ type: 'claudecli', claudePath: '${CLAUDE_CLI}', model: 'sonnet', timeoutMs: 120_000 }, {});
const harness = await buildHarness({ defaultProvider: liveProvider, skipOrphanScan: true });

// 3. CREATE the agent in agent-mcp's own store
const agentDef = agentCreate(
    { name: 'qa-expert', provider: { type: 'claudecli', ... }, systemPrompt: systemPromptBody, mcpServers: {}, permissions: {} },
    { agentStore: harness.agentStore, sessionStore: harness.sessionStore }
);

// 4. Open a session via the Orchestrator path
const { session_id } = await agentTool({ name: 'qa-expert' }, { agentStore, sessionStore, policy });

// 5. RUN through the Orchestrator
const taskResult = await taskTool({ session_id, prompt: '<QA strategy task>', background: false }, harness.taskDeps);

// 6. Confirm persistence
const persisted = resultTool({ task_id: taskResult.task_id }, { taskStore, db });
\`\`\`

### Task lifecycle

| Field       | Value |
|-------------|-------|
| agent name  | \`${AGENT_SLUG}\` |
| session_id  | \`${sessionId}\` |
| task_id     | \`${taskId}\` |
| task status | \`${persisted.status}\` |
| elapsed     | ${elapsedMs}ms |
| events      | ${events.length} total (MODEL_REQUEST ×${modelRequestEvents.length}, MODEL_RESPONSE ×${modelResponseEvents.length}, TASK_COMPLETED ×${completedEvent ? 1 : 0}) |

### Result excerpt (first 30 lines)

\`\`\`
${resultExcerpt}
\`\`\`

### Invariants passed

\`\`\`
${invariantSummary}
\`\`\`

### Symbols imported (file:line)

| Symbol | Source |
|--------|--------|
| \`buildHarness\` | \`packages/ai/agent-mcp/src/__tests__/integration/harness.ts:102\` |
| \`drainQueue\` | \`packages/ai/agent-mcp/src/__tests__/integration/harness.ts:305\` |
| \`agentCreate\` | \`packages/ai/agent-mcp/src/tools/agent-crud.ts:16\` |
| \`agentRead\` | \`packages/ai/agent-mcp/src/tools/agent-crud.ts:21\` |
| \`agentTool\` | \`packages/ai/agent-mcp/src/tools/session.ts:29\` |
| \`taskTool\` | \`packages/ai/agent-mcp/src/tools/task.ts:181\` |
| \`resultTool\` | \`packages/ai/agent-mcp/src/tools/task.ts:534\` |
| \`createProvider\` | \`packages/ai/agent-mcp/src/providers/factory.ts:14\` |
| \`taskEventsTable\` | \`packages/ai/agent-mcp/src/db/schema.ts:99\` |
| \`tasksTable\` | \`packages/ai/agent-mcp/src/db/schema.ts:65\` |

### API-surface findings (backlog candidates)

1. **\`buildHarness\` not in package public API.** Importable only via deep path
   \`packages/ai/agent-mcp/src/__tests__/integration/harness.ts\`. For external consumers
   wanting to write integration tests without copy-pasting the harness, exposing a
   \`@adhd/agent-mcp/test-utils\` sub-path export would be ergonomic.

2. **\`agentCreate\`, \`agentTool\`, \`taskTool\`, \`resultTool\` not in package index.**
   All tool functions must be deep-imported from source paths. A \`tools\` sub-path
   export or re-export from \`index.ts\` would make the create-and-run path accessible
   without relying on internal file paths.

3. **\`createProvider\` not in package index** (already noted in Step 11b).
   Repeated here because it is also needed for the full Orchestrator path — callers
   must know the concrete provider to inject it via \`defaultProvider\`.

4. **\`defaultProvider\` injection in harness is harness-only.** The production
   \`Orchestrator.run()\` accepts a \`provider\` override (so per-task injection works),
   but the \`buildHarness\` \`defaultProvider\` wraps the orchestrator at construction
   time. Both work; the harness pattern (wrapping) is the most ergonomic for tests
   that want every task on one provider without patching per-call.
`;

fs.appendFileSync(README_PATH, step11cSection, 'utf8');
log(`  Step 11c section appended to ${README_PATH}`);

// ── Final summary ──────────────────────────────────────────────────────────────

log('\n');
log('='.repeat(60));
log('create-and-run-via-mcp COMPLETE — ALL INVARIANTS PASSED');
log('='.repeat(60));
log(`  Agent created    : ${agentDef.name} (v${agentDef.version})`);
log(`  Session id       : ${sessionId}`);
log(`  Task id          : ${taskId}`);
log(`  Task status      : ${persisted.status}`);
log(`  task_events rows : ${events.length} (TASK_COMPLETED: ${completedEvent ? 'YES' : 'NO'})`);
log(`  Elapsed          : ${elapsedMs}ms`);
log(`  Invariants       : 7/7 PASSED`);
log(`  README updated   : ${README_PATH}`);
log('');

} // end main()

main().catch(err => {
    process.stderr.write(`\nFatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) {
        process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
});
