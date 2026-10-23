# Guards of the 2026-10-23 main-sync amendment (exec()'d into guard.py's globals by the loader, after search_c.py).
#
# Scope: merge main into the branch, conform the three packages to main's test layout (docs/standards/testing.md), the MCP isError
# change (adhd ADR-0018), the tracing reachability fixes, the defect buckets of the orchestrator report, and release readiness.
# Every criterion is described in guards/amend-spec.json ({id: {text, type, p}}); the docstring is the text, the body is the builder named by `type`.
# Every builder is red on an untouched tree: it first requires the state's own work product (a moved directory, a spec citing its id, an evidence file)
# and only then spends an nx run, so scripts/check-guards-red.py stays fast.

AM = jread(f"{SCRIPTS}/guards/amend-spec.json", {}) or {}
AM_PKG = {"tw": (TW, TW_NAME), "core": (CORE_DIR, CORE_PROJECT), "search": (SEARCH_DIR, SEARCH_PROJECT)}
AM_FLOOR = {"tw": 20, "core": 126, "search": 55}  # spec files that existed under src/test before the move (non-spec helpers excluded)
AM_WIRING = "tools/nx-plugins/test/executors/wiring"
AM_TEST_CHILDREN = {"unit", "e2e", "helpers", "fixtures", "golden", "setup.ts"}
AM_HEADER_PARTS = (re.compile(r"\bguards\s*:"), re.compile(r"\btier\s*:\s*S\b"), re.compile(r"\bcites\s*:"))


def _am_ev(slug):
    return f"{PLAN}/evidence/{slug}.md"


def _am_specs(root, sub=""):
    base = f"{root}/test/{sub}".rstrip("/")
    return [f for f in walk(base, (".ts", ".tsx")) if re.search(r"\.spec\.tsx?$", f)]


def _am_ref(slug, n):
    fn = dict(CHECKS.get(slug, [])).get(f"{slug}.{n}")
    return fn() if fn else (False, f"no check {slug}.{n}")


def _am_gate(proj, targets, extra=None):
    for t in targets:
        rc, out = nx_run(proj, t, *(extra or []))
        if rc != 0:
            return False, f"nx run {proj}:{t} exit {rc}: {out[-300:]}"
    return True, "ok"


def _am_scan(script, key):
    """Run a wiring scanner; its violation lines that name this package (the scanners are repo-wide, siblings may still be red)."""
    if not exists(f"{AM_WIRING}/{script}"):
        return False, f"{AM_WIRING}/{script} missing (main not merged)"
    rc, out = sh(["node", f"{AM_WIRING}/{script}"], timeout=900)
    mine = [ln for ln in out.splitlines() if key in ln]
    return rc in (0, 1) and not mine, f"{script} exit {rc}; lines naming {key}: {mine[:4]}"


def am_layout(slug, p):
    root, _ = AM_PKG[p["pkg"]]
    specs = _am_specs(root, "unit")
    stray = [f for f in walk(f"{root}/test/unit", (".ts", ".tsx")) if not re.search(r"\.spec\.tsx?$", f)]
    kids = set(os.listdir(f"{root}/test")) if exists(f"{root}/test") else set()
    odd = sorted(kids - AM_TEST_CHILDREN)
    legacy = walk(f"{root}/src/test", (".ts", ".tsx", ".json", ".html", ".pdf")) if exists(f"{root}/src/test") else []
    ok = not legacy and not exists(f"{root}/src/test") and len(specs) >= AM_FLOOR[p["pkg"]] and not stray and not odd
    return ok, f"src/test files left {len(legacy)}; unit specs {len(specs)} (floor {AM_FLOOR[p['pkg']]}); non-spec files under test/unit {[os.path.relpath(s, root) for s in stray[:4]]}; unknown children of test/ {odd}"


def am_helpers(slug, p):
    root, _ = AM_PKG[p["pkg"]]
    miss = [h for h in p["helpers"] if not exists(f"{root}/test/helpers/{h}")]
    fx = [d for d in p.get("fixtures", []) if not exists(f"{root}/test/fixtures/{d}")]
    inside = [f for f in walk(f"{root}/test/unit", (".html", ".pdf", ".json")) if "/fixtures/" in f]
    return not miss and not fx and not inside, f"helpers missing {miss}; fixture dirs missing {fx}; fixtures still under test/unit {inside[:3]}"


