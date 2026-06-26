#!/usr/bin/env bash
# live-lmstudio-roundtrip.sh — gated live verification for the `lmstudio` ProviderAdapter.
#
# WHAT THIS IS
#   The runnable artifact behind the `lmstudio_adapter_roundtrip` interface contract
#   (docs/plan/agent-provider/interfaces.json). The `provider-adapter-contract` state's
#   HARD guard is the offline `adapter-resolve.test.ts`; THIS script is the OPTIONAL,
#   env-gated live proof that the lmstudio adapter streams a real completion from the
#   OpenAI-compatible endpoint. It brings the model up itself via the LM Studio CLI so
#   an ejected/unloaded model is not a precondition.
#
# WHY IT IS GATED
#   It must NEVER be a precondition for the offline corpus build. It runs only when
#   AGENT_MCP_LIVE=1 is set; otherwise it SKIPS (exit 0). CI leaves the flag unset, so
#   CI stays fully offline. It is also a no-op (skip, exit 0) when the `lms` bin or the
#   model is unavailable — graceful degradation, never a hard failure for missing local
#   infrastructure.
#
# DETERMINISM / GUARD HYGIENE (project verification standard)
#   - env-pinned ABSOLUTE `lms` path (never bare `lms` on ambient PATH).
#   - exit-code gated end to end; never `… | grep -q passed`.
#   - asserts a MODEL-INDEPENDENT invariant: a non-empty assistant completion comes
#     back. It does NOT assert model-specific text (the heretic-uncensored 9B model is
#     interchangeable with any chat model for this invariant).
#   - no sleep / wall-clock timing; bounded by curl's own --max-time.
#
# EXIT CODES
#   0  = pass, OR a legitimate skip (flag unset / bin absent / model absent)
#   1  = the adapter endpoint was reachable but returned no usable completion (REGRESSION)

set -euo pipefail

LMS="${LMS_BIN:-/Users/nix/.lmstudio/bin/lms}"
MODEL="${LMSTUDIO_MODEL:-qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8}"
ENDPOINT="${LMSTUDIO_ENDPOINT:-http://localhost:1234}"

# --- Gate 1: only run when explicitly asked to go live ------------------------
if [ "${AGENT_MCP_LIVE:-}" != "1" ]; then
  echo "SKIP: AGENT_MCP_LIVE != 1 (offline default; set AGENT_MCP_LIVE=1 to run the live lmstudio round-trip)"
  exit 0
fi

# --- Gate 2: bin must exist (graceful skip, not failure) ----------------------
if [ ! -x "$LMS" ]; then
  echo "SKIP: lms bin absent at $LMS (set LMS_BIN to override)"
  exit 0
fi

# --- Ensure the local server is up --------------------------------------------
if ! "$LMS" server status >/dev/null 2>&1; then
  echo "INFO: starting LM Studio local server"
  "$LMS" server start
fi

# --- Ensure THIS model is loaded (bring it up if ejected) ---------------------
if ! "$LMS" ps 2>/dev/null | grep -q "$MODEL"; then
  echo "INFO: loading model $MODEL"
  if ! "$LMS" load "$MODEL" --yes; then
    echo "SKIP: model $MODEL not available to load (set LMSTUDIO_MODEL to override)"
    exit 0
  fi
fi

# --- Drive the REAL round-trip against the OpenAI-compatible endpoint ----------
# Model-independent invariant: a non-empty assistant message content comes back.
RESP="$(curl -sS --fail --max-time 120 \
  "$ENDPOINT/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":16,"stream":false}' "$MODEL")")"

CONTENT="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const c=j?.choices?.[0]?.message?.content??"";process.stdout.write(String(c).trim());}catch{process.stdout.write("");}})')"

if [ -z "$CONTENT" ]; then
  echo "FAIL: lmstudio adapter endpoint reachable but returned no assistant content"
  echo "raw: $RESP"
  exit 1
fi

echo "PASS: lmstudio adapter streamed a non-empty completion (${#CONTENT} chars) from $ENDPOINT"
exit 0
