# cli-adapter — STATE_NAME

**Phase:** phase-2 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-cli-output:test`

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
mutates:    ["packages/apigen/apigen-plugin-cli-output/src/lib/run.ts", "packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts", "packages/apigen/apigen-plugin-cli-output/src/lib/schema-introspect.ts", "packages/apigen/apigen-plugin-cli-output/src/test/run-cli-integration.spec.ts", "packages/apigen/apigen-plugin-cli-output/src/test/golden/cli.snapshot.json"]
```

---

## Notes for executor

readCall=parseArgs over OpPlan.cliFlags; writeResult=stdout+exit-code. Real spawned child process only. Decide --use capability explicitly.
