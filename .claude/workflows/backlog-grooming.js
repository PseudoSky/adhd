/**
 * backlog-grooming.js — recurring, read-only backlog grooming pipeline.
 *
 * Pipeline (as specified):
 *   product reprioritizes + FLAGS each item (debug-triage | architect-spec)
 *     -> parallel lanes: architects | debugger | devops
 *       -> product writes acceptance criteria
 *
 * This workflow is READ-ONLY ON SOURCE. It never edits, generates, or commits
 * code. It never transitions/resolves/merges/splits/deletes a backlog item.
 * The ONLY writes it performs anywhere are:
 *   (a) backlog_set_priority / backlog_append_note, and ONLY inside the two
 *       "product" phases (Triage-and-Flag, Acceptance-Criteria);
 *   (b) one markdown artifact at tmp/grooming-<runLabel>.md.
 * Every lane (architect/debugger/devops) is READ-ONLY: it investigates and
 * returns a structured verdict/spec, it does not touch the backlog or the repo.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SHAPE — the three hard problems this script exists to solve
 * ---------------------------------------------------------------------------
 * (1) PACKET/EXECUTION COMPATIBILITY. Grouping items is easy; grouping them so
 *     a downstream execution workflow (e.g. remediation-pipeline.js) can
 *     actually DISPATCH them is not. Every architect/devops packet carries
 *     concrete `filesTouched` derived from the items' own citations/audit
 *     trail — never a vague subsystem name. After the lanes return, this
 *     script computes a deterministic WAVE PLAN in pure JS (`planWaves`):
 *     packets sharing a file never share a wave, and any packet touching a
 *     root-sensitive file (package.json/project.json/nx.json/pnpm-lock.yaml/
 *     .gitignore at repo root) is forced into its own solo wave, because nx
 *     treats a root-config change as affecting the entire workspace graph.
 *     This is NOT theoretical here: an unscoped full-graph run has already
 *     cost three package publishes in this repo, and concurrent writers in
 *     one tree produce real gate flakes (DEBT-BUILD-001).
 *
 * (2) RE-DISPATCH CRITERIA. The final phase computes an explicit machine
 *     readable verdict — `shouldRegroom`, `reason`, `suggestedIntervalHint` —
 *     from five concrete, checkable signals (drift / decay-rate / untriaged
 *     high-priority / incomplete packets / growing escalations). See the
 *     `computeRegroomVerdict` function for the thresholds and the header
 *     comment above it for the rationale. Biased toward NOT re-running.
 *
 * (3) GENUINELY DIFFERENT LANES. debugger verifies-or-kills a premise and is
 *     explicitly allowed to conclude DEAD; architect/devops spec a REAL,
 *     under-specified item (devops additionally calls out release/gate
 *     implications). Any lane may HAND BACK an item it believes was
 *     mis-routed; handbacks get a small, bounded correction dispatch to the
 *     lane the handback suggests, rather than forcing wrong-shaped work.
 *
 * ---------------------------------------------------------------------------
 * args (all optional; sane defaults for an unscoped full run)
 * ---------------------------------------------------------------------------
 *   priorities            string[]  scope AFTER inventory to these priorities
 *                                   (CRITICAL|HIGH|MEDIUM|LOW). default: all.
 *   kinds                 string[]  scope AFTER inventory to these kinds.
 *                                   default: all.
 *   dryRun                boolean   default false. When true, the product
 *                                   phases compute what they WOULD write but
 *                                   make no backlog_set_priority /
 *                                   backlog_append_note calls.
 *   runLabel              string    default 'latest'. Artifact path becomes
 *                                   tmp/grooming-<runLabel>.md. Fixed/stable —
 *                                   this script cannot call Date.now().
 *   previousOpenCount     number    optional. Total open-item count (adhd +
 *                                   PseudoSky/adhd) recorded by the LAST run's
 *                                   artifact. Feeds the drift signal. Read it
 *                                   off the previous tmp/grooming-*.md and
 *                                   pass it back in on the next invocation.
 *   previousUnresolvedCount number  optional. Unresolved-escalation count
 *                                   from the last run's artifact. Feeds the
 *                                   escalation-growth signal.
 *
 * Returns: { totalOpen, specPackets, debugVerdicts, wavePlan, regroom,
 *            artifactPath }
 */

export const meta = {
  name: 'backlog-grooming',
  description: 'Recurring, read-only backlog grooming: product flags each item for debug-triage or architect-spec, three parallel lanes (architect/debugger/devops) investigate, product writes acceptance criteria and a wave-planned markdown report with an explicit re-dispatch verdict.',
  whenToUse: 'Run periodically (see the artifact\'s suggestedIntervalHint) or when the caller already knows the open-item count has moved materially. Never implements or commits — output is a plan for a separate execution workflow.',
  phases: [
    { title: 'Inventory', detail: 'read-only: partition-by-kind pull of every open item in adhd + PseudoSky/adhd, reconciled against backlog_stats' },
    { title: 'Triage & Flag', detail: 'product (WRITE: priority + note only): reprioritize, flag debug-triage vs architect-spec, route to a lane' },
    { title: 'Lanes', detail: 'parallel, READ-ONLY: architect | debugger | devops investigate their routed items and pack them into file-scoped packets/verdicts; may hand back mis-routed items' },
    { title: 'Reroute', detail: 'READ-ONLY: bounded correction dispatch for any items a lane handed back, sent to the lane it actually belongs in' },
    { title: 'Acceptance Criteria', detail: 'product (WRITE: priority + note only): writes consumer-visible acceptance criteria / verify-or-dead notes onto the backlog items, read-back confirmed' },
    { title: 'Report', detail: 'writes exactly one markdown artifact: wave plan, lane summaries, and the machine-readable regroom verdict' },
  ],
}

// ============================================================================
// args
// ============================================================================
const RAW_ARGS = (typeof args !== 'undefined' && args) || {}
let A = RAW_ARGS
if (typeof RAW_ARGS === 'string') {
  try {
    A = JSON.parse(RAW_ARGS)
  } catch (e) {
    throw new Error('backlog-grooming: args arrived as a string and is not valid JSON: ' + e.message)
  }
}
if (typeof A !== 'object' || A === null || Array.isArray(A)) {
  throw new Error('backlog-grooming: args must be an object (or a JSON string encoding one), got ' + (Array.isArray(A) ? 'array' : typeof A))
}

const REPO_ROOT = '/Users/nix/dev/node/adhd'
const REPOS = ['adhd', 'PseudoSky/adhd'] // sox-ecosystem is a DIFFERENT repository — always out of scope here
const SCOPE_PRIORITIES = A.priorities && A.priorities.length ? A.priorities : null
const SCOPE_KINDS = A.kinds && A.kinds.length ? A.kinds : null
const DRY_RUN = !!A.dryRun
const RUN_LABEL = A.runLabel || 'latest'
const ARTIFACT_PATH = `${REPO_ROOT}/tmp/grooming-${RUN_LABEL}.md`
const PREV_OPEN_COUNT = typeof A.previousOpenCount === 'number' ? A.previousOpenCount : null
const PREV_UNRESOLVED_COUNT = typeof A.previousUnresolvedCount === 'number' ? A.previousUnresolvedCount : null

