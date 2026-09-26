# adhd Architecture Decision Records

This directory is the **authoritative architecture-decision catalog for the `adhd` repo**. It records decisions that are **settled** — not proposals — and that bind every agent and engineer working here.

> **Why this catalog exists.** `AGENTS.md` cited ADRs (`ADR-0012`, `ADR-0007`, `ADR-0015`) that resolved to a catalog in *another repo* with no in-repo target: every bare `ADR-NNNN` in this repo was dangling (117 lines across 30 files, confirmed 2026-09-24). That defect — the item filed under uid prefix `3f31ccf4` ("NO in-repo `docs/decisions/` ADR catalog despite AGENTS.md citing ADRs") — is closed by this directory. This catalog is the in-repo home.

---

## The two catalogs — and why every reference is repo-qualified

There are **two** ADR catalogs, and their numbers collide by design (both start at `0001`):

| Catalog | Path | Owner |
|---|---|---|
| **adhd** | `docs/decisions/` (this directory) | this repo |
| **sox** | `sox-ecosystem/docs/decisions/` (external; `/Users/nix/dev/ai/sox-ecosystem/docs/decisions/`) | the sox-ecosystem repo |

**A bare `ADR-0012` is ambiguous — both catalogs have one — and is never acceptable again.** The convention, mandatory everywhere in this repo (ADRs, code comments, docs, commit messages):

- **In-repo:** `adhd ADR-0001`, or a relative markdown link `[adhd ADR-0001](./0001-adhd-stores-migrate-to-sox-store-adapter.md)`.
- **Cross-repo:** `sox ADR-0012`, with the source path on first or formal mention (`sox-ecosystem/docs/decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md`).
- A reference to the *other* repo's catalog always names that repo. There is no "the ADR" — only **`adhd ADR-NNNN`** or **`sox ADR-NNNN`**.

This is what makes `AGENTS.md`'s parallel-process hard rule unambiguous: its `ADR-0012` means **`sox ADR-0012`** — the invariant is defined there; it supersedes **`sox ADR-0007`**; and **`sox ADR-0015`** was never accepted.

**Numbering is claimed at authoring time; a proposed ADR in a plan is not a reservation.** Two plans previously proposed `docs/decisions/0001-*` files (`docs/plan/nx-23-upgrade/UPGRADE-PLAN.md`, `docs/plan/push-pr-architecture/PUSH-PR-ARCHITECTURE.md`); those numbers are **not held**. When/if such a proposal is authored, it takes the next free number and the plan's proposed filename is updated at that time.

---

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-adhd-stores-migrate-to-sox-store-adapter.md) | Every adhd store migrates to the sox store adapter (Turso) | ACCEPTED (2026-09-24) |
| [0002](./0002-correct-the-source-never-work-around.md) | Correct the source, never work around a functional gap (adhd ↔ sox) | ACCEPTED (2026-09-24) |
| [0003](./0003-adhd-packages-publish-commonjs-only.md) | `@adhd/*` packages publish CommonJS-only | ACCEPTED (2026-09-25) |
| [0004](./0004-mcp-tool-output-is-the-flat-content-payload.md) | MCP tool output is the flat payload on `content`; no `{result}` envelope | ACCEPTED (2026-09-25) |

---

## Numbering rules

- adhd owns its own `0001+` series. Numbers are **zero-padded to four digits**.
- **Never reuse** a number. A withdrawn or superseded ADR keeps its number forever.
- **Supersession, not deletion.** A decision-changing update is a *new* ADR that `Supersedes:` the old; the old ADR's Status line becomes `SUPERSEDED BY adhd ADR-NNNN`. Nothing is ever deleted.
- Next number = `max(existing NNNN) + 1`.

---

## How to add an ADR

1. **Check the catalog first.** Read every ADR here, and the relevant sox ADRs, before proposing. A request that violates an existing ADR is **rejected**, not accommodated.
2. **Draft from [`TEMPLATE.md`](./TEMPLATE.md).** The full required shape: Status / Owner / Supersedes / Drives / Grounding / TL;DR / Context / Decision / Consequences / Alternatives considered / What does NOT change.
3. **Propose before write.** Do not write an ACCEPTED ADR autonomously: draft it and get the owner's explicit approval. (An owner directive that *is* the approval counts — record it as ACCEPTED and do not re-open it.)
4. **Number it** `max(existing)+1`; name it `NNNN-kebab-title.md`; add it to the Index.
5. **Commit it** with the conventional-commit scope `adr` (e.g. `docs(adr): add adhd ADR-0003 …`).

## Editing an existing ADR

- **Decision-changing update** → a new ADR (`NNNN+1`) that `Supersedes:` the old. Propose both the new ADR and the old ADR's updated Status line; write only after approval.
- **Non-decision correction** (evidence fix, typo, factual error) → propose the edit; write after approval.
- **Never** silently reverse a decision by editing its text.

---

## Format

See [`TEMPLATE.md`](./TEMPLATE.md). Every ADR opens `# ADR-NNNN — <title>` and carries:

- **Status** — `ACCEPTED (YYYY-MM-DD).` (or `PROPOSED`, or `SUPERSEDED BY adhd ADR-NNNN`).
- **Owner**, **Supersedes**, **Drives**, **Grounding**.
- **TL;DR for the next agent** — the highest-value element; include it whenever the decision changes how a future agent works.
- **Context → Decision (D1…Dn) → Consequences → Alternatives considered → What does NOT change.**

This shape is a **superset** of the sox catalog's shape (sox `0009` shows the fuller form; sox `0012`/`0013` the terser one). It matches, and adds to, the strongest elements of both.
