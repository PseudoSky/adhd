# release:dry — engine-runtime extract

Command: `pnpm release:dry`, exit code 0 (`/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/rr-dry.rc`). Full log: `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/rr-dry.log`.

## engine-runtime lines

```text
553:✔  nx run apigen-engine-runtime:version --dryRun
1288:✔  nx run apigen-engine-runtime:publish-hygiene  [existing outputs match the cache, left as is]
1399:✔  nx run apigen-engine-runtime:version
1474:✔  nx run apigen-engine-runtime:publish --dryRun
```

No line in the log states a planned version (no `bumping to` or `would write`) for `@adhd/apigen-engine-runtime`; the version dry-run line reports only the task status.

## Final summary

```text
 NX   Successfully ran target publish for 69 projects and 831 tasks they depend on
Nx read the output from the cache instead of running the command for 692 out of 900 tasks.
Output of 900 successful tasks were not shown. Run with --verbose or --output-style=static to see it.
  Run duration:      1m 30s
  Cache:             692/900 hit (77%)
  Critical path:     20.4s (12 tasks)
  Recoverable time:  1m 9s (77% of the run)
  Recommendation: Increase parallelism to recover up to 1m 4s → https://nx.dev/docs/concepts/ci-concepts/parallelization-distribution?utm_source=nx-cli&utm_medium=cli&utm_campaign=performance-report&utm_content=parallelization.
```

Porcelain status before and after the run differs only by the two APPROVAL edits (`/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/rr-status-before.txt`).
