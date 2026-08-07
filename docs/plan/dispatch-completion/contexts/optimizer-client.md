# optimizer-client — STATE_NAME

**Phase:** optimizer-client · **Kind:** work · **Depends on:** spec-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-core-optimizer,dispatch-core-client`

---

## Goal

`optimize()` sets `execution_mode` per unit, increments `snapshot_version`, resolves `mcp_servers` from a catalog, splits systemPrompt/prompt, and round-trips snapshots JSON-safe; the client inherits the eligible-own-completion guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [optimizer-client.1] optimizer and client build+test green

- [optimizer-client.2] optimize() sets execution_mode on units
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-core-optimizer/src/lib/optimize.ts", "packages/dispatch/dispatch-core-optimizer/src/lib/snapshot.ts", "packages/dispatch/dispatch-core-client/src/lib/client.ts"]
```

---

## Notes for executor

Closes DEBT-005/BL-102 wire (derive execution_mode in assembleUnit), BL-103 (snapshot_version), BL-105 (mcp_servers catalog), DEBT-012 (systemPrompt/prompt split — prompt-compiler), DEBT-014 (round-trip test, teeth), DEBT-013 client-side. Optimizer stays pure ([inv:layer-purity]); every new import uses [def:import-alias] standard names.
