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
    { title: 'Inventory', detail: 'preflight-gated graph access (mcp or CLI, abort if neither), then a partition-by-kind pull of every open item in adhd + PseudoSky/adhd, reconciled against backlog_stats' },
    { title: 'Triage & Flag', detail: 'product (WRITE: priority + note only): reprioritize, flag debug-triage vs architect-spec, route to a lane' },
    { title: 'Lanes', detail: 'parallel, READ-ONLY: items are CONSOLIDATED by overlapping file reservations before architect/devops see them (one architect owns each file), debugger is packed by family; may hand back mis-routed items' },
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
// Test/smoke scoping. `onlyIds` pins the run to an explicit humanId allowlist and
// `maxItems` truncates after scoping — both exist so the full pipeline (preflight ->
// inventory -> triage -> lanes -> persistence audit) can be exercised end to end on
// one real item without a 500-agent fan-out.
const ONLY_IDS = Array.isArray(A.onlyIds) && A.onlyIds.length ? new Set(A.onlyIds) : null
const MAX_ITEMS = Number.isInteger(A.maxItems) && A.maxItems > 0 ? A.maxItems : null
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

// ---------------------------------------------------------------------------
// FILE RESERVATIONS — derived deterministically from data the item already
// carries (citations[].file, plus path-shaped tokens in title/body). This is the
// input to consolidation: we group by what work would TOUCH, not by what it is
// NAMED. 184 of 258 open items (71%) yield at least one path-qualified file.
// ---------------------------------------------------------------------------
// Extension alternation order matters: longer alternatives MUST precede their own
// prefixes or `package.json` matches as `package.js` and silently becomes a
// different reservation. (This bit the analysis that produced these numbers.)
const FILE_EXT = 'tsx|ts|mjs|cjs|jsonc|json|js|md|py|rs|yaml|yml|toml|sh'
const FILE_ROOTS = 'packages|entrypoint|tools|scripts|docs|apps|libs|\\.claude|\\.adhd'
const PATH_RE = new RegExp('((?:' + FILE_ROOTS + ')\\/[A-Za-z0-9._\\-\\/]+\\.(?:' + FILE_EXT + '))', 'g')

// Only PATH-QUALIFIED files are reservations. A bare `AGENTS.md` is referenced by
// 50 items; treating it as a shared reservation collapses half the backlog into one
// packet. Root-sensitive bare names are handled separately by planWaves(), which
// already forces them solo.
function reservationsOf(item) {
  const out = new Set()
  for (const c of item.citations || []) {
    const f = c && typeof c === 'object' ? String(c.file || '').trim() : ''
    if (f.includes('/')) out.add(f)
  }
  const text = `${item.body || ''} ${item.title || ''}`
  let m
  PATH_RE.lastIndex = 0
  while ((m = PATH_RE.exec(text)) !== null) out.add(m[1])
  return out
}

