/**
 * remediation-pipeline.js — parameterized multi-agent backlog-remediation pipeline.
 *
 * Generalizes tmp/backlog-run/{wave0,wave1,wave1-resume,docs-pass}.js. Executes:
 *   S6  per-package  implement -> review -> fix -> review   (pipelined, not barriered)
 *   S10 docs         one steward per touched project, scoped to the incremental diff
 *
 * Companion procedure: ./SKILL.md. Read it first — this script is the mechanical
 * half; the decision rules (clustering, refutation, packing, wave admission, merge
 * ordering) live there and are deliberately NOT scripted (see "NOT GENERALIZED" at
 * the bottom of this header).
 *
 * ---------------------------------------------------------------------------
 * args
 * ---------------------------------------------------------------------------
 * REQUIRED
 *   repoRoot      string   absolute path to the repo root
 *   baselineRef   string   the run's branch-point SHA/ref. Used as --base for
 *                          affected-scoped gate commands and as the docs diff
 *                          baseline. Record it at `git worktree add` time.
 *   packages      array    one entry per implementation package (see shape below).
 *                          May be empty if you only want the docs phase.
 *
 * OPTIONAL — substrate
 *   worktreeTemplate  string  default '{repoRoot}/.worktrees/bl-{cluster}'
 *   branchTemplate    string  default 'bl/{cluster}'
 *   worktreeFor       object  explicit {cluster: absolutePath} overriding the template
 *   envLine           string  a shell line every agent sources first.
 *                             default 'export NX_CACHE_DIRECTORY={repoRoot}/tmp/backlog-run/.nx-shared-cache'
 *                             Pass '' to disable.
 *
 * OPTIONAL — verification
 *   gate          string[]  gate commands, one per line, with {project} and {base}
 *                           placeholders. Defaults to this repo's nx gate.
 *   testStandard  string    overrides the "tests have teeth" block
 *   extraRules    string    appended verbatim to the hard-rules block
 *
 * OPTIONAL — routing
 *   agentFor        object  discipline -> agent type.
 *                           default {typescript:'typescript-pro', devops:'devops-engineer',
 *                                    debug:'debugger', performance:'performance-engineer'}
 *   defaultAgent    string  default 'typescript-pro'
 *   reviewerAgent   string  default 'code-reviewer'
 *   stewardAgent    string  default 'sox-active:doc-steward'
 *   effort          string  default 'high'
 *
 * OPTIONAL — item store (set to '' to omit the instruction entirely)
 *   itemNoteHint  string  how an implementer appends a progress note to a tracked
 *                         item. default: the backlog MCP form used by the run.
 *
 * OPTIONAL — phases
 *   phases        string[]  subset of ['implement','docs']. default: both, but each
 *                           is skipped when its input array/object is empty.
 *   docs          object    {project: {files[], commits[], worktree?, branches?[],
 *                                      new?: bool, dir?: string}}
 *                           `new: true` marks a package that did not exist at
 *                           baseline (its project.json is absent there, so naive
 *                           file->project mapping misses it — see SKILL.md S10).
 *   lintHintDocs  string    doc-phase lint instruction; defaults to the affected form
 *                           this repo's PreToolUse hook requires.
 *
 * ---------------------------------------------------------------------------
 * packages[] entry shape (produced by the S3 architect stage)
 * ---------------------------------------------------------------------------
 *   gid                  string    GLOBALLY unique id, '<cluster>/<packageId>'  (guardrail G5)
 *   cluster              string    selects the worktree/branch
 *   packageId            string    label fragment
 *   title                string
 *   items                string[]  backlog ids this package closes
 *   discipline           string    routes to agentFor[]
 *   risk                 'low'|'medium'|'high'
 *   spec                 string    precise enough that the implementer makes no architectural choices
 *   acceptanceCriteria   string[]  consumer-visible, each provable by a runnable command,
 *                                  phrased WORKTREE-RELATIVE (guardrail G2)
 *   verificationCommands string[]  optional, suggested
 *   filesTouched         string[]  used by the reviewer for the scope check
 *   project              string    optional nx/build project name for {project} in the gate
 *   startAt              string    optional resume point: 'implement'(default)|'review'|'fix'|'review2'
 *   priorReport          object    required when startAt is 'review' or 'review2'
 *   priorReview          object    required when startAt is 'fix'
 *   extraReviewMandate   string    optional — prepended to the first review as a
 *                                  MANDATORY audit (e.g. a --no-verify bypass audit)
 *
 * ---------------------------------------------------------------------------
 * NOT GENERALIZED, on purpose
 * ---------------------------------------------------------------------------
 *   S0 inventory/cluster  — trivial and store-specific; a script adds nothing.
 *   S1 triage, S2 refute, S3 architect — one-shot fan-outs over a cluster list whose
 *      value is entirely in the prompt, not the control flow. Reproducing them here
 *      would freeze prompts that should be re-read from SKILL.md and adapted.
 *   S5 wave planning      — a judgment call over a collision matrix. Scripting it
 *      would hide the cross-cluster serialization decisions that must be reviewed
 *      by a human. Feed this script ONE wave at a time.
 *   S11 merge             — irreversible and order-sensitive; keep a human in it.
 */

