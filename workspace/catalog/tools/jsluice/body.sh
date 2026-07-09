#!/usr/bin/env bash
# HARN-030 — jsluice harness wrapper
# AST-based URL and secret extraction from JavaScript bundles.
# Takes a bundle file path (not host) — the recon module provides JS files.
set -uo pipefail

HARNESS_REF="HARN-030"
ARGS="${1:?usage: $0 <args.json>}"
[ -r "$ARGS" ] || { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 2; }

# Read runtime params
BUNDLE_PATH="$(jq -r '.bundle_path // empty' "$ARGS")"
OUT_DIR="$(jq -r '.output // "/tmp"' "$ARGS")"
[ -z "$BUNDLE_PATH" ] && { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 3; }
[ -r "$BUNDLE_PATH" ] || { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 4; }

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/$HARNESS_REF.json"

# Check tool availability
JSLUICE_BIN="${JSLUICE_BIN:-jsluice}"
if ! command -v "$JSLUICE_BIN" &>/dev/null; then
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":[],"secrets":[],"urls_raw":[],"files_analyzed":1,"error":"jsluice not found on PATH"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit 1
fi

# Run jsluice urls — outputs one URL per line
URLS_RAW="$("$JSLUICE_BIN" urls "$BUNDLE_PATH" 2>/dev/null)" || {
  rc=$?
  if [ -z "$URLS_RAW" ]; then
    cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":[],"secrets":[],"urls_raw":[],"files_analyzed":1,"error":"jsluice urls exited with code $rc"}}
EOM
    echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
    exit "$rc"
  fi
}

# Run jsluice secrets — outputs JSON array
SECRETS_RAW="$("$JSLUICE_BIN" secrets "$BUNDLE_PATH" 2>/dev/null)" || {
  rc=$?
  if [ -z "$SECRETS_RAW" ]; then
    SECRETS_RAW="[]"
  else
    cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":[],"secrets":[],"urls_raw":[],"files_analyzed":1,"error":"jsluice secrets exited with code $rc"}}
EOM
    echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
    exit "$rc"
  fi
}

# Parse URLs: each line is a URL, convert to endpoints
ENDPOINTS="$(
  echo "$URLS_RAW" \
    | grep -v '^\s*$' \
    | jq -Rsc '
      split("\n") | map(select(length > 0)) | map({
        path: .,
        method: "GET",
        source: "jsluice"
      })
    ' 2>/dev/null
)"
URLS_RAW_ARR="$(echo "$URLS_RAW" | grep -v '^\s*$' | jq -Rsc 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')"

# Parse secrets JSON from jsluice
# jsluice secrets output format: [{"kind":"aws-secret-key","data":{"value":"AKIA...","line":10}},...]
SECRETS="$(
  echo "$SECRETS_RAW" \
    | jq -c '
      [.[] | {
        type: (.kind // .type // "unknown"),
        value_redacted: (if (.data.value // .value // "") != "" then ((.data.value // .value)[:4] + "****" + (.data.value // .value)[-4:]) else "redacted" end),
        file: "'"$BUNDLE_PATH"'",
        confidence: "firm"
      }]
    ' 2>/dev/null
)"
FILES_ANALYZED=1

# Build and write output envelope
cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"done","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":$ENDPOINTS,"secrets":$SECRETS,"urls_raw":$URLS_RAW_ARR,"files_analyzed":$FILES_ANALYZED}}
EOM

echo "HARNESS_RESULT: status=pass script=$HARNESS_REF output=$OUT_FILE"
exit 0
