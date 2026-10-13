# sp-switch — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** chrome-lifecycle, core-seam, tripwire-pack, search-hosts · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-switch`

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
mutates:    ["package.json", "pnpm-lock.yaml", "docs/plan/stealth-browser/smoke/switch.md"]
```

---

## Notes for executor

executor=devops-engineer tier=sonnet/medium; human-gated (hb-sp-release): once @adhd/sox-service-proxy 0.6.0 is on the registry delete the root pnpm.overrides dev-tarball entry, pnpm install, prove the lockfile resolves from the registry and that build and the lifecycle unit lane pass with no source change; verification-only no-op when 0.6.0 was already published before sp-link
