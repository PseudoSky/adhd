---
name: "Anti-pattern: environment-variable / config-flag toggles for optional behavior"
topic: "cbr-antipatterns"
tags: ["pattern:antipattern", "feature-flags", "configuration", "env-vars"]
summary: "Using an environment variable or ad-hoc config flag to switch optional behavior is discouraged for anything but the simplest, deploy-time-static cases: env-var config is unwieldy to coordinate across processes, requires a redeploy or process restart to change, needs privileged access, and adds a validation matrix (every flag doubles the states to test). Feature-toggling is a discipline with categories, not a boolean."
importance: 7
type: best-practice
data_quality: verified
---

# content

name: Anti-pattern — env-var / config-flag toggle for optional behavior
description: Reaching for an environment variable (or a bare config boolean) to enable/disable an optional code path. Hodgson's "Feature Toggles" treats parameterized (env-var/CLI) toggle configuration as the lowest tier of a spectrum and documents its specific limitations; "prefer static configuration" is the stated rule.

why_it_fails:
  - Coordination: "unwieldy to coordinate configuration across a large number of processes" — the more processes, the worse, and a multi-process writer deployment is exactly that case.
  - Change cost: "changes to a toggle's configuration require either a re-deploy or at the very least a process restart (and probably privileged access to servers by the person re-configuring the toggle)."
  - Testing burden: a feature-flagged system must be validated in both On and Off states; multiple toggles produce a combinatorial explosion of states to test. A single toggle already "doubles up" testing.
  - Silent divergence: an env var set on one process but not another makes behavior non-uniform and non-reproducible, and env-var state is invisible in code review.

what_to_do_instead:
  - Prefer static configuration under source control ("Managing toggle configuration via source control and re-deployments is preferable, if the nature of the feature flag allows it") — it moves through the pipeline exactly like code and is reproducible.
  - If the flag is inherent and long-lived, use the disciplined toggle patterns: decouple the decision POINT from the decision LOGIC (a `FeatureDecisions` object / dependency injection), and prefer a Strategy (inject an enhancer vs an identity function) over scattered if/else.
  - Expose the current toggle configuration so an operator can discover what is actually live.
  - If a toggle is genuinely dynamic (ops kill-switch), use a real toggle-configuration store, not a bare env var.

strengths: (none — anti-pattern entry)
weaknesses:
  - Nuance: env vars are fine for genuinely deploy-time-static, single-process, non-optional configuration. The anti-pattern is using them for OPTIONAL BEHAVIOR that varies by context or must be changed without a restart.

references:
  - Hodgson, P. (2017). "Feature Toggles (aka Feature Flags)." martinfowler.com. https://martinfowler.com/articles/feature-toggles.html (fetched 2026-09-25; categories, static-vs-dynamic, "prefer static configuration", the env-var limitations, the testing-complexity section).
source:
  - martinfowler.com Feature Toggles article
data_quality: verified
type: best-practice
tags:
  - pattern:antipattern
  - feature-flags
  - configuration
  - env-vars
summary: "Env-var/config toggles for optional behavior are hard to coordinate across processes, need a redeploy/restart + privileged access to change, and multiply the test-state matrix. Prefer static config under source control; for real flags use decoupled decision points (DI/Strategy) + an exposed config, not a bare env var. Hodgson/martinfowler."
---

## Confidence
**HIGH** — read directly from the primary source (martinfowler.com, Pete Hodgson, 2017), with
verbatim quotes for the coordination/restart/testing claims.