// Pack items into clusters that actually REACH `max`, using `keyOf` only as an
// affinity/sort key. The previous code emitted one cluster per distinct key and
// then chunked it, so a corpus of near-unique keys produced near-singleton
// clusters and `max` was never reached: 354 items -> 233 groups, 197 singletons,
// i.e. ~10x the agent calls the constants imply. chunkArray only ever SPLITS;
// nothing ever PACKED. (DEBT-WORKFLOW-GROOMING-CLUSTER-FRAGMENTATION-001)
function packByAffinity(items, max, keyOf) {
  const sorted = [...items].sort((a, b) => {
    const ka = keyOf(a); const kb = keyOf(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    return String(a.humanId) < String(b.humanId) ? -1 : 1
  })
  const out = []
  for (let i = 0; i < sorted.length; i += max) out.push(sorted.slice(i, i + max))
  return out
}

// CONSOLIDATION — group items by OVERLAPPING FILE RESERVATIONS before the
// architect lane, so one architect sees every item that would touch the same file
// and can write one coherent spec instead of N conflicting ones.
//
// Deliberately NOT connected-components/union-find: transitive closure over shared
// files chains everything through hub files and produced a single 121-item blob
// against 117 singletons on the real corpus. Greedy seed-and-grow with a hard cap
// keeps packets cohesive AND bounded (measured: 177 items -> 81 packets, max 8).
//
// Fully deterministic — seeds by (reservation count, humanId) and breaks overlap
// ties by humanId. No Date.now()/Math.random() (both unavailable in workflow
// scripts, and either would break resume-by-cache-key).
function consolidateByReservations(items, max) {
  const files = new Map()          // file -> [item...]
  const reserved = new Map()       // uid -> Set(files)
  const unreserved = []
  // humanId is NOT unique across the graph — 37 humanIds resolve to more than one repo
  // (measured over the full corpus; 26 of them are PseudoSky/adhd + sox-ecosystem, and
  // they cluster on low-entropy ids like BUG-001..BUG-008 that every repo mints for
  // itself). Keying identity on humanId alone made the second repo's copy collide with
  // the first and vanish from the packets entirely — 5 of 301 debugger items lost,
  // silently, with every count still looking healthy. Identity here is (repo, humanId).
  const uid = (it) => `${it.repo}\u0000${it.humanId}`
  for (const it of items) {
    const f = reservationsOf(it)
    if (!f.size) { unreserved.push(it); continue }
    reserved.set(uid(it), f)
    for (const path of f) {
      if (!files.has(path)) files.set(path, [])
      files.get(path).push(it)
    }
  }

  // FILE-GROUP-FIRST assignment. The earlier greedy seeded on "most reservations" and
  // grew by overlap, which let a packet fill to `max` before it had absorbed every
  // sharer of a file it already owned. Measured result: 36 files were split across
  // packets and NONE of them were cap-forced — entrypoint/backlog/src/cli.ts had 7
  // sharers (under the cap of 8) spread over 4 packets. That is exactly the collision
  // consolidation exists to prevent, so the grouping is now driven by the file groups
  // themselves rather than by item adjacency.
  //
  // Invariant: for any file with <= max sharers, all of its items land in ONE packet.
  // A file with more sharers than the cap is chunked, and that is the only legitimate
  // split — it is reported by splitFileGroups so the caller can raise the cap knowingly.
  const placed = new Set()
  const packets = []
  const order = [...files.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1))
  let splitFileGroups = 0
  for (const [path, group] of order) {
    const pending = group.filter((it) => !placed.has(uid(it)))
    if (!pending.length) continue
    if (pending.length > max) splitFileGroups++
    for (let k = 0; k < pending.length; k += max) {
      const chunk = pending.slice(k, k + max)
      // Prefer an existing packet that already owns this file AND has room, so a group
      // split by the cap stays as contiguous as possible.
      // Pick the packet with the MOST file overlap with this chunk, not merely one that
      // already owns `path`. An item cites several files, so the chunk drags its whole
      // reservation set along; homing it on maximum overlap is what actually collapses
      // duplicate file-opens across agents.
      let host = null
      let hostOverlap = 0
      const chunkFiles = new Set()
      for (const it of chunk) for (const f of reserved.get(uid(it)) || []) chunkFiles.add(f)
      for (const pk of packets) {
        if (pk.items.length + chunk.length > max) continue
        let ov = 0
        for (const f of pk.files) if (chunkFiles.has(f)) ov++
        if (ov > hostOverlap) { hostOverlap = ov; host = pk }
      }
      if (host) {
        host.items.push(...chunk)
        for (const f of chunkFiles) if (!host.files.includes(f)) host.files.push(f)
      } else {
        packets.push({ items: [...chunk], files: [...chunkFiles], reason: 'file-overlap' })
      }
      for (const it of chunk) placed.add(uid(it))
    }
  }
  // Record every file each packet actually touches (an item carries more than the one
  // file that placed it), so the lane is told the full surface it owns.
  for (const pk of packets) {
    const all = new Set(pk.files)
    for (const it of pk.items) for (const f of reserved.get(uid(it)) || []) all.add(f)
    pk.files = [...all].sort()
  }

  // Items with no extractable reservation cannot be consolidated on file evidence.
  // They are packed by family affinity and flagged so the lane knows the packet is a
  // bag of neighbours, not a genuine shared-file unit.
  for (const chunk of packByAffinity(unreserved, max, (it) => `${it.repo}|${familyOf(it.humanId)}`)) {
    packets.push({ items: chunk, files: [], reason: 'no-reservations' })
  }
  if (splitFileGroups) {
    log(`consolidation: ${splitFileGroups} file group(s) exceeded the packet cap of ${max} and were chunked — those files have more than one owning agent.`)
  }
  return backfillPackets(packets, max)
}

