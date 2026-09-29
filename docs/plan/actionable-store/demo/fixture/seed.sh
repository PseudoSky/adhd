#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Actionable Store demo — deterministic fixture seed.
#
# Creates the small, fixed set of demo objects the DEMO.md beats need in an
# ISOLATED store under tmp/actionable-store-demo/, then writes
# tmp/actionable-store-demo/fixture.env (shell `export` lines) mapping every
# fixture NAME the beats reference to the uid it resolved to. Re-running this
# script is idempotent-by-reconstruction: it deletes and rebuilds the isolated
# store, so the demo always starts from the same object graph. The real
# production store is never opened or touched.
#
# Usage (from the repo root):
#   bash docs/plan/actionable-store/demo/fixture/seed.sh
#   . tmp/actionable-store-demo/fixture.env
#
# Why isolated + seeded rather than the live production store: the production
# store is mutable; its demo items drift (the "blocked" item gets unblocked,
# close-targets get closed by other agents). A fixture built fresh each run
# makes every beat's preconditions hold identically every time.
#
# Why uids are NOT hardcoded: the shipped write API mints uids with
# crypto.randomUUID() and exposes no uid override, so the seed captures the
# uids it mints and the beats read them from fixture.env. Only object GRAPH
# shape (titles, kinds, statuses, relations, obligations, spec revisions) is
# fixed; the uid strings vary per run by design.
# ---------------------------------------------------------------------------
set -euo pipefail

# The node binary to use. Callers may pin an absolute path via NODE_BIN (the
# acceptance runner passes its own process.execPath) so a flaky PATH symlink
# cannot break a run; a human just gets whatever `node` resolves to.
NODE_BIN="${NODE_BIN:-node}"

# Resolve the repo root from this script's location (…/docs/plan/actionable-store/demo/fixture).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"

DEMO_DIR="$REPO_ROOT/tmp/actionable-store-demo"
export ADHD_BACKLOG_DATABASE_PATH="$DEMO_DIR/demo.db"
export ADHD_BACKLOG_EMBEDDING_ENABLED=false
export ADHD_BACKLOG_LOG_LEVEL=error

BIN="$REPO_ROOT/entrypoint/backlog/dist/index.js"
if [[ ! -f "$BIN" ]]; then
  echo "seed: built binary missing at $BIN — run 'npx nx build backlog' first" >&2
  exit 1
fi

rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

bl() { "$NODE_BIN" "$BIN" "$@"; }

# One create, forced past the dedupe scan, printing the new uid. `kind`
# defaults to FEAT; beat 1.4 seeds a distinct kind so its order-tiebreak
# candidate set is exactly its own nodes.
new_issue() {
  local title="$1" body="$2" priority="${3:-HIGH}" kind="${4:-FEAT}"
  bl backlog create --input "$(printf '{"title":%s,"body":%s,"project":"adhd","component":"entrypoint/backlog","kind":"%s","status":"open","priority":"%s","by":"operator:otto-1","duplicateAction":"force"}' \
    "$(printf '%s' "$title" | jq -Rs .)" "$(printf '%s' "$body" | jq -Rs .)" "$kind" "$priority")" \
    | jq -r .data.uid
}

uid_of() { jq -r .data.uid; }

# bare sha256 hex (64 chars) of a file — EXACTLY the form `checkAnchor`'s
# full-resolve rung compares against (no `sha256:` prefix).
sha256_file() {
  "$NODE_BIN" -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"
}
# bare sha256 hex of stdin (byte-exact, matching checkAnchor's utf8 update).
sha256_stdin() {
  "$NODE_BIN" -e 'const c=require("crypto");process.stdout.write(c.createHash("sha256").update(require("fs").readFileSync(0)).digest("hex"))'
}

# ---- Registry -------------------------------------------------------------
bl backlog upsert-project --input "{\"name\":\"adhd\",\"path\":\"$REPO_ROOT\",\"repoUrl\":\"https://github.com/PseudoSky/adhd\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog upsert-component --input '{"project":"adhd","name":"entrypoint/backlog","path":"entrypoint/backlog","by":"operator:otto-1"}' >/dev/null

