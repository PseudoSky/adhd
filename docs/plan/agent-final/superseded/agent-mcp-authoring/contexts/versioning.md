# versioning — bump to agent-mcp@2.0.0 + CHANGELOG

**Phase:** compat · **Kind:** work · **Depends on:** compat-shim · **Guard:** `npx --yes nx build agent-mcp && test -f entrypoint/agent-mcp/CHANGELOG.md && grep -qE '^#+ *\[?2\.0\.0' entrypoint/agent-mcp/CHANGELOG.md && grep -qi 'systemPrompt' entrypoint/agent-mcp/CHANGELOG.md`

> **AMA-016 — the version bump has ALREADY landed.** `entrypoint/agent-mcp/package.json`
> is `2.0.0` on `main` and `nx build agent-mcp` is already green, so a bare build guard
> is a no-op that could mark this state complete having done nothing (the `ENV-PLAN-001`
> proxy-evidence failure mode). The guard is therefore compound and **RED at plan start**:
> `CHANGELOG.md` does not yet exist. The state's ONLY real deliverable is authoring that
> CHANGELOG entry. The guard AND-chains build + CHANGELOG existence + a `2.0.0` heading +
> a `systemPrompt` mention; the substantive **permanent compat-shim promise** is enforced
> by the `versioning.1.tooth` audit check.

---

## Goal

The package is released as `agent-mcp@2.0.0` (SPEC §11, §14-F). `package.json` is
bumped to `2.0.0` and `CHANGELOG.md` carries the entry: the required→optional
change to `agent_create.systemPrompt` is breaking for strict-schema callers (hence
the major bump) even though behaviorally additive, and `systemPrompt` remains a
supported **permanent** compat shim across the entire 2.x line. The CHANGELOG
records the new definition lane (discovery + authoring tools, auto-enrichment,
`name`-on-wire) and that the upgrade from 1.0.1 is drop-in for existing runtime
callers — no new required args anywhere on the 11-tool hot path.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [versioning.1] package.json is agent-mcp@2.0.0 with CHANGELOG noting breaking required->optional systemPrompt + permanent compat-shim

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/agent-mcp/package.json", "entrypoint/agent-mcp/CHANGELOG.md"]
```

---

## Notes for executor

- **Docs-only state — no `.ts` changes.** Only `package.json` and `CHANGELOG.md`
  (both in the D3 manifest) change. Do not retouch source here; the behavior was
  landed in `compat-shim` and the authoring/discovery states.
- **The bump is major because of the schema break, not the behavior.**
  `agent_create.systemPrompt` going required→optional breaks strict-schema callers;
  frame the CHANGELOG accordingly so consumers understand the upgrade is otherwise
  drop-in for runtime callers.
- **`systemPrompt` is permanent, not sunset.** Say so explicitly — there is no
  deprecation removal date; it stays a supported compat shim across 2.x.
- **The guard is compound and RED until `CHANGELOG.md` exists** (AMA-016). It is
  `npx --yes nx build agent-mcp && test -f entrypoint/agent-mcp/CHANGELOG.md &&
  grep -qE '^#+ *\[?2\.0\.0' … && grep -qi 'systemPrompt' …`. `nx build` and the
  `package.json` 2.0.0 check are already green (the bump landed on main), so they are
  proxy-only; the CHANGELOG entry is what actually moves the guard green. Trust the nx
  cache — never pass `--skip-nx-cache`. Consider the `changelog-writer` skill to match
  the repo's established CHANGELOG style.
- **The CHANGELOG must state the permanent compat-shim promise on one line**, e.g.
  "`systemPrompt` remains a supported permanent compat shim across 2.x." The
  `versioning.1.tooth` check greps for that promise
  (`systemPrompt.*permanent | permanent.*compat | permanent.*shim | …`); a heading and a
  bare `systemPrompt` mention alone will pass the guard but FAIL the audit tooth.