export const meta = {
  name: 'backlog-remediation-pipeline',
  description: 'Parameterized backlog-remediation execution: per-package implement->review->fix->review, then a scoped doc-steward pass',
  phases: [
    { title: 'Implement', detail: 'discipline-routed implementer per package, in its cluster worktree' },
    { title: 'Review', detail: 'reviewer first pass — judges the diff, re-runs the gate' },
    { title: 'Fix', detail: 'implementer applies blocker/major findings (skipped when clean)' },
    { title: 'Review2', detail: 'final gate before merge' },
    { title: 'Docs', detail: 'one doc-steward per touched project, scoped to the incremental diff' },
  ],
}

// --------------------------------------------------------------------------
// args + defaults
// --------------------------------------------------------------------------
// Some hosts deliver `args` as a JSON-encoded STRING rather than a value.
// Accept both — a bare `A.repoRoot` on a string silently yields undefined and
// the run dies before spawning a single agent (observed 2026-08-07).
const RAW_ARGS = (typeof args !== 'undefined' && args) || {}
let A = RAW_ARGS
if (typeof RAW_ARGS === 'string') {
  try {
    A = JSON.parse(RAW_ARGS)
  } catch (e) {
    throw new Error(
      'remediation-pipeline: args arrived as a string and is not valid JSON: ' + e.message
    )
  }
}
if (typeof A !== 'object' || A === null || Array.isArray(A)) {
  throw new Error(
    'remediation-pipeline: args must be an object (or a JSON string encoding one), got ' +
      (Array.isArray(A) ? 'array' : typeof A)
  )
}

const ROOT = A.repoRoot
const BASE = A.baselineRef
if (!ROOT) throw new Error('remediation-pipeline: args.repoRoot is required')
if (!BASE) throw new Error('remediation-pipeline: args.baselineRef is required (the run branch-point SHA)')

const PKGS = A.packages || []
const DOCS = A.docs || {}
const PHASES = A.phases || ['implement', 'docs']

const fill = (tpl, vars) => Object.keys(vars).reduce((s, k) => s.split(`{${k}}`).join(vars[k]), tpl)

const WT_TPL = A.worktreeTemplate || '{repoRoot}/.worktrees/bl-{cluster}'
const BR_TPL = A.branchTemplate || 'bl/{cluster}'
const worktreeOf = (cluster) =>
  (A.worktreeFor && A.worktreeFor[cluster]) || fill(WT_TPL, { repoRoot: ROOT, cluster })
const branchOf = (cluster) => fill(BR_TPL, { repoRoot: ROOT, cluster })

const ENVLINE = A.envLine === '' ? '' : (A.envLine ||
  `export NX_CACHE_DIRECTORY=${ROOT}/tmp/backlog-run/.nx-shared-cache`)

