# Guards of the 2026-10-21 delta fold-in (exec()'d into guard.py's globals by the loader, after search_a.py and search_b.py).
#
# Scope: the bug fixes that went into the old agent-search (agent-browser/) after the port inventory (source commits 591e1a7 and c00edea),
# the orchestrator-reported core and error findings, and the commander range decision. The criterion texts live in
# guards/delta-criteria.json (one source for the guard docstring and the context line written by `plan-scaffold.js add-criterion`).
# Every spec-backed check reuses `_bug_ac` (search_a.py): the specs that cite [slug.N] must carry the uids and title tokens, the optional
# source patterns must match, and the unit directory (or the whole project) must run green through nx. Every check is red on a tree where
# the spec does not exist yet and never raises.

DELTA_TEXT = jread(f"{SCRIPTS}/guards/delta-criteria.json", {}) or {}


def _dd(slug, n, fn):
    """Register `fn` as slug.n with the docstring of delta-criteria.json."""
    key = f"{slug}.{n}"
    _sa_def(slug, n, DELTA_TEXT.get(key, key), fn)
    return fn


# ---------------------------------------------------------------- core-seam (state is in progress: proven red by running --only by hand)
CORE_FIXTURE_SPECS = ["test/unit/cdp/browser.spec.ts", "test/unit/lifecycle/kill.spec.ts", "test/unit/lifecycle/launch.spec.ts",
                      "test/unit/lifecycle/concurrent-launch.spec.ts", "test/unit/lifecycle/reaper-scope.spec.ts"]


def _d_sm7():
    return _bug_ac("core", "core-seam", 7, ["591e1a7"], "seam",
                   ["sharedProfile", "Target.createBrowserContext", "Target.closeTarget", "Target.disposeBrowserContext", "browserContextId"],
                   [("src/lib/cdp/targets.ts", r"sharedProfile")])


def _d_sm8():
    return _bug_ac("core", "core-seam", 8, ["591e1a7"], "seam",
                   ["{repo.repository.owner_login}", "<em>", "&amp;", "&quot;", "&#39;", "extractResultsFromEmbeddedJson"],
                   [("src/lib/parsers.ts", r"amp")])


def _d_sm9():
    return _bug_ac("core", "core-seam", 9, ["591e1a7"], "seam", ["-sTCP:LISTEN", "lsof", "execSync", "client"],
                   [("src/lib/cdp/browser.ts", r"-sTCP:LISTEN")], nx_all=True)


def _d_sm10():
    return _bug_ac("core", "core-seam", 10, ["c00edea"], "seam", ["decideRetry", "empty", "legitimate zero results", "onTimeout", "retried"],
                   [("src/lib/capture/bans.ts", r"legitimate zero results")], nx_all=True)


def _d_sm11():
    return _bug_ac("core", "core-seam", 11, [], "seam",
                   ["ChromeReaperConfig", "profileDir", "runChromeReaper", "killChrome", "user-data-dir", "override", "foreign"],
                   [("src/lib/lifecycle/reaper-entry.ts", r"profileDir")], nx_all=True)


def _d_sm12():
    start = _start_ref("core-seam")
    if not start:
        return False, "core-seam has no start_ref"
    bad = []
    for rel in CORE_FIXTURE_SPECS:
        path = f"{CORE_DIR}/{rel}"
        old = blob_at(start, path)
        if old is None or not exists(path):
            bad.append(f"{rel}: missing at the state start or now")
        elif assertion_lines(old) != assertion_lines(read(path)):
            bad.append(f"{rel}: an expect/it/describe line differs from the state start")
    if bad:
        return False, f"specs changed beyond fixtures: {bad}"
    rc, out = nx_run(CORE_PROJECT, "test")
    return rc == 0, f"nx test exit {rc}: {out[-200:]}"


for _n, _f in ((7, _d_sm7), (8, _d_sm8), (9, _d_sm9), (10, _d_sm10), (11, _d_sm11), (12, _d_sm12)):
    _dd("core-seam", _n, _f)