def am_config(slug, p):
    root, _ = AM_PKG[p["pkg"]]
    vite, lib, spec, proj = (read(f"{root}/{n}") for n in ("vite.config.ts", "tsconfig.lib.json", "tsconfig.spec.json", "project.json"))
    bad = []
    if "UNIT_FILE_INCLUDES" not in code_lines(vite) or "e2e-globs" not in vite:
        bad.append("vite.config.ts test.include is not UNIT_FILE_INCLUDES")
    if "src/test" in vite + lib + spec + proj + read(f"{root}/tsconfig.json"):
        bad.append("a config still names src/test")
    if '"test/**"' not in lib:
        bad.append("tsconfig.lib.json does not exclude test/**")
    if "test/**/*.ts" not in spec or "test/**/*.tsx" not in spec:
        bad.append("tsconfig.spec.json does not include test/**/*.ts and test/**/*.tsx")
    for extra in p.get("keep", []):
        if extra not in spec:
            bad.append(f"tsconfig.spec.json lost {extra}")
    return not bad, "; ".join(bad) or "ok"


def am_scanners(slug, p):
    _, proj = AM_PKG[p["pkg"]]
    root = AM_PKG[p["pkg"]][0]
    bad = []
    for script in ("check-test-layout.mjs", "check-test-headers.mjs", "check-skip-expiry.mjs"):
        ok, why = _am_scan(script, root)
        if not ok:
            bad.append(why)
    base = f"{AM_WIRING}/test-headers.baseline.json"
    drift = git("diff", "main", "--", base) if exists(base) else "baseline missing"
    return not bad and not drift, f"{bad}; test-headers.baseline.json differs from main: {bool(drift)}"


def am_headers(slug, p):
    root, _ = AM_PKG[p["pkg"]]
    files = _am_specs(root)
    bad = [f for f in files if not all(rx.search("\n".join(read(f).splitlines()[:60])) for rx in AM_HEADER_PARTS)]
    uncited = [f for f in files if TICKET not in read(f)]
    return len(files) >= AM_FLOOR[p["pkg"]] and not bad and not uncited, f"specs {len(files)}; without a guards/tier S/cites header {[os.path.relpath(b, root) for b in bad[:4]]}; without ticket {len(uncited)}"


def am_docs(slug, p):
    root, _ = AM_PKG[p["pkg"]]
    hits = []
    for f in walk(root, (".ts", ".md", ".json", ".mjs", ".txt")):
        if "/dist/" in f or "node_modules" in f or f.endswith("CHANGELOG.md"):
            continue
        if re.search(r"src/test\b|src/__tests__|\.e2e\.test\.", read(f)):
            hits.append(os.path.relpath(f, root))
    return exists(f"{root}/test") and not hits, f"files still naming src/test: {hits[:6]}"


def am_gates(slug, p):
    root, proj = AM_PKG[p["pkg"]]
    if not exists(_am_ev(slug)):
        return False, f"evidence/{slug}.md missing (the state's own record, written before the gates)"
    return _am_gate(proj, p["targets"])


def am_regress(slug, p):
    ok, why = _am_ref(slug, p["after"])
    if not ok:
        return False, f"{slug}.{p['after']} red: {why[:120]}"
    bad = []
    for s in p["states"]:
        rc, out = sh([sys.executable, f"{SCRIPTS}/guard.py", s], timeout=3000)
        if rc != 0:
            bad.append(f"{s}(rc={rc}): {out.strip()[-120:]}")
    return not bad, f"regressed completed states: {bad}"


def am_own(slug, p):
    return ownership_ok(slug)


def am_evidence(slug, p):
    t = read(f"{PLAN}/{p['file']}")
    miss = [k for k in p["tokens"] if k not in t]
    return bool(t) and not miss, f"{p['file']} present={bool(t)} missing tokens {miss}"


def am_text(slug, p):
    """present: every (path, regex) matches the comment-stripped file; absent: none matches."""
    bad = []
    for rel, rx in p.get("present", []):
        if not re.search(rx, code_lines(read(rel)), re.M):
            bad.append(f"{rel}: missing /{rx}/")
    for rel, rx in p.get("absent", []):
        if not exists(rel):
            bad.append(f"{rel}: missing (the file the fix lives in does not exist yet)")
            continue
        files = walk(rel, (".ts", ".md")) if os.path.isdir(rel) else [rel]
        for f in files:
            if exists(f) and re.search(rx, code_lines(read(f)), re.M):
                bad.append(f"{f}: still has /{rx}/")
    return not bad, "; ".join(bad[:5]) or "ok"