const AGENT_FOR = A.agentFor || {
  typescript: 'typescript-pro', devops: 'devops-engineer',
  debug: 'debugger', performance: 'performance-engineer',
}
const DEFAULT_AGENT = A.defaultAgent || 'typescript-pro'
const REVIEWER = A.reviewerAgent || 'code-reviewer'
const STEWARD = A.stewardAgent || 'sox-active:doc-steward'
const EFFORT = A.effort || 'high'

const GATE = A.gate || [
  'npx nx lint {project}',
  'npx nx run {project}:sync-deps        # only if lint surfaced dependency drift; never hand-edit deps',
  'npx nx build {project}                # type-check via the real target',
  'npx nx affected -t test --base={base}               # NOT targeted `nx test`, unless you PROVE zero dependents',
  'npx nx affected -t verify-dist-load --base={base}   # prove the shipped artifact actually loads',
  'git status --porcelain                # confirm ONLY your intended files changed',
]
const gateFor = (p) =>
  GATE.map((c) => '  ' + fill(c, { project: p.project || '<project>', base: BASE })).join('\n')

const ITEM_NOTE_HINT = A.itemNoteHint === '' ? '' : (A.itemNoteHint ||
  'Append a note on each backlog item recording what you did (ToolSearch "select:mcp__backlog__backlog_append_note"). Do NOT resolve/close the items — a reviewer gates that.')

const DOC_LINT_HINT = A.lintHintDocs ||
  `npx nx affected -t lint --base=${BASE}\n(Direct \`nx lint <project>\` is intercepted by a repo PreToolUse hook that requires the affected/--base form.)`

// --------------------------------------------------------------------------
// shared prompt blocks — refined language carried over from wave1.js / docs-pass.js
// --------------------------------------------------------------------------
const RULES = `
HARD RULES:
- Work ONLY inside your assigned worktree. Never edit files in the main checkout or another cluster's worktree.
- BANNED: git stash, git reset --hard, git clean -f, git push, git add -A, git add ., git commit -a, --no-verify, chained rm, rm with a variable path.
- Commit with an explicit pathspec ONLY: git commit -- <path> [<path>...]  (the --only form; a shared git index means \`git add\` sweeps other agents' files into your commit).
- Conventional Commits with the library name as scope.
- NEVER invoke tsc directly — type-check via the project's own build target.
- NEVER pass --skip-nx-cache or set NX_SKIP_NX_CACHE. The cache is correct; trust it.
- pnpm only, never npm/yarn. Get human approval before installing any NEW external tool (do not install one; report instead).
- Never discard or revert changes you did not author. If you find unexpected edits, STOP and report.
- Never call a failure "pre-existing", "legacy", or "out of scope". If a test goes red after your edit, fixing it is your sole priority regardless of who introduced it.
- Verify the ambient git environment works in YOUR shell before trusting it (a stray GIT_DIR/GIT_WORK_TREE can silently redirect every git command). Re-run \`git status\` immediately before your first commit — unrelated work from another session may already be present; do not sweep it in.
- If the pre-commit hook misbehaves, STOP and report it. Do NOT bypass it.
- DO NOT STOP for anything you can resolve yourself. A wrong or stale spec, a missing but installable toolchain, a hard bug, a flaky test, an ambiguous acceptance criterion, a package that needs scaffolding first — all of these are YOURS to chase down: re-derive the right answer from the code and record what you decided in deviations[]. Only a genuine human-input block may be reported BLOCKED: a missing credential/secret, a product-scope call with no defensible default, approval to install a NEW external tool, or another session's in-flight work you would have to overwrite.
- Ephemeral/test artifacts write under tmp/ only. Tests must clean up after themselves.
- Every claim you make must cite a file:line you actually opened or a command whose real output you saw.
- Never dump a process environment into your transcript (use \`pgrep -l\`, never \`pgrep -fl\`).
${A.extraRules || ''}`

