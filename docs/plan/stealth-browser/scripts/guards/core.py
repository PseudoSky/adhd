# Guards of the core split: core-scaffold and core-seam.
# exec()d into guard.py's globals (check, sh, git, read, jread, exists, walk, code_lines, ownership_ok, nx_run, pkg_json,
# project_json, nontest_ts, spec_files_of, cites, env_readers, state, criteria_ids and the path constants).
# Every check is red on the pre-split tree (legacy shell present, core package absent) and never raises.

CORE_EVIDENCE = f"{SPLIT_EVIDENCE}/core-dry-run.txt"
CORE_TAGS_WANT = {"domain:stealth", "pkg-kind:core", "pkg-class:foundation", "platform:node", "access:public"}
CORE_TAGS_LAYER = {"layer:logic", "layer:shared"}
CORE_TAGS_ALLOWED = CORE_TAGS_WANT | CORE_TAGS_LAYER | {"publish:npm"}
CORE_BASELINE = "tools/nx-plugins/build/executors/typecheck-spec/stealth-core-browser.baseline.json"
CORE_MOVED = ["src/lib", "src/test/unit", "src/test/fixtures", "src/test/support", "src/api.ts", "src/index.ts", "docs/reference", "CHANGELOG.md", "LICENSE", "AGENTS.md"]
CORE_SWEEP = ["mig-foundation", "mig-cdp", "mig-chrome-manager", "mig-domains-storage", "mig-capture-parsers", "mig-queries", "mig-docs",
              "surface-api", "tests-unit-core", "tests-unit-data", "tests-unit-extract", "port-fixes", "failsafe-inventory", "cdp-test-harness",
              "capture-upgrade", "chrome-lifecycle", "sp-reaper-load-proof", "sp-link"]
LEGACY_RX = r"@adhd/stealth-browser\b|entrypoint/stealth-browser\b|nx run stealth-browser:|\bstealth-browser:(?:build|test|lint|typecheck)"


def _core_started():
    return exists(f"{CORE_DIR}/project.json")


def _start_ref(slug):
    return ((state().get("states") or {}).get(slug) or {}).get("start_ref")


@check("core-scaffold", 1)
def _cs1():
    """The package is generator-built, never hand-built: evidence/split/core-dry-run.txt holds the transcript of `npx nx g @adhd/workspace-codegen-nx:core --name=browser --group=stealth ... --dry-run` with its CREATE list, .adhd/workspace.json has the `stealth` group with a description, packages/stealth/stealth-core-browser/project.json is named `stealth-core-browser` and its tags are domain:stealth, pkg-kind:core, pkg-class:foundation, platform:node, access:public and layer:logic (or layer:shared when the generator rejects logic), plus `publish:npm` and any `scope:*` tag, nothing else."""
    t = read(CORE_EVIDENCE)
    ws = jread(".adhd/workspace.json", {}) or {}
    grp = (ws.get("groups") or {}).get("stealth")
    pj = project_json(CORE_DIR)
    tags = set(pj.get("tags") or [])
    extra = tags - CORE_TAGS_ALLOWED - {x for x in tags if x.startswith("scope:")}
    ok = "--name=browser" in t and "--group=stealth" in t and "--dry-run" in t and "CREATE" in t
    return ok and isinstance(grp, dict) and bool(grp.get("description")) and pj.get("name") == CORE_PROJECT and CORE_TAGS_WANT <= tags and bool(tags & CORE_TAGS_LAYER) and not extra, f"transcript={ok} group={grp} name={pj.get('name')} tags={sorted(tags)}"


def _vite_output_text(vite):
    """The vite config with import/from specifier lines and comments removed, so only output configuration (formats, fileName, entryFileNames, chunkFileNames, ...) is inspected: every generator-built package imports shared `tools/vite-plugins/*.mjs` helpers, which are inputs, not build outputs."""
    vite = re.sub(r"/\*.*?\*/", "", vite, flags=re.S)
    keep = []
    in_import = False
    for ln in vite.splitlines():
        code = re.sub(r"(^|\s)//.*$", "", ln)
        if in_import:
            in_import = not re.search(r"\bfrom\s*['\"]", code)
            continue
        if re.match(r"\s*(import\s*(type\s*)?\{|export\s*(type\s*)?\{|import\s+\w+\s*,\s*\{)[^}]*$", code) and not re.search(r"\bfrom\s*['\"]|^\s*import\s*['\"]", code):
            in_import = True
            continue
        if re.match(r"\s*(import|export)\b.*\bfrom\s*['\"]", code) or re.match(r"\s*import\s*['\"]", code):
            continue
        keep.append(code)
    return "\n".join(keep)