// Bin-pack under-full packets together so we stop paying a whole agent's fixed
// overhead (preamble + tool gate + fetch round-trip, ~8.5k tokens observed) for a
// packet of one.
//
// Measured on the debugger-eligible corpus: consolidating 166 items purely by file
// overlap produced 71 packets against family-packing's 21, while saving only 15% of
// redundant file opens — i.e. the "better" grouping was ~3x more expensive overall,
// because non-overlapping items each became a singleton. Backfilling recovers the
// agent count without breaking any file group.
//
// Backfill only ever MERGES whole packets, never splits one, so it cannot make file
// co-location worse. A merged packet just carries two independent file groups, and the
// lane emits separate output per group.
//
// There is NO "one owner per file" guarantee, and this is not a defect to fix — it is
// structural. An item citing both db.ts and cli.ts can only live in one packet, so
// whichever of those two file groups is placed second loses that member. Guaranteeing
// one owner per file means merging every transitively-connected item, which on this
// corpus is a single 121-item component — far past any workable packet cap. Measured
// on the live backlog at max=8: 47 of ~450 files in the debugger lane and 121 of ~700
// in the architect lane are touched by more than one packet, essentially all of them
// spread over just 2 packets. Agents must therefore treat a reserved file as SHARED,
// not owned, which is why the lane prompts require findings to be persisted per item
// via the backlog tool rather than as a whole-file rewrite.
function backfillPackets(packets, max) {
  const full = packets.filter((p) => p.items.length >= max)
  const partial = packets.filter((p) => p.items.length < max)
    .sort((a, b) => (b.items.length - a.items.length) || (String(a.items[0].humanId) < String(b.items[0].humanId) ? -1 : 1))
  const merged = []
  for (const p of partial) {
    const host = merged.find((m) => m.items.length + p.items.length <= max)
    if (!host) { merged.push({ items: [...p.items], files: [...p.files], reason: p.reason, groups: [p.files] }); continue }
    host.items.push(...p.items)
    for (const f of p.files) if (!host.files.includes(f)) host.files.push(f)
    host.groups = [...(host.groups || [host.files]), p.files]
    host.reason = host.reason === p.reason ? host.reason : 'mixed-groups'
  }
  return [...full, ...merged]
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

// A status is CLOSED only if it positively asserts the work is done or void.
// Anything else — including UNKNOWN/MIXED/PARTIAL — is still open work.
const CLOSED_STATUSES = new Set(['RESOLVED', 'FIXED', 'VERIFIED', 'SUPERSEDED', 'SHIPPED', 'INVALID', 'DUPLICATE', 'ARCHIVED'])

// ---------------------------------------------------------------------------
// ACCOUNTABILITY ENFORCEMENT — a self-report is only worth something if the
// orchestrator acts on it. These run over every agent result.
// ---------------------------------------------------------------------------

// Drop results from agents that admitted they had no graph access, and surface the
// count. Such a result is not partial data — it is fabrication risk, and merging it
// silently is exactly how 22 nonexistent ids entered the last run's output.
function rejectBlindResults(results, label) {
  const kept = []
  const blind = []
  for (const r of results) {
    if (!r) continue
    if (r.toolAccess === 'none' || !r.toolAccess) blind.push(r)
    else kept.push(r)
  }
  if (blind.length) {
    log(`REJECTED ${blind.length}/${results.filter(Boolean).length} ${label} result(s): agent reported no graph access.`)
    for (const b of blind.slice(0, 5)) log(`   [${b.clusterLabel}] ${String(b.toolAccessDetail || '').slice(0, 180)}`)
  }
  return { kept, blindCount: blind.length }
}

// Fabrication tripwire: ids the agents could not resolve. Reported, never silently
// dropped — a rising count means the corpus and the graph have diverged.
function collectUnresolved(results) {
  const out = []
  for (const r of results) for (const u of (r && r.unresolvedIds) || []) out.push(u)
  return out
}

// Persistence audit. `persistence` is the agent's own receipt; readBackConfirmed is
// the only field that reflects an observation rather than an intention, so it is the
// one we count.
function auditPersistence(results, label) {
  let claimed = 0; let confirmed = 0; const failures = []
  for (const r of results) {
    for (const pr of (r && r.persistence) || []) {
      if (pr.noteAppended) claimed++
      if (pr.readBackConfirmed) confirmed++
      else failures.push(`${pr.repo || '?'}::${pr.humanId} ${pr.error ? '- ' + pr.error : ''}`)
    }
  }
  log(`persistence [${label}]: ${confirmed} confirmed / ${claimed} claimed` +
    (failures.length ? ` — ${failures.length} unconfirmed` : ''))
  for (const f of failures.slice(0, 5)) log(`   UNCONFIRMED ${f}`)
  return { claimed, confirmed, failures }
}

function passesScope(item) {
  // Status is enforced HERE, in JS, not left to the inventory agent's prompt.
  // Run wf_28c6a91a-4c9 inventoried 354 items when only 258 were open: ~1/3 of the
  // entire run's spend went to items that were already RESOLVED/FIXED/SUPERSEDED.
  // The prompt already said "status open"; the agent could not honour it because the
  // backlog tools were absent (see TOOL PREFLIGHT). A prompt is not a filter.
  //
  // Exclude CLOSED statuses rather than requiring status==='OPEN'. The graph's own
  // definition of open is broader: backlog_stats for PseudoSky/adhd reports
  // open=258 = OPEN(216) + UNKNOWN(23) + MIXED(17) + PARTIAL(1) + DEFERRED(1).
  // Requiring 'OPEN' would silently drop those 42 — the exact class of item most
  // in need of grooming, since UNKNOWN/MIXED/PARTIAL means nobody could tell.
  if (CLOSED_STATUSES.has(String(item.status || 'OPEN').toUpperCase())) return false
  if (SCOPE_PRIORITIES && !SCOPE_PRIORITIES.includes(item.priority)) return false
  if (SCOPE_KINDS && !SCOPE_KINDS.includes(item.kind)) return false
  if (ONLY_IDS && !ONLY_IDS.has(item.humanId)) return false
  return true
}

// ---------------------------------------------------------------------------
// LANE ELIGIBILITY — markers already carried by every item, used to disqualify
// work before it is dispatched rather than paying an agent to discover it.
// ---------------------------------------------------------------------------

// The debugger lane asks "is this item's premise STILL TRUE?". That question only
// has meaning for a claim about current behaviour. A FEAT/TASK/CHORE/AMA is a want,
// not a claim — there is nothing to have decayed. Measured on the 2026-08-19 corpus
// this disqualifies 79 of 258 open items (FEAT 62, AMA 9, TASK 5, CHORE 2, OBS 1).
// Every lane that READS items from the graph or WRITES findings back must run on an
// agentType that carries BOTH transports: the `mcp__backlog__*` tools AND `Bash` (for
// the `backlog` CLI fallback). This is not a style preference — it is the direct fix
// for the failure that wasted the 19M-token run.
//
// Those lanes were on `product-manager`, whose tool grant is
//   Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, ..., mcp__backlog__*
// with NO Bash. So when the agent-mcp server was down, the lane had no second way to
// reach the graph: 82% of triage agents answered from the item data inlined in their
// own prompt, inventing 22 item IDs that do not exist and mis-tagging ~7% of repos.
// The TOOL_GATE added since then converts that silent fabrication into a loud
// `toolAccess:"none"` — which is strictly better, but it means a product-manager lane
// now ABORTS the whole run instead of fabricating. Either way the lane cannot work.
//
// `general-purpose` grants `*`, so both transports are guaranteed present. The lane's
// role is carried by its prompt (BACKLOG_MECHANICS + TOOL_GATE + the task text), not by
// the agent persona, so nothing is lost by moving off `product-manager`.
//
// If you change this, the lane must still satisfy: has Bash AND has mcp__backlog__*.
const GRAPH_AGENT = 'general-purpose'

const DEBUGGABLE_KINDS = new Set(['BUG', 'DEBT', 'INVESTIGATION', 'ENV', 'MIG', 'TEST'])
function needsDebugger(item) {
  return DEBUGGABLE_KINDS.has(String(item.kind || '').toUpperCase())
}

// The architect lane writes a spec for items that are REAL but UNDER-SPECIFIED.
// An item already attached to a plan is, by definition, already specified — the
// plan IS its spec. 24 of 258 open items carry a `plan`.
function needsArchitect(item) {
  return !item.plan
}

// ============================================================================
// shared prompt preamble — embedded in EVERY agent() prompt (prompts are
// self-contained; agents have none of this context unless it is inlined)
// ============================================================================
const TOOL_GATE = `
STEP 0 — TOOL SELF-CHECK. DO THIS BEFORE ANYTHING ELSE. NON-NEGOTIABLE.
Inspect your OWN available tools and confirm you can reach the backlog graph:
  (a) an mcp__backlog__* tool (e.g. backlog_get_item), OR
  (b) a Bash tool, through which the global \`backlog\` CLI is reachable.
Then PROVE it with one real call (backlog_get_item on one of your assigned ids, or
\`backlog get-item --repo <repo> --human-id <ID>\`).

If NEITHER path works, STOP IMMEDIATELY. Do not analyse. Do not infer. Do not answer
from anything written in this prompt. Return at once with:
    toolAccess = "none"
    toolAccessDetail = <the exact tools you could see, and what your probe returned>
and EMPTY result arrays. A run that aborts loudly is worth more than a run that
looks complete.

WHY THIS RULE EXISTS — this is not hypothetical. Run wf_28c6a91a-4c9 spent 19.3M
tokens and 191 of its 234 triage agents had no backlog tool at all. Instead of
stopping, they answered from data inlined in their prompt. They produced 22 backlog
ids that DO NOT EXIST — not random noise, but plausible pattern-completions:
FEAT-APIGEN-SERVE-CORE-001 (the family has -000 and -005..-009, never -001), NB-003
(the real item is NB-3), RISK-001 (the real item is RISK-SERVE-CORE-PLAN-001). They
also mis-tagged the repo on 7% of items. Every one of those outputs looked correct.
Confident fabrication is the failure mode this gate exists to prevent.

You MUST report toolAccess ("mcp" | "cli" | "none") and toolAccessDetail in your
result. It is a required field. Answering "mcp" without having made a successful
call is a false report.
`.trim()

const BACKLOG_MECHANICS = `
${TOOL_GATE}

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

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'path', 'detail'],
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string', enum: ['mcp', 'cli', 'none'] },
    detail: { type: 'string' },
  },
}

// The CLI's real flag shapes, discovered the hard way. The printed usage line shows
// camelCase field names (`humanId`) but the parser only accepts kebab-case flags
// (`--human-id`), and object arguments must go behind a NAMED flag — a bare
// positional JSON blob is rejected. Stating this here saves every agent from
// rediscovering it, and from concluding the CLI is unusable when it is not.
const CLI_CRIBSHEET = `
\`backlog\` CLI (global, on PATH) — the authoritative fallback when mcp__backlog__* is absent:
  backlog export-json --filter '{"status":"OPEN"}'     # NOT positional; --filter is required
  backlog list-items  --filter '{"repo":"adhd"}'       # there is no --grep; filter only
  backlog stats
  backlog get-item     --repo <repo> --human-id <ID>   # --human-id, NOT --humanId
  backlog append-note  --repo <repo> --human-id <ID> --by <who> --text <text>
  backlog set-priority --repo <repo> --human-id <ID> --priority <ENUM>
Gotchas that WILL bite you:
- filter.status takes a SCALAR string ("OPEN"), not an array (["OPEN"] fails validation).
- Flags are kebab-case even though the usage line prints camelCase field names.
- Output is JSON on stdout mixed with pino log lines on stderr — parse stdout only.
- The repo key is FORKED: items live under "adhd" OR "PseudoSky/adhd". Never guess
  which; if a write reports "did you mean repo X?", the item is in X.
`.trim()

const TOOL_PREFLIGHT_PROMPT = `Determine whether this session can actually reach the backlog graph. Do not groom anything; this is a capability check only.

1. Look at your OWN available tools. Is any mcp__backlog__* tool present (e.g. backlog_stats)?
   - If yes, CALL backlog_stats once. If it returns a count, answer path="mcp", ok=true.
2. If no mcp__backlog__* tool exists, or the call fails, try the CLI — but only if you have Bash:
   ${CLI_CRIBSHEET}
   Run \`backlog stats\`. If it returns JSON with a total/open count, answer path="cli", ok=true.
3. If NEITHER works — no mcp__backlog__* tools AND no Bash (or the CLI errors) — answer
   ok=false, path="none".

Be strictly honest. Do NOT answer ok=true because the tools "should" be there. A false
ok=true causes a 19M-token run to produce invented backlog items. In \`detail\`, state
exactly which tools you could see and what the call returned.`

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

// Every lane/triage agent MUST report how it reached the graph, which ids failed to
// resolve, and what it actually PERSISTED. These are required fields so a missing
// answer is a schema violation the model must fix, not a silent omission.
const ACCOUNTABILITY_PROPS = {
  toolAccess: { enum: ['mcp', 'cli', 'none'] },
  toolAccessDetail: { type: 'string' },
  unresolvedIds: {
    type: 'array',
    items: {
      type: 'object',
      required: ['humanId', 'error'],
      properties: { humanId: { type: 'string' }, repo: { type: 'string' }, error: { type: 'string' } },
    },
  },
  persistence: {
    type: 'array',
    items: {
      type: 'object',
      required: ['humanId', 'noteAppended', 'readBackConfirmed'],
      properties: {
        humanId: { type: 'string' }, repo: { type: 'string' },
        noteAppended: { type: 'boolean' }, readBackConfirmed: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
  },
}
const ACCOUNTABILITY_REQUIRED = ['toolAccess', 'toolAccessDetail', 'unresolvedIds', 'persistence']

const TRIAGE_CLUSTER_SCHEMA = {
  type: 'object',
  required: [...['clusterLabel', 'decisions'], ...ACCOUNTABILITY_REQUIRED],
  properties: {
    clusterLabel: { type: 'string' },
    decisions: { type: 'array', items: TRIAGE_DECISION },
    ...ACCOUNTABILITY_PROPS,
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
  required: [...['clusterLabel', 'lane', 'packets', 'handbacks'], ...ACCOUNTABILITY_REQUIRED],
  properties: {
    clusterLabel: { type: 'string' },
    lane: { enum: ['architect', 'devops'] },
    packets: { type: 'array', items: SPEC_PACKET },
    ...ACCOUNTABILITY_PROPS,
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
  required: [...['clusterLabel', 'verdicts', 'handbacks'], ...ACCOUNTABILITY_REQUIRED],
  properties: {
    clusterLabel: { type: 'string' },
    verdicts: { type: 'array', items: DEBUG_VERDICT },
    ...ACCOUNTABILITY_PROPS,
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
function inventoryPrompt(repo, accessPath) {
  return `You are performing a READ-ONLY backlog inventory pull for ONE repo. Do not write anything.

GRAPH ACCESS PATH for this run: ${accessPath === 'cli' ? 'CLI (mcp__backlog__* is NOT available this run — use the shell)' : 'mcp__backlog__* tools'}.
${accessPath === 'cli' ? CLI_CRIBSHEET : ''}
If your designated path stops working mid-task, STOP and say so in discrepancyNotes. Never
answer from memory or from data inlined in this prompt — an unreachable graph must surface
as a loud failure, not a plausible-looking item list.

TARGET REPO for this call: "${repo}" — use this EXACT string on every mcp__backlog__* call you make in this task. Do not touch any other repo value, including "sox-ecosystem" (a different repository, always out of scope) or the other fork.

${BACKLOG_MECHANICS}

${INVENTORY_METHOD}

Return the structured object: your unioned item list, backlog_stats.open for "${repo}", your own union count, and whether they reconcile.`
}

function targetedFetchPrompt(repo, ids, accessPath) {
  return `You are performing a READ-ONLY, TARGETED backlog fetch for ONE repo. Do not write anything.

TARGET REPO: "${repo}". Do not touch any other repo value.

GRAPH ACCESS PATH: ${accessPath === 'cli' ? 'CLI (mcp__backlog__* is NOT available — use the shell)' : 'mcp__backlog__* tools'}.
${accessPath === 'cli' ? CLI_CRIBSHEET : ''}

${TOOL_GATE}

Fetch EXACTLY these humanIds, and only from repo "${repo}":
${JSON.stringify(ids, null, 1)}

For each id, call backlog_get_item (or \`backlog get-item --repo "${repo}" --human-id <ID>\`).
- If it resolves in THIS repo, include it in items with its real humanId, kind, title, priority, status and tags as the graph returned them.
- If it does NOT exist in this repo, simply OMIT it. That is expected: the repo key is
  forked, so an id living in the other fork will legitimately miss here. Do not guess,
  do not substitute a similar id, and do not report a miss as an error.

Set openCountReported to the number you actually fetched, unionCount to the same, and
reconciled=true. This is a targeted pull, not a census — the usual reconcile-against-
backlog_stats rule does NOT apply.

Return the structured object.`
}

// ============================================================================
// phase 2 — product triage & flag (WRITE: priority + note ONLY)
// ============================================================================
function triagePrompt(clusterLabel, items) {
  return `You are the PRODUCT phase of a backlog-grooming run, working ONE cluster of related items. This is a WRITE-PERMITTED phase but ONLY for two specific calls: backlog_set_priority and backlog_append_note. You MUST NOT call backlog_resolve_item, backlog_transition_status, backlog_merge_items, backlog_split_item, backlog_soft_delete_item, backlog_claim_item, or any other mutating tool. ${DRY_RUN ? 'DRY RUN IS ON: compute what you WOULD write (priorityAfter, priorityChanged, note text) but DO NOT actually call the write tools; set noteAppended=false and readBackConfirmed=false and explain in clusterNotes what you would have done.' : ''}

${BACKLOG_MECHANICS}

CLUSTER "${clusterLabel}" — you are assigned EXACTLY these items, by ID ONLY:
${JSON.stringify(items.map((i) => ({ repo: i.repo, humanId: i.humanId })), null, 1)}

STEP 1 — FETCH. You are deliberately given NOTHING but repo+humanId. Titles, kinds,
bodies, priorities and tags are NOT in this prompt, by design. Call backlog_get_item
(or \`backlog get-item --repo <repo> --human-id <ID>\`) for EVERY id above and work
only from what the graph returns.

If an id does not resolve, that is a REAL FINDING, not an obstacle to route around:
record it in unresolvedIds with the exact error and EXCLUDE it from decisions. Never
substitute a similar-looking id, and never reconstruct an item from its id string —
an id is not evidence. (The previous run invented 22 items exactly that way.)

The repo values above are authoritative — they were resolved against the graph by the
orchestrator, not echoed by an agent. If a write reports "did you mean repo X?", stop
and record it; do not retry against a different repo on your own initiative.

FOR EACH ITEM YOU SUCCESSFULLY FETCHED, do the following:
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

function specLanePrompt(lane, clusterLabel, items, reservedFiles, consolidationReason) {
  const reserved = (reservedFiles || []).length
    ? `
CONSOLIDATED PACKET — WHY THESE ITEMS ARE TOGETHER:
These items were grouped because their FILE RESERVATIONS OVERLAP. Between them they
touch the following files, derived from their own citations and bodies:
${JSON.stringify(reservedFiles, null, 1)}

This is the whole point of the grouping: you are the ONLY architect who sees all of
these items, so you are the only one who can produce a spec for these files that is
internally consistent. Two architects speccing the same file independently is the
failure this consolidation exists to prevent.
- Where two items imply CONFLICTING edits to the same file, say so explicitly and
  resolve it in ONE spec — do not emit two packets that both rewrite the same lines.
- Where two items are really the same underlying defect seen from two angles, MERGE
  them into a single packet and name both humanIds.
- The list above is DERIVED, not authoritative. Verify against the real code and
  correct filesTouched if it is wrong or incomplete.
`
    : `
UNCONSOLIDATED PACKET: no file reservations could be derived from these items'
citations or bodies (reason=${consolidationReason || 'no-reservations'}), so they were
grouped by humanId family and may be unrelated. Establish what each one actually
touches BEFORE forming packets, and split them apart if they do not belong together.
`
  return `${LANE_ROLE[lane]}
${reserved}

You MUST NOT edit or commit any repository file, and you MUST NOT change any item's
status or priority (no resolve, no transition, no set_priority). Investigate with real
reads: open files, run \`git log\`/\`git diff\`/\`grep\`, check backlog_audit_trail/
backlog_blockers for the item's history.

FINAL STEP — PERSIST YOUR FINDINGS TO THE GRAPH. This is mandatory and it is the last
thing you do. For EVERY item you reached a conclusion about, call backlog_append_note
(or \`backlog append-note --repo <repo> --human-id <ID> --by <you> --text <text>\`)
with your finding and its evidence. Then READ IT BACK with backlog_get_item and confirm
the note is actually present. Record one entry per item in \`persistence\` with
noteAppended and readBackConfirmed set from what you OBSERVED, not what you intended.

Your structured return value is a RECEIPT, not the deliverable. The graph is the
deliverable. The previous run returned 19.3M tokens of good analysis purely in its
transcript, was killed before a separate write phase could run, and every finding had
to be manually excavated from a cache file afterwards. If your note is not in the
graph, your work does not exist. Persist as you go — do not batch it all to the very
end where a single interruption loses everything.

${BACKLOG_MECHANICS}

CLUSTER "${clusterLabel}" (lane=${lane}) — you are assigned EXACTLY these items, by ID ONLY:
${JSON.stringify(items.map((i) => ({ repo: i.repo, humanId: i.humanId, routeReason: i.routeReason })), null, 1)}

FETCH FIRST. Only repo+humanId (and why you were routed) are given. Call
backlog_get_item on EVERY id before analysing — title, body, citations, tags and
priority must come from the graph, never from this prompt. An id that does not
resolve goes in unresolvedIds with its exact error and is EXCLUDED from your output;
never substitute a similar id or reconstruct the item from its name.

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

// TOOL PREFLIGHT — run wf_28c6a91a-4c9 spent 19.3M tokens producing triage that was
// structurally worthless: 191 of 234 clusters (82%) reported that no mcp__backlog__*
// tool was in their toolset, because the MCP server was down. They could not fall
// back to the `backlog` CLI either — agentType 'product-manager' has no Bash — and
// this prompt never named the CLI as an alternative. The agents did the only thing
// left: they answered from the item payload inlined in the prompt, which is how 22
// nonexistent humanIds and 12 wrong repo tags entered the results.
//
// So: prove graph access BEFORE dispatching anything, and abort loudly if absent.
// The inventory agentType MUST be one that has Bash so the CLI is a genuine fallback.
const preflight = await agent(TOOL_PREFLIGHT_PROMPT, {
  label: 'preflight:graph-access', phase: 'Inventory', schema: PREFLIGHT_SCHEMA,
  agentType: 'qa-expert', effort: 'low', model: 'haiku',
}).catch((e) => ({ ok: false, path: 'none', detail: `preflight threw: ${e && e.message}` }))

if (!preflight || !preflight.ok) {
  const detail = preflight ? preflight.detail : '(no result)'
  log(`ABORT: no working path to the backlog graph (mcp__backlog__* absent AND \`backlog\` CLI unusable). ${detail}`)
  log('Refusing to run: every downstream phase would answer from prompt-inlined data and silently invent items.')
  return { aborted: true, reason: 'no-graph-access', detail }
}
log(`preflight OK: graph reachable via ${preflight.path} (${preflight.detail})`)

// When onlyIds pins the run to an explicit allowlist, a full partition-by-kind
// inventory of both repos is pure waste AND a failure point: the first smoke run
// pulled 83 of 258 items and simply did not happen to contain the target, so the
// allowlist matched nothing and the run aborted in a phase it was not testing.
// Fetch the named ids directly instead.
const invRaw = ONLY_IDS
  ? await parallel(REPOS.map((repo) => () => agent(targetedFetchPrompt(repo, [...ONLY_IDS], preflight.path), {
    label: `inventory:targeted:${repo}`, phase: 'Inventory', schema: INVENTORY_SCHEMA,
    agentType: 'qa-expert', effort: 'low', model: 'haiku',
  })))
  : await parallel(REPOS.map((repo) => () => agent(inventoryPrompt(repo, preflight.path), {
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

// A failed reconcile is not a warning to log past — it means the census is WRONG and
// every downstream count, the drift signal, and the re-groom verdict are computed
// against a partial corpus. Smoke run wf_f0095bef-1a1 pulled 83 items where the graph
// held 258 open, reported reconciled=false honestly, and the run carried on regardless.
// Unless the caller opts in via allowIncompleteInventory, halt.
const unreconciled = inventories.filter((inv) => !inv.reconciled)
for (const inv of unreconciled) {
  log(`INVENTORY RECONCILIATION MISMATCH for ${inv.repo}: reported open=${inv.openCountReported}, collected=${(inv.items || []).length}. ${inv.discrepancyNotes || '(no notes given)'}`)
}
if (unreconciled.length && !ONLY_IDS && !A.allowIncompleteInventory) {
  log('ABORT: inventory did not reconcile against backlog_stats. Grooming a partial corpus silently produces a confident, wrong report.')
  log('Re-run with allowIncompleteInventory:true to proceed anyway (every count will be a LOWER BOUND).')
  return {
    aborted: true,
    reason: 'inventory-unreconciled',
    repos: unreconciled.map((inv) => ({ repo: inv.repo, reported: inv.openCountReported, collected: (inv.items || []).length, notes: inv.discrepancyNotes })),
  }
}

const totalOpen = inventories.reduce((s, inv) => s + (inv.openCountReported || (inv.items || []).length), 0)
const fullItems = inventories.flatMap((inv) => (inv.items || []).map((it) => ({ ...it, repo: inv.repo })))
let scopedItems = fullItems.filter(passesScope)
if (MAX_ITEMS && scopedItems.length > MAX_ITEMS) {
  log(`SMOKE SCOPE: truncating ${scopedItems.length} scoped items to maxItems=${MAX_ITEMS}`)
  scopedItems = scopedItems.slice(0, MAX_ITEMS)
}

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
// PACK to MAX_TRIAGE_CLUSTER using family only as an affinity/sort key. The old
// code emitted one cluster per distinct family and then chunked, which on this
// corpus (long descriptive humanIds -> 85% singleton families) produced 234
// clusters for 354 items instead of 24.
const triageClusters = packByAffinity(scopedItems, MAX_TRIAGE_CLUSTER, (it) => `${it.repo}|${familyOf(it.humanId)}`)
  .map((chunk, i) => ({ clusterLabel: `T${i + 1}:${chunk[0].repo}|${familyOf(chunk[0].humanId)}`, items: chunk }))
log(`triage: ${scopedItems.length} items -> ${triageClusters.length} clusters (avg ${(scopedItems.length / Math.max(1, triageClusters.length)).toFixed(1)} items/cluster, cap ${MAX_TRIAGE_CLUSTER})`)

const triageRaw = await pipeline(triageClusters, (cluster) => agent(triagePrompt(cluster.clusterLabel, cluster.items), {
  label: `triage:${cluster.clusterLabel}`, phase: 'Triage & Flag', schema: TRIAGE_CLUSTER_SCHEMA,
  agentType: GRAPH_AGENT, effort: 'medium', model: 'haiku',
}))
const triageGate = rejectBlindResults(triageRaw.filter(Boolean), 'triage')
const triageResults = triageGate.kept
// Distinguish the three zero-result cases. Collapsing them reports the wrong cause:
// the first smoke run aborted as "all-triage-blind" with blindCount=0, when in fact
// no cluster had been dispatched at all because scoping matched nothing.
if (!triageClusters.length) {
  log('ABORT: scope matched no items — nothing to triage. Check onlyIds/priorities/kinds against the inventory.')
  return { aborted: true, reason: 'empty-scope', scopedItems: scopedItems.length, inventoryItems: fullItems.length }
}
if (!triageResults.length && triageGate.blindCount) {
  log('ABORT: every triage agent reported no graph access. Nothing downstream can be trusted.')
  return { aborted: true, reason: 'all-triage-blind', blindCount: triageGate.blindCount }
}
if (!triageResults.length) {
  log(`ABORT: ${triageClusters.length} triage cluster(s) dispatched but none returned a usable result (agents died).`)
  return { aborted: true, reason: 'no-triage-results', dispatched: triageClusters.length }
}
const triageUnresolved = collectUnresolved(triageResults)
if (triageUnresolved.length) {
  log(`FABRICATION TRIPWIRE: ${triageUnresolved.length} assigned id(s) did not resolve in the graph — excluded from routing.`)
  for (const u of triageUnresolved.slice(0, 8)) log(`   unresolved: ${u.repo || '?'}::${u.humanId} — ${String(u.error).slice(0, 120)}`)
}
auditPersistence(triageResults, 'triage')
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

// Index the full inventory rows by humanId so a lane packet can be built from the
// item's OWN data (citations, body) rather than the thin triage decision. File
// reservations are derived from that data — a decision object has no body to read.
const itemByKey = new Map(scopedItems.map((it) => [`${it.repo}||${it.humanId}`, it]))

// CONSOLIDATION — group by overlapping file reservations BEFORE the architect
// sees them, so one architect owns every item touching a given file and writes one
// coherent spec. Previously the architect lane clustered by humanId family, which
// is orthogonal to what the work touches: two items editing the same file landed
// with two different architects, who then produced independent (and potentially
// contradictory) specs for the same lines. Wave planning caught the file collision
// only afterwards, at scheduling time — far too late to merge the specs.
//
// The debugger lane is NOT consolidated this way: "is this premise still true?" is
// a per-item question with no cross-item coupling, so family affinity is fine there.
function buildLaneClusters(route) {
  const all = allDecisions.filter((d) => d.route === route)
  // Disqualify on markers the items ALREADY carry, before paying an agent to look.
  const decisions = all.filter((d) => {
    const item = itemByKey.get(`${d.repo}||${d.humanId}`)
    if (!item) return true // unknown to inventory: let the lane decide, don't silently drop
    if (route === 'debugger') return needsDebugger(item)
    return needsArchitect(item)
  })
  const dropped = all.length - decisions.length
  if (dropped) {
    log(`lane ${route}: ${dropped} of ${all.length} items disqualified by marker (` +
      (route === 'debugger' ? 'kind has no verifiable premise' : 'already attached to a plan') + `)`)
  }
  const enriched = decisions.map((d) => {
    const item = itemByKey.get(`${d.repo}||${d.humanId}`) || {}
    return {
      humanId: d.humanId, repo: d.repo, kind: d.kind, title: d.title,
      possiblyDecayed: d.possiblyDecayed, routeReason: d.routeReason,
      body: item.body, citations: item.citations, plan: item.plan, priority: item.priority,
    }
  })

  // The debugger lane IS consolidated by file too. Its verdicts do not conflict the
  // way specs do, but its COST is dominated by investigation: answering "is this
  // premise still true?" means opening the cited files and walking git history. Eight
  // items citing one file should read it once, not eight times. In the killed run this
  // was the most expensive lane by far — 1,385,579 output tokens and 3,138 tool calls
  // across 164 agents, ~19 tool calls to settle ~1.3 items. Co-locating same-file items
  // also lets one agent notice that several items share a root cause, or were closed by
  // the same commit — which is invisible when they are scattered across agents.
  if (route === 'debugger') {
    return consolidateByReservations(enriched, MAX_LANE_CLUSTER).map((pk, i) => ({
      clusterLabel: `D${i + 1}:${pk.reason}:${pk.items[0].repo}|${familyOf(pk.items[0].humanId)}`,
      items: pk.items,
      reservedFiles: pk.files,
      consolidationReason: pk.reason,
    }))
  }

  const prefix = route === 'devops' ? 'V' : 'A'
  return consolidateByReservations(enriched, MAX_LANE_CLUSTER).map((pk, i) => ({
    clusterLabel: `${prefix}${i + 1}:${pk.reason}:${pk.items[0].repo}|${familyOf(pk.items[0].humanId)}`,
    items: pk.items.map(({ body, citations, ...rest }) => rest),
    reservedFiles: pk.files,
    consolidationReason: pk.reason,
  }))
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
  () => pipeline(architectClusters, (cluster) => agent(specLanePrompt('architect', cluster.clusterLabel, cluster.items, cluster.reservedFiles, cluster.consolidationReason), {
    label: `arch:${cluster.clusterLabel}`, phase: 'Lanes', schema: LANE_SPEC_SCHEMA,
    agentType: 'architect-reviewer', effort: 'high', model: 'sonnet',
  })),
  () => pipeline(devopsClusters, (cluster) => agent(specLanePrompt('devops', cluster.clusterLabel, cluster.items, cluster.reservedFiles, cluster.consolidationReason), {
    label: `devops:${cluster.clusterLabel}`, phase: 'Lanes', schema: LANE_SPEC_SCHEMA,
    agentType: 'devops-engineer', effort: 'high', model: 'sonnet',
  })),
])

const debugResultsMain = rejectBlindResults((debugOutMain || []).filter(Boolean), 'debugger').kept
const architectResultsMain = rejectBlindResults((architectOutMain || []).filter(Boolean), 'architect').kept
const devopsResultsMain = rejectBlindResults((devopsOutMain || []).filter(Boolean), 'devops').kept
const laneUnresolved = collectUnresolved([...debugResultsMain, ...architectResultsMain, ...devopsResultsMain])
if (laneUnresolved.length) {
  log(`FABRICATION TRIPWIRE (lanes): ${laneUnresolved.length} assigned id(s) did not resolve — excluded.`)
}
auditPersistence(debugResultsMain, 'debugger')
auditPersistence(architectResultsMain, 'architect')
auditPersistence(devopsResultsMain, 'devops')
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
    return agent(specLanePrompt(job.route, job.clusterLabel, job.items, job.reservedFiles, job.consolidationReason), {
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
    agentType: GRAPH_AGENT, effort: 'medium', model: 'sonnet',
  })),
  () => pipeline(debugNoteGroups, (g) => agent(debugNoteWritePrompt(g.groupId, g.verdicts), {
    label: `debugnote:${g.groupId}`, phase: 'Acceptance Criteria', schema: DEBUG_NOTE_WRITE_SCHEMA,
    agentType: GRAPH_AGENT, effort: 'low', model: 'haiku',
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