const TEST_STD = A.testStandard || `
TEST STANDARD — this is the bar, not a suggestion:
- Prove the CONSUMER-VISIBLE outcome through REAL components (real DB/queue/HTTP/built artifact). Mock only a paid external boundary (a real LLM/billed API).
- Assertions must have teeth: the test MUST fail if the bug is reintroduced. Prove it — run a negative control (revert the fix or introduce the wrong value), confirm it goes RED, then restore. Confirm the control actually executed its assertion step; a control that silently skips proves nothing.
- Deterministic without timing: latches/barriers/bounded deadlines, never sleep or wall-clock.
- Tests run BY DEFAULT, unflagged. The ONLY legitimate env-gate is a paid third-party service; needing a build, spawning a process, or being slow are NOT reasons to gate.
- Assert the outcome, not the implementation shape.
`

const gateBlock = (p) => `
VERIFICATION GATE — run from your worktree root before declaring done. Trust EXIT CODES, never a stdout grep:
${ENVLINE ? '  ' + ENVLINE + '\n' : ''}${gateFor(p)}
`

const acList = (p) => (p.acceptanceCriteria || []).map((c, i) => `  ${i + 1}. ${c}`).join('\n')
const header = (p) => {
  const wt = worktreeOf(p.cluster)
  return `Worktree: ${wt} (branch ${branchOf(p.cluster)}). cd there first${ENVLINE ? ` and run: ${ENVLINE}` : ''}. Do ALL work there.`
}

