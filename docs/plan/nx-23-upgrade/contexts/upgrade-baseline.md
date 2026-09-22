# upgrade-baseline — Baseline frozen and the in-flight vite bump committed

**Phase:** intake · **Kind:** work · **Depends on:** none · **Guard:** `test -f docs/plan/nx-23-upgrade/BASELINE.md && ./node_modules/.bin/nx --version | rg -q "Local: v23\.2\.1" && node -e "const d=require(\"./package.json\").devDependencies;if(d.nx!==\"23.2.1\"||d.vite!==\"^8.3.0\"||d.vitest!==\"4.1.9\")process.exit(1)"`

---

## Goal

The branch's working tree is clean and the toolchain it actually carries is recorded as a measured baseline. Every later guard compares against this record instead of against a remembered version number.

---

## Semantic distillation

- The staged vite bump is real, verified work sitting uncommitted — commit it before anything else touches the tree.
- Record MEASURED values (project count, per-executor target counts, resolved versions), not claims. Later states cite this file.
- vitest 4.1.9 is the ceiling, not a choice: @nx/vitest peers `^3.0.0 || ^4.0.0`. Record the ceiling AND its evidence so nobody re-litigates it.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/BASELINE.md"]
modified: ["package.json","pnpm-lock.yaml"]
deleted:  []
```

---

## Commit points

- Commit the vite bump + BASELINE.md together, post-guard, as `chore(nx): pin the measured upgrade baseline`.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [upgrade-baseline.1] The repo-local Nx binary reports 23.2.1

- [upgrade-baseline.2] The declared toolchain pins match the measured baseline
- [upgrade-baseline.3] No vite 5 major pin remains declared
- [upgrade-baseline.4] The measured baseline record exists
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "package.json", "pnpm-lock.yaml"]
mutates:    ["docs/plan/nx-23-upgrade/BASELINE.md"]
```

---

## References & interfaces

- [iface:nx-vitest-peer-range] — @nx/vitest peerDependencies.vitest

---

## Notes for executor

Commit the in-flight vite 8 bump and freeze the measured baseline that every later guard compares against.
