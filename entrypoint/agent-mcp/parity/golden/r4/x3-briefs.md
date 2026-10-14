# x3_nested: every R4 docs-worker brief, old vs new verdict (R1.AC3, 90758419 AC3)

Old = `golden/r4/oracle.r4.frozen.mjs` (`docsBriefVerdict`, line-level `!HEDGE.test(line)`).
New = `oracle.mjs` (`docsBriefVerdict` with `delegationIsDirective`: a hedge counts only when it sits in the same sentence as the delegation word, at or before it; `so (that) you can ...` is a purpose clause, never a hedge).
Produced by scoring `observation.phase1` of each golden with both oracles. Asserted by the `--check-lib` case "R1.AC3 ... x3 verdicts on the R4 briefs are unchanged".

| run | docs brief delegation line | old brief verdict | new brief verdict | old x3_nested | new x3_nested | flip |
|---|---|---|---|---|---|---|
| B1 | none: the docs brief says "Look up the owning team in CODEOWNERS" itself, no delegation word | not-actionable (no delegation instruction) | not-actionable (no delegation instruction) | na | na | no |
| B2 | "if you need to know which team owns src/shipping.js, delegate to a subagent named 'worker' ..." has no `owner`/`CODEOWNERS` token on that line ("owns") | not-actionable (no delegation instruction) | not-actionable (no delegation instruction) | na | na | no |
| C1 | "Delegate to a subagent named 'worker': Look up src/shipping.js in CODEOWNERS ..." | actionable | actionable | fail | fail | no (real: directive, no grandchild) |
| C2 | none: owner is stated in the brief ("The owning team is @team-61399f") | not-actionable (no delegation instruction) | not-actionable (no delegation instruction) | na | na | no |

Result: no R4 verdict flips. The purpose-clause pattern ("so you can ...") does not occur in any R4 docs brief; the rule is proven on synthetic briefs in the oracle self-test (`x3 (R1.AC3, 90758419 AC3)` cases) and in the `--check-lib` pair "flips exactly the purpose-clause brief" (frozen: not-actionable, new: actionable). The only allowed flip class (purpose clause) therefore has zero R4 members, and no other flip occurred.
