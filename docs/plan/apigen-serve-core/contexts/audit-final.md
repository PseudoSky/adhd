# audit-final — Final audit — every [dod.N] proven

**Phase:** final · **Kind:** audit · **Depends on:** audit-transports, audit-python · **Guard:** `python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase final`

---

## Goal

Every [dod.1]..[dod.10] emits an executed PASS: all transport parity gates green, all flagged behavior changes tested, the two out-of-scope bugs pinned unchanged, no shim modules remain, and verify-dist-load is green for every consumer-loaded package. This is what 'done' means.

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

Read-only audit: fixes go in SOURCE, never by weakening a check. Runs `audit_apigen-serve-core.py --phase final` which proxies run-audit.js over criteria.json (accumulating prior phases) and, for `final`, emits every `[dod.N]` proof. Every fix made during this audit is listed in the transition log.
