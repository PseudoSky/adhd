# unified-cli — STATE_NAME

**Phase:** v2-packaging · **Kind:** work · **Depends on:** package-restructure · **Guard:** `npx --yes nx test apigen-cli`

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
mutates:    ["packages/apigen/cli/src/lib/orchestrator.ts", "packages/apigen/cli/src/lib/commands/run.ts", "packages/apigen/cli/src/lib/commands/generate.ts"]
```

---

## Notes for executor

SPEC §13: the ONE adhd-apigen orchestrator — detect lang per source, drive per-lang extractor subprocess, merge into one descriptor, generate/run; --type <plugin> (target) and --use <plugin> (layer/mount/envelope; pkg specifier OR local path).
