# Guards of split-plan-repair: the plan-machinery amendment that renames the core package and adds the search entrypoint states.
SPLIT_NEW = ["split-plan-repair", "core-scaffold", "core-seam", "search-scaffold", "search-inventory", "search-errors", "search-port-providers", "search-port-fetch", "search-port-engine",
             "search-port-guards", "search-verbs", "search-tracing", "search-hosts", "search-usecases", "search-examples", "tracing-log-validation", "search-cutover", "consumer-relink"]
SPLIT_GONE = ["surface-hosts", "tracing-plugin", "tracing-namespace-proof", "agent-search-cutover", "agent-search-relink"]
SKILL_SCRIPTS = os.path.expanduser("~/.claude/plugins/cache/sox-subagents/workflow/0.8.35/skills/plan-state-machine/scripts")


@check("split-plan-repair", 1)
def _spr1():
    """dag.json holds every state of the amendment (split-plan-repair, core-scaffold, core-seam, search-scaffold, search-inventory, search-errors, search-port-providers, search-port-fetch, search-port-engine, search-port-guards, search-verbs, search-tracing, search-hosts, search-usecases, search-examples, tracing-log-validation, search-cutover, consumer-relink) and none of the retired ones (surface-hosts, tracing-plugin, tracing-namespace-proof, agent-search-cutover, agent-search-relink), whose retirement is recorded as `retire-state` entries in state.json amendment_log; there is no `tracing-validation` phase or state."""
    nodes = (jread(f"{PLAN}/dag.json", {}) or {}).get("nodes", {})
    log = (jread(f"{PLAN}/state.json", {}) or {}).get("amendment_log", [])
    retired = {e.get("state") for e in log if e.get("type") == "retire-state"}
    missing = [s for s in SPLIT_NEW if s not in nodes]
    present = [s for s in SPLIT_GONE if s in nodes]
    return not missing and not present and set(SPLIT_GONE) <= retired and "tracing-validation" not in nodes, f"missing {missing} still present {present} retired logged {sorted(retired)}"


@check("split-plan-repair", 2)
def _spr2():
    """The wiring matches the amendment: core-scaffold depends on split-plan-repair; search-scaffold on core-scaffold and tripwire-pack; search-hosts on search-verbs, search-tracing and core-seam; tracing-log-validation on search-hosts; search-cutover on search-usecases, search-examples, tracing-log-validation and tripwire-pack; consumer-relink on merge-readiness; gates-first on tests-unit-surface, search-usecases, search-examples, tracing-log-validation and search-cutover; merge-readiness on audit-final and tripwire-reverse-migrate (not on consumer-relink); sp-switch on core-seam; prod-errors, prod-examples and tests-unit-surface on core-seam."""
    n = (jread(f"{PLAN}/dag.json", {}) or {}).get("nodes", {})

    def deps(s):
        return set((n.get(s) or {}).get("depends_on", []))
    want = {"core-scaffold": {"split-plan-repair"}, "search-scaffold": {"core-scaffold", "tripwire-pack"}, "search-hosts": {"search-verbs", "search-tracing", "core-seam"},
            "tracing-log-validation": {"search-hosts"}, "search-cutover": {"search-usecases", "search-examples", "tracing-log-validation", "tripwire-pack"}, "consumer-relink": {"merge-readiness"},
            "gates-first": {"tests-unit-surface", "search-usecases", "search-examples", "tracing-log-validation", "search-cutover"}, "merge-readiness": {"audit-final", "tripwire-reverse-migrate"},
            "sp-switch": {"core-seam"}, "prod-errors": {"core-seam"}, "prod-examples": {"core-seam"}, "tests-unit-surface": {"core-seam"}}
    bad = [s for s, w in want.items() if not w <= deps(s)]
    return not bad and "consumer-relink" not in deps("merge-readiness") and bool(n), f"wrong edges {bad}"