# ---- Sibling repo (cross-repo + content-address beats 2.4 / 2.5) ----------
# A SECOND registered project root — a real git work tree under the demo dir —
# so a citation into it must resolve against ITS root, never this repo's HEAD.
# `evidence.txt` stays untouched (beat 2.4: verified via changed_since);
# `digest.txt` is committed once here and once MORE, dated after this run's
# attestations, so beat 2.5's recheck reaches the full-resolve rung.
SIBLING_DIR="$DEMO_DIR/sibling-repo"
mkdir -p "$SIBLING_DIR"
git -C "$SIBLING_DIR" init -q
git -C "$SIBLING_DIR" config user.email demo@example.com
git -C "$SIBLING_DIR" config user.name "actionable-store demo"
git -C "$SIBLING_DIR" config commit.gpgsign false
printf 'sibling evidence v1\n' > "$SIBLING_DIR/evidence.txt"
printf 'digest v1\n' > "$SIBLING_DIR/digest.txt"
git -C "$SIBLING_DIR" add evidence.txt digest.txt
GIT_AUTHOR_DATE=2020-01-01T00:00:00Z GIT_COMMITTER_DATE=2020-01-01T00:00:00Z git -C "$SIBLING_DIR" commit -qm 'sibling repo v1'
bl backlog upsert-project --input "{\"name\":\"sibling-demo\",\"path\":\"$SIBLING_DIR\",\"by\":\"operator:otto-1\"}" >/dev/null

# ---- Issues ---------------------------------------------------------------
C5=$(new_issue "C5 — Closure gate: terminal transitions require satisfied obligations and verified evidence" "A terminal transition is refused until its declared proof exists." HIGH)
C6=$(new_issue "C6 — Verdict: derived actionability with reasons; claim refuses live blockers" "Actionability is derived at read, never stored." MEDIUM)
RESEARCH=$(new_issue "Rex — similarity scan is project-scoped" "Research ticket for the evidence-attachment beat." MEDIUM)
CROSSREPO=$(new_issue "Cross-repo citation" "An item whose citation points into a sibling repository." MEDIUM)
PLAN=$(new_issue "Umbrella plan" "The plan Dee must advance." HIGH)
BLOCKER=$(new_issue "The blocker" "What blocks the plan and the blocked work." HIGH)
BLOCKED=$(new_issue "Blocked work" "An item a dispatcher once took while it was blocked." HIGH)
COMMITREF=$(new_issue "Commit-ref closure" "The item that was closed on a merge ref." HIGH)
C3=$(new_issue "C3 — Attestation: anchored, verifiable evidence that never churns identity" "Evidence attaches without rewriting the subject." HIGH)
CHILD1=$(new_issue "Plan child one" "A member of the umbrella plan." LOW)
CHILD2=$(new_issue "Plan child two" "Another member of the umbrella plan." LOW)
CYCLE_A=$(new_issue "Cycle A" "Cycle member." LOW)
CYCLE_B=$(new_issue "Cycle B" "Cycle member." LOW)
CLAIM_1=$(new_issue "Parallel claim one" "Free to claim." MEDIUM)
CLAIM_2=$(new_issue "Parallel claim two" "Free to claim." MEDIUM)

# ---- C2 AC4 order-tiebreak fixture (beat 1.4) -----------------------------
# A distinct kind (`SPIKE`) bounds beat 1.4's candidate set to exactly these
# nodes. X and Y have EQUAL in-degree (0) but X has two transitive dependents
# (D1→D2) and Y has one (D3) — the dependent-weight key must put X first. The
# beat then gives Y three dependents (D4→D5) and asserts the order flips.
AC2_X=$(new_issue "C2 tiebreak X" "equal in-degree; more transitive dependents" MEDIUM SPIKE)
AC2_Y=$(new_issue "C2 tiebreak Y" "equal in-degree; fewer transitive dependents" MEDIUM SPIKE)
AC2_D1=$(new_issue "C2 tiebreak D1" "dependent of X" MEDIUM SPIKE)
AC2_D2=$(new_issue "C2 tiebreak D2" "transitive dependent of X" MEDIUM SPIKE)
AC2_D3=$(new_issue "C2 tiebreak D3" "dependent of Y" MEDIUM SPIKE)
AC2_D4=$(new_issue "C2 tiebreak D4" "flip dependent of Y" MEDIUM SPIKE)
AC2_D5=$(new_issue "C2 tiebreak D5" "transitive flip dependent of Y" MEDIUM SPIKE)