def am_spec(slug, p):
    """A spec under <pkg>/test/<sub> cites [slug.N] and the ticket, carries every uid and token, source/spec patterns hold, it is green through nx (repeat times uncached)."""
    root, proj = AM_PKG[p["pkg"]]
    n = p["n"]
    tag = f"[{slug}.{n}]"
    specs = [f for f in _am_specs(root, p["sub"]) if tag in read(f)]
    if not specs:
        return False, f"no spec under {root}/test/{p['sub']} cites {tag}"
    txt = "\n".join(read(f) for f in specs)
    low = txt.lower()
    miss = [t for t in p.get("uids", []) + p.get("tokens", []) if t.lower() not in low]
    ok, why = cites(specs, slug)
    bad = []
    for rel, rx in p.get("present", []):
        if not re.search(rx, code_lines(read(f"{root}/{rel}")), re.M):
            bad.append(f"{rel}: missing /{rx}/")
    for rel, rx in p.get("absent", []):
        if re.search(rx, code_lines(read(f"{root}/{rel}")), re.M):
            bad.append(f"{rel}: still has /{rx}/")
    for rx in p.get("absent_in_specs", []):
        hit = [os.path.relpath(f, root) for f in specs if re.search(rx, code_lines(read(f)), re.M)]
        if hit:
            bad.append(f"spec has /{rx}/: {hit}")
    for rx in p.get("absent_in_tests", []):
        hit = [os.path.relpath(f, root) for f in _am_specs(root) if re.search(rx, code_lines(read(f)), re.M)]
        if hit:
            bad.append(f"tests have /{rx}/: {hit[:3]}")
    if miss or not ok or bad:
        return False, f"tokens missing {miss} {why} {bad}"
    extra = ["--skip-nx-cache"] if p.get("repeat", 1) > 1 else []
    for _ in range(p.get("repeat", 1)):
        rc, out = nx_run(proj, "test", "--", f"test/{p['sub']}", *extra)
        if rc != 0:
            return False, f"nx test exit {rc}: {out[-250:]}"
    return True, "ok"


def am_repeat_guard(slug, p):
    if not exists(_am_ev(slug)) or "root cause" not in read(_am_ev(slug)).lower():
        return False, f"evidence/{slug}.md must name the root cause"
    for i in range(p["times"]):
        rc, out = sh([sys.executable, f"{SCRIPTS}/guard.py", p["state"], "--only", p["only"]], timeout=3000)
        if rc != 0:
            return False, f"run {i + 1}/{p['times']} of {p['only']} exit {rc}: {out.strip()[-200:]}"
    return True, "ok"


# ---------------------------------------------------------------- main-merge
def _am_merge():
    main = (read(_am_ev("main-merge")).split("MAIN-SHA:")[-1].split()[:1] or [""])[0] if "MAIN-SHA:" in read(_am_ev("main-merge")) else git("rev-parse", "main")
    if not main or sh(["git", "merge-base", "--is-ancestor", main, "HEAD"])[0] != 0:
        return None, main
    for ln in git("rev-list", "--merges", "--parents", f"{main}..HEAD").splitlines():
        parts = ln.split()
        if main in parts[1:]:
            return parts[0], main
    return None, main


def am_merge_commit(slug, p):
    m, main = _am_merge()
    return bool(m), f"no merge commit on HEAD has main {main[:9]} as a parent"


def am_merge_union(slug, p):
    ok, why = _am_ref("main-merge", 1)
    if not ok:
        return False, why
    ws, tb = read(".adhd/workspace.json"), read("tsconfig.base.json")
    bad = [f for f in (".adhd/workspace.json", "tsconfig.base.json", "pnpm-lock.yaml") if re.search(r"^(<<<<<<<|>>>>>>>)", read(f), re.M)]
    groups = [g for g in ("policy", "resilience", "stealth") if f'"{g}"' not in ws]
    paths = [x for x in ("@adhd/policy-core-client", "@adhd/policy", "@adhd/apigen-plugin-policy", TW_PKG, CORE_PKG, SEARCH_PKG) if f'"{x}"' not in tb]
    valid = all(jread(f) is not None for f in (".adhd/workspace.json",)) and "parity-harness" in tb
    return not bad and not groups and not paths and valid, f"conflict markers {bad}; workspace groups missing {groups}; tsconfig paths missing {paths}; workspace.json parses={valid}"


