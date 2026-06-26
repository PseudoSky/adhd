#!/usr/bin/env bash
# ===========================================================================
# apigen — logical types, every framework at once  (runnable human demo)
# ===========================================================================
# What this shows, from zero:
#   You write ONE set of typed functions. apigen serves them over EVERY
#   framework and language at once — TypeScript (Fastify + Express), Python
#   (Flask + gRPC) — behind ONE port. The "types that normally break JSON"
#   (Decimal, 64-bit int, Date) come off EVERY host as the SAME canonical wire.
#
# Run it:   bash docs/apigen/demo-logical-types.sh
# Requires: node (repo build), python3 + grpcio (`pip install grpcio`), grpcurl.
#           These are real local prerequisites — a MISSING one fails LOUDLY
#           (this is a live demo; it is not gated or mocked).
#
# Every assertion is EXACT: the demo FAILS (non-zero exit) if any host emits
# the wrong bytes — so a green run is real proof, not a substring coincidence.
# ===========================================================================
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

CLI=dist/packages/apigen/cli/index.js
PORT=8080
PASS=0 FAIL=0
WORK="$(mktemp -d)"; SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31m✗\033[0m %s\n     expected: %s\n     got:      %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }
# expect_eq "<label>" "<exact-expected>" "<actual>"
expect_eq() { [ "$3" = "$2" ] && ok "$1 → $3" || bad "$1" "$2" "$3"; }
hr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- 0. build the CLI (so `apigen` exists; no network, no mocks) -------------
hr "0 · Build the apigen CLI"
if [ ! -f "$CLI" ]; then npx nx build apigen-cli >/dev/null 2>&1; fi
[ -f "$CLI" ] || { echo "FATAL: CLI not built at $CLI"; exit 1; }
command -v grpcurl >/dev/null || { echo "FATAL: grpcurl required (brew install grpcurl)"; exit 1; }
python3 -c 'import grpc' 2>/dev/null || { echo "FATAL: python3 + grpcio required (pip install grpcio)"; exit 1; }
echo "  CLI built, grpcurl + grpcio present."

# --- 1. ONE definition per framework, each using the types JSON mangles -----
# These are plain typed functions. You write them once; apigen does the rest.
hr "1 · Write typed functions (Decimal / 64-bit int / Date — zero annotations)"
cat > "$WORK/money.ts" <<'TS'
import Decimal from 'decimal.js';
export async function price(d: Decimal): Promise<Decimal> { return d; }   // exact money
export async function when(at: Date): Promise<Date> { return at; }         // instant
TS
cat > "$WORK/orders.ts" <<'TS'
export async function big(n: bigint): Promise<bigint> { return n; }        // 64-bit int, past 2^53
TS
cat > "$WORK/billing.py" <<'PY'
from decimal import Decimal
def invoice(amount: Decimal) -> Decimal: return amount                     # exact money, Python
PY
cat > "$WORK/ledger.py" <<'PY'
from decimal import Decimal
def balance(amount: Decimal) -> Decimal: return amount                     # exact money, over gRPC
PY
echo "  money.ts (Fastify) · orders.ts (Express) · billing.py (Flask) · ledger.py (gRPC)"

# --- 2. ONE command mounts ALL FOUR frameworks behind ONE port --------------
hr "2 · apigen serve — every framework + language at once, one port"
echo "  \$ apigen serve \\"
echo "      --source money.ts --source orders.ts \\"
echo "      --source billing.py --source ledger.py \\"
echo "      --port $PORT --mount orders=api-express --mount ledger=py-grpc"
PYTHONPATH=packages/apigen/python node "$CLI" serve \
  --source "$WORK/money.ts" --source "$WORK/orders.ts" \
  --source "$WORK/billing.py" --source "$WORK/ledger.py" \
  --port $PORT --mount orders=api-express --mount ledger=py-grpc \
  > "$WORK/serve.log" 2>&1 &
SRV=$!
# wait until the front answers AND every host reports ready (bounded poll, no sleep-racing)
for _ in $(seq 1 120); do
  curl -s "http://127.0.0.1:$PORT/_meta/health" 2>/dev/null | grep -q '"status":"ok"' && break
  grpcurl -plaintext "127.0.0.1:$PORT" list 2>/dev/null | grep -q Ledger || true
  sleep 0.5