# ---- Relations ------------------------------------------------------------
bl backlog relate --input "{\"sourceUid\":\"$BLOCKER\",\"targetUid\":\"$PLAN\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog relate --input "{\"sourceUid\":\"$BLOCKER\",\"targetUid\":\"$BLOCKED\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog relate --input "{\"sourceUid\":\"$CHILD1\",\"targetUid\":\"$PLAN\",\"rel\":\"part_of\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog relate --input "{\"sourceUid\":\"$CHILD2\",\"targetUid\":\"$PLAN\",\"rel\":\"part_of\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog relate --input "{\"sourceUid\":\"$AC2_X\",\"targetUid\":\"$AC2_D1\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog relate --input "{\"sourceUid\":\"$AC2_D1\",\"targetUid\":\"$AC2_D2\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null
bl backlog relate --input "{\"sourceUid\":\"$AC2_Y\",\"targetUid\":\"$AC2_D3\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}" >/dev/null

# ---- Revision shaping -----------------------------------------------------
# C3 must read revision 1 for the in-flight-finding beat (one in-place edit).
bl backlog update --input "{\"uid\":\"$C3\",\"by\":\"operator:otto-1\",\"priority\":\"CRITICAL\"}" >/dev/null
# COMMITREF must read revision 2 for the closure beat (two in-place edits).
bl backlog update --input "{\"uid\":\"$COMMITREF\",\"by\":\"operator:otto-1\",\"priority\":\"LOW\"}" >/dev/null
bl backlog update --input "{\"uid\":\"$COMMITREF\",\"by\":\"operator:otto-1\",\"priority\":\"HIGH\"}" >/dev/null

# ---- C10 base spec revision on C5 (the append beat's `base_revision`) ------
SPEC0="$(bl backlog spec-append --input "{\"uid\":\"$C5\",\"fragment\":\"## DoR\n- one\",\"anchor\":{\"locator\":\"path:docs/product/feature-research/actionable-store/specs/C5-closure-gate.spec.md\",\"digest\":\"sha256:base\"},\"base_revision\":\"\",\"by\":\"architect:axl-1\"}")"
C5_REV0="$(printf '%s' "$SPEC0" | jq -r .data.spec_revision)"
C5_TOK0="$(printf '%s' "$SPEC0" | jq -r .data.spec_revision_token)"

# ---- Cross-repo + content-address attestations (beats 2.4 / 2.5) -----------
# REAL digests (bare sha256 hex — what `checkAnchor`'s full-resolve compares):
#   CROSS_ATT   → evidence.txt (unchanged)   → recheck verified/changed_since
#   DIGEST_GOOD → digest.txt, digest = v2    → recheck verified/full_resolve
#   DIGEST_BAD  → digest.txt, digest = v1    → recheck stale/full_resolve
# Both digest attestations are recorded BEFORE the v2 commit below, so the
# recheck's changed-since rung fires and hands off to the full re-resolve.
CROSS_ANCHOR="path:$SIBLING_DIR/evidence.txt"
EVID_DIGEST="$(sha256_file "$SIBLING_DIR/evidence.txt")"
GOOD_DIGEST="$(printf 'digest v2\n' | sha256_stdin)"
BAD_DIGEST="$(sha256_file "$SIBLING_DIR/digest.txt")"
CROSS_ATT="$(bl backlog attest --input "{\"subject\":{\"id\":\"$CROSSREPO\",\"revision\":0},\"claim\":{\"kind\":\"source-reading\",\"body\":\"citation resolves in a sibling repo\"},\"anchor\":{\"locator\":\"$CROSS_ANCHOR\",\"digest\":\"$EVID_DIGEST\"},\"by\":\"researcher:rex-1\"}" | jq -r .data.attestationUid)"
DIGEST_ANCHOR="path:$SIBLING_DIR/digest.txt"
DIGEST_GOOD="$(bl backlog attest --input "{\"subject\":{\"id\":\"$CROSSREPO\",\"revision\":0},\"claim\":{\"kind\":\"source-reading\",\"body\":\"artifact hash\"},\"anchor\":{\"locator\":\"$DIGEST_ANCHOR\",\"digest\":\"$GOOD_DIGEST\"},\"by\":\"researcher:rex-1\"}" | jq -r .data.attestationUid)"
DIGEST_BAD="$(bl backlog attest --input "{\"subject\":{\"id\":\"$CROSSREPO\",\"revision\":0},\"claim\":{\"kind\":\"source-reading\",\"body\":\"stale hash\"},\"anchor\":{\"locator\":\"$DIGEST_ANCHOR\",\"digest\":\"$BAD_DIGEST\"},\"by\":\"researcher:rex-1\"}" | jq -r .data.attestationUid)"
# The change AFTER filing: digest.txt moves to exactly the GOOD content, dated
# in the FUTURE so `git log --since=<filed-now>` sees it deterministically.
printf 'digest v2\n' > "$SIBLING_DIR/digest.txt"
git -C "$SIBLING_DIR" add digest.txt
GIT_AUTHOR_DATE=2030-01-01T00:00:00Z GIT_COMMITTER_DATE=2030-01-01T00:00:00Z git -C "$SIBLING_DIR" commit -qm 'digest v2 (after filing)'

# ---- Act-4 closure item's obligation --------------------------------------
bl backlog obligate --input "{\"uid\":\"$COMMITREF\",\"applies_to\":{\"to\":\"closed\"},\"requirement\":{\"op\":\"evidence\",\"kind\":\"published-artifact\",\"min\":1},\"on_fail\":\"block\",\"by\":\"architect:axl-1\"}" >/dev/null

# ---- Emit the fixture manifest --------------------------------------------
{
  echo "# Generated by seed.sh — fixture NAME -> uid for the current isolated store."
  echo "export ADHD_BACKLOG_DATABASE_PATH=\"$ADHD_BACKLOG_DATABASE_PATH\""
  echo "export ADHD_BACKLOG_EMBEDDING_ENABLED=false"
  for pair in \
    "C5=$C5" "C6=$C6" "RESEARCH=$RESEARCH" "CROSSREPO=$CROSSREPO" \
    "PLAN=$PLAN" "BLOCKER=$BLOCKER" "BLOCKED=$BLOCKED" "COMMITREF=$COMMITREF" \
    "C3=$C3" "CHILD1=$CHILD1" "CHILD2=$CHILD2" \
    "CYCLE_A=$CYCLE_A" "CYCLE_B=$CYCLE_B" "CLAIM_1=$CLAIM_1" "CLAIM_2=$CLAIM_2" \
    "AC2_X=$AC2_X" "AC2_Y=$AC2_Y" "AC2_D4=$AC2_D4" "AC2_D5=$AC2_D5" \
    "C5_REV0=$C5_REV0" "C5_TOK0=$C5_TOK0" "CROSS_ATT=$CROSS_ATT" \
    "CROSS_ANCHOR=$CROSS_ANCHOR" "DIGEST_GOOD=$DIGEST_GOOD" "DIGEST_BAD=$DIGEST_BAD"; do
    echo "export ${pair}"
  done
} > "$DEMO_DIR/fixture.env"

echo "seed: isolated store at $ADHD_BACKLOG_DATABASE_PATH"
echo "seed: fixture names written to $DEMO_DIR/fixture.env"
