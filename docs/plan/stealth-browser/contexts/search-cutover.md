# search-cutover — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** search-usecases, search-examples, tracing-log-validation, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-cutover`

---

## Goal

<What is true after this state that was not true before?>

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
mutates:    ["docs/plan/stealth-browser/evidence/cutover/", "/Users/nix/dev/ai/scratch/agent-browser/", "/Users/nix/dev/ai/scratch/bin/scratch-agent-search", "/Users/nix/dev/ai/scratch/bin/scratch-agent-search-serve", "/Users/nix/dev/ai/scratch/bin/scratch-agent-search-mcp-cli", "/Users/nix/dev/ai/scratch/docs/GIT-POLICY.md"]
```

---

## Notes for executor

typescript-pro sonnet/high; three-package tarball proof and scratch agent-browser removal