@check("core-scaffold", 2)
def _cs2():
    """The manifest has the ADR-0003 CJS-only library shape: name @adhd/stealth-core-browser, version 0.1.0, `main` ./dist/index.js, a `types` entry, `type` unset, no `module`, no `exports`, no `bin`, engines.node >= 22.5, publishConfig.access public, `files` containing dist and CHANGELOG.md; the package vite config is `vite.config.ts` (not .mts) and emits CJS only (`formats` exactly ['cjs'], and no `.mjs` in the config's output settings: import and export-from lines and comments are not inspected, because the shared tools/vite-plugins/*.mjs helpers are inputs, not build outputs); the package has no bin/ directory and no `build-bin` target."""
    p = pkg_json(CORE_DIR)
    vite = read(f"{CORE_DIR}/vite.config.ts")
    fm = re.search(r"formats\s*:\s*\[([^\]]*)\]", vite)
    fmts = re.findall(r"['\"]([A-Za-z]+)['\"]", fm.group(1)) if fm else []
    shape = (p.get("name") == CORE_PKG and p.get("version") == "0.1.0" and p.get("main") == "./dist/index.js" and bool(p.get("types"))
             and not ({"type", "module", "exports", "bin"} & set(p)) and (p.get("publishConfig") or {}).get("access") == "public"
             and {"dist", "CHANGELOG.md"} <= set(p.get("files") or []) and re.search(r"22\.5", (p.get("engines") or {}).get("node", "")) is not None)
    targets = set((project_json(CORE_DIR).get("targets") or {}))
    return shape and fmts == ["cjs"] and not re.search(r"\.mjs['\"`]", _vite_output_text(vite)) and not exists(f"{CORE_DIR}/vite.config.mts") and not exists(f"{CORE_DIR}/bin") and "build-bin" not in targets, f"shape={shape} formats={fmts} targets={sorted(targets)}"


@check("core-scaffold", 3)
def _cs3():
    """The rename is complete: `git grep` finds no `@adhd/stealth-browser`, `entrypoint/stealth-browser`, `nx run stealth-browser:` or `[stealth-browser]` log prefix in any tracked file outside docs/plan/ and CHANGELOG.md files, and no non-test source under the core package contains the `[stealth-browser]` prefix (it is `[@adhd/stealth-core-browser]`)."""
    if not _core_started():
        return False, "core package missing"
    rc, out = sh(["git", "grep", "-l", "-I", "-E", LEGACY_RX + r"|\[stealth-browser\]", "--", ".", ":(exclude)docs/plan", ":(exclude)*CHANGELOG.md"])
    hits = [x for x in out.splitlines() if x.strip()] if rc == 0 else []
    return not hits, f"files still naming the legacy package: {hits[:8]}"


@check("core-scaffold", 4)
def _cs4():
    """The core package builds and passes on its own: `nx run stealth-core-browser:typecheck`, `:build` and `:test` exit 0 (the ported unit lane runs unchanged under the new project)."""
    if not _core_started():
        return False, "core package missing"
    bad = []
    for t in ("typecheck", "build", "test"):
        rc, out = nx_run(CORE_PROJECT, t)
        if rc != 0:
            bad.append(f"{t}={rc}:{out[-120:]}")
    return not bad, f"failing {bad}"


@check("core-scaffold", 5)
def _cs5():
    """The old shell is gone: entrypoint/stealth-browser does not exist in the tree (no tracked file and no leftover directory, including dist/), `tsconfig.base.json` maps @adhd/stealth-core-browser to packages/stealth/stealth-core-browser/src/index.ts and has no @adhd/stealth-browser alias, and pnpm-lock.yaml has the importer key `packages/stealth/stealth-core-browser:` and no `entrypoint/stealth-browser:` importer."""
    base = read("tsconfig.base.json")
    lock = read("pnpm-lock.yaml")
    tracked = git("ls-files", "--", LEGACY_DIR)
    return (_core_started() and not exists(LEGACY_DIR) and not tracked and CORE_PKG in base and f"{CORE_DIR}/src/index.ts" in base and LEGACY_PKG not in base
            and re.search(rf"^\s*{re.escape(CORE_DIR)}:\s*$", lock, re.M) is not None and re.search(rf"^\s*{re.escape(LEGACY_DIR)}:\s*$", lock, re.M) is None), f"legacy dir={exists(LEGACY_DIR)} tracked={tracked[:80]!r} alias={CORE_PKG in base}"


