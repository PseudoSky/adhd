# seed-provider-registry — populate the provider registry lookup rows (providers, models, platform-bindings, tool-formats)

**Phase:** superseded-scope · **Kind:** work · **Depends on:** (none) · **Guard:** `npx --yes nx test agent-core-provider --testFile=packages/agent/agent-core-provider/src/__tests__/roundtrip.test.ts`

See `contexts/_shared.md` for definitions and invariants.

> ⚠️ **Reconciliation note (2026-07-15, plan-builder update mode).** This state was
> inherited from `agent-provider-credentialing` dod.1 (the registry-seed clause). The
> credentialing runtime was implemented out-of-band; this state captured the residual
> "the seed rows were never populated" work. **That premise is now STALE.** The shipped
> `@adhd/agent-core-provider` package (real path `packages/agent/agent-core-provider`,
> the post-rename home of the old `packages/ai/agent-provider`) ALREADY ships a unified
> idempotent `seed(db)` that populates providers → models → bindings, plus the tool-format
> store, with a passing `roundtrip.test.ts` (`[seed-and-roundtrip.1..4]`: reopen +
> idempotency + canonical model/provider rows + negative-control). **This state therefore
> appears already-satisfied by landed work.** The criteria below are written to reflect
> the REAL shipped target so they PASS if the seed is populated and FAIL if it regresses.
> A human should decide whether to mark this state complete against the shipped package
> rather than execute it fresh. (Original stale target: `packages/ai/agent-provider` — gone.)

---

## Goal

Ensure the provider registry lookup tables are populated with the canonical seed
rows the whole agent stack reads: **providers** (`provider_providers`), **models**
(`provider_models`), **model/tool platform-bindings** (`claude_code` → canonical
model/tool ids), and **tool-formats**. The seed is **idempotent** (`INSERT OR IGNORE`
/ `onConflictDoNothing()` on every table — a second call is a no-op, row counts do
not drift) and its correctness is proven by CLOSE+REOPEN of the on-disk SQLite handle
(`[inv:reopen-proves-persistence]`), driving the REAL stores, never mocks
(`[inv:real-deps-not-mocks]`).

The provider-seed rows are the ground truth the migration's frontmatter parser reads
to resolve a `model:` alias (`sonnet` → `claude_sonnet_4_6`) and `tools:` tokens back
to canonical ids — so this seed must exist before the import pipeline runs.

---

## Acceptance criteria

<!-- Criteria mirror the REAL shipped @adhd/agent-core-provider target (post-rename). -->

- [seed-provider-registry.1] a unified idempotent `seed(db)` populates providers + models + platform-bindings via the real `@adhd/agent-core-provider` seed module (providers → models → bindings ordering), safe to call on every start (no row drift)
- [seed-provider-registry.2] the real seed+reopen+idempotency roundtrip test passes against a real on-disk SQLite DB, driving the real provider/model/tool-format stores (not mocks); rows recoverable after DB reopen
- [seed-provider-registry.3] the seed enumerates canonical rows as named constants (SEEDED_PROVIDER_IDS / MODEL_ROWS / BINDING_ROWS) — proving the tables are populated with real values, not left empty stubs

---

## Reservations

```text
read_only:  []
mutates:    ["packages/agent/agent-core-provider/src/seed/providers.ts", "packages/agent/agent-core-provider/src/seed/models.ts", "packages/agent/agent-core-provider/src/seed/bindings.ts", "packages/agent/agent-core-provider/src/seed/index.ts", "packages/agent/agent-core-provider/src/store/provider-store.ts", "packages/agent/agent-core-provider/src/store/model-store.ts", "packages/agent/agent-core-provider/src/store/tool-format-store.ts"]
```

---

## References & interfaces

- [inv:reopen-proves-persistence] — prove persistence by REOPEN, not in-memory (`_shared.md`).
- [inv:real-deps-not-mocks] — drive the real stores, never mock the thing under test (`_shared.md`).
- [fix:store-usage] — write rows via the published store classes, not hand-written SQL (`_shared.md`).

---

## Notes for executor

- **Real target is `@adhd/agent-core-provider`** (`packages/agent/agent-core-provider`),
  NOT the stale `packages/ai/agent-provider` (that layout is gone). The unified
  `seed(db)` lives at `src/seed/index.ts` and re-exports `seedProviders` /
  `seedModels` / `seedBindings` plus the row constants.
- **Idempotency has teeth** — assert a second `seed(db)` call does NOT change row
  counts (negative-control), and that reopening the DB reads the same rows back.
  Gate on the runner EXIT CODE, never stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`, CLAUDE.md verification standard #4).
- **This state likely needs no new code** — verify the shipped seed already covers
  providers/models/bindings/tool-formats and simply close the state against it if so.
  If a gap exists (e.g. a missing tool-format row), fill only that gap; do not
  re-implement the seeder.
