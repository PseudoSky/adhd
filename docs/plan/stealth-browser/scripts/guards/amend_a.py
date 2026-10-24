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
        rc, out = nx_run(proj, "test", *extra, "--", f"test/{p['sub']}")
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
    # the shared apigen tracing plugin emits one documented upstream twin, event `adhd.op.error` with op id `op`; it is the only tolerated record carrying that op id
    def _bogus_op(ln):
        t = str(ln).replace(" ", "")
        return '"adhd.op":"op"' in t and '"event":"adhd.op.error"' not in t
    dup = [ln for c in ev.get("checks", []) if isinstance(c, dict) for ln in c.get("sample_lines", []) if _bogus_op(ln)]
    return not miss and ev.get("process_spawn_mocked") is True and "9222" not in cmds and ev.get("real_chrome_launched") is False and '"input"' in cmds and not dup, f"checks missing/not PASS {miss}; spawn mocked={ev.get('process_spawn_mocked')}; 9222 used={'9222' in cmds}; data.input envelope used={'\"input\"' in cmds}; bogus op id lines {len(dup)}"


# ---------------------------------------------------------------- release amendment: release-gate-fixes + release-readiness .1/.5/.6
RGF_WIRING_SRC = f"{AM_WIRING}/check-test-wiring.mjs"
RGF_DRY_CACHE = f"{PLAN}/evidence/release-gate-fixes.dry.json"
# paths the heavy release:dry comparison and cache key ignore: plan bookkeeping that every state legitimately rewrites
RGF_BOOKKEEPING = (f"{PLAN}/events.ndjson", f"{PLAN}/state.json", f"{PLAN}/evidence/", "docs/plan/plan-index.json")
RR_BASELINE = "6034633c6"  # the commit whose APPROVAL documents carry the human's verbatim quotes
_SEMVER = re.compile(r"^\^?(\d+)\.(\d+)\.(\d+)$")