@check("core-scaffold", 6)
def _cs6():
    """Exactly the approved project.json files were added since main: the core package's and the tripwire package's (plus the stealth-search entrypoint's once search-scaffold has run); the legacy entrypoint/stealth-browser/project.json is not among them, and no other project or workspace group was edited (nx.json and eslint.config.mjs are unchanged since the state start; the generator-created packages/stealth/stealth-core-browser typecheck-spec baseline is committed)."""
    base = git("merge-base", "HEAD", "main")
    added = [f for f in git("diff", "--name-only", "--diff-filter=A", f"{base}..HEAD").splitlines() if f.endswith("project.json")]
    want = {f"{CORE_DIR}/project.json", f"{TW}/project.json"}
    allowed = want | {f"{SEARCH_DIR}/project.json"}
    start = _start_ref("core-scaffold")
    drift = git("diff", "--name-only", start, "HEAD", "--", "nx.json", "eslint.config.mjs") if start else "(no start_ref)"
    return want <= set(added) and set(added) <= allowed and f"{LEGACY_DIR}/project.json" not in added and not drift and exists(CORE_BASELINE) and bool(git("ls-files", "--", CORE_BASELINE)), f"added={added} drift={drift!r} baseline={exists(CORE_BASELINE)}"


@check("core-scaffold", 7)
def _cs7():
    """The move preserved the whole library: every path under the legacy shell at the state start (src/lib/**, src/test/unit/**, src/test/fixtures/**, src/test/support/**, src/api.ts, src/index.ts, docs/reference/**, CHANGELOG.md, LICENSE, AGENTS.md) exists at the same relative path under packages/stealth/stealth-core-browser; the `src/api.ts` header states that the verbs are projected by consumers and not mounted here."""
    start = _start_ref("core-scaffold")
    if not start or not _core_started():
        return False, f"start_ref={start} core={_core_started()}"
    before = git("ls-tree", "-r", "--name-only", start, "--", *[f"{LEGACY_DIR}/{m}" for m in CORE_MOVED]).splitlines()
    missing = [b[len(LEGACY_DIR) + 1:] for b in before if not exists(f"{CORE_DIR}/{b[len(LEGACY_DIR) + 1:]}")]
    head = "\n".join(read(f"{CORE_DIR}/src/api.ts").splitlines()[:40])
    return bool(before) and not missing and re.search(r"projected\s+by\s+(?:its\s+|the\s+)?consumers", head, re.I) is not None, f"moved={len(before)} missing={missing[:6]}"


@check("core-scaffold", 8)
def _cs8():
    """Regression sweep: after the move every previously completed core state's whole-state guard still exits 0 (mig-foundation, mig-cdp, mig-chrome-manager, mig-domains-storage, mig-capture-parsers, mig-queries, mig-docs, surface-api, tests-unit-core, tests-unit-data, tests-unit-extract, port-fixes, failsafe-inventory, cdp-test-harness, capture-upgrade, chrome-lifecycle, sp-reaper-load-proof, sp-link); guard.py resolves its package path to packages/stealth/stealth-core-browser once the legacy shell is gone."""
    if not _core_started() or exists(LEGACY_DIR):
        return False, "move not done"
    bad = []
    for s in CORE_SWEEP:
        rc, out = sh([sys.executable, f"{SCRIPTS}/guard.py", s], timeout=3000)
        if rc != 0:
            bad.append(f"{s}(rc={rc}): {out.strip()[-100:]}")
    return not bad, f"regressed states: {bad}"


@check("core-scaffold", 9)
def _cs9():
    """Only owned paths changed by [psm:core-scaffold] commits (the core package, the legacy entrypoint shell it deletes, .adhd/workspace.json, tsconfig.base.json, pnpm-lock.yaml importers, the generator-created typecheck-spec baseline and evidence/split/); the pnpm-lock.yaml diff of those commits is confined to the two importer blocks (the legacy key removed, the core key added)."""
    o = ownership_ok("core-scaffold")
    return o[0] and _core_started(), o[1]


# ---------------------------------------------------------------- core-seam
def _managers():
    return read(f"{CORE_DIR}/src/lib/managers.ts")


