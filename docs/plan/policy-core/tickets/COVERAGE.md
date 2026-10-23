# Coverage: demo beats to proving scenarios

Tags are `@S<scenario>.<beat>` in the ticket's Gherkin. Scenario Outline rows count as one scenario.

| Beat | Proven by | Note |
|---|---|---|
| B1.1 | T11 `@S1.1` | import starts nothing |
| B1.2 | T11 `@S1.2` (happy + negative) | `no-match` for anonymous caller: merged into T12 `@S2.5` |
| B1.3 | T11 `@S1.3` | |
| B1.4 | merged into T16 `@S6.4` | same operation and assertions |
| B2.0 | not tested: fixture | validity proven by T16 `@S6.1` |
| B2.1 | T12 `@S2.1` | proven: `entrypoint/policy/src/test/functional/s2-check-evaluate.spec.ts` |
| B2.2 | T12 `@S2.2` | proven (exit 3, empty stdout, matched deny named) |
| B2.3 | T12 `@S2.3` | proven |
| B2.4 | merged into T11 `@S1.2` | forced `set` is the same engine path; CLI only prints it; the CLI print is also asserted in T12 (`@S2.1` forced value) |
| B2.5 | T12 `@S2.5` | proven (outline, both rows, check exits 3) |
| B2.6 | T12 `@S2.6` | proven (outline, ask and deny rows) |
| B2.7 | merged into T12 `@S2.6` | outline row amount 90 |
| B2.8 | merged into T12 `@S2.5` | outline row billing.refund |
| B2.9 | T12 `@S2.9` | proven (missing tool exit 2; the demo's `--tool` form is `invalid_argument` too, D-03) |
| B3.0 | not tested: fixture | |
| B3.1 | T13 `@S3.1` | proven (`entrypoint/policy/src/test/functional/s3-run-bin.spec.ts`); also covers `--adhd-*` stripped, the child exit code and a forced `set` reaching the child |
| B3.2 | T13 `@S3.2` | proven (4 rows: outside root, `.ssh` deny wins, guest, intern ask; `run --name` and non-bin sources exit 2) |
| B3.3 | T13 `@S3.3` | proven (attributes file rewritten between two runs) |
| B3.4 | merged into T13 `@S3.2` | proven (row 2); deny-wins itself proven by T12 `@S2.2` |
| B3.5 | merged into T13 `@S3.2` | proven (row 3); empty attributes is guest; also T12 `@S2.5` |
| B3.6 | T13 `@S3.6` | proven (four non-object values, exit 2, no start) |
| B4.1 | T14 `@S4.1` (4 scenarios) | includes B4.2 decisions across layers |
| B5.0 | not tested: fixture | |
| B5.1 | T15 `@S5.1` | proven at CLI level (`entrypoint/policy/src/test/functional/s5-narrow.spec.ts`) |
| B5.2 | T15 `@S5.2` | proven |
| B5.3 | T15 `@S5.3` | proven (refusals exit 0 as data; the spawn gate is `check`, exit 3) |
| B5.4 | merged into T15 `@S5.3` | outline row |
| B5.5 | merged into T15 `@S5.3` | outline row |
| B5.6 | T15 `@S5.6` | proven (rule `uncovered`) |
| B5.7 | merged into T15 `@S5.1` | parent untouched is a Then-clause |
| B6.1 | T16 `@S6.1` | proven (`entrypoint/policy/src/test/functional/s6-verify-explain-draft.spec.ts`) |
| B6.2 | T16 `@S6.2` | proven (3 errors with paths, 1 warning, exit 2) |
| B6.3 | T16 `@S6.3` | proven (exit 1 for check and evaluate; good parent file never mixed in) |
| B6.4 | T16 `@S6.4` | also B1.4; proven |
| B6.5 | T16 `@S6.5` | proven |
| B6.6 | T16 `@S6.6` | proven (and the drafted yaml verifies with exit 0, B6.7) |
| B6.7 | merged into T16 `@S6.6` | last Then-clause |
| B7.0 | not tested: fixture | |
| B7.1 | T17 `@S7.1` (2 scenarios) | proven (`s7-mcp-json.spec.ts`; the wrapped entry is also run through `serveVerb` in `s7-serve.spec.ts`): wrap+no-op, undo byte for byte, E2/E3/E8 |
| B7.2 | T17 `@S7.2` (2 scenarios) | proven (`s7-serve.spec.ts`): allowed+forced (also when the host omitted the argument), refused with upstream call count 0, `serve --name` alias ids, E5 teardown |
| B7.3 | T17 `@S7.3` | proven (built-in default refuses, announced once, upstream log empty) |

## Spec behaviors with no demo beat (build gate only)

| Behavior | Ticket | Why not tested |
|---|---|---|
| `createDecider` (SV-18) | T05 | demo excludes it; structural port checked by typecheck |
| `show`, `doctor` | T05 | demo excludes them |
| Layer decider failure/timeout/malformed fails closed | T07 | demo excludes the Layer standalone (U15) |
| `serve` handshake failure is an error, no argv fallback (D-08) | T19 `@S8.2` | proven (`s8-serve-handshake-and-precedence.spec.ts`: silent upstream on a fake timer, JSON-RPC errors, unstartable command, plain program; exit 1, host never started, one start, no `tools/call`) |
| `ADHD_POLICY_ATTRIBUTES` precedence (D-06) | T09 | demo uses only the flag; proven at the attribute-source / attributes-layer seams in `review-fixes-entrypoint.spec.ts` (REVIEW-FIXES.md, Entrypoint proof); the `run`/`serve` end of it is T19 @S8.3, proven (flag over env, never merged, file re-read per call, bad env value) |
| Layer file discovery from disk (D-10) | T18 | demo passes layers explicitly; reconciled by observation |
| `adhd-policy-mcp` / `-http` projections | T06 | demo excludes them; the `-http` entry is exercised in process by `http-entry.e2e.test.ts` (the `e2e` lane) (loopback port, ephemeral port, strict-port refusals, signal stop); the `-mcp` entry has no in-process test yet |