// ============================================================================
// small pure-JS helpers (no fs/Date/Math.random — none needed)
// ============================================================================
function groupBy(arr, keyFn) {
  const m = new Map()
  for (const item of arr) {
    const k = keyFn(item)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(item)
  }
  return m
}

function chunkArray(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// mechanical id-family derivation: 'BUG-BACKLOG-003' -> 'BUG-BACKLOG', 'TASK-001' -> 'TASK'
function familyOf(humanId) {
  return String(humanId).replace(/-\d+$/, '') || String(humanId)
}

const ROOT_SENSITIVE_FILES = new Set(['package.json', 'project.json', 'nx.json', 'pnpm-lock.yaml', '.gitignore'])
const isRootSensitive = (f) => typeof f === 'string' && !f.includes('/') && ROOT_SENSITIVE_FILES.has(f)

// Deterministic collision-aware wave planner (requirement 1).
// - any packet touching a root-sensitive file, or self-flagged soloRequired, gets its OWN wave
// - remaining packets are greedily placed into the first wave with zero filesTouched overlap
function planWaves(packets) {
  const solo = []
  const normal = []
  for (const p of packets) {
    const touchesRoot = (p.filesTouched || []).some(isRootSensitive)
    if (touchesRoot || p.soloRequired) solo.push({ ...p, soloRequired: true, soloReason: touchesRoot ? 'touches root-sensitive file' : (p.soloReason || 'lane-flagged solo') })
    else normal.push(p)
  }
  const waves = []
  for (const p of normal) {
    const pFiles = new Set(p.filesTouched || [])
    let placed = false
    for (const wave of waves) {
      const collides = wave.some((q) => (q.filesTouched || []).some((f) => pFiles.has(f)))
      if (!collides) {
        wave.push(p)
        placed = true
        break
      }
    }
    if (!placed) waves.push([p])
  }
  for (const p of solo) waves.push([p])
  return waves
}

function passesScope(item) {
  if (SCOPE_PRIORITIES && !SCOPE_PRIORITIES.includes(item.priority)) return false
  if (SCOPE_KINDS && !SCOPE_KINDS.includes(item.kind)) return false
  return true
}

// ============================================================================
// shared prompt preamble — embedded in EVERY agent() prompt (prompts are
// self-contained; agents have none of this context unless it is inlined)
// ============================================================================
const BACKLOG_MECHANICS = `
BACKLOG MECHANICS — this is a live, defect-prone system, follow this exactly:
- The graph (mcp__backlog__* tools) is the ONLY source of truth. BACKLOG.md is a generated projection — NEVER read it, NEVER edit it, NEVER cite it as evidence.
- THE REPO KEY IS FORKED. Items live under repo="adhd" (~31 open) or repo="PseudoSky/adhd" (~208 open). "sox-ecosystem" is a DIFFERENT repository and is ALWAYS out of scope for this run — never call it. Pass repo explicitly on every single call; never assume a default.
- DANGEROUS EXCEPTION: humanId "TASK-001" exists as TWO DISTINCT open items, one in each repo. A wrong-repo lookup on TASK-001 returns the WRONG ITEM with NO error. If you touch TASK-001, double- and triple-check the repo value on every call that mentions it.
- DO NOT PAGINATE backlog_list_items. It caps at ~145 rows and offset is not honored by the status-filtered index — paging past the cap silently returns a wrong, overlapping, incomplete window (BUG-BACKLOG-003).
- Every write (backlog_set_priority, backlog_append_note) MUST be READ BACK with backlog_get_item afterward. A success response from the write call is NOT proof it landed — an item here sat OPEN for a full day because a resolution was written as a note and the status field itself never transitioned. Confirm the field you changed actually changed.

DECAYED-PREMISE LENS — apply this skeptically to every item, always:
A large fraction of this backlog was accurate when filed and is FALSE now. Confirmed recent examples: a patch claimed applied that was never applied; a file reported "missing" that existed in another worktree; a directory that had since moved; a gitignore rule added later that already covers the complaint; the single CRITICAL on a triage list where 3 of its 6 claims were already fixed on main; a HIGH item that was a false alarm caused by a diagnostic script that MUTATED the artifact it was inspecting. Default posture: verify against CURRENT code, not against the item's own text. An item's age or prior priority is not evidence of its current truth.

CITATION DISCIPLINE — no citation, no claim:
Every factual claim you make (in your structured output AND in any backlog note you write) must resolve to a file:line you personally opened, or a command whose real output you personally saw. A grep hit is not "reading" — open the file. If you did not verify something, say "unverified" — do not imply it.

READ-ONLY-ON-SOURCE — this entire workflow only grooms, specs, and plans:
You MUST NOT edit, create, or delete any repository file. You MUST NOT run \`git commit\`, \`git add\`, \`git push\`, or any mutating git command. You MUST NOT run \`git stash\`, \`git reset --hard\`, \`git checkout -- .\`/whole-tree restore, or \`git clean -f\`. Read-only investigation only: \`git log\`, \`git diff\`, \`git show\`, \`grep\`, reading files, \`npx nx graph\`, and — ONLY where genuinely needed to reproduce a bug for the debugger lane — a read-only \`npx nx build/test\` run is fine (build output is gitignored). Never \`--skip-nx-cache\`, never invoke \`tsc\` directly.
`.trim()

const INVENTORY_METHOD = `
INVENTORY METHOD for THIS ONE repo (do not skip any step):
1. Discover the kinds present by calling backlog_list_items with no kind filter and a small limit first, noting every distinct "kind" value you see; also check backlog_spotlight for anything you might have missed.
2. For EACH kind value you discovered, call backlog_list_items again filtered to (repo=<this repo>, kind=<that kind>, status open / excludeArchived) and collect every row returned.
3. If a single kind's result count sits at or near the ~145-row cap, that kind is under-counted — further partition IT by priority (CRITICAL/HIGH/MEDIUM/LOW) and union those sub-results. NEVER use offset to page past the cap — it silently returns a wrong overlapping window (BUG-BACKLOG-003).
4. Union all partition results, de-duplicate by humanId (should not be necessary if partitions were disjoint by kind — if you find a duplicate, that itself is a signal your kind partition wasn't clean; report it).
5. Call backlog_stats scoped to this repo and read its "open" count.
6. RECONCILE: your unioned, de-duplicated item count MUST equal backlog_stats.open for this repo. If it does not match, do NOT silently proceed — report the exact discrepancy (which is bigger, by how much) in discrepancyNotes, and still return your best-effort item list.
For every item, also record: humanId, kind, title, current priority, tags, and a rough count of how many citations/notes it already carries (from what backlog_list_items/backlog_get_item shows you) — do not open every item's full detail, that is too expensive at this scale; a light pass is correct here, deep reading happens in later phases.
`.trim()

// ============================================================================
// schemas
// ============================================================================
const INVENTORY_SCHEMA = {
  type: 'object',
  required: ['repo', 'items', 'openCountReported', 'reconciled'],
  properties: {
    repo: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['humanId', 'kind', 'title', 'priority'],
        properties: {
          humanId: { type: 'string' },
          kind: { type: 'string' },
          title: { type: 'string' },
          priority: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    openCountReported: { type: 'number', description: 'backlog_stats.open for this repo' },
    unionCount: { type: 'number', description: 'your de-duplicated unioned item count' },
    reconciled: { type: 'boolean' },
    discrepancyNotes: { type: 'string' },
  },
}

const TRIAGE_DECISION = {
  type: 'object',
  required: ['humanId', 'repo', 'flag', 'route', 'routeReason'],
  properties: {
    humanId: { type: 'string' },
    repo: { type: 'string' },
    kind: { type: 'string' },
    title: { type: 'string' },
    flag: { enum: ['debug-triage', 'architect-spec'] },
    route: { enum: ['debugger', 'architect', 'devops'], description: 'debug-triage always maps to debugger; architect-spec maps to devops if it is a build/release/CI/tooling item, else architect' },
    routeReason: { type: 'string' },
    possiblyDecayed: { type: 'boolean', description: 'quick plausibility flag only — deep verify-or-kill is the debugger lane\'s job, not yours' },
    priorityBefore: { type: 'string' },
    priorityAfter: { type: 'string' },
    priorityChanged: { type: 'boolean' },
    priorityReason: { type: 'string' },
    noteAppended: { type: 'boolean' },
    readBackConfirmed: { type: 'boolean' },
  },
}

const TRIAGE_CLUSTER_SCHEMA = {
  type: 'object',
  required: ['clusterLabel', 'decisions'],
  properties: {
    clusterLabel: { type: 'string' },
    decisions: { type: 'array', items: TRIAGE_DECISION },
    clusterNotes: { type: 'string' },
  },
}

const SPEC_PACKET = {
  type: 'object',
  required: ['packetId', 'items', 'filesTouched', 'rootCause', 'spec', 'whatNotToDo', 'risks', 'acceptanceCriteriaDraft'],
  properties: {
    packetId: { type: 'string' },
    items: { type: 'array', items: { type: 'string' }, description: 'humanIds this packet closes' },
    filesTouched: { type: 'array', items: { type: 'string' }, description: 'concrete, repo-root-relative paths derived from the items\' own citations/audit trail — never a subsystem name' },
    rootCause: { type: 'string' },
    spec: { type: 'string', description: 'precise enough that an implementer makes no architectural choices' },
    whatNotToDo: { type: 'string' },
    risks: { type: 'string' },
    soloRequired: { type: 'boolean', description: 'true if you believe this packet must run alone regardless of file overlap (e.g. touches shared generated state)' },
    soloReason: { type: 'string' },
    releaseImplications: { type: 'string', description: 'REQUIRED non-empty for devops-lane packets: gate/CI/release-path impact. Leave empty for architect-lane packets.' },
    acceptanceCriteriaDraft: { type: 'array', items: { type: 'string' }, description: 'draft consumer-visible, command-provable acceptance criteria; product finalizes these in the next phase' },
    blocked: { type: 'boolean', description: 'true if you could NOT produce a real spec without a human decision' },
    blockedReason: { type: 'string' },
  },
}

const LANE_SPEC_SCHEMA = {
  type: 'object',
  required: ['clusterLabel', 'lane', 'packets', 'handbacks'],
  properties: {
    clusterLabel: { type: 'string' },
    lane: { enum: ['architect', 'devops'] },
    packets: { type: 'array', items: SPEC_PACKET },
    handbacks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['humanId', 'repo', 'suggestedRoute', 'reason'],
        properties: {
          humanId: { type: 'string' }, repo: { type: 'string' },
          suggestedRoute: { enum: ['debugger', 'architect', 'devops'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const DEBUG_VERDICT = {
  type: 'object',
  required: ['humanId', 'repo', 'verdict', 'evidence'],
  properties: {
    humanId: { type: 'string' }, repo: { type: 'string' },
    verdict: { enum: ['VERIFIED_LIVE', 'DEAD', 'PARTIALLY_LIVE', 'NEEDS_HUMAN'] },
    evidence: { type: 'string', description: 'real command output or file:line you personally opened — the thing that kills or confirms it' },
    filesInspected: { type: 'array', items: { type: 'string' } },
    recommendedAction: { type: 'string' },
  },
}

const LANE_DEBUG_SCHEMA = {
  type: 'object',
  required: ['clusterLabel', 'verdicts', 'handbacks'],
  properties: {
    clusterLabel: { type: 'string' },
    verdicts: { type: 'array', items: DEBUG_VERDICT },
    handbacks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['humanId', 'repo', 'suggestedRoute', 'reason'],
        properties: {
          humanId: { type: 'string' }, repo: { type: 'string' },
          suggestedRoute: { enum: ['debugger', 'architect', 'devops'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const AC_WRITE_SCHEMA = {
  type: 'object',
  required: ['groupId', 'writes'],
  properties: {
    groupId: { type: 'string' },
    writes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['humanId', 'repo', 'noteAppended', 'readBackConfirmed'],
        properties: {
          humanId: { type: 'string' }, repo: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          noteAppended: { type: 'boolean' },
          readBackConfirmed: { type: 'boolean' },
          finalPriority: { type: 'string' },
        },
      },
    },
  },
}

const DEBUG_NOTE_WRITE_SCHEMA = {
  type: 'object',
  required: ['groupId', 'writes'],
  properties: {
    groupId: { type: 'string' },
    writes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['humanId', 'repo', 'noteAppended', 'readBackConfirmed'],
        properties: {
          humanId: { type: 'string' }, repo: { type: 'string' },
          verdict: { type: 'string' },
          noteAppended: { type: 'boolean' },
          readBackConfirmed: { type: 'boolean' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['pathWritten', 'confirmed'],
  properties: {
    pathWritten: { type: 'string' },
    linesWritten: { type: 'number' },
    confirmed: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

// ============================================================================
// phase 1 — inventory (read-only)
// ============================================================================
function inventoryPrompt(repo) {
  return `You are performing a READ-ONLY backlog inventory pull for ONE repo. Do not write anything.

TARGET REPO for this call: "${repo}" — use this EXACT string on every mcp__backlog__* call you make in this task. Do not touch any other repo value, including "sox-ecosystem" (a different repository, always out of scope) or the other fork.

${BACKLOG_MECHANICS}

${INVENTORY_METHOD}

Return the structured object: your unioned item list, backlog_stats.open for "${repo}", your own union count, and whether they reconcile.`
}

// ============================================================================
// phase 2 — product triage & flag (WRITE: priority + note ONLY)
// ============================================================================
function triagePrompt(clusterLabel, items) {
  return `You are the PRODUCT phase of a backlog-grooming run, working ONE cluster of related items. This is a WRITE-PERMITTED phase but ONLY for two specific calls: backlog_set_priority and backlog_append_note. You MUST NOT call backlog_resolve_item, backlog_transition_status, backlog_merge_items, backlog_split_item, backlog_soft_delete_item, backlog_claim_item, or any other mutating tool. ${DRY_RUN ? 'DRY RUN IS ON: compute what you WOULD write (priorityAfter, priorityChanged, note text) but DO NOT actually call the write tools; set noteAppended=false and readBackConfirmed=false and explain in clusterNotes what you would have done.' : ''}

${BACKLOG_MECHANICS}

CLUSTER "${clusterLabel}" — items to triage (do not touch items outside this list):
${JSON.stringify(items, null, 1)}

FOR EACH ITEM, do the following:
1. REPRIORITIZE: form your own view of CRITICAL/HIGH/MEDIUM/LOW from the title/kind/tags and a quick backlog_get_item read (do not do deep code verification here — that is the lane's job downstream). If it should change, ${DRY_RUN ? 'record what you would call' : 'call backlog_set_priority'} and set priorityChanged=true with priorityReason.
2. FLAG: decide "debug-triage" (the item's premise or root cause is genuinely uncertain — you cannot tell if it is still real from the text alone) vs "architect-spec" (the item is plausibly real, but the fix shape/files/approach are not specified).
3. ROUTE, from the flag:
   - flag=debug-triage -> route=debugger, always.
   - flag=architect-spec -> route=devops if this is fundamentally a build/release/CI/tooling item (touches nx.json/package.json/pnpm-lock/CI config/tools/nx-plugins/publish workflow, or its kind/tags say so) — otherwise route=architect.
   Write a one-line routeReason for every item; a lane is allowed to hand the item back to you if your routing was wrong, so be honest about your uncertainty rather than guessing confidently.
4. QUICK PLAUSIBILITY CHECK ONLY (not a full verify): if something about the item smells stale on its face (references a path/tool/file you have reason to doubt still exists, claims a fix that seems too easy to still be open, etc.) set possiblyDecayed=true — this is a HINT for the debugger lane, not your own conclusion.
5. ${DRY_RUN ? 'Skip the note call.' : `Append a note (backlog_append_note) recording your flag, route, routeReason, and priority decision — cite whatever you actually looked at (do not overclaim; a title-only read is fine to say so).`}
6. ${DRY_RUN ? '' : 'READ BACK every item you wrote to with backlog_get_item and confirm the priority/note field actually changed — set readBackConfirmed accordingly. If a write did not land, say so in clusterNotes; do not silently mark it confirmed.'}

Return the structured object.`
}

// ============================================================================
// phase 3 (+ phase 3b reroute) — lanes, READ-ONLY
// ============================================================================
const LANE_ROLE = {
  debugger: `You are the DEBUGGER lane. Your ONLY job is to determine, per item, whether its premise is still true RIGHT NOW — VERIFIED_LIVE, DEAD (the premise no longer holds; you have evidence that kills it), PARTIALLY_LIVE (some sub-claims true, some not — say which), or NEEDS_HUMAN (you genuinely cannot resolve it without a human decision/credential). You are explicitly ALLOWED and EXPECTED to conclude DEAD with evidence — this is exactly where decayed premises get killed. Do not write a spec; that is not your job even for VERIFIED_LIVE items (they go to an architect/devops packet in a later run/pass, or you may HAND BACK to whichever lane if you believe this item is actually a clear spec-ready item, not a debug question).`,
  architect: `You are the ARCHITECT lane. Your job is to write an implementation-ready SPEC for items that are REAL but under-specified: the shape of the fix, the exact files, the risks, and explicitly what NOT to do. Pack items that share a FILE or a ROOT CAUSE into one packet — never pack by mere thematic similarity. If you read an item and it turns out its premise is actually uncertain (you cannot tell if it is still true), HAND IT BACK to the debugger lane rather than speccing a fix for something that might not exist.`,
  devops: `You are the DEVOPS lane. Same job as the architect lane (write an implementation-ready SPEC: files, approach, risks, what NOT to do) but you ALSO explicitly call out release-path and CI/gate implications for every packet in releaseImplications (this field must be non-empty for you) — does the fix touch a root-sensitive file (package.json/project.json/nx.json/pnpm-lock.yaml/.gitignore) forcing a solo/whole-workspace-affected run, does it change a published package's version surface, does it change the pre-commit or CI gate itself. If an item you were routed turns out to be a plain application-logic bug with an uncertain premise, HAND IT BACK to the debugger lane; if it is real but has nothing to do with build/release/CI/tooling, HAND IT BACK to the architect lane.`,
}

function specLanePrompt(lane, clusterLabel, items) {
  return `${LANE_ROLE[lane]}

You are READ-ONLY. You MUST NOT write to the backlog (no set_priority, no append_note, no status change) and you MUST NOT edit/commit any repository file. Investigate with real reads: open files, run \`git log\`/\`git diff\`/\`grep\`, check backlog_audit_trail/backlog_blockers for the item's history.

${BACKLOG_MECHANICS}

CLUSTER "${clusterLabel}" (lane=${lane}) — items routed to you:
${JSON.stringify(items, null, 1)}
${items.some((i) => !i.title) ? '\nSome of the above entries only carry humanId/repo — call backlog_get_item on each to pull its full title/body/tags/citations before you start.' : ''}

FOR EACH PACKET YOU FORM:
- filesTouched MUST be concrete, repo-root-relative paths (e.g. "packages/apigen/apigen-core-client/src/lib/schema.ts") derived from the item's own citations, backlog_audit_trail, or your own \`git log --follow\`/grep of the actual code — never a vague area like "the apigen package".
- Two packets in this cluster that would write the same path must be merged into one packet, or you must sequence them (say so in the spec) — never leave them as two co-equal packets on the same file.
- If a packet touches package.json/project.json/nx.json/pnpm-lock.yaml/.gitignore AT THE REPO ROOT, set soloRequired=true and say why — nx treats a root-config change as affecting the ENTIRE workspace graph, forcing its pre-commit gate to run the full task graph alone; this has already cost three package publishes in this repo.
- acceptanceCriteriaDraft must be CONSUMER-VISIBLE outcomes provable by a runnable command (e.g. "an agent gets N results back from X, verified by running Y") — never an implementation-shape claim like "Promise.all is present". A future implementer of your spec is held to: real components not mocks (mock only a paid external boundary), tests that FAIL if reverted (a negative control), determinism without sleeps, trusting exit codes not stdout greps. Write your draft ACs so that bar is achievable.
- whatNotToDo should name the tempting-but-wrong approach if there is one (e.g. "do not hand-edit BACKLOG.md", "do not use tsc directly", "do not scaffold with a generic @nx/js generator").
- If you could not produce a real spec without a human decision (ambiguous product scope, missing credential), set blocked=true with blockedReason instead of guessing.

If an item does not belong in this lane, put it in handbacks with your best-guess suggestedRoute and a real reason — do not force it into a packet just because it was assigned to you.

Return the structured object.`
}

function debugLanePrompt(clusterLabel, items) {
  return `${LANE_ROLE.debugger}

You are READ-ONLY. You MUST NOT write to the backlog and you MUST NOT edit/commit any repository file. You MAY run a read-only build/test to reproduce a bug if that is the only way to confirm it (build/test output is gitignored) — never edit tracked files, never commit.

${BACKLOG_MECHANICS}

CLUSTER "${clusterLabel}" — items routed to you:
${JSON.stringify(items, null, 1)}
${items.some((i) => !i.title) ? '\nSome of the above entries only carry humanId/repo — call backlog_get_item on each to pull its full title/body/tags/citations before you start.' : ''}

FOR EACH ITEM, actually verify against CURRENT code/state (never trust the item's own text):
- Open the cited file(s) at the cited line(s). If a citation is stale (moved/renamed/deleted), say so — that itself may be the whole story.
- Check backlog_audit_trail for prior work/notes on this item; a "fixed" claim in a note is not proof — verify it yourself.
- Reproduce the defect if it is reproducible (run the real command/test, read the real exit code) rather than reasoning about whether it "should" still fail.
- Watch specifically for the five decay shapes: a partial fix presented as full; source fixed but the built artifact/dist not; a type/signature hardened but the call site left stale; docs updated but behavior not (or the reverse); something that holds in source but not through the real consumer seam (built artifact, loaded MCP tool, CLI entry).
- evidence must be the literal command output or file:line that kills or confirms it — not a summary of what you expect.

If an item is actually a clear, already-real, spec-ready item (you're confident the premise holds and you can already see the fix shape), you MAY hand it back to whichever spec lane (architect or devops) fits — do not spend time writing that spec yourself.

Return the structured object.`
}

// ============================================================================
// phase 4 — product acceptance criteria + notes (WRITE: priority + note ONLY)
// ============================================================================
function acWritePrompt(groupId, packets) {
  return `You are the PRODUCT phase finalizing acceptance criteria for a set of architect/devops SPEC packets. WRITE-PERMITTED for backlog_append_note and backlog_set_priority ONLY — nothing else mutating. ${DRY_RUN ? 'DRY RUN IS ON: compute the finalized acceptanceCriteria and finalPriority but do NOT actually call the write tools; set noteAppended=false and readBackConfirmed=false.' : ''}

${BACKLOG_MECHANICS}

SPEC PACKETS to finalize (group "${groupId}"):
${JSON.stringify(packets, null, 1)}

FOR EVERY backlog item named in every packet's "items" array:
1. Take the packet's acceptanceCriteriaDraft and FINALIZE it: each criterion must be a consumer-visible outcome provable by a runnable command, phrased so a reviewer could verify it by literally running something and checking output/exit code — tighten any criterion that is really describing an implementation shape rather than an outcome.
2. Set finalPriority — normally the item's current priority unless the packet's risk/blocked status clearly argues otherwise (a blocked packet's items should usually stay at their current priority or be flagged, not silently downgraded).
3. ${DRY_RUN ? 'Skip the note call.' : `Append a note (backlog_append_note) on the item recording: which packet it's in (packetId), the finalized acceptance criteria, filesTouched, and — if the packet is blocked — the blockedReason, so a human/executor knows exactly what is needed next. Do NOT resolve or transition the item's status — that is not this workflow's job.`}
4. ${DRY_RUN ? '' : 'READ BACK with backlog_get_item and confirm the note actually landed; set readBackConfirmed accordingly.'}

Return the structured object.`
}

function debugNoteWritePrompt(groupId, verdicts) {
  return `You are the PRODUCT phase recording DEBUGGER-LANE verdicts onto the backlog. WRITE-PERMITTED for backlog_append_note and backlog_set_priority ONLY. ${DRY_RUN ? 'DRY RUN IS ON: compute what you would write but do NOT call the write tools; set noteAppended=false and readBackConfirmed=false.' : ''}

${BACKLOG_MECHANICS}

DEBUGGER VERDICTS to record (group "${groupId}"):
${JSON.stringify(verdicts, null, 1)}

FOR EVERY item:
- ${DRY_RUN ? 'Skip the note call.' : `Append a note (backlog_append_note) recording the verdict (VERIFIED_LIVE / DEAD / PARTIALLY_LIVE / NEEDS_HUMAN) and its evidence verbatim, so the reasoning survives even though you are not changing status. For DEAD, recommend the item be closed by a human/executor with the cited evidence — you do NOT resolve/transition it yourself, that is out of scope for this workflow. For VERIFIED_LIVE, recommend it proceed to the architect/devops lane on the NEXT grooming pass (or note if it is now ready for direct spec work).`}
- If the verdict argues for a priority change (e.g. DEAD items are typically not worth CRITICAL/HIGH churn, a confirmed-live item with fresh evidence of severity might deserve raising), ${DRY_RUN ? 'record what you would set' : 'call backlog_set_priority'} and note why.
- ${DRY_RUN ? '' : 'READ BACK with backlog_get_item and confirm the note landed; set readBackConfirmed accordingly.'}

Return the structured object.`
}

// ============================================================================
// phase 5 — report (writes exactly one markdown file)
// ============================================================================
function reportPrompt(payload) {
  return `You are writing the SINGLE markdown artifact for this backlog-grooming run. This is the ONLY file you may write in this entire workflow, and it goes to EXACTLY this path — do not choose your own filename or add a timestamp:

  ${ARTIFACT_PATH}

Render the following pre-computed JSON data as clear, well-organized markdown (headings, tables where it helps). Do not invent numbers not present in the data. Sections, in order:
1. Summary — total open items (adhd + PseudoSky/adhd), how many were triaged this run, how many packets/verdicts each lane produced, how many handbacks/reroutes occurred.
2. Wave Plan — one subsection per wave, in order; for each packet in the wave show packetId, lane, items, filesTouched, and whether it is soloRequired (with reason). State explicitly: packets in the same wave are file-disjoint by construction; solo waves run alone.
3. Debugger Lane — table of humanId/repo/verdict/evidence-summary/recommendedAction. Call out DEAD items distinctly (these are recommended for human closure).
4. Architect + Devops Lanes — per packet: title/rootCause/spec-summary/risks/whatNotToDo/finalized acceptance criteria/releaseImplications (devops)/blocked status.
0. BANNERS FIRST, before anything else. If payload.dryRun is true, open the artifact with a bold **DRY RUN — NO BACKLOG WRITES WERE MADE THIS RUN** banner. If payload.incompleteInventory is true, open with a bold **INCOMPLETE CORPUS** banner naming payload.reposCovered vs payload.reposExpected and stating that every count in this report is a LOWER BOUND and the drift signal must not be trusted against it. A reader who misses either of these will draw wrong conclusions from correct-looking numbers.

5. Regroom Verdict — render shouldRegroom/reason/suggestedIntervalHint verbatim, plus the raw signal values that produced it (drift, decayRate, untriagedHighCount, packetsIncomplete, escalationsGrowing) so a future run can sanity-check the decision. Explicitly note: "Pass previousOpenCount=${payload.totalOpen} and previousUnresolvedCount=${payload.regroom.signals.unresolvedEscalations} as args on the next invocation to enable the drift and escalation-growth signals."

DATA:
${JSON.stringify(payload, null, 1)}

After writing the file, read it back (or run \`wc -l\`) and report the real path and line count. Return the structured object.`
}

// ============================================================================
// MAIN
// ============================================================================
phase('Inventory')
log(`backlog-grooming starting: repos=${REPOS.join(',')} dryRun=${DRY_RUN} scope(priorities=${SCOPE_PRIORITIES || 'all'}, kinds=${SCOPE_KINDS || 'all'})`)

const invRaw = await parallel(REPOS.map((repo) => () => agent(inventoryPrompt(repo), {
  label: `inventory:${repo}`, phase: 'Inventory', schema: INVENTORY_SCHEMA,
  agentType: 'qa-expert', effort: 'medium', model: 'haiku',
})))
// Re-tag each inventory with the repo WE dispatched it for, by index, rather than
// trusting the `repo` string the subagent echoed back. parallel() preserves input
// order (Promise.all semantics), so invRaw[i] corresponds to REPOS[i].
//
// This matters more here than it looks. The repo key in this backlog is FORKED
// (`adhd` vs `PseudoSky/adhd`), and a mis-tagged item is not a loud failure — it
// is a SILENT wrong-item write for the rest of the pipeline (triage, lanes,
// notes). `TASK-001` in particular exists as two DISTINCT open items, one per
// repo value, so a wrong repo tag resolves to a real-but-wrong ticket with no
// error at all. Trusting the echoed value reproduced, inside this tool, exactly
// the hazard this tool's own preamble warns about.
const inventories = REPOS
  .map((repo, i) => (invRaw[i] ? { ...invRaw[i], repo } : null))
  .filter(Boolean)

if (!inventories.length) {
  throw new Error('backlog-grooming: every inventory call failed/died — cannot proceed without a real item set.')
}

// A PARTIAL inventory is the dangerous case, not the total one. If the
// PseudoSky/adhd call dies we lose ~208 of ~239 open items and every downstream
// count (drift, decay rate, excluded-high) is computed against a corpus that
// silently is not the corpus. Surface it loudly and mark the artifact.
const incompleteInventory = inventories.length < REPOS.length
if (incompleteInventory) {
  const missing = REPOS.filter((r) => !inventories.some((inv) => inv.repo === r))
  log(`CRITICAL: ${inventories.length} of ${REPOS.length} repo inventories returned — corpus is INCOMPLETE this run. Missing: ${missing.join(', ')}. Every count below is a LOWER BOUND, and the re-groom drift signal must not be trusted against it.`)
}

for (const inv of inventories) {
  if (!inv.reconciled) log(`INVENTORY RECONCILIATION MISMATCH for ${inv.repo}: ${inv.discrepancyNotes || '(no notes given)'}`)
}

const totalOpen = inventories.reduce((s, inv) => s + (inv.openCountReported || (inv.items || []).length), 0)
const fullItems = inventories.flatMap((inv) => (inv.items || []).map((it) => ({ ...it, repo: inv.repo })))
const scopedItems = fullItems.filter(passesScope)

// A typo'd scope arg ('Critical' vs 'CRITICAL', 'bug' vs 'BUG') matches nothing
// and would otherwise produce a confident, fully-green run over ZERO items —
// the worst failure shape available, because it looks like success. Fail loudly
// and echo the offending values back.
if ((SCOPE_PRIORITIES || SCOPE_KINDS) && fullItems.length > 0 && scopedItems.length === 0) {
  throw new Error(
    `backlog-grooming: scope filter matched 0 of ${fullItems.length} items. ` +
    `Check for a typo/case mismatch — priorities=${JSON.stringify(SCOPE_PRIORITIES)} kinds=${JSON.stringify(SCOPE_KINDS)}. ` +
    `Expected priorities are CRITICAL/HIGH/MEDIUM/LOW and kinds are upper-case families (BUG, DEBT, FEAT, ...).`
  )
}
const excludedHighPriority = fullItems.filter((it) => !passesScope(it) && (it.priority === 'CRITICAL' || it.priority === 'HIGH'))
log(`inventory: ${fullItems.length} open total (${totalOpen} per backlog_stats), ${scopedItems.length} in scope for this run, ${excludedHighPriority.length} high/critical excluded by scoping`)

// --------------------------------------------------------------------------
// phase 2 — product triage & flag, one agent per family cluster
// --------------------------------------------------------------------------
phase('Triage & Flag')
const MAX_TRIAGE_CLUSTER = 15
const triageClustersMap = groupBy(scopedItems, (it) => `${it.repo}|${familyOf(it.humanId)}`)
const triageClusters = []
for (const [key, items] of triageClustersMap) {
  const chunks = chunkArray(items, MAX_TRIAGE_CLUSTER)
  chunks.forEach((chunk, i) => triageClusters.push({ clusterLabel: chunks.length > 1 ? `${key}#${i + 1}` : key, items: chunk }))
}
log(`triage: ${scopedItems.length} items -> ${triageClusters.length} clusters (one product agent per cluster)`)

const triageRaw = await pipeline(triageClusters, (cluster) => agent(triagePrompt(cluster.clusterLabel, cluster.items), {
  label: `triage:${cluster.clusterLabel}`, phase: 'Triage & Flag', schema: TRIAGE_CLUSTER_SCHEMA,
  agentType: 'product-manager', effort: 'medium', model: 'sonnet',
}))
const triageResults = triageRaw.filter(Boolean)
if (triageResults.length !== triageClusters.length) {
  log(`WARNING: ${triageClusters.length - triageResults.length} triage clusters produced no result (agent died) — their items got no flag/route this run.`)
}
const allDecisions = triageResults.flatMap((r) => r.decisions || [])
log(`triage complete: ${allDecisions.length} decisions (${allDecisions.filter((d) => d.flag === 'debug-triage').length} debug-triage, ${allDecisions.filter((d) => d.flag === 'architect-spec').length} architect-spec)`)

// --------------------------------------------------------------------------
// phase 3 — parallel lanes: architect | debugger | devops
// --------------------------------------------------------------------------
phase('Lanes')
const MAX_LANE_CLUSTER = 8
function buildLaneClusters(route) {
  const items = allDecisions.filter((d) => d.route === route)
  const byFamily = groupBy(items, (it) => `${it.repo}|${familyOf(it.humanId)}`)
  const clusters = []
  for (const [key, decs] of byFamily) {
    const chunks = chunkArray(decs, MAX_LANE_CLUSTER)
    chunks.forEach((chunk, i) => clusters.push({
      clusterLabel: chunks.length > 1 ? `${key}#${i + 1}` : key,
      items: chunk.map((d) => ({ humanId: d.humanId, repo: d.repo, kind: d.kind, title: d.title, possiblyDecayed: d.possiblyDecayed, routeReason: d.routeReason })),
    }))
  }
  return clusters
}

const debuggerClusters = buildLaneClusters('debugger')
const architectClusters = buildLaneClusters('architect')
const devopsClusters = buildLaneClusters('devops')
log(`lanes: debugger=${debuggerClusters.length} clusters, architect=${architectClusters.length} clusters, devops=${devopsClusters.length} clusters`)

const plannedPacketCallsMain = debuggerClusters.length + architectClusters.length + devopsClusters.length

const [debugOutMain, architectOutMain, devopsOutMain] = await parallel([
  () => pipeline(debuggerClusters, (cluster) => agent(debugLanePrompt(cluster.clusterLabel, cluster.items), {
    label: `debug:${cluster.clusterLabel}`, phase: 'Lanes', schema: LANE_DEBUG_SCHEMA,
    agentType: 'debugger', effort: 'high', model: 'sonnet',
  })),
  () => pipeline(architectClusters, (cluster) => agent(specLanePrompt('architect', cluster.clusterLabel, cluster.items), {
    label: `arch:${cluster.clusterLabel}`, phase: 'Lanes', schema: LANE_SPEC_SCHEMA,
    agentType: 'architect-reviewer', effort: 'high', model: 'sonnet',
  })),
  () => pipeline(devopsClusters, (cluster) => agent(specLanePrompt('devops', cluster.clusterLabel, cluster.items), {
    label: `devops:${cluster.clusterLabel}`, phase: 'Lanes', schema: LANE_SPEC_SCHEMA,
    agentType: 'devops-engineer', effort: 'high', model: 'sonnet',
  })),
])

const debugResultsMain = (debugOutMain || []).filter(Boolean)
const architectResultsMain = (architectOutMain || []).filter(Boolean)
const devopsResultsMain = (devopsOutMain || []).filter(Boolean)
const completedPacketCallsMain = debugResultsMain.length + architectResultsMain.length + devopsResultsMain.length
log(`lanes done: debugger ${debugResultsMain.length}/${debuggerClusters.length}, architect ${architectResultsMain.length}/${architectClusters.length}, devops ${devopsResultsMain.length}/${devopsClusters.length} calls completed`)

// --------------------------------------------------------------------------
// phase 3b — reroute corrections for anything a lane handed back
// --------------------------------------------------------------------------
phase('Reroute')
const MAX_CORRECTION_CHUNK = 10
const rawHandbacks = [
  ...debugResultsMain.flatMap((r) => r.handbacks || []),
  ...architectResultsMain.flatMap((r) => r.handbacks || []),
  ...devopsResultsMain.flatMap((r) => r.handbacks || []),
].filter((h) => ['debugger', 'architect', 'devops'].includes(h.suggestedRoute))

let debugResultsCorrection = []
let architectResultsCorrection = []
let devopsResultsCorrection = []
let plannedPacketCallsCorrection = 0
let completedPacketCallsCorrection = 0
let secondRoundHandbacks = []

if (rawHandbacks.length) {
  log(`reroute: ${rawHandbacks.length} handbacks to re-dispatch to their suggested lane`)
  const byRoute = groupBy(rawHandbacks, (h) => h.suggestedRoute)
  const correctionJobs = []
  for (const route of ['debugger', 'architect', 'devops']) {
    const hs = byRoute.get(route) || []
    chunkArray(hs, MAX_CORRECTION_CHUNK).forEach((chunk, i) => {
      correctionJobs.push({
        route, clusterLabel: `REROUTE-${route}#${i + 1}`,
        items: chunk.map((h) => ({ humanId: h.humanId, repo: h.repo, handbackReason: h.reason })),
      })
    })
  }
  plannedPacketCallsCorrection = correctionJobs.length

  const correctionOut = await pipeline(correctionJobs, (job) => {
    if (job.route === 'debugger') {
      return agent(debugLanePrompt(job.clusterLabel, job.items), {
        label: `reroute-debug:${job.clusterLabel}`, phase: 'Reroute', schema: LANE_DEBUG_SCHEMA,
        agentType: 'debugger', effort: 'high', model: 'sonnet',
      })
    }
    return agent(specLanePrompt(job.route, job.clusterLabel, job.items), {
      label: `reroute-${job.route}:${job.clusterLabel}`, phase: 'Reroute', schema: LANE_SPEC_SCHEMA,
      agentType: job.route === 'devops' ? 'devops-engineer' : 'architect-reviewer', effort: 'high', model: 'sonnet',
    })
  })
  const correctionResults = (correctionOut || []).filter(Boolean)
  completedPacketCallsCorrection = correctionResults.length

  // A correction-round agent that STILL thinks an item is mis-routed will return
  // handbacks of its own (both lane schemas require the field). Those were being
  // silently dropped — the item would then appear fully processed while nobody
  // had produced usable output for it. Deliberately do NOT auto-redispatch a
  // third round: two disagreeing lanes is a routing question for a human, and an
  // unbounded reroute loop is worse than an unrouted item. Surface and count it.
  secondRoundHandbacks = correctionResults.flatMap((r) => (r && r.handbacks) || [])
  if (secondRoundHandbacks.length) {
    log(`WARNING: ${secondRoundHandbacks.length} item(s) were handed back a SECOND time after rerouting — two lanes disagree on who owns them. Not re-dispatching again; these are counted as unresolved and need a human routing call: ${secondRoundHandbacks.map((h) => h.humanId || '(unknown id)').join(', ')}`)
  }
  debugResultsCorrection = correctionResults.filter((r) => r && r.verdicts)
  architectResultsCorrection = correctionResults.filter((r) => r && r.lane === 'architect')
  devopsResultsCorrection = correctionResults.filter((r) => r && r.lane === 'devops')
  log(`reroute done: ${completedPacketCallsCorrection}/${plannedPacketCallsCorrection} correction calls completed`)
} else {
  log('reroute: no handbacks — every lane accepted its routed items')
}

const debugVerdictsAll = [...debugResultsMain, ...debugResultsCorrection].flatMap((r) => r.verdicts || [])
const specPacketsAll = [...architectResultsMain, ...devopsResultsMain, ...architectResultsCorrection, ...devopsResultsCorrection]
  .flatMap((r) => (r.packets || []).map((p) => ({ ...p, lane: r.lane })))

const plannedPacketCount = plannedPacketCallsMain + plannedPacketCallsCorrection
const completedPacketCount = completedPacketCallsMain + completedPacketCallsCorrection

// --------------------------------------------------------------------------
// phase 4 — product writes acceptance criteria + debug notes (WRITE)
// --------------------------------------------------------------------------
phase('Acceptance Criteria')
const MAX_AC_GROUP = 10
const acGroups = chunkArray(specPacketsAll, MAX_AC_GROUP).map((chunk, i) => ({ groupId: `AC-${i + 1}`, packets: chunk }))
const debugNoteGroups = chunkArray(debugVerdictsAll, MAX_AC_GROUP).map((chunk, i) => ({ groupId: `DEBUGNOTE-${i + 1}`, verdicts: chunk }))
log(`acceptance-criteria: ${specPacketsAll.length} packets -> ${acGroups.length} write-groups; ${debugVerdictsAll.length} verdicts -> ${debugNoteGroups.length} write-groups`)

const [acWriteOut, debugNoteOut] = await parallel([
  () => pipeline(acGroups, (g) => agent(acWritePrompt(g.groupId, g.packets), {
    label: `ac:${g.groupId}`, phase: 'Acceptance Criteria', schema: AC_WRITE_SCHEMA,
    agentType: 'product-manager', effort: 'medium', model: 'sonnet',
  })),
  () => pipeline(debugNoteGroups, (g) => agent(debugNoteWritePrompt(g.groupId, g.verdicts), {
    label: `debugnote:${g.groupId}`, phase: 'Acceptance Criteria', schema: DEBUG_NOTE_WRITE_SCHEMA,
    agentType: 'product-manager', effort: 'medium', model: 'sonnet',
  })),
])
const acWrites = (acWriteOut || []).filter(Boolean).flatMap((r) => r.writes || [])
const debugNoteWrites = (debugNoteOut || []).filter(Boolean).flatMap((r) => r.writes || [])
log(`writes: ${acWrites.filter((w) => w.noteAppended).length}/${acWrites.length} AC notes appended, ${debugNoteWrites.filter((w) => w.noteAppended).length}/${debugNoteWrites.length} debug notes appended`)

// --------------------------------------------------------------------------
// wave planning (deterministic, pure JS — requirement 1)
// --------------------------------------------------------------------------
const wavePlan = planWaves(specPacketsAll)
const waveSanityTotal = wavePlan.reduce((s, w) => s + w.length, 0)
if (waveSanityTotal !== specPacketsAll.length) {
  log(`WAVE PLAN SANITY WARNING: ${waveSanityTotal} packets placed across ${wavePlan.length} waves, expected ${specPacketsAll.length}`)
}
log(`wave plan: ${specPacketsAll.length} packets -> ${wavePlan.length} waves (${wavePlan.filter((w) => w.length === 1 && w[0].soloRequired).length} solo)`)

// --------------------------------------------------------------------------
// re-dispatch (regroom) verdict — requirement 2
// --------------------------------------------------------------------------
// Signals, each independently checkable and thresholded:
//  1. DRIFT          — total open count moved >=20 items or >=15% since the
//                       last recorded run. Below that, the corpus shape this
//                       run already captured is still representative.
//  2. DECAY RATE      — >=20% of debugger-lane-VERIFIED items came back DEAD.
//                       Calibrated below the two worst full-remediation runs
//                       observed in this repo (~50-54% dead), because this is
//                       a lighter grooming pass, not a full remediation sweep
//                       — 20% is well above single-item noise but well below
//                       "the corpus is mostly fiction" territory.
//  3. UNTRIAGED HIGH  — >=3 CRITICAL/HIGH items existed but were excluded by
//                       this run's own args scoping. A scoped run choosing to
//                       skip a handful of high-priority items is normal; three
//                       or more sitting untouched is a signal to run unscoped.
//  4. PACKETS INCOMPLETE — any planned lane/correction dispatch produced no
//                       result at all (agent died). Always actionable — those
//                       items got literally zero coverage this run.
//  5. ESCALATIONS GROWING — the NEEDS_HUMAN/blocked count grew versus the
//                       last run's recorded count. A STATIC small escalation
//                       count is not actionable by re-grooming (it needs a
//                       human, not more grooming) — only a GROWING count
//                       means genuinely new escalations are piling up.
// Twice-handed-back items count as unresolved: no lane produced usable output
// for them, and the disagreement is itself a human routing decision.
const unresolvedEscalations =
  debugVerdictsAll.filter((v) => v.verdict === 'NEEDS_HUMAN').length + secondRoundHandbacks.length
  + specPacketsAll.filter((p) => p.blocked).length

const drift = PREV_OPEN_COUNT !== null && (
  Math.abs(totalOpen - PREV_OPEN_COUNT) >= 20 ||
  Math.abs(totalOpen - PREV_OPEN_COUNT) / Math.max(totalOpen, 1) >= 0.15
)
const debuggerVerifiedCount = debugVerdictsAll.length
const decayedCount = debugVerdictsAll.filter((v) => v.verdict === 'DEAD').length
const decayRate = debuggerVerifiedCount ? decayedCount / debuggerVerifiedCount : 0
const decayAlert = debuggerVerifiedCount > 0 && decayRate >= 0.20
const untriagedHighAlert = excludedHighPriority.length >= 3
const packetsIncomplete = completedPacketCount < plannedPacketCount
const escalationsGrowing = PREV_UNRESOLVED_COUNT !== null && unresolvedEscalations > PREV_UNRESOLVED_COUNT

const triggers = []
if (drift) triggers.push(`open-count drift ${PREV_OPEN_COUNT}->${totalOpen}`)
if (decayAlert) triggers.push(`decay rate ${Math.round(decayRate * 100)}% (${decayedCount}/${debuggerVerifiedCount} DEAD) >= 20% threshold`)
if (untriagedHighAlert) triggers.push(`${excludedHighPriority.length} CRITICAL/HIGH items excluded by this run's scoping`)
if (packetsIncomplete) triggers.push(`${plannedPacketCount - completedPacketCount} planned lane/correction dispatches produced no result`)
if (escalationsGrowing) triggers.push(`unresolved escalations grew ${PREV_UNRESOLVED_COUNT}->${unresolvedEscalations}`)

const shouldRegroom = triggers.length > 0
let suggestedIntervalHint
if (decayAlert) {
  suggestedIntervalHint = '3-4 days — decay rate is elevated, the corpus is drifting from code faster than a normal cadence should tolerate'
} else if (packetsIncomplete) {
  suggestedIntervalHint = 'immediately — re-run covering only the items that got zero coverage this pass, no need to wait'
} else if (drift || untriagedHighAlert || escalationsGrowing) {
  suggestedIntervalHint = '7 days, or immediately if another material change lands first'
} else {
  suggestedIntervalHint = '10-14 days, or immediately after a net +/-20 open-item change, whichever comes first — nothing this run measured indicates the corpus has moved enough to be worth re-grooming sooner'
}

const regroom = {
  shouldRegroom,
  reason: shouldRegroom ? `Triggered by: ${triggers.join('; ')}.` : 'No signal crossed its threshold this run — see suggestedIntervalHint.',
  suggestedIntervalHint,
  signals: {
    totalOpen, previousOpenCount: PREV_OPEN_COUNT, drift,
    decayRate, decayedCount, debuggerVerifiedCount, decayAlert,
    excludedHighPriorityCount: excludedHighPriority.length, untriagedHighAlert,
    plannedPacketCount, completedPacketCount, packetsIncomplete,
    unresolvedEscalations, previousUnresolvedCount: PREV_UNRESOLVED_COUNT, escalationsGrowing,
  },
}
log(`regroom verdict: shouldRegroom=${shouldRegroom} — ${regroom.reason}`)

// --------------------------------------------------------------------------
// phase 5 — report (single markdown artifact)
// --------------------------------------------------------------------------
phase('Report')
const reportPayload = {
  totalOpen,
  scopedItemCount: scopedItems.length,
  triageDecisionCount: allDecisions.length,
  wavePlan: wavePlan.map((wave, i) => ({ wave: i + 1, packets: wave })),
  debugVerdicts: debugVerdictsAll,
  specPackets: specPacketsAll,
  acWrites,
  debugNoteWrites,
  handbacks: rawHandbacks,
  secondRoundHandbacks,
  incompleteInventory,
  reposCovered: inventories.map((inv) => inv.repo),
  reposExpected: REPOS,
  regroom,
  dryRun: DRY_RUN,
}

const reportOut = await agent(reportPrompt(reportPayload), {
  label: 'report', phase: 'Report', schema: REPORT_SCHEMA,
  agentType: 'product-manager', effort: 'medium', model: 'sonnet',
})

if (!reportOut || !reportOut.confirmed) {
  log('WARNING: report agent did not confirm the artifact was written — check tmp/ manually.')
}

return {
  totalOpen,
  specPackets: specPacketsAll,
  debugVerdicts: debugVerdictsAll,
  wavePlan: wavePlan.map((wave, i) => ({ wave: i + 1, packets: wave })),
  regroom,
  artifactPath: (reportOut && reportOut.pathWritten) || ARTIFACT_PATH,
}