@check("core-seam", 1)
def _sm1():
    """(P7) src/lib/managers.ts exports `configureManagers({ idleTimeoutMs, keepAlive, entryPath, checkHistory, logger })`, `managerFor` and `chromeExitTarget` and is the only non-test file under src/ that constructs a ChromeManager (`new ChromeManager(`); src/api.ts imports managerFor from './lib/managers.js' and holds no manager map of its own; `ChromeManagerOptions` declares `keepAlive?` and `entryPath?` and chrome-manager.ts passes `entryPath` to createProxyReaperLink."""
    m = _managers()
    names = exports_of(m)
    opts = all(k in m for k in ("idleTimeoutMs", "keepAlive", "entryPath", "checkHistory", "logger"))
    ctor = [f for f in nontest_ts(CORE_DIR, "src") if re.search(r"\bnew\s+ChromeManager\s*\(", code_lines(read(f)))]
    api = read(f"{CORE_DIR}/src/api.ts")
    cm = read(f"{CORE_DIR}/src/lib/chrome-manager.ts")
    uses = re.search(r"import\s*\{[^}]*\bmanagerFor\b[^}]*\}\s*from\s*['\"]\./lib/managers\.js['\"]", api) is not None
    cmok = re.search(r"keepAlive\s*\?", cm) is not None and re.search(r"entryPath\s*\?", cm) is not None and re.search(r"createProxyReaperLink\([^)]*entryPath", cm, re.S) is not None
    return {"configureManagers", "managerFor", "chromeExitTarget"} <= names and opts and ctor == [f"{CORE_DIR}/src/lib/managers.ts"] and uses and cmok, f"exports={sorted(names)} opts={opts} constructors={ctor} api uses managerFor={uses} chrome-manager={cmok}"


@check("core-seam", 2)
def _sm2():
    """(P7) The seam is unit-tested through the real functions: spec files under src/test/unit/seam/ cite ticket 8468f7b1 and a valid core-seam.N id, import no node:child_process, and assert that `keepAlive: true` never arms the idle timer, that `checkHistory: false` reaches the manager, that `release()` and `shutdownIfIdle()` through `chromeExitTarget` reach every live manager, and an error path; `nx run stealth-core-browser:test -- src/test/unit/seam` exits 0."""
    specs = spec_files_of(CORE_DIR, "unit/seam")
    t = "\n".join(read(f) for f in specs)
    ids = set(re.findall(r"\[(core-seam\.\d+)\]", t))
    need = ("keepAlive", "checkHistory", "chromeExitTarget", "shutdownIfIdle", "release", "configureManagers", "managerFor")
    miss = [k for k in need if k not in t]
    if not specs or miss or TICKET not in t or not (ids & criteria_ids()) or re.search(r"from\s+['\"]node:child_process['\"]", t):
        return False, f"specs={len(specs)} missing={miss} ids={sorted(ids)}"
    rc, out = nx_run(CORE_PROJECT, "test", "--", "src/test/unit/seam")
    return rc == 0, out[-200:]


@check("core-seam", 3)
def _sm3():
    """(P8) The built package exposes the seam at the root: after `nx run stealth-core-browser:build` exits 0, `require()` of dist/index.js has `lifecycle.configureManagers`, `lifecycle.managerFor`, `lifecycle.chromeExitTarget`, `lifecycle.installProcessExitHooks` and `lifecycle.runChromeReaper` as functions/objects; src/index.ts has `export * as lifecycle from './lib/lifecycle/index.js'` and src/lib/lifecycle/index.ts re-exports from '../managers.js'."""
    idx = read(f"{CORE_DIR}/src/index.ts")
    li = read(f"{CORE_DIR}/src/lib/lifecycle/index.ts")
    wired = re.search(r"export\s+\*\s+as\s+lifecycle\s+from\s+['\"]\./lib/lifecycle/index\.js['\"]", idx) is not None and re.search(r"from\s+['\"]\.\./managers\.js['\"]", li) is not None
    if not wired or not _core_started():
        return False, f"wired={wired}"
    rc, _ = nx_run(CORE_PROJECT, "build")
    if rc != 0:
        return False, f"build rc={rc}"
    js = "const m=require('./dist/index.js');const l=m.lifecycle||{};console.log(JSON.stringify(['configureManagers','managerFor','chromeExitTarget','installProcessExitHooks','runChromeReaper'].filter(k=>l[k]===undefined)))"
    rc, out = sh(["node", "-e", js], cwd=CORE_DIR, timeout=120)
    try:
        miss = json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return False, f"probe failed rc={rc}: {out[-150:]}"
    return rc == 0 and not miss, f"missing on built lifecycle: {miss}"