@check("split-plan-repair", 3)
def _spr3():
    """scripts/ownership.json has an entry for exactly the states of dag.json (retired entries removed, new states added) and `scripts/check-disjoint.py` exits 0 (no two concurrent states share a path)."""
    own = set(ownership())
    dg = set((jread(f"{PLAN}/dag.json", {}) or {}).get("nodes", {}))
    rc, out = sh([sys.executable, f"{SCRIPTS}/check-disjoint.py"], timeout=300)
    return own == dg and rc == 0, f"ownership-only {sorted(own - dg)} dag-only {sorted(dg - own)} disjoint rc={rc}"


@check("split-plan-repair", 4)
def _spr4():
    """scripts/criteria.json carries exactly the criterion ids that `guard.py --list` registers for the states of dag.json (every marker has a check, every check a marker) and each id's command runs `guard.py <state> --only <id>`."""
    dg = set((jread(f"{PLAN}/dag.json", {}) or {}).get("nodes", {}))
    reg = {cid for s, items in CHECKS.items() if s in dg for cid, _ in items}
    crit = {c["id"]: c for c in (jread(f"{SCRIPTS}/criteria.json", {}) or {}).get("criteria", [])}
    cmd_bad = [i for i, c in crit.items() if f"--only {i}" not in c.get("cmd", "")]
    return set(crit) == reg and not cmd_bad, f"criteria-only {sorted(set(crit) - reg)[:6]} check-only {sorted(reg - set(crit))[:6]} bad cmds {cmd_bad[:3]}"


@check("split-plan-repair", 5)
def _spr5():
    """The plan's own sources agree with three packages: SCOPE.md and README.md name @adhd/stealth-core-browser and @adhd/stealth-search, no longer say 'TWO approved new packages', APPROVAL-split.md exists and quotes the verbatim request (port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search) and the three-package decision, `scaffold.5` and `tripwire-scaffold.5` accept the three project.json files, and `check-guards-red.py` names none of the retired states."""
    scope, readme, appr = read(f"{PLAN}/SCOPE.md"), read(f"{PLAN}/README.md"), read(f"{PLAN}/APPROVAL-split.md")
    red = read(f"{SCRIPTS}/check-guards-red.py")
    doc5 = " ".join((fn.__doc__ or "") for slug, items in CHECKS.items() if slug in ("scaffold", "tripwire-scaffold") for cid, fn in items if cid.endswith(".5"))
    ok = (CORE_PKG in scope and SEARCH_PKG in scope and CORE_PKG in readme and SEARCH_PKG in readme and "TWO approved new packages" not in readme and SPLIT_REQUEST in appr and "three" in appr.lower()
          and "three" in doc5 and not any(s in red for s in SPLIT_GONE))
    return ok, f"scope={CORE_PKG in scope and SEARCH_PKG in scope} readme={CORE_PKG in readme} approval={SPLIT_REQUEST in appr} guards-red clean={not any(s in red for s in SPLIT_GONE)}"


@check("split-plan-repair", 6)
def _spr6():
    """The plan validators pass on the amended plan: `gap-check.js docs/plan/stealth-browser --discover`, `consistency-check.js docs/plan/stealth-browser` and `check-disjoint.py` exit 0, and docs/plan/plan-index.json lists the plan with the new states and mutate_set paths (the corpus verified_at is re-stamped by project-status, not by this state)."""
    rc1, o1 = sh(["node", f"{SKILL_SCRIPTS}/gap-check.js", PLAN, "--discover"], timeout=600)
    rc2, o2 = sh(["node", f"{SKILL_SCRIPTS}/consistency-check.js", PLAN], timeout=600)
    rc3, _ = sh([sys.executable, f"{SCRIPTS}/check-disjoint.py"], timeout=300)
    idx = read("docs/plan/plan-index.json")
    return rc1 == 0 and rc2 == 0 and rc3 == 0 and "search-hosts" in idx and "stealth-core-browser" in idx, f"gap={rc1} consistency={rc2} disjoint={rc3} {o1[-200:]}"


@check("split-plan-repair", 7)
def _spr7():
    """Only owned paths changed by [psm:split-plan-repair] commits (the plan scripts, dag.json, contexts, the plan documents and docs/plan/plan-index.json)."""
    return ownership_ok("split-plan-repair")
