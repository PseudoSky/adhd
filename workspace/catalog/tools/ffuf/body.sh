#!/usr/bin/env bash
# HARN-029 — ffuf harness wrapper
# Runs ffuf directory/parameter fuzzing against a target host with a wordlist.
set -uo pipefail

HARNESS_REF="HARN-029"
ARGS="${1:?usage: $0 <args.json>}"
[ -r "$ARGS" ] || { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 2; }

# Read runtime params
HOST="$(jq -r '.host // empty' "$ARGS")"
WORDLIST="$(jq -r '.wordlist // empty' "$ARGS")"
OUT_DIR="$(jq -r '.output // "/tmp"' "$ARGS")"
EXTENSIONS="$(jq -r '.extensions // ""' "$ARGS")"
[ -z "$HOST" ] && { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 3; }
[ -z "$WORDLIST" ] && { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 4; }
[ -r "$WORDLIST" ] || { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 5; }

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/$HARNESS_REF.json"

# Check tool availability
FFUF_BIN="${FFUF_BIN:-ffuf}"
if ! command -v "$FFUF_BIN" &>/dev/null; then
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":[],"results_total":0,"wordlist":"$WORDLIST","error":"ffuf not found on PATH"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit 1
fi

# Build ffuf command
FFUF_ARGS=("-u" "$HOST/FUZZ" "-w" "$WORDLIST" "-json" "-ac" "-o" "-")
[ -n "$EXTENSIONS" ] && FFUF_ARGS+=("-e" "$EXTENSIONS")

# Run ffuf
RAW_JSON="$("$FFUF_BIN" "${FFUF_ARGS[@]}" 2>/dev/null)" || {
  rc=$?
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":[],"results_total":0,"wordlist":"$WORDLIST","error":"ffuf exited with code $rc"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit "$rc"
}

# Parse ffuf JSON output
# ffuf -json -o - produces: {"config":{...},"results":[{"url":"...","status":200,"length":123,...},...]}
ENDPOINTS="$(
  echo "$RAW_JSON" \
    | jq -c '
      [.results[] | {
        path: .url,
        method: "GET",
        source: "ffuf",
        status_code: .status,
        content_length: .length
      }]
    ' 2>/dev/null
)"
RESULTS_TOTAL="$(echo "$ENDPOINTS" | jq 'length' 2>/dev/null || echo 0)"

# Build and write output envelope
cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"done","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"endpoints":$ENDPOINTS,"results_total":$RESULTS_TOTAL,"wordlist":"$WORDLIST"}}
EOM

echo "HARNESS_RESULT: status=pass script=$HARNESS_REF output=$OUT_FILE"
exit 0
