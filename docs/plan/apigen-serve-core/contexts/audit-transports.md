# audit-transports — Phase-2 audit — express/mcp/cli adapters

**Phase:** phase-2 · **Kind:** audit · **Depends on:** express-adapter, mcp-adapter, cli-adapter · **Guard:** `python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase phase-2`

---

## Goal

Every phase-2 criterion passes: express (DEBT-003 void fixture), mcp (BUG-001 validate + malformed→invalid_argument + streaming), and cli (cliFlags + front-proxy pin) parity gates are green with negative controls proven. Accumulates phase-1.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py"]
```

---

## Notes for executor

Read-only audit: fixes go in SOURCE, never by weakening a check. Runs `audit_apigen-serve-core.py --phase phase-2` which proxies run-audit.js over criteria.json (accumulating prior phases) and, for `final`, emits every `[dod.N]` proof. Every fix made during this audit is listed in the transition log.