def am_merge_lock(slug, p):
    ok, why = _am_ref("main-merge", 1)
    if not ok:
        return False, why
    rc, out = sh(["pnpm", "install", "--frozen-lockfile"], timeout=1800)
    lock = read("pnpm-lock.yaml")
    proxy = re.search(r"'?@adhd/sox-service-proxy'?:\s*\n\s+specifier:\s*~?\^?0\.6", lock) is not None or "sox-service-proxy@0.6" in lock
    return rc == 0 and proxy and "adhd-dev-tarballs" not in lock and "file:/Users" not in lock and PROXY_PKG not in root_overrides(), f"pnpm install --frozen-lockfile exit {rc} {out[-160:]!r}; proxy 0.6.x resolved={proxy}"


def am_merge_build(slug, p):
    ok, why = _am_ref("main-merge", 1)
    if not ok:
        return False, why
    for t in ("build", "typecheck"):
        rc, out = sh([NX, "run-many", "-t", t, "-p", f"{CORE_PROJECT},{SEARCH_PROJECT},{TW_NAME}"], timeout=3000)
        if rc != 0:
            return False, f"nx run-many -t {t} exit {rc}: {out[-250:]}"
    return True, "ok"


def am_merge_own(slug, p):
    m, main = _am_merge()
    if not m:
        return False, "no merge commit yet"
    a = set(git("diff", "--name-only", f"{m}^1", m).splitlines())
    b = set(git("diff", "--name-only", f"{m}^2", m).splitlines())
    owned = ownership().get("main-merge", [])
    extra = [f for f in sorted(a & b) if f not in owned]
    o = ownership_ok("main-merge")
    return not extra and o[0], f"resolution edits outside the owned files: {extra[:6]}; {o[1]}"


# ---------------------------------------------------------------- tracing-log-validation re-run guards (appended criteria)
def am_tlv_fresh(slug, p):
    done = ((state().get("states") or {}).get("search-tracing-fixes") or {}).get("done_at") or ""
    ev = jread(f"{PLAN}/evidence/tracing-log-validation.json", {}) or {}
    started = ((state().get("states") or {}).get("tracing-log-validation") or {}).get("started_at") or ""
    return state_status("search-tracing-fixes") == "complete" and bool(done) and str(ev.get("validated_at", "")) > done, f"search-tracing-fixes complete={state_status('search-tracing-fixes')} done_at={done} validated_at={ev.get('validated_at')!r}"


def am_tlv_reach(slug, p):
    ev = jread(f"{PLAN}/evidence/tracing-log-validation.json", {}) or {}
    names = {c.get("name"): c for c in ev.get("checks", []) if isinstance(c, dict)}
    need = ("cli_unknown_provider_span", "mcp_unknown_provider_span", "cli_rejected_flag_span", "help_is_not_a_dispatch")
    miss = [n for n in need if names.get(n, {}).get("status") != "PASS" or not names.get(n, {}).get("sample_lines")]
    cmds = json.dumps(ev.get("commands_run", [])) + json.dumps(ev.get("mcp_calls", []))
    dup = [ln for c in ev.get("checks", []) if isinstance(c, dict) for ln in c.get("sample_lines", []) if '"adhd.op":"op"' in str(ln).replace(" ", "")]
    return not miss and ev.get("process_spawn_mocked") is True and "9222" not in cmds and ev.get("real_chrome_launched") is False and '"input"' in cmds and not dup, f"checks missing/not PASS {miss}; spawn mocked={ev.get('process_spawn_mocked')}; 9222 used={'9222' in cmds}; data.input envelope used={'\"input\"' in cmds}; bogus op id lines {len(dup)}"


AM_FN = {
    "layout": am_layout, "helpers": am_helpers, "config": am_config, "scanners": am_scanners, "headers": am_headers, "docs": am_docs, "gates": am_gates,
    "regress": am_regress, "own": am_own, "evidence": am_evidence, "text": am_text, "spec": am_spec, "repeat_guard": am_repeat_guard,
    "merge_commit": am_merge_commit, "merge_union": am_merge_union, "merge_lock": am_merge_lock, "merge_build": am_merge_build, "merge_own": am_merge_own,
    "tlv_fresh": am_tlv_fresh, "tlv_reach": am_tlv_reach,
}


def _am_register(cid, entry):
    slug, n = cid.rsplit(".", 1)
    fn_impl, params = AM_FN[entry["type"]], dict(entry.get("p", {}))
    params["n"] = int(n)

    def fn():
        return fn_impl(slug, params)
    fn.__doc__ = entry["text"]
    check(slug, int(n))(fn)


for _cid, _entry in AM.items():
    _am_register(_cid, _entry)
