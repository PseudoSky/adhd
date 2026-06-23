---
name: ticket-creation
description: >
  Use this skill any time you need to create a SOX ticket. Covers title format,
  description quality, acceptance criteria, testing scenarios, priority, parent/epic
  linking, tags, and the correct sox state create invocation. Required reading before
  calling sox state create for any non-trivial ticket.
---

# Ticket Creation Skill

Use this skill every time you create a SOX ticket. A well-formed ticket is one that an implementer can pick up cold — without asking questions — and produce exactly the right output.

---

## Pre-creation checklist

Before writing anything, answer these:

1. **Does this ticket already exist?** Run `sox state list --role <role>` and scan titles. Duplicates waste cycles and confuse metrics.
2. **Should this be a child of an existing EPIC?** If yes, use `--parent <epic-id>`.
3. **Is this blocked by another ticket?** If yes, use `--blocked-by <id>`.
4. **What role owns this?** Match the work type, not the reporter's role.
5. **What would prove this is done?** Write acceptance criteria before anything else — they shape the title and description.

---

## Title

**Format:** `<component>: <what is wrong or what needs to happen> — <observable impact or consequence>`

Keep it under 100 characters. The title is the first thing an implementer reads. It must communicate the area, the problem, and why it matters.

**Good titles:**

```text
autoRollupEpic(): missing cascadeUnblock call — tickets blocked-by an EPIC never auto-unblock
EventLog.append(): lockSync has no retries — ELOCKED crashes sox state under concurrent writes
supervisor: bootFailedCounts key mismatch between spawner and daemon — threshold check is dead code
packages/state: transaction rollback does not restore blocked_by — downstream deps left dangling
```

**Bad titles:**

```text
Fix the epic rollup bug
Update locking
ENGIN-0079 follow-up
```

---

## Type

| Type | When |
|---|---|
| `BUG` | Observed incorrect behaviour. Root cause identified. Fix known. |
| `STORY` | New user-facing capability. Acceptance criteria define "done". |
| `TASK` | Internal improvement, refactor, or infrastructure change. |
| `CHORE` | Routine maintenance: dependency bumps, config cleanup, dead code removal. |
| `SPIKE` | Time-boxed investigation. Output is a finding, not code. |
| `EPIC` | Umbrella for a set of related tickets. Children link to it via `--parent`. |
| `REVIEW` | Explicit review assignment (rare — usually handled by routing flags). |

---

## Priority

| Priority | Meaning |
|---|---|
| `P1` | System-breaking. Data corruption or permanent data loss possible. |
| `P2` | Significant. Causes observable failures in normal operation. |
| `P3` | Moderate. Wrong behaviour in edge cases or degraded-but-functional operation. |
| `P4` | Low. Cosmetic, technical debt, or code smell with no runtime impact. |
| `P5` | Wishlist. Nice to have when time permits. |

When in doubt between two priorities, pick the higher one. Under-prioritised bugs sit in the queue too long.

---

## Description

The description must contain four things.

**1. The symptom** — what observable behaviour is wrong or missing:

```text
In tools/cli/state/commands/cmd-finish.js, autoRollupEpic() (lines 304-381)
transitions an EPIC to DONE but never calls cascadeUnblock(). Any ticket with
blocked_by containing the EPIC's ID is never automatically promoted to READY.
```

**2. The root cause** — the specific code responsible:

```javascript
writeTicketJSON(ctoDir, parentId, { ...parentT, state: "DONE", finished_at: now });
// ← NO cascadeUnblock call here
```

**3. The impact** — what breaks, who is affected, how severely:

```text
Tickets blocked by an EPIC stay in blocked[] indefinitely after the EPIC auto-rolls up.
Only the periodic reconcileBlockedPromotion scan would eventually rescue them — not
immediately on EPIC completion. This silently breaks any workflow that gates work behind an EPIC.
```

**4. The fix direction** — what the implementer should do:

```text
Add cascadeUnblock(ctoDir, parentId, workerId) inside autoRollupEpic() after the DONE
writes. cascadeUnblock is already imported in cmd-finish.js. Pass workerId as a parameter
to autoRollupEpic — it is available at the call site in cmdFinish.
```

Do not write vague descriptions. An implementer reading a vague description will implement a different fix than you intended.

---

## Acceptance criteria

Each criterion must be independently verifiable by a reviewer without ambiguity.

**Good criteria:**

```text
After autoRollupEpic() transitions an EPIC to DONE, any ticket whose blocked_by contains
the EPIC ID is immediately promoted to ready[]

cascadeUnblock is called with parentId and the triggering workerId inside autoRollupEpic
after writing DONE state

Normal cmdFinish Path B and cmdGate terminal path are unaffected

A scenario test is added covering: EPIC + downstream blocked ticket → finish all children
→ assert downstream ticket moves to ready[] automatically
```

**Bad criteria:**