# ---------------------------------------------------------------- prod-errors
def _d_pe9():
    api = code_lines(read(f"{CORE_DIR}/src/api.ts"))
    if re.search(r"\bnew\s+Error\s*\(", api):
        return False, "src/api.ts still constructs a plain Error"
    return _bug_ac("core", "prod-errors", 9, [], "errors",
                   ["launchChrome", "LifecycleError", "LAUNCH_FAILED", "foreign-profile", "LAUNCH_CIRCUIT_OPEN", "retryAfterMs", "cause"])


_dd("prod-errors", 9, _d_pe9)


# ---------------------------------------------------------------- search-inventory
def _d_si7():
    d = jread(SA_INV, {}) or {}
    rows = _sa_rows()
    base = d.get("baseline_commit") if isinstance(d, dict) else None
    if not rows or not base:
        return False, "inventory missing or without baseline_commit"
    not_anc = [c for c in ("591e1a7", "c00edea") if sh(["git", "-C", SA_SRC, "merge-base", "--is-ancestor", c, str(base)])[0] != 0]
    want = [(r"fallbackView|resolveProvider", "search-port-providers", ("fallbackView", "resolveProvider")),
            (r"loginWallResponse|noCaptureOutcome", "search-port-engine", ("loginWallResponse", "noCaptureOutcome")),
            (r"decideRetry", "core-seam", ("decideRetry",)), (r"sharedProfile", "core-seam", ("sharedProfile",)), (r"sTCP|lsof", "core-seam", ("lsof",))]
    miss = []
    for rx, owner, names in want:
        for nm in names:
            if not any(r.get("owner_state") == owner and re.search(nm if nm != "lsof" else r"sTCP|lsof", json.dumps([r.get("symbols"), r.get("feature")])) for r in rows):
                miss.append(f"{nm}->{owner}")
    return not not_anc and not miss, f"baseline lacks fixes {not_anc} unowned deltas {miss}"


_dd("search-inventory", 7, _d_si7)


# ---------------------------------------------------------------- search-errors
def _d_se7():
    doc = read(f"{SEARCH_DIR}/docs/ERRORS.md")
    if not (re.search(r"SEARCH_FAILED[^\n]*strategy-unsupported", doc) and re.search(r"HITL_ABORTED[^\n]*\b2\b", doc)):
        return False, "docs/ERRORS.md lacks the SEARCH_FAILED strategy-unsupported row or the HITL_ABORTED exit 2 row"
    return _bug_ac("search", "search-errors", 7, ["591e1a7"], "errors", ["strategy-unsupported", "SEARCH_FAILED", "HITL_ABORTED", "exitCodeFor"])


_dd("search-errors", 7, _d_se7)


# ---------------------------------------------------------------- search-port-providers
def _d_spp10():
    ty = code_lines(read(f"{SEARCH_DIR}/src/lib/types.ts"))
    ut = code_lines(read(f"{SEARCH_DIR}/src/lib/utils.ts"))
    ok = (all(k in ty for k in ("emptyRequiresLogin", "fallbackNetwork", "sharedProfile", "login_required"))
          and re.search(r"sharedProfile\s*\?\s*:\s*true", ty) is not None and re.search(r"export\s+function\s+fallbackView", ut) is not None)
    if not ok:
        return False, "types.ts/utils.ts lack emptyRequiresLogin, fallbackNetwork, `sharedProfile?: true`, the login_required reason or fallbackView"
    return _bug_ac("search", "search-port-providers", 10, ["591e1a7"], "providers",
                   ["fallbackView", "fallbackNetwork", "emptyRequiresLogin", "sharedProfile", "login_required"])


_dd("search-port-providers", 10, _d_spp10)


# ---------------------------------------------------------------- search-port-engine
_dd("search-port-engine", 11, lambda: _bug_ac("search", "search-port-engine", 11, ["591e1a7"], "engine",
    ["login_required", "loginWallResponse", "return_to", "signed-out", "signed-in", "emptyRequiresLogin"],
    [("src/lib/network.ts", r"loginWallResponse"), ("src/lib/network.ts", r"login_required")]))
