#!/usr/bin/env bash
# HARN-028 — nuclei harness wrapper
# Runs nuclei vulnerability scanner against a target host and returns normalized findings.
set -uo pipefail

HARNESS_REF="HARN-028"
ARGS="${1:?usage: $0 <args.json>}"
[ -r "$ARGS" ] || { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 2; }

# Read runtime params
HOST="$(jq -r '.host // empty' "$ARGS")"
OUT_DIR="$(jq -r '.output // "/tmp"' "$ARGS")"
SEVERITY="$(jq -r '.severity // "low"' "$ARGS")"
[ -z "$HOST" ] && { echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=-"; exit 3; }

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/$HARNESS_REF.json"

# Check tool availability
NUCLEI_BIN="${NUCLEI_BIN:-nuclei}"
if ! command -v "$NUCLEI_BIN" &>/dev/null; then
  cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"findings":[],"templates_run":0,"error":"nuclei not found on PATH"}}
EOM
  echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
  exit 1
fi

# Run nuclei with JSON-line output
# Each line is a finding with fields: template-id, info.name, severity, matched-at, type, etc.
RAW_OUTPUT="$("$NUCLEI_BIN" -u "$HOST" -json -severity "$SEVERITY" -no-stdin 2>/dev/null)" || {
  rc=$?
  # nuclei exits 0 on success even with findings; non-zero may mean no templates or config error
  # If it exited non-zero but produced output, still attempt to parse
  if [ -z "$RAW_OUTPUT" ]; then
    cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"fail","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"findings":[],"templates_run":0,"error":"nuclei exited with code $rc"}}
EOM
    echo "HARNESS_RESULT: status=fail script=$HARNESS_REF output=$OUT_FILE"
    exit "$rc"
  fi
}

# Parse JSON lines into normalized findings array
FINDINGS="$(
  echo "$RAW_OUTPUT" \
    | jq -sc '
      [.[] | {
        id: (.template-id // .info.name // "unknown"),
        title: (.info.name // .template-id // "unknown"),
        severity: (.info.severity // .severity // "unknown"),
        endpoint: (.matched-at // .host // ""),
        vector: (.template-id // ""),
        mitre_techniques: ([.info.classification.mitreattack[].id] // []),
        confidence: "firm"
      }]
    ' 2>/dev/null
)"
FINDINGS_COUNT="$(echo "$FINDINGS" | jq 'length' 2>/dev/null || echo 0)"

# Build and write output envelope
cat > "$OUT_FILE" <<-EOM
{"meta":{"module":"$HARNESS_REF","status":"done","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"},"data":{"findings":$FINDINGS,"templates_run":$FINDINGS_COUNT}}
EOM

echo "HARNESS_RESULT: status=pass script=$HARNESS_REF output=$OUT_FILE"
exit 0