@check("core-seam", 4)
def _sm4():
    """(P7) The seam is host-neutral and env-free: managers.ts and every file under src/lib/lifecycle/ contain no `process.env`, managers.ts names neither the proxy package (@adhd/sox-service-proxy) nor any apigen, commander or host package, and the core package manifest has no @adhd/apigen-* dependency; only owned paths changed by [psm:core-seam] commits (src/lib/managers.ts, chrome-manager.ts, lifecycle/index.ts, lifecycle/reaper-entry.ts, reaper-host.ts and reaper-link.ts, src/index.ts, the src/api.ts header, src/lib/cdp/browser.ts, cdp/targets.ts, src/lib/parsers.ts, capture/bans.ts, the five specs of core-seam.12, capture-parsers/bans.spec.ts, and src/test/unit/seam/)."""
    m = _managers()
    life = [f for f in walk(f"{CORE_DIR}/src/lib/lifecycle") if f.endswith(".ts")]
    env = env_readers([f"{CORE_DIR}/src/lib/managers.ts"] + life) if m else ["managers.ts missing"]
    deps = {**(pkg_json(CORE_DIR).get("dependencies") or {})}
    hosts = [d for d in deps if d.startswith("@adhd/apigen") or d == "commander"]
    o = ownership_ok("core-seam")
    return bool(m) and not env and "@adhd/sox-service-proxy" not in m and not hosts and o[0], f"env readers={env} host deps={hosts} {o[1]}"


# ---------------------------------------------------------------- backlog fold-in (2026-10-14 search bugs)
@check("core-seam", 5)
def _sm5():
    """(backlog e093636f) The legacy heartbeat reader stays out of the core: src/lib/managers.ts exists and its options carry no heartbeat setting, and a seam spec under src/test/unit/seam/ asserts at the type level (`// @ts-expect-error`) that `ChromeManagerOptions` has no `legacyHeartbeatPath` or `heartbeatPath` and that configuring the seam reads no heartbeat file; the static absence scan stays chrome-lifecycle.24. Titles carry `legacyHeartbeatPath`, `@ts-expect-error` and the uid e093636f, and the spec cites [core-seam.5]."""
    m = _managers()
    if not m or re.search(r"heartbeat", code_lines(m), re.I):
        return False, f"managers.ts present={bool(m)} heartbeat mention={bool(re.search('heartbeat', code_lines(m), re.I))}"
    return _bug_ac("core", "core-seam", 5, ["e093636f"], "seam", ["legacyHeartbeatPath", "@ts-expect-error"])


@check("core-seam", 6)
def _sm6():
    """(backlog 7f881aa7) The attach and kill paths check profile identity before they touch a process, as a filter on the existing paths (defaults stay port 9222 and the Chrome-CDP profile dir per backlog 8332a825; both are exported constants overridable through the typed options and every check uses the RESOLVED profile): `launchChrome` and `ensureChromeRunning` attach to a reachable listener only when it is this tool's own Chrome (its `--user-data-dir` equals the resolved profile dir, read through an injected process probe, or the profile's DevToolsActivePort names the port); a reachable foreign Chrome (the operator's real profile) is not attached to and raises LifecycleError LAUNCH_FAILED with detail reason `foreign-profile` (no new code: the six lifecycle codes are pinned); `killChrome(port)` and the reaper's port-occupant path signal only a pid whose command line carries the resolved `--user-data-dir`, never an arbitrary port listener, and skip with a logged reason otherwise. Specs under src/test/unit/seam/ (no node:child_process import: the probe is injected) simulate own Chrome attached, foreign Chrome refused, kill of a foreign occupant skipped, kill of an own occupant done and an override profile dir honored; titles carry `foreign-profile`, `LAUNCH_FAILED`, `user-data-dir`, `killChrome`, `9222`, `probe` and the uid 7f881aa7, and the spec cites [core-seam.6]. `nx run stealth-core-browser:test` (the whole project, the completed lifecycle and cdp specs included; the five specs kill.spec.ts, launch.spec.ts, concurrent-launch.spec.ts, reaper-scope.spec.ts and cdp/browser.spec.ts may adapt their fixtures (the simulated machine's `ps -o command=` answer for the listener), never their assertions; the one permitted assertion edit is the exact lsof command string of core-seam.9 and the mechanical proof is core-seam.12) exits 0."""
    br = code_lines(read(f"{CORE_DIR}/src/lib/cdp/browser.ts"))
    if not re.search(r"foreign-profile", br) or not re.search(r"user-data-dir", br):
        return False, "browser.ts has no foreign-profile refusal or user-data-dir identity filter"
    return _bug_ac("core", "core-seam", 6, ["7f881aa7"], "seam",
                   ["foreign-profile", "LAUNCH_FAILED", "user-data-dir", "killChrome", "9222", "probe"], nx_all=True)
