# UNRESOLVED — Nx 23 / Vite 8 Upgrade Demo

Interfaces this demo had to guess, and scope gaps found while authoring it.
Resolve each before treating the corresponding `DEMO.md` step as authoritative.

---

## Unresolved interfaces

| ID | Guessed interface | Used in | Basis | What would confirm it |
|---|---|---|---|---|
| ⟦U1⟧ | The exact wording of the zero-selection failure message — demo shows `no tests selected for ⟨1⟩ changed file(s)` | §4 (the refusal beat) | Inferred. `README.md` `[dod.6]` pins the *contract* ("a message naming zero selected") and `scripts/check-zero-selection.mjs` asserts `/no tests selected/i`, but neither fixes the full sentence or whether a count is included. | Read the message the delivered fast-path wrapper actually prints; if it differs, update the demo's Expect block and the probe's regex together so they still agree. |
| ⟦U2⟧ | The stdout shape of the fast-path wrapper's selection summary — demo shows `selected=⟨4⟩/⟨22⟩` | §4 (the payoff beat), and `[dod.5]`'s proving check | Inferred. `README.md` `[dod.5]` requires "a selected=N/M line … with N strictly below M" and the `dod.5` criterion greps for `selected=`, so the `key=N/M` form is a concrete realization of a pinned contract — not a measured one. | Run the delivered wrapper once and copy its real summary line into the Expect block and the `dod.5` regex. |
| ⟦U3⟧ | The exact rendering of `nx show projects` for the remodelled graph — demo counts comma-separated output via `tr ',' '\n' | wc -l` | §2.4 (cold start) | Inferred. The command shape was verified against the current branch (68 projects, comma-separated JSON array on one line), but the count after the remodel is not known at authoring time, so the literal is shown as ⟨68⟩ and the *invariant* (project count matches §2.4) is what is asserted. | Re-run after the graph phase and record the real count in `BASELINE.md`; if the output format changes, update the counting pipeline. |

---

## Scope gaps & open questions

- **The three post-bump gate failures have no verdict yet.** `apigen-cli`, `backlog` and
  `apigen-plugin-java-javalin` failed the commit gate after the vite 8 bump, and a
  separate triage is still running. The demo does not exercise them; the plan consumes
  their verdict in the `gate-triage-absorbed` state. Until that verdict lands, no beat
  in this script should be read as evidence that the bump was clean.

- **The lint-mutation criterion is a scope extension.** `graph-release-eslint-inferred.5`
  requires the lint path to stop depending on the target that rewrites `package.json`.
  That is derived from goal 2 ("remodel the task graph **correctly**") rather than from
  the five stated goals, and it is flagged for confirmation at the approval gate. If the
  consumer declines it, remove that criterion — beat 3.6 and `REQ-010` go with it.

- **Beats assert against a branch, not a merge.** Every command here is run on
  `perf/nx-upgraded`. Nothing in this script validates behaviour after a merge to the
  default branch, because landing is explicitly out of scope. A post-merge regression
  would not be caught by this demo.

- **Wall-clock claims are deliberately absent.** The machine runs ~35 concurrent
  worktrees. No beat asserts a speedup, because a timing assertion here would be
  measuring machine load, not the change. The selection beats assert *counts*
  (specs selected, specs skipped) which are load-independent.

- **The browser bundle's red state is reported, not re-measured (beat 5.5).** The
  empty-import-meta token in `ui-react-base-hooks`' CJS and UMD bundles was verified by the
  reviewing pass, which built the package past the `vite-plugin-dts` type-check. It was not
  independently reproduced during the 2026-09-21 plan-repair pass, because
  `nx build ui-react-base-hooks` fails earlier on four React-19 type errors — which is why the
  plan now owns `browser-package-build-repair` ahead of `browser-cjs-umd-repair`. That state
  re-confirms the token as its first step and records the result in `BROWSER-BUNDLE-REPAIR.md`;
  until then, treat 5.5's red as unconfirmed rather than measured.

- **The React-19 build breakage is a finding of the repair pass, not of the original demo.**
  `nx run-many -t build` over the 66 JS/TS projects reports exactly one failing target —
  `ui-react-base-hooks:build`, with four type errors caused by the branch's
  `@types/react 18 → 19` bump. It blocks publishing a public package, so it is in scope as a
  consequence of goal 1, and `[dod.15]` now covers it. The demo's beats 2.4/2.5/5.5 and the
  `REQ-019`–`REQ-021` / `CAP-011`–`CAP-012` rows were added with it.

- **Two DoD clauses were added after the GATE 2 approval.** `[dod.14]` and `[dod.15]` are
  derived from *measured* defects that the original 13 clauses did not cover, not from new
  goals — but they post-date the approval recorded in `APPROVAL.md`, which carries an
  amendment section naming them as pending owner re-acknowledgement.

- **`vitest@5` is unreachable, not deferred.** Recorded in `interfaces.json` as
  `nx-vitest-peer-range` with a vendored source. This is not a gap; it is a documented
  ceiling. It appears here so a reader does not file it as a missing capability.
