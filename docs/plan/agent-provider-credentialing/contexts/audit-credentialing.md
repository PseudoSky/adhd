# audit-credentialing — final hold point: prove every DoD clause

**Phase:** audit · **Kind:** audit · **Depends on:** lmstudio-removal, dotenv-dual-load, backcompat-normalizer · **Guard:** `python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase audit`

---

## Goal

The mandatory hold point before `done`. `audit_credentialing.py --phase audit` runs **every**
prior criterion (contract + runtime + env + backcompat) plus the audit-only checks and the
behavioral `[dod.1..8]` checks, and exits non-zero on any failure. No deferrable items.

This state proves the consumer outcomes through REAL components:

- **[dod.2]/[dod.3]** drive `credential-inference.test.ts` (real `AnthropicProvider`/`OpenAIProvider`).
- **[dod.4]** drives `dotenv-load.test.ts` (real loader, temp dirs).
- **[dod.5]** drives `backcompat-normalize.test.ts` (real zod schema + the real `~/.adhd/agent-mcp/agents.db`).
- **[dod.6]** drives `openai-compat-roundtrip.e2e.test.ts` (real `openai` adapter vs the LM Studio box).
- **[audit-credentialing.3]** is the **teeth** check: it runs `nc_break_credential.mjs`, confirms the
  live test's unconditional credential-flow assertions go RED with the box-independent break, then
  restores. Proves [dod.6]'s unconditional half has real teeth.
- **[dod.1]/[dod.7]/[dod.8]** are structural (greps + `check-no-secrets.sh`).

## Pre-execution prerequisite (human-blocker)

`lmstudio-credential` (see `human-blockers.json`): a valid `LMSTUDIO_API_KEY` must be present in
`~/.adhd/agent-mcp/.env` so [dod.6]'s live round-trip genuinely sources the key. Verification:
`bash -c 'f="$HOME/.adhd/agent-mcp/.env"; [ -f "$f" ] && grep -qE "^LMSTUDIO_API_KEY=.+" "$f"'`.
(Rotation of the previously-leaked key is operational, not a plan gate — ADDENDUM §6.)

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-credentialing.1] no LM Studio secret in any tracked file (incl docs/mcp-env/PROPOSAL.md); .env paths gitignored

- [audit-credentialing.2] live openai_compat_roundtrip drives the real openai adapter (unconditional credential flow; network leg self-skips loud if box down)
- [audit-credentialing.3] teeth: breaking openai credential resolution makes the unconditional credential-flow assertions fail RED even with the LM Studio box down
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-mcp/src/providers", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/index.ts"]
mutates:    ["docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py", "docs/plan/agent-provider-credentialing/scripts/check-no-secrets.sh"]
```

> **Audit scripts are read-only on source.** Any failure is fixed in the owning state's source
> files, never by weakening a check. Every fix is recorded in the transition log.

---

## Commit points

1. After `--phase audit` exits 0 with every `[dod.N] PASS`:
   `git commit -m "chore(plan): agent-provider-credentialing final audit green"`.

## Notes for executor

- If `[dod.6]`/`[audit-credentialing.3]` are red because the box is down, that is NOT a pass: the
  unconditional flow assertions and the teeth check do not depend on reachability — only the live
  completion leg self-skips with a WARNING. A red here means a real credential-flow regression.
- If `[dod.7]` (`check-no-secrets.sh`) is red, a tracked file still carries the LM Studio token
  (the requester flagged `docs/mcp-env/PROPOSAL.md`) — scrub it; do not weaken the scan.
- `state-transition.js --complete` will refuse to advance to `done` unless every `[dod.N]` shows an
  executed PASS (exit 4 `dod_unconfirmed` otherwise).
