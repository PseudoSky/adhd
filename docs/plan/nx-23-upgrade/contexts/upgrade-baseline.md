# upgrade-baseline — Baseline frozen; the bump is measured, not yet landed

**Phase:** intake · **Kind:** work · **Depends on:** none · **Guard:** `test -f docs/plan/nx-23-upgrade/BASELINE.md && ./node_modules/.bin/nx --version | rg -q "Local: v23\.2\.1" && node -e "const d=require(\"./package.json\").devDependencies;if(d.nx!==\"23.2.1\"||d.vite!==\"^8.3.0\"||d.vitest!==\"4.1.9\")process.exit(1)"`

---

## Goal

The toolchain the branch actually carries is recorded as a **measured** baseline. Every later
guard compares against this record instead of against a remembered version number.

---

## Semantic distillation

- **This state measures; it does not land.** The vite bump sits uncommitted in the working
  tree and stays that way here. `mutates` is `BASELINE.md` alone. The bump is committed by
  `vite-cjs-import-meta-repair`, atomically with the CJS fix that makes it safe — a commit
  that bumps vite without that fix is a broken commit, and the plan refuses to author one.
- Record MEASURED values (project count, per-executor target counts, resolved versions), not
  claims. Later states cite this file.
- Record the **deferred landing explicitly**: name `vite-cjs-import-meta-repair` as the state
  that commits `package.json`/`pnpm-lock.yaml`, and name the CJS hazard as the reason. A
  reader must be able to tell "the bump is present in the working tree" from "the bump is
  committed".
- vitest 4.1.9 is the ceiling, not a choice: `@nx/vitest` peers `^3.0.0 || ^4.0.0`. Record the
  ceiling AND its evidence so nobody re-litigates it.
- Measure the **build graph's health**, not just version strings. `nx run-many -t build`
  across the 66 JS/TS projects is the honest before-picture: on the branch as authored it
  reports exactly one failing target (`ui-react-base-hooks:build`, the React-19 type
  breakage owned by `browser-package-build-repair`). A baseline that records only versions is
  what let two broken public packages sit unnoticed.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/BASELINE.md"]
modified: []
deleted:  []
```

---

## Commit points

- Commit `BASELINE.md` alone, post-guard, as `chore(nx): pin the measured upgrade baseline`.
- **Do not stage `package.json` or `pnpm-lock.yaml` here.** If they are already staged in the
  working tree, unstage them (`git restore --staged package.json pnpm-lock.yaml`) before
  committing — staging state must survive this state unchanged, because the next state lands
  them together with the fix.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [upgrade-baseline.1] The repo-local Nx binary reports 23.2.1

- [upgrade-baseline.2] The declared toolchain pins match the measured baseline
- [upgrade-baseline.3] No vite 5 major pin remains declared
- [upgrade-baseline.4] The measured baseline record exists
- [upgrade-baseline.5] The baseline record names the state that lands the vite bump, so measuring the toolchain is not conflated with landing it
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

Freeze the measured baseline that every later guard compares against. **The in-flight vite 8
bump is NOT committed here** — it is measured and recorded as pending, and lands in
`vite-cjs-import-meta-repair` in the same commit as the CJS fix.

The guard reads `package.json` for the declared pins, which is a *measurement* of the working
tree, not a claim that they are committed. That distinction is the whole repair: the previous
version of this state committed the bump on its own, so the branch carried a commit where
`vite ^8.3.0` was declared and every built CommonJS entrypoint threw at module load.

Write `BASELINE.md` with: the resolved toolchain (`nx 23.2.1`, `vite 8.3.0`, `vitest 4.1.9`,
`typescript 6.0.3`), the vitest ceiling and its peer-range evidence, the measured project and
per-executor target counts, the `nx run-many -t build` health sweep result, the **pending**
bump (naming `vite-cjs-import-meta-repair`), and the measured cost of the CJS defect
(`apigen-cli:test` 28 files / 188 tests green on vite 6.4.3 → 26 failed / 162 passed on
vite 8.3.0).

Do not run `nx lint` anywhere in this plan's intake phase: `lint.dependsOn: ["sync-deps"]` and
`sync-deps` rewrites tracked `package.json` files.