```text
The bug is fixed
Code is clean and well-documented
Performance is acceptable
```

Every criterion becomes a row in the reviewer's checklist. If a criterion cannot be verified by a code read or a test run, rewrite it.

---

## Testing scenarios (required for state-machine and package API tickets)

For any ticket touching state transitions, queue operations, or cross-package data, include a `Testing scenarios` section in the description. This section drives both the implementer's scenario test and the reviewer's verification.

**What to include per scenario:**

```text
Testing scenarios:

Scenario A — normal rollup with downstream blocked ticket:
  Setup:   EPIC IN_PROGRESS, two children DONE, one ticket with blocked_by=[EPIC-ID]
  Operate: trigger autoRollupEpic (finish the last child)
  Assert:  EPIC state=DONE, downstream ticket in ready[], no duplicate in done[],
           assertQueueInvariants passes

Scenario B — concurrent children finishing simultaneously:
  Setup:   EPIC with two children both transitioning to DONE concurrently
  Operate: two simultaneous cmdFinish calls against the same parent EPIC
  Assert:  EPIC appears exactly once in done[], EPIC_DONE fires exactly once
```

For package tickets, describe in-memory fixtures rather than file fixtures:

```text
Scenario A — rollback restores blocked_by:
  Setup:   transaction with two operations; second operation fails
  Operate: rollback()
  Assert:  blocked_by array is restored to pre-transaction value; no orphan entries
```

The scenario section does not need to be code — it describes the logical test case. The implementer translates it into a Tier 2 scenario test following `docs/standards/TESTING-IMPLEMENTATION.md`. Tickets touching only pure utility functions may omit scenarios and use function tests instead.

---

## Where tests live (reference)

| Change type | Test location | Harness |
|---|---|---|
| `tools/cli/` change | `tests/unit/sox-<feature>.test.js` | `node --test` |
| `packages/<name>/` change | `packages/<name>/src/lib/<module>.spec.ts` | vitest |
| Cross-package integration | `tests/unit/<workflow>.test.js` | `node --test` |
| Full e2e (supervisor) | `tests/e2e/` | `node --test` + real Claude |

---

## Parent and EPIC linking

**Create a ticket as a child of an EPIC:**

```bash
sox state create --role engineering --type BUG --parent EPIC-0062 \
  --title "..." --description "..."
```

**Link an existing ticket to an EPIC after creation:**

```bash
sox state link --from ENGIN-0079 --to EPIC-0062 --type parent
```

Use `--force` if the ticket already has a different parent.

**Declare a blocking dependency:**

```bash
sox state create ... --blocked-by ENGIN-0042,ENGIN-0043
```

The ticket starts in `blocked[]` and is automatically promoted to `ready[]` when all blocking tickets finish.

---

## Tags

Tags are matched by routing rules to route tickets to specialists.

| Domain | Tags |
|---|---|
| Supervisor / daemon | `supervisor`, `daemon`, `spawner`, `lifecycle` |
| State machine | `state`, `cmd-finish`, `cmd-claim`, `cmd-gate`, `locking` |
| Event log | `event-log`, `live-log` |
| Queue operations | `queue`, `role-json`, `epic`, `cascade`, `blocked` |
| Package code | `packages`, `execution-graph`, `state`, `workflow-graph` (use package name) |
| Testing | `testing`, `scenario`, `invariant`, `e2e` |
| CLI infrastructure | `cli`, `routing`, `team` |
| Concurrency / races | `concurrency`, `race`, `locking` |

---

## The full `sox state create` invocation

```bash
sox state create \
  --role <engineering|qa|ops|...> \
  --type <BUG|STORY|TASK|CHORE|SPIKE|EPIC> \
  --priority <P1|P2|P3|P4|P5> \
  --title "<component>: <what> — <impact>" \
  --description "$(cat <<'EOF'
<symptom>

<root cause with code reference>

<impact>

<fix direction>

Testing scenarios:

Scenario A — <name>:
  Setup:   <state>
  Operate: <operation>
  Assert:  <expected system state including downstream effects>
EOF
)" \
  --criteria "<criterion 1>" \
  --criteria "<criterion 2>" \
  --criteria "Scenario test added covering: <scenario A description>" \
  [--parent <EPIC-id>] \
  [--blocked-by <id>[,<id>]] \
  [--tag <tag>] [--tag <tag>] \
  [--assigned-to <agent-name>]
```

Always include at least one `--criteria` that explicitly requires the scenario test. This makes the test a named, reviewable acceptance criterion — not an afterthought.

---

## After creation

1. Note the returned `ticket_id`.
2. Verify parent linkage if applicable: `sox state context --ticket <id> | jq .parent_ticket`
3. If created as an out-of-scope finding during a review, reference the new ticket ID in your gate verdict notes before approving.
4. If creating a group of related tickets, create the EPIC first and use `--parent` on each child.