_dd("search-port-engine", 12, lambda: _bug_ac("search", "search-port-engine", 12, ["591e1a7"], "engine",
    ["429", "503", "retry-after", "rso", "rate_limited", "select"], [("src/lib/network.ts", r"429")]))
_dd("search-port-engine", 13, lambda: _bug_ac("search", "search-port-engine", 13, ["591e1a7"], "engine",
    ["timeoutMs", "useFakeTimers", "14000", "5000", "30000", "timeout"], [("src/lib/network.ts", r"timeoutMs")]))
_dd("search-port-engine", 14, lambda: _bug_ac("search", "search-port-engine", 14, ["591e1a7"], "engine",
    ["fallbackView", "no DOM strategy config", "index", "dom"]))
_dd("search-port-engine", 15, lambda: _bug_ac("search", "search-port-engine", 15, ["c00edea"], "engine",
    ["noCaptureOutcome", "WebSocket error", "timeout", "empty"], [("src/lib/network.ts", r"noCaptureOutcome")]))


# ---------------------------------------------------------------- search-port-guards
_dd("search-port-guards", 11, lambda: _bug_ac("search", "search-port-guards", 11, ["591e1a7"], "guards",
    ["login_required", "no lock", "gate", "clears", "captcha"], [("src/lib/tripwire.ts", r"login_required")]))


# ---------------------------------------------------------------- search-verbs
_dd("search-verbs", 13, lambda: _bug_ac("search", "search-verbs", 13, ["591e1a7"], "verbs",
    ["login_required", "reveal", "confirmSolved", "pageUrl", "no tripwire", "attempts"], [("src/lib/search.ts", r"login_required")]))
_dd("search-verbs", 14, lambda: _bug_ac("search", "search-verbs", 14, ["591e1a7"], "verbs",
    ["timeoutMs", "networkSearch", "post-challenge", "30000", "12000"], [("src/lib/search.ts", r"timeoutMs")]))
_dd("search-verbs", 15, lambda: _bug_ac("search", "search-verbs", 15, ["591e1a7"], "verbs",
    ["strategy-unsupported", "SEARCH_FAILED", "before any page", "github", "dom"], [("src/lib/search.ts", r"\bthrow\s+strategyUnsupported\s*\(")]))
_dd("search-verbs", 16, lambda: _bug_ac("search", "search-verbs", 16, ["c00edea"], "verbs",
    ["attempts", "empty", "decideRetry", "legitimate zero results", "noCaptureOutcome"], [("src/lib/search.ts", r"decideRetry")]))


# ---------------------------------------------------------------- search-hosts
_dd("search-hosts", 22, lambda: _bug_ac("search", "search-hosts", 22, ["591e1a7"], "hosts",
    ["closed stdin", "hitl", "attempts", "exit 2", "confirmSolved", "isError", "HITL_ABORTED"]))


def _d_sh23():
    t = read(f"{PLAN}/evidence/naming-decision.md")
    m = re.search(r"^COMMANDER:\s*(\^14\.0\.3|none)\b", t, re.M)
    why = "22.12" in t and "^15" in t and "22.5" in t
    if not m or not why:
        return False, f"naming-decision.md COMMANDER line={m.group(1) if m else None} reason names ^15, 22.12 and 22.5={why}"
    deps = pkg_json(SEARCH_DIR).get("dependencies") or {}
    if m.group(1) == "none":
        return "commander" not in deps, f"COMMANDER: none but commander dependency={deps.get('commander')}"
    lock = read("pnpm-lock.yaml")
    blk = re.search(rf"^  {re.escape(SEARCH_DIR)}:\n((?:    .*\n|\n)*)", lock, re.M)
    pinned = blk is not None and re.search(r"commander:\n\s+specifier: \^14\.0\.3\n\s+version: 14\.", blk.group(1)) is not None
    return deps.get("commander") == "^14.0.3" and pinned, f"manifest commander={deps.get('commander')} lock importer pins 14.x={pinned}"


_dd("search-hosts", 23, _d_sh23)
