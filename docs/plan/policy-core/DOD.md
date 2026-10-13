# Definition of done

A ticket is done only when every clause for its phase holds and the evidence (command + exit code) is recorded in the ticket's `Evidence` section.

## Per ticket (Phase A, source)
1. Every symbol in the ticket's contract exists with the exact signature in `INTERFACES.md`/spec; no extra public export.
2. Layer rules hold (spec §1.2): only `core/engine/**` imports the query engine; only `service/config/**` imports `@adhd/environment*`/YAML; only entry files import apigen/server libs; entry files contain no logic.
3. `npx nx run <project>:lint` and `:typecheck` exit 0 (no rule disabled without an in-code reason and a backlog item). `npx nx run <project>:build` exits 0.
4. JSDoc on every public function; interfaces prefixed `I`.
5. Any bug or deferral found is filed through backlog-operator; nothing is left as an unfiled TODO.

## Phase B (review)
6. Each package gets one large-batch review by the `performance` agent over the whole package diff (blind: diff + "Review"). All high/medium findings are fixed or filed; a fix commit references the review.

## Phase C (functional tests, user-usage only, unit lane, no subprocess, no e2e)
7. One test file per demo scenario S1-S7 drives the public entry exactly as the demo does (library import; CLI via apigen `cliPlugin.run({options:{argv}})` in-process; Layer via the apigen host in-process; MCP serve via an in-memory transport and an injected `IProcessLauncher` fake). Each Gherkin scenario in the ticket maps to ≥1 test whose title carries the scenario name.
8. Every test has teeth: for each behavior group a negative control was run (the production line removed or inverted) and shown red, then restored (recorded in Evidence).
9. No sleeps, no network, writes only under `tmp/policy/`, cleans up in `finally`.
10. `npx nx run-many -t test -p policy-core-client,policy,apigen-plugin-policy` exits 0. `e2e` is NOT run.

## Plan done
11. `demo-policy-v1.md` UNKNOWNs are each closed (observed behavior recorded) or filed as backlog; demo commands that the tests cover match the built CLI.
12. `npx nx affected -t lint,typecheck,typecheck-spec` exits 0 on the branch; `npx nx run <each>:verify-dist-load` exits 0.
13. `git status --porcelain` accounted for; nothing merged to main, nothing pushed.
