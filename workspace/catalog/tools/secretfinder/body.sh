#!/usr/bin/env bash
# HARN-031 — SecretFinder harness wrapper
# Regex-based secret detection (API keys, tokens, credentials) in JavaScript bundles.
# Takes a bundle file path and runs python3 SecretFinder.py against it.
set -uo pipefail

HARNESS_REF="HARN-031"
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
SECRETFINDER_BIN="${SECRETFINDER_BIN:-SecretFinder.py}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" &>/dev/null; then
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"secrets":[],"files_analyzed":1,"error":"python3 not found on PATH"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit 1
fi

if ! command -v "$SECRETFINDER_BIN" &>/dev/null && ! "$PYTHON_BIN" -c "import SecretFinder" 2>/dev/null; then
  # Try common installation paths
  SF_SCRIPT=""
  for candidate in \
    "/usr/local/bin/SecretFinder.py" \
    "/opt/homebrew/bin/SecretFinder.py" \
    "$(dirname "$(which "$PYTHON_BIN" 2>/dev/null)")/SecretFinder.py" \
    "$(pip3 show SecretFinder 2>/dev/null | grep Location | head -1 | awk '{print $2}')/SecretFinder.py"; do
    if [ -r "$candidate" ]; then
      SF_SCRIPT="$candidate"
      break
    fi
  done

  if [ -z "$SF_SCRIPT" ]; then
    cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"secrets":[],"files_analyzed":1,"error":"SecretFinder.py not found on PATH or installed as a module"}}
EOM
    echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
    exit 1
  fi
  SECRETFINDER_BIN="$SF_SCRIPT"
fi

# Determine how to invoke SecretFinder
if [ -x "$SECRETFINDER_BIN" ] || echo "$SECRETFINDER_BIN" | grep -q '\.py$'; then
  SF_CMD=("$PYTHON_BIN" "$SECRETFINDER_BIN")
else
  # Assume pip-installed CLI entry point
  SF_CMD=("$SECRETFINDER_BIN")
fi

# Run SecretFinder with JSON output
RAW_JSON="$("${SF_CMD[@]}" -i "$BUNDLE_PATH" -o json 2>/dev/null)" || {
  rc=$?
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"secrets":[],"files_analyzed":1,"error":"SecretFinder exited with code $rc"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit "$rc"
}

# Parse SecretFinder JSON output
# SecretFinder -o json produces: [{"type":"aws_key","value":"AKIA...","line":10},...]
SECRETS="$(
  echo "$RAW_JSON" \
    | jq -c '
      [.[] | {
        type: (.type // "unknown"),
        value_redacted: (if (.value // "") != "" then (.value[:4] + "****" + .value[-4:]) else "redacted" end),
        file: "'"$BUNDLE_PATH"'",
        confidence: "possible"
      }]
    ' 2>/dev/null
)"
FILES_ANALYZED=1

# Write output envelope
cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"done","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"secrets":$SECRETS,"files_analyzed":$FILES_ANALYZED}}
EOM

echo "HARNESS_RESULT: status=pass script=$HARNESS_REF output=$OUT_FILE"
exit 0