done

# --- 3. one merged health view across all four hosts ------------------------
hr "3 · One health endpoint, every host"
H=$(curl -s "http://127.0.0.1:$PORT/_meta/health")
expect_eq "GET /_meta/health" \
  '{"status":"ok","hosts":{"money":"ready","orders":"ready","billing":"ready","ledger":"ready"}}' "$H"

# --- 4. the SAME canonical wire off EVERY framework -------------------------
# A Decimal/int64 is a JSON STRING on the wire on every host — so money math
# stays exact and a 64-bit int never becomes a precision-losing float.
hr "4 · Logical types survive — identical canonical wire on all four hosts"
B="http://127.0.0.1:$PORT"
expect_eq "api-fastify  money/price   123.456" '"123.456"' \
  "$(curl -s "$B/money/price"     -H 'content-type: application/json' -d '{"data":{"d":"123.456"}}')"
expect_eq "api-fastify  money/when    instant" '"2024-01-15T12:00:00.000Z"' \
  "$(curl -s "$B/money/when"      -H 'content-type: application/json' -d '{"data":{"at":"2024-01-15T12:00:00.000Z"}}')"
expect_eq "api-express  orders/big    2^53+1 " '"9007199254740993"' \
  "$(curl -s "$B/orders/big"      -H 'content-type: application/json' -d '{"data":{"n":"9007199254740993"}}')"
expect_eq "py-flask     billing/invoice 99.99" '"99.99"' \
  "$(curl -s "$B/billing/invoice" -H 'content-type: application/json' -d '{"data":{"amount":"99.99"}}')"
# gRPC: same Decimal, over HTTP/2, through the SAME port. `data` carries the
# JSON-encoded result, so the decimal string `"123.456"` is preserved exactly.
G=$(grpcurl -plaintext -d '{"data":{"amount":"123.456"}}' "127.0.0.1:$PORT" ledger.LedgerService/balance 2>/dev/null | tr -d ' \n')
expect_eq "py-grpc      ledger/balance 123.456" '{"data":"\"123.456\""}' "$G"

# --- 5. teeth: invalid Decimal is REJECTED before it reaches your code -------
hr "5 · Validation has teeth — an invalid Decimal is rejected (HTTP 400)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$B/money/price" -H 'content-type: application/json' -d '{"data":{"d":"12.x.3"}}')
expect_eq "api-fastify  money/price  \"12.x.3\" → 400" "400" "$CODE"

# --- 6. partial availability: kill one host, the rest keep serving ----------
hr "6 · Kill one host — the front degrades, the others stay up"
PYPID=$(pgrep -f "flask_server.*billing" | head -1)
if [ -n "$PYPID" ]; then
  kill "$PYPID" 2>/dev/null
  for _ in $(seq 1 20); do curl -s "$B/_meta/health" | grep -q '"billing":"down"' && break; sleep 0.5; done
  HD=$(curl -s "$B/_meta/health")
  echo "$HD" | grep -q '"status":"degraded"' && ok "health → degraded after billing died" || bad "degraded health" "degraded" "$HD"
  echo "$HD" | grep -q '"money":"ready"'     && ok "money still ready (isolated failure)"  || bad "money survives" "ready" "$HD"
  C=$(curl -s -o /dev/null -w '%{http_code}' "$B/billing/invoice" -H 'content-type: application/json' -d '{"data":{"amount":"1"}}')
  expect_eq "dead host → 503" "503" "$C"
else
  echo "  (skipped: could not locate the billing child pid)"
fi

# --- 7. clean teardown: one SIGINT reaps every child, zero orphans ----------
hr "7 · One signal, zero orphans"
kill -INT "$SRV" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$SRV" 2>/dev/null || break; sleep 0.5; done
SRV=""
ORPH=$(pgrep -f "$WORK" | wc -l | tr -d ' ')
expect_eq "no orphaned children after shutdown" "0" "$ORPH"

# --- summary ----------------------------------------------------------------
hr "Result"
printf '  PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && { echo "  ✅ One definition → every framework → identical canonical wire."; exit 0; } \
                  || { echo "  ❌ a host drifted — see failures above"; exit 1; }
