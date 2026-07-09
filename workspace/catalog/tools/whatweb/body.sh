#!/usr/bin/env bash
# HARN-027 — whatweb harness wrapper
# Runs WhatWeb against a target host and returns normalized technology fingerprints.
set -uo pipefail

HARNESS_REF="HARN-027"
ARGS="${1:?usage: $0 <args.json>}"
[ -r "$ARGS" ] || { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 2; }

# Read runtime params
HOST="$(jq -r '.host // empty' "$ARGS")"
OUT_DIR="$(jq -r '.output // "/tmp" ' "$ARGS")"
[ -z "$HOST" ] && { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 3; }

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/$HARNESS_REF.json"

# Check tool availability
WHATWEB_BIN="${WHATWEB_BIN:-whatweb}"
if ! command -v "$WHATWEB_BIN" &>/dev/null; then
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"technologies":[],"plugin_count":0,"error":"whatweb not found on PATH"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit 1
fi

# Run WhatWeb with JSON output (aggression level 3, no errors)
RAW_JSON="$("$WHATWEB_BIN" --log-json=- --no-errors -a 3 "$HOST" 2>/dev/null)" || {
  rc=$?
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"technologies":[],"plugin_count":0,"error":"whatweb exited with code $rc"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit "$rc"
}

# Parse WhatWeb JSON output into normalized technologies array
# WhatWeb --log-json=- produces lines like: {"target":"https://...","plugins":{"jQuery":{"version":["3.6.0"],"certainty":[100]},...}}
# We extract each plugin name, version, and certainty as normalized Technology entries.
TECHNOLOGIES="$(
  echo "$RAW_JSON" \
    | jq -c '
      [.plugins | to_entries[] | {
        name: .key,
        version: (.value.version // [] | join(", ")),
        category: "unknown",
        confidence: (.value.certainty // [100] | max // 100),
        source: "whatweb"
      }]
    ' 2>/dev/null
)"
PLUGIN_COUNT="$(echo "$TECHNOLOGIES" | jq 'length' 2>/dev/null || echo 0)"

# Build and write output envelope
cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"done","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"technologies":$TECHNOLOGIES,"plugin_count":$PLUGIN_COUNT,"raw":$(echo "$RAW_JSON" | jq -Rs .)}}
EOM

echo "HARNESS_RESULT: status=pass script=$HARNESS_REF output=$OUT_FILE"
exit 0