def _semver(v):
    m = _SEMVER.match(str(v or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def _rgf_bookkeeping(path):
    return any(path == b or (b.endswith("/") and path.startswith(b)) for b in RGF_BOOKKEEPING)


def _rgf_dirty():
    """{path: git blob hash of the working file or 'deleted'} for every modified or untracked path outside the bookkeeping set."""
    out = {}
    names = set(git("diff", "HEAD", "--name-only").splitlines()) | set(git("ls-files", "--others", "--exclude-standard").splitlines())
    for f in sorted(n for n in names if n and not _rgf_bookkeeping(n)):
        out[f] = git("hash-object", "--", f) if exists(f) else "deleted"
    return out


def _rgf_key(dirty):
    """Identity of the code the dry run sees: HEAD's tree minus docs/plan (the cache file lives there, committing it must not invalidate it) plus every dirty path's content."""
    head = git("ls-tree", "-r", "HEAD", "--", ".", ":(exclude)docs/plan")
    return hashlib.sha256((head + "\n" + json.dumps(dirty, sort_keys=True)).encode()).hexdigest()


def _rgf_dry_cached():
    c = jread(RGF_DRY_CACHE, {}) or {}
    key = _rgf_key(_rgf_dirty())
    return c.get("key") == key and c.get("rc") == 0 and c.get("clean") is True, f"cached dry run key match={c.get('key') == key} rc={c.get('rc')} clean={c.get('clean')}"


def _rgf_dry_static():
    """package.json `release:dry` exports ADHD_NX_VERSION_DRY_RUN=1 before its first command, so every nx invocation of the chain (build, version, publish) inherits it."""
    s = ((jread("package.json", {}) or {}).get("scripts") or {}).get("release:dry", "")
    return re.match(r"\s*export\s+ADHD_NX_VERSION_DRY_RUN=1\s*(&&|;)", s) is not None, "package.json scripts['release:dry'] must begin with `export ADHD_NX_VERSION_DRY_RUN=1 &&`"


def _rgf_spec_core(slug, n, spec, tokens):
    path = f"{AM_WIRING}/{spec}"
    if not exists(path):
        return False, f"{path} missing"
    txt = read(path)
    bad = []
    if not all(rx.search("\n".join(txt.splitlines()[:60])) for rx in AM_HEADER_PARTS):
        bad.append("header lacks guards:/tier: S/cites: in its first 60 lines")
    if TICKET not in txt or f"[{slug}.{n}]" not in txt:
        bad.append(f"does not cite {TICKET} and [{slug}.{n}]")
    miss = [t for t in tokens if t.lower() not in txt.lower()]
    if miss:
        bad.append(f"missing tokens {miss}")
    if f"{AM_WIRING}/{spec}" not in ((jread("package.json", {}) or {}).get("scripts") or {}).get("test:build-tools", ""):
        bad.append("not listed in package.json scripts['test:build-tools'] (the lane that runs it)")
    return not bad, "; ".join(bad) or "ok"


def am_rgf_spec(slug, p):
    """A wiring spec exists with the testing-standard header, cites its criterion id, carries its tokens, is in the test:build-tools lane, passes `node --test`, and check-lane-reachability stays 0."""
    n = p["n"]
    ok, why = _rgf_spec_core(slug, n, p["spec"], p.get("tokens", []))
    if not ok:
        return False, why
    if p.get("static") == "dry":
        ok, why = _rgf_dry_static()
        if not ok:
            return False, why
    rc, out = sh(["node", "--test", f"{AM_WIRING}/{p['spec']}"], timeout=600)
    if rc != 0:
        return False, f"node --test {p['spec']} exit {rc}: {out[-250:]}"
    rc, out = sh(["node", f"{AM_WIRING}/check-lane-reachability.mjs"], timeout=300)
    return rc == 0, f"check-lane-reachability exit {rc}: {out[-200:]}"


def am_rgf_wiring(slug, p):
    """check-test-wiring.mjs honours plugin-inferred `test` targets through the project graph, keeps its failing exit and has no project allow-list, and exits 0 on the tree."""
    if not exists(f"{AM_WIRING}/check-test-wiring.spec.mjs"):
        return False, "check-test-wiring.spec.mjs missing (the fix's own proof)"
    src = code_lines(read(RGF_WIRING_SRC))
    bad = []
    if not re.search(r"project[-_ ]?graph|createProjectGraph\w*|readCachedProjectGraph|show\W+project", src, re.I):
        bad.append("does not consult the Nx project graph / `nx show project` for inferred targets")
    if "process.exit(1)" not in src:
        bad.append("lost its exit 1 on a gap (gate relaxed)")
    if re.search(r"agent-store-(runtime|prompts)", src):
        bad.append("names agent-store-* (allow-list instead of a root-cause fix)")
    if bad:
        return False, "; ".join(bad)
    rc, out = sh(["node", RGF_WIRING_SRC], timeout=600)
    return rc == 0, f"check-test-wiring exit {rc}: {out[-250:]}"


def am_rgf_dry(slug, p):
    """`pnpm release:dry` with ADHD_NX_VERSION_DRY_RUN NOT pre-set exits 0, does real dry work (not 'nothing to version/publish'), and leaves `git status --porcelain` identical (bookkeeping paths ignored); a passing run is cached by code identity in evidence/release-gate-fixes.dry.json."""
    ok, why = _rgf_dry_static()
    if not ok:
        return False, why
    pre = [f for f in (f"{AM_WIRING}/check-test-wiring.spec.mjs", f"{AM_WIRING}/release-dry-clean.spec.mjs", _am_ev("release-gate-fixes")) if not exists(f)]
    if pre:
        return False, f"work product missing before the heavy run: {pre}"
    rc, out = sh(["node", RGF_WIRING_SRC], timeout=300)
    if rc != 0:
        return False, f"check-test-wiring exit {rc} (fix 1 not in): {out[-160:]}"
    if re.search(r"""['"]tests['"]\s*,\s*['"]fixtures['"]""", read("entrypoint/decompile-cli/test/unit/lib/validators/local/index.spec.ts")):
        return False, "decompile-cli index.spec.ts still builds the old fixtures path (fix 3 not in)"
    before = _rgf_dirty()
    key = _rgf_key(before)
    c = jread(RGF_DRY_CACHE, {}) or {}
    if c.get("key") == key and c.get("rc") == 0 and c.get("clean") is True:
        return True, "cached green for this code identity"
    snap = {f: open(f, "rb").read() for f in before if exists(f)}
    env = {k: v for k, v in os.environ.items() if k not in ("ADHD_NX_VERSION_DRY_RUN", "RELEASE_RUN_TOKEN")}
    env.update({"CI": "true", "NX_NO_CLOUD": "true"})
    try:
        r = subprocess.run(["pnpm", "release:dry"], capture_output=True, text=True, timeout=3600, env=env)
        rc, out = r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        rc, out = 124, "timeout after 3600s"
    after = _rgf_dirty()
    new = sorted(set(after) - set(before))
    changed = sorted(f for f in before if after.get(f) != before[f])
    for f in new:  # restore only what the run dirtied; never touch a path that was dirty before (it is rewritten from the snapshot below)
        if f in git("ls-files", "--", f).splitlines():
            git("restore", "--", f)
        elif exists(f):
            os.remove(f)
    for f in changed:
        if f in snap:
            with open(f, "wb") as fh:
                fh.write(snap[f])
    vacuous = "nothing to version/publish" in out or not re.search(r"dry-?run|would (write|publish)", out, re.I)
    clean = not new and not changed
    with open(RGF_DRY_CACHE, "w", encoding="utf8") as fh:
        json.dump({"key": key, "rc": rc, "clean": clean, "vacuous": vacuous, "dirtied": new + changed, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tail": out[-400:]}, fh, indent=1)
    if rc != 0 or vacuous or not clean:
        return False, f"pnpm release:dry exit {rc}; vacuous={vacuous}; tracked/untracked paths it dirtied (restored) {(new + changed)[:6]}; tail {out[-200:]!r}"
    return True, "ok"


def am_rgf_decompile(slug, p):
    """decompile-cli's index.spec.ts resolves its fixtures from test/fixtures (the directory exists) and `nx run decompile-cli:test --skip-nx-cache` exits 0."""
    code = code_lines(read("entrypoint/decompile-cli/test/unit/lib/validators/local/index.spec.ts"))
    m = re.search(r"fixturesDir\s*=\s*([^;\n]+)", code)
    if not m or re.search(r"""['"]tests['"]""", m.group(1)) or "fixtures" not in m.group(1):
        return False, f"fixturesDir is {m.group(1) if m else 'undefined'!r}: it must resolve to entrypoint/decompile-cli/test/fixtures, not the old src/tests layout"
    if not os.path.isdir("entrypoint/decompile-cli/test/fixtures") or not os.listdir("entrypoint/decompile-cli/test/fixtures"):
        return False, "entrypoint/decompile-cli/test/fixtures is missing or empty"
    return _am_gate("decompile-cli", ["test"], ["--skip-nx-cache"])


def am_rgf_backlog(slug, p):
    """The evidence carries a `ROOT-CAUSE backlog: <mechanism>` line, `nx run backlog:test --skip-nx-cache` exits 0, and the end-to-end release:dry run (criterion .4) is green for this code identity."""
    ev = read(_am_ev(slug))
    m = re.search(r"^ROOT-CAUSE backlog:[ \t]*(.{60,})$", ev, re.M)
    if not m or re.search(r"(?i)\b(tbd|unknown|not established|unclear|todo)\b", m.group(1)):
        return False, f"evidence/{slug}.md has no mechanism-bearing `ROOT-CAUSE backlog: ...` line"
    ok, why = _am_gate("backlog", ["test"], ["--skip-nx-cache"])
    if not ok:
        return False, why
    return _rgf_dry_cached()


def am_rgf_publish(slug, p):
    """publish/impl.js fails a same-version/different-content package without a bump except under dryRun AND process.env.ADHD_NX_VERSION_DRY_RUN === '1'; impl.spec.mjs has the three cases (dry+env succeeds, dry without env fails, non-dry fails), each citing 8468f7b1 and [release-gate-fixes.8], and passes `node --test`."""
    impl, spec = "tools/nx-plugins/build/executors/publish/impl.js", "tools/nx-plugins/build/executors/publish/impl.spec.mjs"
    src = read(impl)
    i = src.find("built content DIFFERS")
    win = src[max(0, i - 900): i + 900] if i >= 0 else ""
    bad = []
    if not re.search(r"process\.env\.ADHD_NX_VERSION_DRY_RUN", win) or "dryRun" not in win or "dry-run" not in win:
        bad.append("impl.js: the same-version/different-content branch does not gate a dry-run success on dryRun and process.env.ADHD_NX_VERSION_DRY_RUN")
    t = read(spec)
    tag = f"[{slug}.{p['n']}]"
    if t.count(tag) < 3 or t.count(TICKET) < 3 or "ADHD_NX_VERSION_DRY_RUN" not in t:
        bad.append(f"impl.spec.mjs: needs >= 3 cases citing {TICKET} and {tag} and the ADHD_NX_VERSION_DRY_RUN env")
    if bad:
        return False, "; ".join(bad)
    if spec not in ((jread("package.json", {}) or {}).get("scripts") or {}).get("test:build-tools", ""):
        return False, "impl.spec.mjs is not listed in package.json test:build-tools"
    rc, out = sh(["node", "--test", spec], timeout=900)
    if rc != 0:
        return False, f"node --test impl.spec.mjs exit {rc}: {out[-250:]}"
    rc, out = sh(["node", f"{AM_WIRING}/check-lane-reachability.mjs"], timeout=300)
    return rc == 0, f"check-lane-reachability exit {rc}: {out[-200:]}"


def am_rr_gates(slug, p):
    """Release-readiness gate evidence: every `EXIT <command>: <code>` token, the affected gate based on the merge-base of HEAD with LOCAL main (`BASE <sha>` equals `git merge-base HEAD main`), and no `--base=origin/main`."""
    ev = read(f"{PLAN}/{p['file']}")
    miss = [k for k in p["tokens"] if k not in ev]
    base = re.search(r"^BASE ([0-9a-f]{7,40})\s*$", ev, re.M)
    mb = git("merge-base", "HEAD", "main")
    rec = git("rev-parse", base.group(1)) if base else ""
    bad = []
    if not ev:
        bad.append("evidence missing")
    if not base or not mb or rec != mb:
        bad.append(f"BASE line {base.group(1) if base else None!r} is not `git merge-base HEAD main` ({mb[:12]})")
    if "git merge-base HEAD main" not in ev:
        bad.append("evidence does not show the `git merge-base HEAD main` base expression")
    if "--base=origin/main" in ev:
        bad.append("evidence still uses the stale --base=origin/main")
    return not miss and not bad, f"missing tokens {miss}; {bad}"


def am_rr_order(slug, p):
    """release-readiness/release-order.md orders the release (1 publish engine-runtime, 2 bump stealth-search's range then check:release-ranges) with consistent versions, ranges and source evidence."""
    t = read(f"{PLAN}/{p['file']}")
    if not t:
        return False, f"{p['file']} missing"
    lines = t.splitlines()

    def block(n):
        start = next((i for i, ln in enumerate(lines) if re.match(rf"\s*{n}[.)]\s", ln)), None)
        if start is None:
            return None, ""
        end = next((j for j in range(start + 1, len(lines)) if re.match(r"\s*\d+[.)]\s", lines[j]) or lines[j].startswith("#")), len(lines))
        return start, "\n".join(lines[start:end])

    def kv(k):
        m = re.search(rf"^{k}:[ \t]*(\S+)[ \t]*$", t, re.M)
        return m.group(1) if m else None
    bad = []
    s1, b1 = block(1)
    s2, b2 = block(2)
    if s1 is None or s2 is None or s1 >= s2:
        bad.append("numbered items 1 and 2 missing or out of order")
    bad += [f"item 1 lacks {k}" for k in ("publish", "@adhd/apigen-engine-runtime") if k not in b1.lower()]
    bad += [f"item 2 lacks {k}" for k in ("bump", "entrypoint/stealth-search", "@adhd/stealth-core-browser", "@adhd/stealth-search", "check:release-ranges") if k not in b2.lower()]
    bad += [f"missing {k}" for k in ("buildApigenPackage", "cutover-apigen-engine-runtime-0.3.5.tgz", "c4afebb0", "evidence/cutover/tarballs.json") if k not in t]
    reg, wt, cur, plan_v, plan_r = (kv(k) for k in ("REGISTRY-VERSION", "WORKTREE-VERSION", "CURRENT-RANGE", "PLANNED-VERSION", "PLANNED-RANGE"))
    if reg != "0.3.5":
        bad.append(f"REGISTRY-VERSION is {reg!r}, expected 0.3.5")
    eng = (jread("packages/apigen/apigen-engine-runtime/package.json", {}) or {}).get("version")
    if wt not in (eng, plan_v) or not wt:
        bad.append(f"WORKTREE-VERSION {wt!r} is neither engine-runtime's package.json version {eng!r} nor the planned one")
    pv, rv = _semver(plan_v), _semver(reg)
    if not pv or not rv or pv <= rv:
        bad.append(f"PLANNED-VERSION {plan_v!r} must be a version greater than the registry's {reg!r}")
    if plan_r != f"^{plan_v}":
        bad.append(f"PLANNED-RANGE {plan_r!r} must be ^{plan_v}")
    ss = (jread("entrypoint/stealth-search/package.json", {}) or {}).get("dependencies", {}).get("@adhd/apigen-engine-runtime")
    if ss not in (cur, plan_r):
        bad.append(f"entrypoint/stealth-search/package.json range {ss!r} is neither CURRENT-RANGE {cur!r} nor PLANNED-RANGE {plan_r!r}")
    dry = read(f"{PLAN}/release-readiness/release-dry.log.md") + read(_am_ev("release-readiness"))
    seen = set(re.findall(r"apigen-engine-runtime[^\n]*?(?:bumping to|would write)\s+v?(\d+\.\d+\.\d+)", dry)) | set(re.findall(r"(?:bumping to|would write)\s+v?(\d+\.\d+\.\d+)[^\n]*apigen-engine-runtime", dry)) | set(re.findall(r"@adhd/apigen-engine-runtime@(\d+\.\d+\.\d+)", dry))
    if plan_v not in seen:
        bad.append(f"the release:dry output in release-readiness/ shows engine-runtime versions {sorted(seen)}, not PLANNED-VERSION {plan_v!r}")
    src = read("packages/apigen/apigen-engine-runtime/src/lib/build-apigen-package.ts") + "\n" + read("packages/apigen/apigen-engine-runtime/src/index.ts")
    if not re.search(r"export\s+(async\s+)?function\s+buildApigenPackage", read("packages/apigen/apigen-engine-runtime/src/lib/build-apigen-package.ts")) or "build-apigen-package" not in read("packages/apigen/apigen-engine-runtime/src/index.ts"):
        bad.append("buildApigenPackage is not defined in engine-runtime's src/lib/build-apigen-package.ts and re-exported from src/index.ts")
    return not bad, "; ".join(bad) or "ok"


def am_rr_approvals(slug, p):
    """The APPROVAL documents name the three approved packages in their summary, no longer name the superseded package or 'exactly TWO/ONE' outside the human's quotes, carry a dated `Summary corrected` line, and every double-quoted segment of 6034633c6 is byte-identical."""
    bad = []
    for rel in p["files"]:
        cur = read(f"{PLAN}/{rel}")
        old = git("show", f"{RR_BASELINE}:{PLAN}/{rel}")
        if not cur or not old:
            bad.append(f"{rel}: current={bool(cur)} baseline={bool(old)}")
            continue
        quotes = re.findall(r'"[^"\n]{8,}"', old)
        gone = [q[:50] for q in quotes if q not in cur]
        outside = re.sub(r'"[^"\n]*"', "", cur)
        summary = cur.split("## Human approval carried by the request")[0]
        names = [n for n in p["names"] if n not in summary]
        if gone:
            bad.append(f"{rel}: verbatim quotes changed or lost {gone}")
        if names:
            bad.append(f"{rel}: summary does not name {names}")
        if re.search(r"(@adhd|entrypoint)/stealth-browser(?![\w/-])", outside):
            bad.append(f"{rel}: still names the superseded @adhd/stealth-browser (or entrypoint/stealth-browser) outside a quote")
        if re.search(r"(?i)exactly\s+(one|two)\b", outside):
            bad.append(f"{rel}: still says 'exactly ONE/TWO' outside a quote")
        if not re.search(r"^[\s>*_-]*Summary corrected 2026-10-\d\d\b", outside, re.M):
            bad.append(f"{rel}: no `Summary corrected 2026-10-23` line")
    return not bad, "; ".join(bad) or "ok"


AM_FN = {
    "layout": am_layout, "helpers": am_helpers, "config": am_config, "scanners": am_scanners, "headers": am_headers, "docs": am_docs, "gates": am_gates,
    "regress": am_regress, "own": am_own, "evidence": am_evidence, "text": am_text, "spec": am_spec, "repeat_guard": am_repeat_guard,
    "merge_commit": am_merge_commit, "merge_union": am_merge_union, "merge_lock": am_merge_lock, "merge_build": am_merge_build, "merge_own": am_merge_own,
    "tlv_fresh": am_tlv_fresh, "tlv_reach": am_tlv_reach,
    "rgf_spec": am_rgf_spec, "rgf_wiring": am_rgf_wiring, "rgf_dry": am_rgf_dry, "rgf_decompile": am_rgf_decompile, "rgf_backlog": am_rgf_backlog, "rgf_publish": am_rgf_publish,
    "rr_gates": am_rr_gates, "rr_order": am_rr_order, "rr_approvals": am_rr_approvals,
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
