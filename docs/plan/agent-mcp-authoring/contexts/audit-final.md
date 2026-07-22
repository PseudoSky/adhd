# audit-final — final DoD + back-out-guarantee self-consistency gate

**Phase:** audit · **Kind:** audit · **Depends on:** code-review · **Guard:** `python3 docs/plan/agent-mcp-authoring/scripts/audit_authoring.py --phase final`

---

## Goal

The plan is self-consistent and every Definition of Done clause is mechanically
proven. `audit_authoring.py --phase final` runs green: it asserts every `[dod.N]`
(dod.1–dod.8) by driving its named entrypoint/observable, plus the back-out
guarantee — `check_manifest.py` confirms the change set is a subset of the D3
modification manifest (reverting this plan's commits restores agent-mcp to the
`baseline-ref` byte-for-byte), the non-regression guard `nx test agent-mcp` stays
green, and `nx build agent-mcp` succeeds. After this state the plan is DONE: the
definition lane ships, the runtime hot path is provably unchanged, and the
agent-mcp back-out remains intact.

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
mutates:    ["docs/plan/agent-mcp-authoring/scripts/audit_authoring.py"]
```

---

## Notes for executor

- **Every `[dod.N]` check must DRIVE its entrypoint, not grep a proxy** (CLAUDE.md
  verification standard). A behavioral clause is proven by exercising the real
  tool/store/server and asserting the consumer-visible observable — never by
  "symbol X is present." Each criterion's audit check ID must mirror its `[dod.N]`.
- **The back-out checks are first-class**, not afterthoughts: `check_manifest.py`
  must fail if any agent-mcp src file outside the manifest changed (dod.8); the
  non-regression `nx test agent-mcp` and `nx build agent-mcp` must be exit-code
  gated, not stdout-grepped.
- **Trust exit codes, not stdout** — the better-sqlite3 + vitest teardown can
  segfault after printing "passed"; key on the runner's exit status.
- **Trust the nx cache** — never `--skip-nx-cache`; prove a hit/miss by running
  twice if needed.
- This state mutates only `scripts/audit_authoring.py`. It runs after
  `code-review` is APPROVED — a NEEDS-WORK review must be resolved before the final
  audit can pass.
