# name-slug-seam — name↔slug translation bridge at the MCP boundary

**Phase:** seam · **Kind:** work · **Depends on:** enrichment-pipeline · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/name-slug-seam.test.ts`

---

## Goal

There is now a real translation seam at the agent-mcp tool boundary so the wire
speaks `name` and only `name` (D2, SPEC §3, Decision E). A new
`registry/name-slug.ts` exposes `toSlug(name) = name.toLowerCase().replace(/\s+/g,'-')`
(identity when already slug-form), and a `registry/registry-bridge.ts` wraps the
registry stores: it translates `name → slug` on every inbound call and **strips
`slug`** (re-keys rows to `name`) on every outbound result, so no `slug` field
appears in any MCP tool schema, any tool output, or `guide` text
(`inv:no-slug-on-wire`). A human "Display Name" resolves to the exact same row as
its slug form. This is additive: the registry stores keep their `slug` vocabulary
byte-for-byte (`PromptComponent.slug`, `ComponentCreateInput.slug`,
`linkComponent(componentSlug,…)`, `AgentStore.read(slug)` all unchanged) — the
bridge is the single chokepoint every discovery/authoring tool routes through,
not a store refactor.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [name-slug-seam.1] bridge translates name->slug inbound, strips slug outbound; no slug field in any MCP response (recursive scan)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/registry/name-slug.ts", "packages/ai/agent-mcp/src/registry/registry-bridge.ts", "packages/ai/agent-mcp/src/__tests__/name-slug-seam.test.ts"]
```

---

## Notes for executor

- **The outbound strip is the easy thing to get wrong.** It is not enough to
  rename one top-level field — a raw store object (with `.slug`) handed back inside
  a nested array (e.g. `component_consumers`, `agent_read.components[]`) leaks a
  slug. The seam must re-key recursively; the proof is a recursive scan asserting
  NO `slug` key anywhere in any response (D2 dod.4). Leaving a raw store row in any
  response is the negative-control failure.
- **Do NOT refactor the stores' slug vocabulary.** Translating at the boundary is
  deliberate — touching the stores risks Plans 1–5's green audits and is out of
  scope. Both new files are ADDITIVE per the D3 manifest
  (`registry/name-slug.ts`, `registry/registry-bridge.ts`).
- **`toSlug` must be idempotent on already-slug input** so passing a slug-form
  name still resolves the same row (round-trip safety for callers that already
  have a slug-shaped name).
- This seam is consumed by every later state (`discovery-tools`,
  `component-define`, `agent-define`); land it before them so they route through
  the bridge rather than the stores directly.