// --------------------------------------------------------------------------
// schemas
// --------------------------------------------------------------------------
const IMPL_SCHEMA = {
  type: 'object', required: ['gid', 'status', 'summary', 'filesChanged', 'commits', 'verification'],
  properties: {
    gid: { type: 'string' }, status: { enum: ['DONE', 'PARTIAL', 'BLOCKED', 'FAILED'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, exitCode: { type: 'number' }, result: { type: 'string' } } } },
    acceptanceEvidence: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, proof: { type: 'string' } } } },
    negativeControl: { type: 'string' },
    deviations: { type: 'string' }, blockers: { type: 'string' },
    newIssues: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', required: ['gid', 'verdict', 'findings'],
  properties: {
    gid: { type: 'string' }, verdict: { enum: ['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'] },
    findings: {
      type: 'array', items: {
        type: 'object', required: ['severity', 'summary', 'file'],
        properties: {
          severity: { enum: ['blocker', 'major', 'minor', 'nit'] }, summary: { type: 'string' },
          file: { type: 'string' }, line: { type: 'number' }, why: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
    acceptanceVerified: { type: 'boolean' }, testsHaveTeeth: { type: 'boolean' },
    scopeClean: { type: 'boolean' }, bypassAudit: { type: 'string' }, notes: { type: 'string' },
  },
}

const DOC_SCHEMA = {
  type: 'object', required: ['project', 'status', 'summary'],
  properties: {
    project: { type: 'string' }, status: { enum: ['UPDATED', 'NO_CHANGE_NEEDED', 'BLOCKED', 'FAILED'] },
    summary: { type: 'string' },
    filesWritten: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    claimsCorrected: { type: 'array', items: { type: 'string' }, description: 'doc claims that were WRONG and are now fixed' },
    gapsFound: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'string' }, blockers: { type: 'string' },
  },
}

// --------------------------------------------------------------------------
// stage prompt builders
// --------------------------------------------------------------------------
const needsFix = (rev) =>
  !rev || rev.verdict !== 'APPROVED' ||
  (rev.findings || []).some((f) => f.severity === 'blocker' || f.severity === 'major')

function implementPrompt(p) {
  return `Implement ONE package. ${header(p)}

PACKAGE: ${p.gid}
TITLE: ${p.title}
BACKLOG ITEMS: ${(p.items || []).join(', ')}
RISK: ${p.risk || 'unknown'}

SPEC (authoritative — implement exactly this; it was written by an architect who read the code):
${p.spec}

ACCEPTANCE CRITERIA (each must end up provable by a runnable command, run from the worktree root):
${acList(p)}
${p.verificationCommands ? `\nSUGGESTED VERIFICATION COMMANDS:\n${p.verificationCommands.map((c) => '  ' + c).join('\n')}\n` : ''}
EXPECTED FILES: ${(p.filesTouched || []).join(', ') || '(not enumerated)'}
(If the spec turns out to be wrong about the code, say so in deviations[] and do the right thing — do not silently follow a broken spec, and do not silently deviate either.)
${TEST_STD}${RULES}
${gateBlock(p)}
Then commit your work with pathspec-scoped commits. ${ITEM_NOTE_HINT}

Return the structured object, including acceptanceEvidence (criterion -> the command output proving it) and your negativeControl proof.`
}

function reviewPrompt(p, impl, isFinal) {
  const wt = worktreeOf(p.cluster)
  const mandate = (!isFinal && p.extraReviewMandate)
    ? `\n*** MANDATORY AUDIT — do this FIRST and record it in bypassAudit ***\n${p.extraReviewMandate}\nRe-run every gate command yourself and record each exit code. Do not accept the implementer's reported numbers as substitutes. Also verify the commits contain nothing beyond this package's declared scope (\`git log --stat ${BASE}..HEAD\`): any stray file, secret, scratch artifact, or swept-in foreign change is a blocker.\n`
    : ''

  return `${isFinal ? 'FINAL review gate' : 'Review ONE implementation'}. ${header(p)}

PACKAGE: ${p.gid} — ${p.title}
BACKLOG ITEMS: ${(p.items || []).join(', ')}
RISK: ${p.risk || 'unknown'}
${!isFinal ? `SPEC THE IMPLEMENTER WAS GIVEN:\n${p.spec}\n` : ''}
ACCEPTANCE CRITERIA:
${acList(p)}

${isFinal ? 'FIX-ROUND REPORT' : "IMPLEMENTER'S REPORT"}:
${JSON.stringify(impl, null, 1)}
${mandate}
Review the ACTUAL DIFF, not the report. Run: cd ${wt} && git log --oneline ${BASE}..HEAD && git diff ${BASE}...HEAD

Judge, and VERIFY don't trust:
1. Correctness — does it actually fix the cited defect${isFinal ? ', and is every previously-raised blocker/major genuinely resolved with no regression or scope creep' : ''}? Re-run the verification gate YOURSELF and cite YOUR exit codes; never a stdout grep.
2. Acceptance — is EVERY criterion met and proven by a real command, through the real consumer seam (built artifact / real components), not a proxy and not a mock of the thing under test?
3. Tests have teeth — would the test actually FAIL if the bug came back? Verify the implementer's negative control, or run your own, then restore. Confirm the control's assertion step actually executed; a control that silently skips is a blocker. A test that stays green on broken code proves nothing.
4. Scope — did anything outside ${(p.filesTouched || []).length ? 'the intended files (' + (p.filesTouched || []).join(', ') + ')' : 'the intended files'} change? Did a commit sweep in another agent's work (git show --stat)? Any git add -A evidence is a blocker. Verify claimed artifacts exist ON DISK — do not accept "built and proven" from a report.
5. Project rules — no direct tsc, no --skip-nx-cache, no --no-verify, no env-gated tests except a paid third-party service, import paths matching package.json exactly, dependency direction downward, correct platform isolation.
6. Quality — reuse over reinvention, no dead code, docs on new public functions, lint clean.

VERIFICATION GATE to re-run yourself:
${gateFor(p)}

Be specific and actionable: every finding names file:line and the fix. Do NOT edit code — you are the gate, not the author. Do NOT commit.
${isFinal ? 'This is the last gate before merge. APPROVE only if you would ship it. If not, list exactly what still blocks.' : ''}

Return the structured verdict.`
}

function fixPrompt(p, rev) {
  return `Apply code-review findings to YOUR package. ${header(p)}

PACKAGE: ${p.gid} — ${p.title}
BACKLOG ITEMS: ${(p.items || []).join(', ')}
ORIGINAL SPEC:
${p.spec}
ACCEPTANCE CRITERIA:
${acList(p)}

REVIEW VERDICT: ${rev.verdict}
FINDINGS:
${JSON.stringify(rev.findings, null, 1)}
${rev.bypassAudit ? `BYPASS AUDIT: ${rev.bypassAudit}\n` : ''}${rev.notes ? `REVIEWER NOTES: ${rev.notes}\n` : ''}
Fix every blocker and major finding. For each minor/nit, either fix it or justify in deviations[] why not. If you believe a finding is wrong, say so with evidence rather than silently ignoring it.
${TEST_STD}${RULES}
${gateBlock(p)}
Re-run the FULL verification gate after your fixes and commit with pathspec-scoped commits.
Return the structured object (same shape as the implementation report).`
}

function docPrompt(name, d) {
  const wt = d.worktree || worktreeOf((d.branches || [])[0])
  const branch = branchOf((d.branches || [])[0])
  const files = d.files || []
  return `Update the documentation for ONE package to match code changes that just landed. Worktree: ${wt} (branch ${branch}). Work ONLY there.

PACKAGE: ${name}${d.new ? '  *** BRAND NEW PACKAGE — it has no documentation history; this is its first doc pass ***' : ''}
${d.dir ? `PACKAGE DIR: ${d.dir}` : ''}

INCREMENTAL CHANGE SET — this is exactly what changed since the run began (baseline ${BASE}):
${files.map((f) => '  ' + f).join('\n')}

COMMITS touching those files:
${(d.commits || []).map((c) => '  ' + c).join('\n')}

See the real diff yourself:
  cd ${wt} && git diff ${BASE}..HEAD -- ${files.map((f) => `'${f}'`).join(' ')}

SCOPE — documentation for THIS package only:
- Its README.md (and any docs/ it owns). For a new package, author one.
- Its package.json description/keywords if they are now wrong.
- Docs/JSDoc on new or changed PUBLIC functions — add where missing on the changed surface.
- Any repo doc that makes a claim about this package which the diff has now falsified.
Do NOT document other packages. Do NOT rewrite docs unrelated to this change set. Ignore mechanical config/lockfile sweeps in the change set — document substantive behaviour only.

THE BAR — docs must be FACTUALLY TRUE, not aspirational:
- Every claim must resolve to something that actually ships. If you write that a command exists, RUN IT and paste real output. If you describe an API, read the actual export.
- If you find an EXISTING doc claim that is false (stale path, renamed symbol, command that no longer works, capability that was never built), FIX IT and list it in claimsCorrected — those are the highest-value finds. A prior run caught a README asserting a provably false claim; assume more exist.
- Do not invent capabilities, roadmap items, or performance numbers. Unknown means unknown.
- Code examples must be runnable as written against this package's real API.

VERIFY before declaring done, from the worktree root:
${ENVLINE ? '  ' + ENVLINE + '\n' : ''}  ${DOC_LINT_HINT}
Trust EXIT CODES, never stdout greps.

Then commit pathspec-scoped: git commit -m 'docs(${name}): ...' -- <the doc files you changed>
${RULES}
Never touch files outside this package (except a repo doc whose claim about THIS package you are correcting — say so in deviations).

If the change set genuinely requires no doc update, return NO_CHANGE_NEEDED with the reasoning — do not manufacture edits.

Return the structured object.`
}

// --------------------------------------------------------------------------
// S6 — per-package pipeline
// --------------------------------------------------------------------------
let chains = []

if (PHASES.includes('implement') && PKGS.length) {
  // guardrail G5: globally-unique ids
  const seen = new Set()
  for (const p of PKGS) {
    if (!p.gid) throw new Error(`remediation-pipeline: package "${p.packageId}" has no gid (must be '<cluster>/<packageId>')`)
    if (seen.has(p.gid)) throw new Error(`remediation-pipeline: duplicate gid "${p.gid}" — namespace package ids globally (guardrail G5)`)
    seen.add(p.gid)
  }

  const byGid = Object.fromEntries(PKGS.map((p) => [p.gid, p]))
  const gids = PKGS.map((p) => p.gid)

  phase('Implement')
  log(`remediation wave: ${gids.length} packages -> implement/review/fix/review (pipelined)`)

  const out = await parallel([
    () => pipeline(gids,
      // --- stage 1: implement (or pass through a prior report on resume)
      (gid) => {
        const p = byGid[gid]
        const at = p.startAt || 'implement'
        if (at !== 'implement') return p.priorReport || { gid, status: 'DONE', summary: `resumed at ${at}`, resumed: at }
        return agent(implementPrompt(p), {
          label: `impl:${p.packageId}`, phase: 'Implement', schema: IMPL_SCHEMA,
          agentType: AGENT_FOR[p.discipline] || DEFAULT_AGENT, effort: EFFORT,
        })
      },
      // --- stage 2: first review
      (impl, gid) => {
        const p = byGid[gid]
        if (!impl) return null
        if (p.startAt === 'fix' || p.startAt === 'review2') return p.priorReview || null
        return agent(reviewPrompt(p, impl, false), {
          label: `review:${p.packageId}`, phase: 'Review', schema: REVIEW_SCHEMA,
          agentType: REVIEWER, effort: EFFORT,
        })
      },
      // --- stage 3: fix (skipped when the first review is clean)
      (rev, gid) => {
        const p = byGid[gid]
        if (!rev) return null
        if (!needsFix(rev)) return { gid, skipped: 'approved-clean', review: rev }
        return agent(fixPrompt(p, rev), {
          label: `fix:${p.packageId}`, phase: 'Fix', schema: IMPL_SCHEMA,
          agentType: AGENT_FOR[p.discipline] || DEFAULT_AGENT, effort: EFFORT,
        })
      },
      // --- stage 4: final gate
      (fix, gid) => {
        const p = byGid[gid]
        if (!fix) return null
        if (fix.skipped) {
          return { ...fix.review, gid, firstPass: true, notes: `approved clean on first pass; no fix round needed. ${fix.review.notes || ''}` }
        }
        return agent(reviewPrompt(p, fix, true), {
          label: `review2:${p.packageId}`, phase: 'Review2', schema: REVIEW_SCHEMA,
          agentType: REVIEWER, effort: EFFORT,
        })
      },
    ),
  ])

  chains = (out[0] || []).filter(Boolean)
  const approved = chains.filter((r) => r && r.verdict === 'APPROVED')
  log(`wave done: ${approved.length}/${gids.length} APPROVED at final gate`)
  const notApproved = chains.filter((r) => r && r.verdict !== 'APPROVED').map((r) => r.gid)
  if (notApproved.length) log(`NOT approved (do not merge): ${notApproved.join(', ')}`)
  // guardrail G1: coverage reconciliation
  if (chains.length !== gids.length) {
    log(`COVERAGE WARNING (G1): ${gids.length} packages in, ${chains.length} verdicts out — reconcile before merging.`)
  }
}

// --------------------------------------------------------------------------
// S10 — doc steward pass
// --------------------------------------------------------------------------
let docResults = []

if (PHASES.includes('docs') && Object.keys(DOCS).length) {
  phase('Docs')
  const names = Object.keys(DOCS)
  log(`doc-steward over ${names.length} packages (${names.filter((n) => DOCS[n].new).length} brand new)`)

  const res = await parallel(names.map((name) => () => agent(docPrompt(name, DOCS[name]), {
    label: `docs:${name}`, phase: 'Docs', schema: DOC_SCHEMA,
    agentType: STEWARD, effort: EFFORT,
  })))

  docResults = res.filter(Boolean)
  log(`docs done: ${docResults.filter((r) => r.status === 'UPDATED').length} updated, ` +
      `${docResults.filter((r) => r.status === 'NO_CHANGE_NEEDED').length} no-change, ` +
      `${docResults.filter((r) => r.status === 'BLOCKED' || r.status === 'FAILED').length} blocked/failed`)
  const corrected = docResults.flatMap((r) => r.claimsCorrected || [])
  if (corrected.length) log(`false doc claims corrected (${corrected.length}): ${corrected.join(' | ')}`)
}

return { finalReviews: chains, docs: docResults }
