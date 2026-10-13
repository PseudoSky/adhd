# audit-fixes — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** audit-pre-review · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-fixes`

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
mutates:    ["packages/stealth/stealth-core-browser/", "entrypoint/stealth-search/", "/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW-RESOLUTION.json", "/Users/nix/dev/ai/scratch/agent-browser/adhd/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts", "/Users/nix/dev/ai/scratch/agent-browser/cdp-search.ts", "/Users/nix/dev/ai/scratch/agent-browser/chrome-lifecycle-test.ts", "/Users/nix/dev/ai/scratch/agent-browser/network-capture.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-challenge.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-dom.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-fetch.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-guard-test.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-network.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-tripwire.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/activity.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/context.ts", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/last-search.ts", "/Users/nix/dev/ai/scratch/agent-browser/package.json", "/Users/nix/dev/ai/scratch/agent-browser/AGENTS.md", "/Users/nix/dev/ai/scratch/agent-browser/SEARCH.md", "/Users/nix/dev/ai/scratch/agent-browser/FEATURES.md", "/Users/nix/dev/ai/scratch/agent-browser/FETCH.md", "/Users/nix/dev/ai/scratch/agent-browser/docs/", "packages/resilience/resilience-core-tripwire/"]
```

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; ONE implementer resolves every pre-review finding
