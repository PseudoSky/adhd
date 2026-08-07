<!-- markdownlint-disable MD013 -->
# State machine — agent-provider-credentialing

Rendered from `dag.json`. Sequence comes from `depends_on`, not the order below.

## States

| Slug | Phase | Kind | Depends on | Guard |
|---|---|---|---|---|
| `unified-credential-contract` | contract | work | — | `python3 …/audit_credentialing.py --phase contract` |
| `provider-credential-runtime` | runtime | work | unified-credential-contract | `npx --yes nx test agent-mcp --testFile=…/credential-inference.test.ts` |
| `lmstudio-removal` | runtime | work | provider-credential-runtime | `npx --yes nx build agent-mcp && python3 …/audit_credentialing.py --phase runtime` |
| `dotenv-dual-load` | env | work | unified-credential-contract | `npx --yes nx test agent-mcp --testFile=…/dotenv-load.test.ts` |
| `backcompat-normalizer` | backcompat | work | provider-credential-runtime, lmstudio-removal | `npx --yes nx test agent-mcp --testFile=…/backcompat-normalize.test.ts` |
| `audit-credentialing` | audit | audit | lmstudio-removal, dotenv-dual-load, backcompat-normalizer | `python3 …/audit_credentialing.py --phase audit` |

## Topology

```text
unified-credential-contract
        │
        ├──────────────► provider-credential-runtime ──► lmstudio-removal
        │                          │                          │
        │                          └──────────┐               │
        │                                     ▼               ▼
        └──────────► dotenv-dual-load     backcompat-normalizer
                          │                     │
                          └─────────┬───────────┘
                                    ▼
                            audit-credentialing ──► done
```

- **Serial runtime spine:** `provider-credential-runtime → lmstudio-removal → backcompat-normalizer`
  (they share `validation/agent.ts` + `openai.ts`; the union-member removal must be atomic with the
  build to stay green).
- **Parallel branch:** `dotenv-dual-load` runs alongside the runtime spine (disjoint file set), both
  converging at `audit-credentialing`.

## Rollback / abort

Each work state's mandatory post-guard commit is the rollback unit — revert the state's commit to
back out just that state. The change is purely additive at the contract layer and removal+shim at the
runtime layer; no data migration occurs (legacy `agents.db` rows are normalized on load, never
rewritten), so abort at any state leaves stored data untouched. Token rotation (ADDENDUM §6) is
operational and outside the state machine.

## Human action required before execution

`human-blockers.json` → `lmstudio-credential` (gates `audit-credentialing`): a valid
`LMSTUDIO_API_KEY` must be present in `~/.adhd/agent-mcp/.env` (gitignored) so the live
`[openai_compat_roundtrip]` proof sources the key. Verify:
`bash -c 'f="$HOME/.adhd/agent-mcp/.env"; [ -f "$f" ] && grep -qE "^LMSTUDIO_API_KEY=.+" "$f"'`.
