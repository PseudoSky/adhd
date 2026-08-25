# Architecture critiques — cross-cutting assessment

**Inputs:** five independent critiques (`arch-01`…`arch-05`), one per proposed package
structure, each dispatched from a self-contained brief with no knowledge of the other four.
**Caveat on independence:** the critics were asked, not forced, to work from the brief
alone — a `tools` restriction on dispatch is accepted and silently ignored (see
`BUG-DISPATCH-TOOL-SCOPING-UNENFORCED-001`). Tool-use counts were low (2, 7, 2, 8, 4),
consistent with brief-driven reasoning, but blindness is **advisory, not verified**. A
scoped `arch-critic` agent (`tools: Write`) now exists for future runs where it must be.

---

## 1. The finding all five converge on

Each critic, judging a different structure without sight of the others, arrived at the same
class of objection: **the structure specifies arrangement and is silent on obligation.**

| Structure | The silence |
|---|---|
| Hexagonal | No application layer — orchestration has "no single authoritative home," so each host reimplements it |
| Capability-vertical | No shared domain layer — the entities every capability touches get duplicated or smuggled |
| Bounded contexts | "Specifies *who may write which table*, stays silent on *what must be atomic together*" |
| Kernel + extensions | Non-negotiable capabilities behind the same optional mechanism as genuinely optional ones |
| Process-topology | Fixes the *shape* of the wire bug (types) while leaving its *cause* (no lifecycle contract) unaddressed |

**This is the project's own quality factor 5.3 — structural enforcement over convention —
turned back on the proposals.** Every one of these structures reproduces, somewhere else,
the disease it was drawn to cure. Naming a package does not create an invariant; naming a
port does not make its implementation atomic; putting supervision in an `extensions/`
directory does not make a deployment safe to run unattended.

The sharpest statement of it, from the kernel critique: the design "cannot, by inspection of
its own directory structure, tell you whether a given deployment is safe to run unattended."

## 2. The convergence that matters most

Two critics, on different structures, independently reached **the same concrete answer to
the same invariant** — and it matches the conclusion `ROADMAP.md` §5.6 reached from the
storage side.

- **Capability-vertical** (§4): the claim/plan-state invariant "must live in a small shared
  transactional store — Task/Plan/Attempt/claim aggregate — that `plans` and `exclusivity`
  both depend on… costing the design its purity claim, in exchange for the one invariant the
  brief says is mandatory."
- **Bounded contexts** (§4): "merge `work`+`execution` into one physical file for atomic
  claim/dispatch… the cheapest way to get a guarantee you can actually cite instead of hope
  for."
- **ROADMAP §5.6(c)**: integrity-critical state in one file; derived and high-volume data in
  an attached store.

Three independent routes to one conclusion: **the claim and the record of what was done must
commit together, in one physical store, and the structure must not make that awkward.**

That is now the most strongly-supported decision available, and it is a *storage* decision
that constrains the package structure rather than the reverse.

## 3. What each structure specifically costs

**Hexagonal.** Genuinely fixes recoverability — append-only observation log with derived
state as projections directly kills the last-writer-wins data loss, and the critic says so
plainly. But three capabilities have **no home at all**: prompts-as-versioned-software (no
package), cost enforcement as a blocking primitive (no ledger port), and session (not a
domain concept anywhere). The last explains the HITL bug more deeply than the roadmap did:
the planner "has no vocabulary for *this task needs a live session*." Ports also need
*semantics*, not just existence — `claimTask()` specified as atomic returning
`Claimed | AlreadyClaimed`, and `agent-runtime` requiring `healthCheck`/`restart`, or every
adapter author reinvents the reconnect bug as the natural default.

**Capability-vertical.** Best DX, and it fails first exactly where the system is meant to be
strongest: "as soon as claim-write and plan-state-write are not the same transaction, a crash
between them… leaves the two stores inconsistent. It will not show up in tests, because it's
a race between crash timing and two separate commits." The honest version of this structure
has a shared layer underneath — which means its central claim was never true.

**Bounded contexts.** Directionally right; ownership does kill advisory-field rot. Needs one
addition: contexts must declare **what commits together**, not only who writes what. Its §4
recommends doing the storage merge *and* building the reconciler — not as alternatives,
because capability 2's unattended recovery needs a reconciliation loop regardless, so it is
"not extra work."

**Kernel + extensions.** The store/loop split is right. The fatal error is category
collapse: cost caps, supervision, and guards are preconditions for the stated goals, not
optional seams, and putting them behind the same manifest mechanism as providers and
transports means a deployment can silently lack them. Forever-API advice is concrete: build
three *structurally different* extensions (provider, transport, guard) before freezing
`kernel/contracts`, and semver that package independently from day one.

**Process-topology.** The weakest of the five, and instructively so. It solves a types
problem by making process crossings mandatory while supplying no connection-lifecycle
contract — so it "manufactures more places for exactly that failure to recur." Its
alternative is better than the structure it critiques: get the same wire-skew guarantee from
an **orthogonal `runtime:` tag plus a boundary rule**, with zero forced file moves when
topology changes. That fits the repo's existing `domain:`/`layer:`/`platform:` tag
convention.

## 4. Revised recommendation

The earlier position — contexts as skeleton, kernel/extensions for the runtime, hexagonal
ports at three seams — survives in outline and changes in three material ways.

1. **Contexts as the skeleton, with atomicity contracts as first-class.** Each context
   declares what it owns *and* what must commit with what. Ownership alone is what all five
   critiques call insufficient.
2. **The kernel is bigger than proposed.** Store, loop, **budget ledger, supervisor, and
   guard evaluation** are kernel. Extensions are for genuinely optional variation: providers,
   transports, composition strategies, individual healers. The test is not "could this be
   swapped?" but "is a deployment without it still safe to run unattended?"
3. **Add the application layer.** All five critiques point at its absence from different
   angles. It is where orchestration lives so that CLI, MCP, and daemon are views rather than
   three reimplementations — the only way capability 10 becomes structural instead of
   asserted.

Plus three specifics worth adopting verbatim:

- **Session becomes a domain concept**, with a durable port independent of any runtime
  process. Without this the HITL gap is structural, not a wiring bug.
- **Ports specify semantics** — atomic claim, lifecycle with health/restart — because an
  interface that does not force the issue gets the wrong default implementation.
- **Topology via orthogonal tags**, never via package structure.

## 5. What this exercise changed

The five structures were five answers to "how should packages be arranged." The critiques
say, unanimously and from independent directions, that arrangement is the wrong primary
question. **The primary question is which invariants must hold and where they are enforced**;
package structure follows from that, and any structure chosen first will encode the
enforcement gaps of whoever drew it.

The one decision now strongly supported by convergent evidence is the storage one (§2). It
should be settled first, and the package structure derived from it — not the other way
around.
