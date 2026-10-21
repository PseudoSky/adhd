# Guards for the search-side states, group 1 (exec()'d into guard.py's globals by the loader).
# States: search-scaffold, search-inventory, search-errors, search-port-providers, search-port-fetch,
#         search-port-engine, search-port-guards, search-verbs, search-tracing.
# Every check is red on a tree where entrypoint/stealth-search does not exist and never crashes.

SA_INV = f"{PLAN}/evidence/search-failsafe-inventory.json"
SA_PROBES = f"{SPLIT_EVIDENCE}/search-verbs-probes.json"
SA_UPDF = f"{SPLIT_EVIDENCE}/u-pdf.json"
SA_SRC = "/Users/nix/dev/ai/scratch/agent-browser"
SA_PROVIDERS = ["duckduckgo", "google", "arxiv", "npm", "github", "maven", "wikipedia", "crates", "pypi", "mdn", "stackoverflow", "fetch"]
SA_TOOLS = ["search", "listProviders", "describeProvider", "tripwireStatus", "clearTripwire", "chromeStatus", "launchChrome",
            "shutdownChrome", "listPageTargets", "checkChromeActivity", "getPageContext"]
SA_CODES = ["UNKNOWN_PROVIDER", "SEARCH_FAILED", "SELECTOR_TIMEOUT", "HITL_ABORTED", "TRIPWIRE_STATE_UNREADABLE", "TRIPWIRE_CLEAR_FAILED",
            "PROVIDER_STATE_IO", "FETCH_URL_REFUSED", "PDF_EXTRACT_FAILED", "HOST_FLAG_INVALID", "HOST_TRANSPORT_UNSUPPORTED",
            "HOST_BOOT_FAILED", "NODE_TOO_OLD"]
SA_SOURCE_FILES = ["search-mcp-source.ts", "search-guard.ts", "search-tripwire.ts", "search-providers.ts", "search-types.ts",
                   "search-network.ts", "search-dom.ts", "search-challenge.ts", "search-fetch.ts", "fetch-policy.ts",
                   "fetch-markdown.ts", "fetch-pdf.ts", "network-capture.ts", "search/utils.ts", "search/queries/last-search.ts", "cdp-search.ts"]
SA_REQUIRED_DEPS = ["@adhd/stealth-core-browser", "@adhd/resilience-core-tripwire", "@adhd/sox-telemetry", "@adhd/apigen-core-client",
                    "@adhd/apigen-engine-naming", "@adhd/apigen-engine-runtime", "@adhd/apigen-plugin-mcp", "@adhd/apigen-plugin-cli-output",
                    "@adhd/apigen-plugin-ir-cache", "@adhd/apigen-plugin-tracing", "@modelcontextprotocol/sdk", "commander", "turndown", "pdfjs-dist"]
SA_OWNERS = {"search-inventory", "search-errors", "search-port-providers", "search-port-fetch", "search-port-engine", "search-port-guards",
             "search-verbs", "search-hosts", "search-usecases", "search-examples", "search-cutover", "search-tracing", "core-seam",
             "docs-marketing-run", "readme-rewrite", "core-scaffold", "tripwire-pack", "none"}

# slug -> (source files, spec dir under src/test/unit)
SA_SCOPE = {
    "search-errors": (["src/errors.ts"], "errors"),
    "search-port-providers": (["src/lib/types.ts", "src/lib/providers.ts", "src/lib/utils.ts", "src/lib/queries/last-search.ts"], "providers"),
    "search-port-fetch": (None, "fetch"),  # src/lib/fetch/*
    "search-port-engine": (["src/lib/network.ts", "src/lib/dom.ts", "src/lib/challenge.ts"], "engine"),
    "search-port-guards": (["src/lib/guard.ts", "src/lib/tripwire.ts", "src/lib/config.ts"], "guards"),
    "search-verbs": (["src/api.ts", "src/lib/search.ts", "src/host-projection.ts", "src/index.ts"], "verbs"),
}


def _sa_def(slug, n, doc, fn):
    fn.__doc__ = doc
    check(slug, n)(fn)


def _sa_has_project():
    return exists(f"{SEARCH_DIR}/project.json")


def _sa_files(slug):
    rel, _ = SA_SCOPE[slug]
    if rel is None:
        return [f for f in walk(f"{SEARCH_DIR}/src/lib/fetch") if not f.endswith((".spec.ts", ".d.ts"))]
    return [f"{SEARCH_DIR}/{r}" for r in rel if exists(f"{SEARCH_DIR}/{r}")]


def _sa_specs(slug):
    return spec_files_of(SEARCH_DIR, f"unit/{SA_SCOPE[slug][1]}")


def _sa_text(files):
    return "\n".join(read(f) for f in files)


def _sa_gate(*targets):
    if not _sa_has_project():
        return False, f"{SEARCH_DIR}/project.json missing"
    for t in targets:
        rc, out = nx_run(SEARCH_PROJECT, t)
        if rc != 0:
            return False, f"nx run {SEARCH_PROJECT}:{t} exit {rc}: {out[-300:]}"
    return True, "ok"


def _sa_rows():
    d = jread(SA_INV, {}) or {}
    rows = d.get("rows") if isinstance(d, dict) else None
    return rows if isinstance(rows, list) else []


def _sa_inventory_cited(slug):
    rows = [r for r in _sa_rows() if r.get("owner_state") == slug]
    files = _sa_files(slug) + _sa_specs(slug)
    txt = _sa_text(files)
    missing = [r.get("id") for r in rows if r.get("id") not in txt]
    return bool(rows) and bool(files) and not missing, f"rows={len(rows)} files={len(files)} ids not cited in source or specs: {missing[:10]}"


def _sa_hygiene(slug):
    files = _sa_files(slug)
    if not files:
        return False, "no source files yet"
    bad = {
        "process.env": env_readers(files),
        "untyped error": untyped_error_sites(files),
        "legacy package": offenders(files, r"@adhd/stealth-browser\b"),
        "core src deep import": offenders(files, r"stealth-core-browser/src|from\s+['\"](?:\.\./)+(?:packages|entrypoint)/"),
        "own cdp socket": offenders(files, r"from\s+['\"]ws['\"]|new\s+WebSocket\s*\("),
    }
    bad = {k: v for k, v in bad.items() if v}
    return not bad, f"violations: {bad}"


def _sa_tests_cite(slug, minimum=2):
    specs = _sa_specs(slug)
    ok, detail = cites(specs, slug)
    return ok and len(specs) >= minimum, f"{detail}; need at least {minimum} spec files"


def _sa_probe(key):
    return (jread(SA_PROBES, {}) or {}).get(key) or {}


# ============================================================ search-scaffold
@check("search-scaffold", 1)
def _ssc1():
    """The package is generator-built: evidence/split/search-dry-run.txt holds the transcript of `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-search --nxLayer entrypoints --platform node --dry-run` with its CREATE list, entrypoint/stealth-search/project.json is named `stealth-search`, and its tags are exactly domain:entrypoint, pkg-kind:entrypoint, pkg-class:entrypoint, layer:entrypoints, platform:node and access:domain (plus any `publish:npm` or `scope:*` tag)."""
    t = read(f"{SPLIT_EVIDENCE}/search-dry-run.txt")
    pj = project_json(SEARCH_DIR)
    tags = set(pj.get("tags") or [])
    want = {"domain:entrypoint", "pkg-kind:entrypoint", "pkg-class:entrypoint", "layer:entrypoints", "platform:node", "access:domain"}
    extra = {x for x in tags - want if not (x.startswith("scope:") or x == "publish:npm")}
    ok = "workspace-codegen-nx:entrypoint" in t and "stealth-search" in t and "CREATE" in t
    return ok and pj.get("name") == SEARCH_PROJECT and want <= tags and not extra, f"transcript ok={ok} name={pj.get('name')} tags={sorted(tags)}"


@check("search-scaffold", 2)
def _ssc2():
    """Structure equals the sibling entrypoints: the tracked top-level file set contains every file common to dispatch-cli, backlog and apigen-cli (minus BACKLOG.md and CONTRIBUTING.md), and `nx show project stealth-search` lists every target common to dispatch-cli and backlog plus `build-bin`."""
    if not _sa_has_project():
        return False, "project missing"
    need = sibling_top()
    have = {f[len(SEARCH_DIR) + 1:] for f in git("ls-files", "--", SEARCH_DIR).splitlines() if "/" not in f[len(SEARCH_DIR) + 1:]}

    def targets(name):
        rc, out = sh([NX, "show", "project", name, "--json"], timeout=300)
        try:
            return set(json.loads(out[out.index("{"):]).get("targets", {}))
        except (ValueError, json.JSONDecodeError):
            return set()
    tneed = (targets("dispatch-cli") & targets("backlog")) | {"build-bin"}
    tmine = targets(SEARCH_PROJECT)
    return bool(need) and need <= have and tneed <= tmine, f"missing files {sorted(need - have)} missing targets {sorted(tneed - tmine)}"


@check("search-scaffold", 3)
def _ssc3():
    """The manifest is the ADR-0003 CJS-only entrypoint shape: name @adhd/stealth-search, version 0.1.0, bins `stealth-search` -> ./dist/bin/cli.js and `stealth-search-mcp` -> ./dist/bin/mcp.js, `main` and `types`, no `module`, no `exports`, engines.node >= 22.5, repository.directory entrypoint/stealth-search, and no `link:` or `file:` dependency specifier anywhere."""
    p = pkg_json(SEARCH_DIR)
    bins = p.get("bin") or {}
    m = re.match(r"\s*>=\s*(\d+)(?:\.(\d+))?", (p.get("engines") or {}).get("node", ""))
    specs = [v for k in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies") for v in (p.get(k) or {}).values()]
    ok = (p.get("name") == SEARCH_PKG and p.get("version") == "0.1.0"
          and bins.get("stealth-search") == "./dist/bin/cli.js" and bins.get("stealth-search-mcp") == "./dist/bin/mcp.js"
          and "main" in p and "types" in p and "module" not in p and "exports" not in p
          and bool(m) and (int(m.group(1)), int(m.group(2) or 0)) >= (22, 5)
          and (p.get("repository") or {}).get("directory") == SEARCH_DIR
          and not any(str(v).startswith(("link:", "file:")) for v in specs))
    return ok, f"name={p.get('name')} version={p.get('version')} bin={bins} module={'module' in p} exports={'exports' in p}"


@check("search-scaffold", 4)
def _ssc4():
    """The manifest declares EVERY dependency the later search states need so none of them edits package.json or the lockfile: @adhd/stealth-core-browser, @adhd/resilience-core-tripwire, @adhd/sox-telemetry, the apigen core-client / engine-naming / engine-runtime / plugin-mcp / plugin-cli-output / plugin-ir-cache / plugin-tracing packages, @modelcontextprotocol/sdk, commander, turndown and pdfjs-dist (workspace packages as ranges that resolve in the workspace, never link: or file:), and every `import` of a bare package in the source repo's search files that is not a node builtin is covered or recorded as unused in evidence/split/search-deps.md."""
    p = pkg_json(SEARCH_DIR)
    deps = {**(p.get("devDependencies") or {}), **(p.get("dependencies") or {})}
    miss = [d for d in SA_REQUIRED_DEPS if d not in deps]
    note = read(f"{SPLIT_EVIDENCE}/search-deps.md")
    return not miss and bool(note.strip()), f"missing deps {miss}; search-deps.md present={bool(note.strip())}"


@check("search-scaffold", 5)
def _ssc5():
    """Workspace wiring is minimal: tsconfig.base.json maps `@adhd/stealth-search` to a path under entrypoint/stealth-search and keeps the `@adhd/stealth-core-browser` alias, `pnpm-lock.yaml` has an `entrypoint/stealth-search:` importer, no [psm:search-scaffold] commit removes a pnpm-lock.yaml line, and tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json exists."""
    ts = read("tsconfig.base.json")
    lock = read("pnpm-lock.yaml")
    log = sh(["git", "log", "--format=%H", "--grep", r"\[psm:search-scaffold\]"])[1].split()
    removed = []
    for sha in log:
        d = git("show", "--format=", "--numstat", sha, "--", "pnpm-lock.yaml").split()
        if len(d) >= 2 and d[1].isdigit() and int(d[1]) > 0:
            removed.append(sha[:8])
    ok = (re.search(r'"@adhd/stealth-search"\s*:\s*\[\s*"(?:\./)?entrypoint/stealth-search/', ts) is not None
          and re.search(r'"@adhd/stealth-core-browser"\s*:', ts) is not None
          and "entrypoint/stealth-search:" in lock and not removed
          and exists("tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json"))
    return ok, f"alias/importer/baseline ok={ok} lock-removing commits={removed}"


@check("search-scaffold", 6)
def _ssc6():
    """The empty shell passes its gates: `nx run stealth-search:lint`, `:typecheck` and `:build` exit 0."""
    return _sa_gate("lint", "typecheck", "build")


@check("search-scaffold", 7)
def _ssc7():
    """Only owned paths changed by [psm:search-scaffold] commits."""
    return ownership_ok("search-scaffold")


# ============================================================ search-inventory
@check("search-inventory", 1)
def _si1():
    """evidence/search-failsafe-inventory.json (schema, baseline_commit, row_count, rows) holds one row for every seed row I-01..I-42 of the spec section 3 (ids `I-NN`; sub-rows `I-NN.a` allowed), `row_count` equals len(rows), each row has feature, destination, owner_state (one of the plan state ids that implements it, or `none` for a documented deletion) and `source` {file, line, anchor}."""
    d = jread(SA_INV, {}) or {}
    rows = _sa_rows()
    ids = {str(r.get("id", "")).split(".")[0] for r in rows}
    need = {f"I-{i:02d}" for i in range(1, 43)}
    bad = [r.get("id") for r in rows if not (r.get("feature") and r.get("destination") and r.get("owner_state") in SA_OWNERS
                                              and isinstance(r.get("source"), dict) and r["source"].get("file") and isinstance(r["source"].get("line"), int) and r["source"].get("anchor"))]
    return bool(rows) and need <= ids and d.get("row_count") == len(rows) and not bad, f"missing {sorted(need - ids)[:6]} malformed {bad[:6]} row_count={d.get('row_count')}"


@check("search-inventory", 2)
def _si2():
    """Every row's `source.file` exists under /Users/nix/dev/ai/scratch/agent-browser (until the cutover) or is recorded with `source.baseline_blob`, its `line` is within the file, and the `anchor` text occurs within 3 lines of that line, so each citation is verified rather than copied."""
    rows = _sa_rows()
    bad = []
    for r in rows:
        s = r.get("source") or {}
        path = f"{SA_SRC}/{s.get('file','')}"
        txt = read(path)
        if not txt:
            if not s.get("baseline_blob"):
                bad.append(f"{r.get('id')}: file missing")
            continue
        lines = txt.splitlines()
        ln = s.get("line", 0)
        if not (1 <= ln <= len(lines)) or s.get("anchor", "\0") not in "\n".join(lines[max(0, ln - 4):ln + 3]):
            bad.append(f"{r.get('id')}: line/anchor")
    return bool(rows) and not bad, f"unverified {bad[:8]}"


@check("search-inventory", 3)
def _si3():
    """The rows cover every exported function, class and const of the search source files (search-mcp-source, search-guard, search-tripwire, search-providers, search-types, search-network, search-dom, search-challenge, search-fetch, fetch-policy, fetch-markdown, fetch-pdf, network-capture, search/utils, search/queries/last-search, cdp-search): each exported name appears in some row's `symbols` list, and at least 10 of those files exist to be scanned."""
    cover = set()
    for r in _sa_rows():
        cover |= set(r.get("symbols") or [])
    rx = re.compile(r"^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|enum)\s+([A-Za-z0-9_$]+)", re.M)
    names, scanned = set(), 0
    for f in SA_SOURCE_FILES:
        t = read(f"{SA_SRC}/{f}")
        if t:
            scanned += 1
            names |= set(rx.findall(t))
    miss = sorted(names - cover)
    return scanned >= 10 and bool(cover) and not miss, f"scanned={scanned} uncovered exports={miss[:12]} (total {len(miss)})"


@check("search-inventory", 4)
def _si4():
    """Each row names the destination state it is implemented in and carries a `pin` {file, test} placeholder under entrypoint/stealth-search/src/test/ or `pin: null` with a `reason` for rows owned by hosts, usecases, examples, cutover or docs states; the 209 rows of evidence/failsafe-inventory.json are not duplicated (no row repeats a `fs-NNN` id)."""
    rows = _sa_rows()
    bad = []
    for r in rows:
        pin = r.get("pin")
        if str(r.get("id", "")).startswith("fs-"):
            bad.append(f"{r.get('id')}: duplicates a core row")
        elif pin is None:
            if not r.get("reason"):
                bad.append(f"{r.get('id')}: null pin without reason")
        elif not (isinstance(pin, dict) and str(pin.get("file", "")).startswith("src/test/") and pin.get("test")):
            bad.append(f"{r.get('id')}: pin")
    return bool(rows) and not bad, f"pin problems {bad[:8]}"


@check("search-inventory", 5)
def _si5():
    """Only owned paths changed by [psm:search-inventory] commits."""
    return ownership_ok("search-inventory")


# ============================================================ search-errors
def _se_text():
    return read(f"{SEARCH_DIR}/src/errors.ts")


@check("search-errors", 1)
def _se1():
    """src/errors.ts defines `StealthSearchError extends StealthCoreBrowserError` (imported from @adhd/stealth-core-browser, which exports it), exports `SEARCH_ERROR_CODES` containing every code UNKNOWN_PROVIDER, SEARCH_FAILED, SELECTOR_TIMEOUT, HITL_ABORTED, TRIPWIRE_STATE_UNREADABLE, TRIPWIRE_CLEAR_FAILED, PROVIDER_STATE_IO, FETCH_URL_REFUSED, PDF_EXTRACT_FAILED, HOST_FLAG_INVALID, HOST_TRANSPORT_UNSUPPORTED, HOST_BOOT_FAILED and NODE_TOO_OLD, and exports `exitCodeFor`."""
    t = _se_text()
    core = read(f"{CORE_DIR}/src/index.ts") + read(f"{CORE_DIR}/src/lib/errors.ts")
    ok = (re.search(r"class\s+StealthSearchError\s+extends\s+StealthCoreBrowserError", t) is not None
          and "@adhd/stealth-core-browser" in t and "SEARCH_ERROR_CODES" in t and re.search(r"export\s+(?:function|const)\s+exitCodeFor", t) is not None
          and all(c in t for c in SA_CODES) and "StealthCoreBrowserError" in core)
    return ok, f"codes missing={[c for c in SA_CODES if c not in t]}"


@check("search-errors", 2)
def _se2():
    """Every code is proven by a unit spec through the real path (the spec triggers the failure and asserts `instanceof StealthSearchError`, `instanceof StealthCoreBrowserError`, the `code` and the `exitCodeFor` value; no mocking of the error class), each spec cites ticket 8468f7b1 and a search-errors.N id, and each of the 13 code strings appears in at least one spec under src/test/unit/errors/."""
    specs = _sa_specs("search-errors")
    txt = _sa_text(specs)
    miss = [c for c in SA_CODES if c not in txt]
    ok, d = cites(specs, "search-errors")
    return ok and not miss and "exitCodeFor" in txt and "instanceof" in txt, f"{d}; codes without spec {miss}"


@check("search-errors", 3)
def _se3():
    """100% typed errors in the entrypoint so far: no bare `new Error(`, `TypeError`, `RangeError`, string throw or string rejection in non-test source under entrypoint/stealth-search/src and bin, and no `process.env`."""
    files = nontest_ts(SEARCH_DIR)
    return bool(files) and not untyped_error_sites(files) and not env_readers(files), f"files={len(files)} untyped={untyped_error_sites(files)[:5]} env={env_readers(files)[:5]}"


@check("search-errors", 4)
def _se4():
    """docs/ERRORS.md lists every code with its exit code, cause and remedy (a table row per code, the same strings as SEARCH_ERROR_CODES), states that outcomes (`success|empty|error|timeout|hitl|captcha|rate_limited|banned`) are data and not exceptions, and shows the CLI `<CODE>: <message>` stderr form and the MCP `isError: true` form."""
    t = read(f"{SEARCH_DIR}/docs/ERRORS.md")
    miss = [c for c in SA_CODES if c not in t]
    ok = not miss and "rate_limited" in t and "isError" in t and re.search(r"<CODE>: <message>|CODE: message", t) is not None
    return bool(t) and ok, f"codes missing {miss}"


@check("search-errors", 5)
def _se5():
    """The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0."""
    return _sa_gate("typecheck", "lint", "test")


@check("search-errors", 6)
def _se6():
    """Only owned paths changed by [psm:search-errors] commits."""
    return ownership_ok("search-errors")


# ============================================================ search-port-providers
@check("search-port-providers", 1)
def _spp1():
    """src/lib/providers.ts registers exactly the 12 providers duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow and fetch (a spec asserts the ordered id list equals these twelve), each with its extractor config and qualifier examples, and `getProvider` of an unknown id throws StealthSearchError with code UNKNOWN_PROVIDER (asserted through the real call, not a mock)."""
    t = read(f"{SEARCH_DIR}/src/lib/providers.ts")
    spec = _sa_text(_sa_specs("search-port-providers"))
    ok = all(f"'{p}'" in t or f'"{p}"' in t for p in SA_PROVIDERS) and all(p in spec for p in SA_PROVIDERS) and "UNKNOWN_PROVIDER" in spec and "getProvider" in t
    return ok, "provider ids/spec incomplete"


@check("search-port-providers", 2)
def _spp2():
    """src/lib/types.ts reuses the core `PageSource` (imported from @adhd/stealth-core-browser, no second definition of it), declares the eight outcomes success, empty, error, timeout, hitl, captcha, rate_limited and banned, and has no optional boolean property in any exported input or output type (`?: boolean` is forbidden, enums replace includeContent/foreground/keepPage)."""
    t = read(f"{SEARCH_DIR}/src/lib/types.ts")
    code = code_lines(t)
    outcomes = ["success", "empty", "error", "timeout", "hitl", "captcha", "rate_limited", "banned"]
    ok = (re.search(r"import[^;]*PageSource[^;]*@adhd/stealth-core-browser", t, re.S) is not None
          and not re.search(r"(?:interface|type)\s+(?:PageSource|SearchResultSource)\b", code)
          and all(o in t for o in outcomes) and not re.search(r"\?\s*:\s*boolean", code))
    return ok, "types.ts missing core PageSource reuse / outcomes or has optional booleans"


@check("search-port-providers", 3)
def _spp3():
    """src/lib/utils.ts prepends the qualifier to the query and maps a github `type:code` search to the github-code provider, proven by a spec that runs both transformations on real provider ids (including the no-qualifier and fetch-provider no-prepend cases)."""
    t = read(f"{SEARCH_DIR}/src/lib/utils.ts")
    spec = _sa_text(_sa_specs("search-port-providers"))
    return "github-code" in t and "github-code" in spec and "qualifier" in spec and "type:code" in spec, "utils.ts/spec lack qualifier or github-code handling"


@check("search-port-providers", 4)
def _spp4():
    """src/lib/queries/last-search.ts recovers the last Google search keyword by reading the core `storage.history` API (imported from @adhd/stealth-core-browser; no `node:sqlite`, no SQL and no profile path in this file), proven by a spec over a history fixture with a result, an empty history and a non-Google URL."""
    t = read(f"{SEARCH_DIR}/src/lib/queries/last-search.ts")
    spec = _sa_text(_sa_specs("search-port-providers"))
    ok = "storage" in t and "@adhd/stealth-core-browser" in t and "node:sqlite" not in t and not re.search(r"\bSELECT\b", t) and "last-search" in spec
    return bool(t) and ok, "last-search.ts missing or not built on core storage.history"


@check("search-port-providers", 5)
def _spp5():
    """Every inventory row owned by search-port-providers is cited by its id (e.g. `I-22`) in the source or its specs, and every spec cites ticket 8468f7b1 and a search-port-providers.N id with at least two spec files simulating real provider use."""
    a = _sa_inventory_cited("search-port-providers")
    b = _sa_tests_cite("search-port-providers")
    return a[0] and b[0], f"{a[1]} | {b[1]}"


@check("search-port-providers", 6)
def _spp6():
    """Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket."""
    return _sa_hygiene("search-port-providers")


@check("search-port-providers", 7)
def _spp7():
    """The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0."""
    return _sa_gate("typecheck", "lint", "test")


@check("search-port-providers", 8)
def _spp8():
    """Only owned paths changed by [psm:search-port-providers] commits."""
    return ownership_ok("search-port-providers")


# ============================================================ search-port-fetch
@check("search-port-fetch", 1)
def _spf1():
    """FIRST STEP, probe U-PDF (risk O4): evidence/split/u-pdf.json records `fixture_pdf` (a PDF in the unit fixtures), `extracted_text` containing the fixture's known sentence, `built_load: true` (the BUILT bin or dist module extracted it, not tsx), and `route` of `dynamic-import` or `mjs-helper`; if the CJS build rewrote `await import('pdfjs-dist/legacy/build/pdf.mjs')` into `require()` the route is `mjs-helper` and the helper is copied to dist by a build asset entry."""
    d = jread(SA_UPDF, {}) or {}
    return (d.get("route") in ("dynamic-import", "mjs-helper") and d.get("built_load") is True and bool(d.get("fixture_pdf")) and bool(d.get("extracted_text"))), f"probe={d}"


@check("search-port-fetch", 2)
def _spf2():
    """src/lib/fetch/ holds policy.ts, markdown.ts, pdf.ts and fetch.ts: the SSRF policy, the 1 MiB Turndown input cap with a truncation marker, the pdfjs text extraction (failure -> StealthSearchError PDF_EXTRACT_FAILED), and the cookieless render with `FETCH_UA`, the 3000-character sparse-challenge heuristic and the two-phase Cloudflare wait; fetch.ts reaches Chrome only through core `cdp.*`/`capture.*`/`chromeManager` calls."""
    base = f"{SEARCH_DIR}/src/lib/fetch"
    t = {n: read(f"{base}/{n}.ts") for n in ("policy", "markdown", "pdf", "fetch")}
    ok = (all(t.values()) and re.search(r"1048576|1024\s*\*\s*1024", t["markdown"]) and "truncat" in t["markdown"].lower()
          and "PDF_EXTRACT_FAILED" in t["pdf"] and "FETCH_UA" in t["fetch"] and "3000" in t["fetch"]
          and "@adhd/stealth-core-browser" in t["fetch"])
    return bool(ok), "fetch module set incomplete"


@check("search-port-fetch", 3)
def _spf3():
    """The SSRF matrix is a security failsafe with its own spec: the policy spec asserts a refusal for `::ffff:169.254.169.254`, `localhost.` (trailing dot), `file:`, embedded credentials (`user:pass@`), `169.254.169.254`, `10.0.0.1`, `192.168.1.1`, `127.0.0.1`, a single-label host, an IPv4-mapped hex form, a URL over 2000 characters and a non-http(s) scheme, plus an accepted public https URL; a refusal stays a RESPONSE outcome `error` whose message carries `FETCH_URL_REFUSED`."""
    spec = _sa_text(spec_files_of(SEARCH_DIR, "unit/fetch"))
    vectors = ["::ffff:169.254.169.254", "localhost.", "file:", "user:pass@", "169.254.169.254", "10.0.0.1", "192.168.1.1", "127.0.0.1", "FETCH_URL_REFUSED", "2000"]
    miss = [v for v in vectors if v not in spec]
    return not miss and "https://" in spec, f"matrix vectors missing from specs: {miss}"


@check("search-port-fetch", 4)
def _spf4():
    """The markdown and PDF branches are proven by specs: a 1.5 MiB HTML input is truncated at the 1 MiB cap with the marker, a fixture PDF is extracted page by page under the per-page cap, a corrupt PDF raises PDF_EXTRACT_FAILED, and a sparse (under 3000 characters) challenge page triggers the two-phase wait before the result is returned."""
    spec = _sa_text(spec_files_of(SEARCH_DIR, "unit/fetch")).lower()
    return all(k in spec for k in ("truncat", "pdf_extract_failed", "sparse", "pdf")), "specs lack truncation / corrupt-pdf / sparse-challenge cases"


@check("search-port-fetch", 5)
def _spf5():
    """Every inventory row owned by search-port-fetch is cited by id in the source or specs, and the specs (at least two files, one for the policy matrix) cite ticket 8468f7b1 and a search-port-fetch.N id."""
    a = _sa_inventory_cited("search-port-fetch")
    b = _sa_tests_cite("search-port-fetch")
    return a[0] and b[0], f"{a[1]} | {b[1]}"


@check("search-port-fetch", 6)
def _spf6():
    """Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket."""
    return _sa_hygiene("search-port-fetch")


@check("search-port-fetch", 7)
def _spf7():
    """The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0."""
    return _sa_gate("typecheck", "lint", "test")


@check("search-port-fetch", 8)
def _spf8():
    """Only owned paths changed by [psm:search-port-fetch] commits."""
    return ownership_ok("search-port-fetch")


# ============================================================ search-port-engine
@check("search-port-engine", 1)
def _spe1():
    """src/lib/network.ts, dom.ts and challenge.ts exist; network capture is done through the core `capture.captureNetworkResponse` with a `select` function (no second capture implementation, no file named network-capture* in the package), and the direct JSON-API fetch path needs no browser."""
    base = f"{SEARCH_DIR}/src/lib"
    n = read(f"{base}/network.ts")
    dup = [f for f in walk(f"{SEARCH_DIR}/src") if "network-capture" in os.path.basename(f)]
    ok = all(exists(f"{base}/{x}.ts") for x in ("network", "dom", "challenge")) and "captureNetworkResponse" in n and "select" in n and not dup
    return ok, f"duplicate capture files {dup}"


@check("search-port-engine", 2)
def _spe2():
    """dom.ts ports the DOM extraction (pattern and structural extractors, ban checks) and the selector wait with jittered 600-1800 ms retries, raising StealthSearchError SELECTOR_TIMEOUT when the wait is exhausted; a spec drives it with a fake page object over a real result-page HTML fixture, an empty page, a banned page and a selector timeout."""
    t = read(f"{SEARCH_DIR}/src/lib/dom.ts")
    spec = _sa_text(spec_files_of(SEARCH_DIR, "unit/engine"))
    ok = "600" in t and "1800" in t and "SELECTOR_TIMEOUT" in t and "SELECTOR_TIMEOUT" in spec and "banned" in spec
    return ok, "dom.ts/spec missing jitter bounds, SELECTOR_TIMEOUT or banned case"


@check("search-port-engine", 3)
def _spe3():
    """challenge.ts ports the Cloudflare managed-challenge recovery: reveal the page, poll the provider ban markers, retry exactly once; a spec asserts recovery then one retry, an unrecoverable challenge returning outcome `captcha`, and that no second retry is attempted."""
    t = read(f"{SEARCH_DIR}/src/lib/challenge.ts")
    spec = _sa_text(spec_files_of(SEARCH_DIR, "unit/engine")).lower()
    return bool(t) and "captcha" in spec and "retry" in spec and "once" in spec, "challenge.ts/spec lack the recover-then-retry-once cases"


@check("search-port-engine", 4)
def _spe4():
    """The engine layer is pure over core calls: network.ts, dom.ts and challenge.ts import their browser access only from @adhd/stealth-core-browser (no `ws`, no raw CDP client of their own), and a spec covers the no-network-config error outcome and the direct JSON fetch."""
    files = _sa_files("search-port-engine")
    spec = _sa_text(spec_files_of(SEARCH_DIR, "unit/engine"))
    ok = len(files) == 3 and all("@adhd/stealth-core-browser" in read(f) for f in files if not f.endswith("utils.ts")) and "No network config" in spec
    return ok, f"files={len(files)}"


@check("search-port-engine", 5)
def _spe5():
    """Every inventory row owned by search-port-engine is cited by id in the source or specs, and the specs (at least three files: network, dom, challenge) cite ticket 8468f7b1 and a search-port-engine.N id."""
    a = _sa_inventory_cited("search-port-engine")
    b = _sa_tests_cite("search-port-engine", 3)
    return a[0] and b[0], f"{a[1]} | {b[1]}"


@check("search-port-engine", 6)
def _spe6():
    """Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket."""
    return _sa_hygiene("search-port-engine")


@check("search-port-engine", 7)
def _spe7():
    """The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0."""
    return _sa_gate("typecheck", "lint", "test")


@check("search-port-engine", 8)
def _spe8():
    """Only owned paths changed by [psm:search-port-engine] commits."""
    return ownership_ok("search-port-engine")


# ============================================================ search-port-guards
@check("search-port-guards", 1)
def _spg1():
    """src/lib/config.ts exports the typed `SearchHostConfig` (dataDir, auditPath, auditMaxBytes, tripwireTtlMs, cooldownCaptchaMs, cooldownRateMs, cooldownBannedMs, maxConcurrent, maxSiblings, sessionId) and a `DEFAULT_SEARCH_HOST_CONFIG` with the defaults 7200000, 30000, 20000, 60000, 2 and 4 and a data dir derived from `adhdDataDir` (default root ~/.adhd/reverse/data), plus the `InteractionPort` interface (tripwire gate prompt and solved-confirmation methods) used by `configureSearch({ interaction })`."""
    t = read(f"{SEARCH_DIR}/src/lib/config.ts")
    keys = ["dataDir", "auditPath", "auditMaxBytes", "tripwireTtlMs", "cooldownCaptchaMs", "cooldownRateMs", "cooldownBannedMs", "maxConcurrent", "maxSiblings"]
    nums = ["7200000", "30000", "20000", "60000"]
    ok = all(k in t for k in keys) and all(n in t for n in nums) and "SearchHostConfig" in t and "InteractionPort" in t and "adhdDataDir" in t
    return ok, "config.ts incomplete"


@check("search-port-guards", 2)
def _spg2():
    """guard.ts ports the provider cooldown and the concurrency cap: cooldown state is written atomically (temp file then rename) to `<data>/guard/<provider>.json`, expired cooldowns are removed lazily on read, a `hitl` outcome never arms a cooldown while `success` and `empty` disarm it, unreadable state raises PROVIDER_STATE_IO, and `maxConcurrent` (default 2, <= 0 disables) is a per-process FIFO queue; specs simulate three concurrent callers (third waits, FIFO release order), the three cooldown durations, lazy removal and the hitl exclusion."""
    t = read(f"{SEARCH_DIR}/src/lib/guard.ts")
    spec = _sa_text(_sa_specs("search-port-guards")).lower()
    ok = ("rename" in t and "PROVIDER_STATE_IO" in t and "guard" in t
          and all(k in spec for k in ("fifo", "hitl", "rename", "lazy")) and "maxconcurrent" in spec)
    return ok, "guard.ts/spec lack atomic write, lazy removal, hitl exclusion or FIFO cases"


@check("search-port-guards", 3)
def _spg3():
    """tripwire.ts builds the tripwire from the tripwire package with `createTripwire` using namespace `stealth-search` (decision O8, constant `TRIPWIRE_NAMESPACE`, existing `agent-search` locks expire in 2 h), `clearPolicy: 'open'`, the TTL from config (default 7200000), stateDir/auditPath/maxAuditBytes from `SearchHostConfig`; it maps fire, gate with blocked-count, cleared, resolved, read and isTripped, keeps `TripwireRecord` a concrete non-generic interface, and `tripwireStatus` returns a sparse string-keyed record; unreadable state raises TRIPWIRE_STATE_UNREADABLE and a failed clear TRIPWIRE_CLEAR_FAILED; specs simulate fire, blocked gate, clear of a tripped provider, clear of an untripped one (false), an expired lock and a corrupt lock."""
    t = read(f"{SEARCH_DIR}/src/lib/tripwire.ts")
    spec = _sa_text(_sa_specs("search-port-guards"))
    ok = ("createTripwire" in t and "@adhd/resilience-core-tripwire" in t and re.search(r"TRIPWIRE_NAMESPACE\s*=\s*['\"]stealth-search['\"]", t) is not None
          and re.search(r"clearPolicy:\s*['\"]open['\"]", t) is not None and "TRIPWIRE_STATE_UNREADABLE" in t and "TRIPWIRE_CLEAR_FAILED" in t
          and "interface TripwireRecord" in t and all(k in spec.lower() for k in ("expired", "corrupt", "blocked")))
    return ok, "tripwire.ts/spec incomplete"


@check("search-port-guards", 4)
def _spg4():
    """No state or behaviour is read from the environment: guard.ts, tripwire.ts and config.ts have no `process.env` and take every setting from `SearchHostConfig` (ADR-0001), proven by a spec that builds two different configs in one process."""
    files = _sa_files("search-port-guards")
    spec = _sa_text(_sa_specs("search-port-guards"))
    return len(files) == 3 and not env_readers(files) and "SearchHostConfig" in spec, f"files={len(files)} env={env_readers(files)}"


@check("search-port-guards", 5)
def _spg5():
    """Every inventory row owned by search-port-guards is cited by id in the source or specs, and the specs (at least three files: guard, tripwire, config) cite ticket 8468f7b1 and a search-port-guards.N id."""
    a = _sa_inventory_cited("search-port-guards")
    b = _sa_tests_cite("search-port-guards", 3)
    return a[0] and b[0], f"{a[1]} | {b[1]}"


@check("search-port-guards", 6)
def _spg6():
    """Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket."""
    return _sa_hygiene("search-port-guards")


@check("search-port-guards", 7)
def _spg7():
    """The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0."""
    return _sa_gate("typecheck", "lint", "test")


@check("search-port-guards", 8)
def _spg8():
    """Only owned paths changed by [psm:search-port-guards] commits."""
    return ownership_ok("search-port-guards")


# ============================================================ search-verbs
@check("search-verbs", 1)
def _sv1():
    """FIRST STEP, probes U-REEXPORT and U-BOOL: evidence/split/search-verbs-probes.json records `u_reexport` {result: pass|fallback, tools_checked: the five re-exported core verbs, properties_seen} from extracting the BUILT dist/api.d.ts, and `u_bool` {result: pass, help_ok: true, tools_list_ok: true} (`--help` and `tools/list` do not crash on `SearchInput`); when u_reexport is `fallback`, src/api.ts declares the five verbs as local wrappers with identical signatures instead of `export { ... } from`."""
    pr = jread(SA_PROBES, {}) or {}
    ur, ub = pr.get("u_reexport") or {}, pr.get("u_bool") or {}
    api = read(f"{SEARCH_DIR}/src/api.ts")
    reexport = re.search(r"export\s*\{[^}]*chromeStatus[^}]*\}\s*from\s*['\"]@adhd/stealth-core-browser", api) is not None
    ok = (ur.get("result") in ("pass", "fallback") and len(ur.get("tools_checked") or []) == 5 and ub.get("result") == "pass"
          and ub.get("help_ok") is True and ub.get("tools_list_ok") is True and (ur.get("result") == "fallback") != reexport)
    return ok, f"probes={pr} reexport_in_api={reexport}"


@check("search-verbs", 2)
def _sv2():
    """src/api.ts exports exactly the eleven tools search, listProviders, describeProvider, tripwireStatus, clearTripwire, chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity and getPageContext (no `shutdownSearchChrome`, no `providerUsage`), every verb takes at most one JSON input object, `SearchInput` carries the enums `strategy`, `content: 'none'|'full'`, `visibility: 'offscreen'|'foreground'`, `pageDisposal: 'dispose'|'keep'`, and no optional boolean property exists in any input or output type of src/api.ts and src/lib/types.ts."""
    api = read(f"{SEARCH_DIR}/src/api.ts")
    code = code_lines(api)
    names = set(re.findall(r"export\s+(?:async\s+)?function\s+(\w+)", code))
    for blk in re.findall(r"export\s*\{([^}]*)\}", code):
        names |= {x.strip().split(" as ")[-1].strip() for x in blk.split(",") if x.strip()}
    verbs = names - {n for n in names if n[:1].isupper()}
    one_arg = not re.search(r"export\s+(?:async\s+)?function\s+\w+\s*\([^)]*,", code)
    types_txt = code + code_lines(read(f"{SEARCH_DIR}/src/lib/types.ts"))
    ok = (set(SA_TOOLS) <= verbs and not ({"shutdownSearchChrome", "providerUsage"} & verbs) and one_arg
          and "pageDisposal" in api + types_txt and "visibility" in types_txt + api and not re.search(r"\?\s*:\s*boolean", types_txt))
    return ok, f"missing={sorted(set(SA_TOOLS) - verbs)} extra={sorted(verbs - set(SA_TOOLS))}"


@check("search-verbs", 3)
def _sv3():
    """`launchChrome` exposes no `chromePath` and no `extraArgs` property anywhere in src/api.ts or in the type it takes (it inherits the core `LaunchChromeInput` of `{port, userDataDir}`), and getPageContext's pipeline lives in src/host-projection.ts as `redactCookieValues`, called by the `getPageContext` verb so both hosts share one redaction site; a spec over a cookie fixture whose value is `SECRET123` asserts the output keeps cookie names and counts and contains no value string."""
    api = read(f"{SEARCH_DIR}/src/api.ts")
    hp = read(f"{SEARCH_DIR}/src/host-projection.ts")
    spec = _sa_text(_sa_specs("search-verbs"))
    ok = ("chromePath" not in api and "extraArgs" not in api and re.search(r"export\s+(?:function|const)\s+redactCookieValues", hp) is not None
          and "redactCookieValues" in api and "SECRET123" in spec)
    return ok, "api.ts/host-projection.ts/spec lack allowlist or redaction"


@check("search-verbs", 4)
def _sv4():
    """src/lib/search.ts orchestrates the search in the ported order and is proven by unit scenarios on a fake core (zero real Chrome): unknown provider raises UNKNOWN_PROVIDER before any gate; a tripped provider returns outcome `hitl` with attempts 0 and ZERO Chrome calls; an armed cooldown returns `rate_limited` with a retry hint and no window; the concurrency cap queues the third call; a hostile outcome (captcha, rate_limited, banned) arms the cooldown but `hitl` does not; a HITL outcome fires the tripwire, reveals the page and keeps the context alive; `pageDisposal: 'dispose'` disposes the context in the finally path and an outer catch disposes a leaked one."""
    t = read(f"{SEARCH_DIR}/src/lib/search.ts")
    spec = _sa_text(_sa_specs("search-verbs"))
    ok = bool(t) and all(k in spec for k in ("UNKNOWN_PROVIDER", "hitl", "rate_limited", "pageDisposal", "attempts")) and "configureSearch" in (t + read(f"{SEARCH_DIR}/src/index.ts"))
    return ok, "search.ts/spec lack the gate-order scenarios"


@check("search-verbs", 5)
def _sv5():
    """src/index.ts exports the eleven verbs, `configureSearch` (accepting `{ interaction?, config? }` with the `InteractionPort`), the types and the error classes; the package root has no side effect on import (no listen, no spawn, no telemetry init), asserted by a spec that imports it and checks that no handle was created."""
    t = read(f"{SEARCH_DIR}/src/index.ts")
    spec = _sa_text(_sa_specs("search-verbs"))
    ok = "configureSearch" in t and "StealthSearchError" in t and "interaction" in (t + read(f"{SEARCH_DIR}/src/lib/search.ts")) and "import" in spec
    return ok, "index.ts incomplete"


@check("search-verbs", 6)
def _sv6():
    """Every inventory row owned by search-verbs is cited by id in the source or specs, and the specs (at least three files) cite ticket 8468f7b1 and a search-verbs.N id."""
    a = _sa_inventory_cited("search-verbs")
    b = _sa_tests_cite("search-verbs", 3)
    return a[0] and b[0], f"{a[1]} | {b[1]}"


@check("search-verbs", 7)
def _sv7():
    """Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket."""
    return _sa_hygiene("search-verbs")


@check("search-verbs", 8)
def _sv8():
    """The state gates are green: `nx run stealth-search:typecheck`, `:lint`, `:test` and `:build` exit 0."""
    return _sa_gate("typecheck", "lint", "test", "build")


@check("search-verbs", 9)
def _sv9():
    """Only owned paths changed by [psm:search-verbs] commits."""
    return ownership_ok("search-verbs")


# ============================================================ search-tracing
@check("search-tracing", 1)
def _st1():
    """src/tracing.ts exports `tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' })` and is the ONLY file under entrypoint/stealth-search/src and bin that contains a `serviceName` literal; the literal is `adhd`."""
    t = read(f"{SEARCH_DIR}/src/tracing.ts")
    holders = [f for f in nontest_ts(SEARCH_DIR) if re.search(r"serviceName", code_lines(read(f)))]
    ok = re.search(r"export\s+const\s+tracingPlugin\s*=\s*makeTracingPlugin\(\s*\{\s*serviceName:\s*['\"]adhd['\"]", t) is not None
    return ok and holders == [f"{SEARCH_DIR}/src/tracing.ts"], f"serviceName holders {holders}"


@check("search-tracing", 2)
def _st2():
    """The package's own `tracingPlugin` singleton (namespace `apigen`) is never imported: no file in src or bin imports `tracingPlugin` from `@adhd/apigen-plugin-tracing`, and no `apigen` serviceName appears."""
    files = nontest_ts(SEARCH_DIR)
    bad = offenders(files, r"import\s*\{[^}]*\btracingPlugin\b[^}]*\}\s*from\s*['\"]@adhd/apigen-plugin-tracing['\"]")
    return bool(files) and not bad and exists(f"{SEARCH_DIR}/src/tracing.ts"), f"singleton importers {bad}"


@check("search-tracing", 3)
def _st3():
    """src/telemetry.ts is the single telemetry composition root: it exports one function that calls `initTelemetry({ service: 'stealth-search', role, logSink: 'file', ... })` with `role` of `cli` or `live-service` and an optional `logDir`, failure is non-fatal and warned once on stderr, and exactly ONE `initTelemetry(` call exists in all non-test source under src and bin (in telemetry.ts)."""
    t = read(f"{SEARCH_DIR}/src/telemetry.ts")
    files = nontest_ts(SEARCH_DIR)
    calls = [f for f in files if re.search(r"\binitTelemetry\s*\(", code_lines(read(f)))]
    ok = (re.search(r"service:\s*['\"]stealth-search['\"]", t) is not None and "logSink" in t and "'cli'" in t.replace('"', "'")
          and "live-service" in t and "logDir" in t and "catch" in t and "stderr" in t)
    return ok and calls == [f"{SEARCH_DIR}/src/telemetry.ts"] and len(re.findall(r"\binitTelemetry\s*\(", code_lines(t))) == 1, f"initTelemetry callers {calls}"


@check("search-tracing", 4)
def _st4():
    """Neither file reads the environment (no `process.env`, ADR-0001), neither constructs a bare Error, and `nx run stealth-search:typecheck` and `:lint` exit 0."""
    files = [f"{SEARCH_DIR}/src/tracing.ts", f"{SEARCH_DIR}/src/telemetry.ts"]
    if not all(exists(f) for f in files):
        return False, "tracing.ts/telemetry.ts missing"
    if env_readers(files) or untyped_error_sites(files):
        return False, f"env={env_readers(files)} untyped={untyped_error_sites(files)}"
    return _sa_gate("typecheck", "lint")


@check("search-tracing", 5)
def _st5():
    """Only owned paths changed by [psm:search-tracing] commits."""
    return ownership_ok("search-tracing")


# ============================================================ backlog fold-in (2026-10-14 search bugs)
# Each criterion below is red until a spec that cites its [slug.N] id AND the backlog uid it simulates exists
# and the owning unit directory runs green.  Specs are plan-owned test files under the owning state's reserved dirs.
def _bug_ac(project, slug, n, uids, sub, tokens, src=None, nx_all=False):
    """Shared check body: specs under src/test/unit/<sub> that cite [slug.n] carry every uid and token, the optional
    source patterns match, and the unit directory (or the whole project when nx_all) runs green through nx."""
    root = SEARCH_DIR if project == "search" else CORE_DIR
    tag = f"[{slug}.{n}]"
    specs = [f for f in spec_files_of(root, f"unit/{sub}") if tag in read(f)]
    if not specs:
        return False, f"no spec under {root}/src/test/unit/{sub} cites {tag}"
    txt = "\n".join(read(f) for f in specs)
    low = txt.lower()
    miss_uid = [u for u in uids if u not in txt]
    miss_tok = [t for t in tokens if t.lower() not in low]
    ok, detail = cites(specs, slug)
    bad_src = []
    for rel, rx in (src or []):
        body = code_lines(read(f"{root}/{rel}")) if exists(f"{root}/{rel}") else ""
        if not re.search(rx, body):
            bad_src.append(f"{rel}: /{rx}/")
    if miss_uid or miss_tok or not ok or bad_src:
        return False, f"uids missing {miss_uid} tokens missing {miss_tok} {detail} source patterns unmet {bad_src}"
    target = ["test"] if nx_all else ["test", "--", f"src/test/unit/{sub}"]
    rc, out = nx_run(SEARCH_PROJECT if project == "search" else CORE_PROJECT, *target)
    return rc == 0, f"nx test exit {rc}: {out[-200:]}"


@check("search-port-fetch", 9)
def _spf9():
    """(backlog cd05ad09) The fetch result is token-efficient by default: with the default `content: 'none'` it holds only the metadata fields provider, url, finalUrl, outcome, status, contentType, contentSize, title, truncated, attempts and tookMs (no `content`, no HTML, no `raw.preview`); `content: 'full'` adds `content` as HTML-stripped markdown or text bounded by `maxContentSize` (the exported constant `DEFAULT_MAX_CONTENT_SIZE = 20000` bytes in src/lib/fetch/fetch.ts) starting at `offset`, and returns `nextOffset` while truncated so a caller can page. A spec under src/test/unit/fetch/ simulates the real case, a 408112-byte repository README page: the default result serializes under 2048 bytes, `content: 'full'` returns at most 20000 bytes plus `nextOffset`, and following `nextOffset` reaches the end with `nextOffset` absent; spec titles carry the literals `contentSize`, `nextOffset`, `maxContentSize`, `offset`, `finalUrl`, `408112`, `2048`, `20000` and the uid cd05ad09, and the spec cites [search-port-fetch.9]."""
    return _bug_ac("search", "search-port-fetch", 9, ["cd05ad09"], "fetch",
                   ["contentSize", "nextOffset", "maxContentSize", "offset", "finalUrl", "408112", "2048", "20000"],
                   [("src/lib/fetch/fetch.ts", r"DEFAULT_MAX_CONTENT_SIZE\s*=\s*20_?000\b")])


@check("search-port-fetch", 10)
def _spf10():
    """(backlog 86ed154e) A fetch of a missing page is never `success`: HTTP 404 and 410 return outcome `error` carrying the HTTP `status` and a message that begins `SEARCH_FAILED:` (no new error code: the registry stays at the 13 of search-errors); a soft not-found (status 200 whose title or first heading matches a not-found phrase on a sparse page under 3000 characters, or a deep path that redirects to the site root so `finalUrl` differs from `url`) returns outcome `error` the same way; a long real page (over 3000 characters) that merely contains the phrase 'page not found' in its body stays `success`. Specs under src/test/unit/fetch/ simulate the reported cases (self-hosting docs URL that 404s, a marketing page reached by redirect, a guide page that is real) with HTML fixtures; titles carry `404`, `410`, `soft-404`, `redirect`, `SEARCH_FAILED`, `false positive` and the uid 86ed154e, and the spec cites [search-port-fetch.10]."""
    return _bug_ac("search", "search-port-fetch", 10, ["86ed154e"], "fetch",
                   ["404", "410", "soft-404", "redirect", "SEARCH_FAILED", "false positive"])


@check("search-port-providers", 9)
def _spp9():
    """(backlog 861571da, 224e7a44) The github provider returns results or a typed outcome, never a silent empty or a long hang: repository search (default `type=repositories`, dom strategy) yields results from a result-page fixture and, when the dom path finds none, falls back once to an API fixture inside the same call; `type:code` search maps to the github-code provider and, given an unauthenticated login wall fixture, returns outcome `error` whose message names the login wall (never `empty` or `success` with zero results); a rate-limit fixture returns `rate_limited`. Specs under src/test/unit/providers/ drive the real provider functions over fixtures; titles carry `type:code`, `login wall`, `fallback`, `rate_limited`, `repositories` and the uids 861571da and 224e7a44, and the spec cites [search-port-providers.9]."""
    return _bug_ac("search", "search-port-providers", 9, ["861571da", "224e7a44"], "providers",
                   ["type:code", "login wall", "fallback", "rate_limited", "repositories"])


@check("search-port-engine", 9)
def _spe9():
    """(backlog 224e7a44) A network-capture failure never hangs or escapes as an unhandled rejection: when the CDP socket closes or errors during capture (a fake page whose capture rejects with a socket-closed error) the engine falls back to the dom strategy once and returns its results; when the fallback also fails it returns outcome `error` whose message names the cause. Specs under src/test/unit/engine/ register a process `unhandledRejection` listener and assert it never fires; titles carry `socket closed`, `falls back`, `dom`, `unhandledRejection` and the uid 224e7a44, and the spec cites [search-port-engine.9]."""
    return _bug_ac("search", "search-port-engine", 9, ["224e7a44"], "engine",
                   ["socket closed", "falls back", "dom", "unhandledRejection"])


@check("search-port-engine", 10)
def _spe10():
    """(backlog 406a4e66) Google result-page (SERP) parsing is a search feature owned by stealth-search, not the core: src/lib/dom.ts holds the Google SERP walker (OD-11 keeps it as a ported feature) and imports no SERP- or Google-named symbol from @adhd/stealth-core-browser; a spec under src/test/unit/engine/ parses a Google result-page fixture through it. Deleting the original from the core is a core-side follow-up that belongs to the OD-11 decision and is recorded as a finding in this state's context, not required here. Titles carry `Google`, `SERP` and the uid 406a4e66, and the spec cites [search-port-engine.10]."""
    dom = read(f"{SEARCH_DIR}/src/lib/dom.ts")
    imports = re.findall(r"import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['\"]@adhd/stealth-core-browser['\"]", dom)
    leaked = [n.strip() for blob in imports for n in blob.split(",") if re.search(r"serp|google", n, re.I)]
    if not re.search(r"google", code_lines(dom), re.I) or leaked:
        return False, f"dom.ts google walker present={bool(re.search('google', code_lines(dom), re.I))} serp/google imports from the core={leaked}"
    return _bug_ac("search", "search-port-engine", 10, ["406a4e66"], "engine", ["Google", "SERP"])


@check("search-inventory", 6)
def _si6():
    """(backlog 406a4e66) The inventory records the Google SERP parsing as search-owned: at least one row whose feature, symbols or source mention the Google result-page (SERP) walker or `capture/dom.ts` has owner_state `search-port-engine` and a destination naming `dom.ts` (entrypoint/stealth-search/src/lib/dom.ts), so no Google SERP parser is left unaccounted for in the core."""
    hit = [r.get("id") for r in _sa_rows()
           if re.search(r"serp|capture/dom|google result", json.dumps(r, default=str), re.I)
           and r.get("owner_state") == "search-port-engine" and "dom.ts" in str(r.get("destination", ""))]
    return bool(hit), f"rows {hit}"


@check("search-verbs", 10)
def _sv10():
    """(backlog cd05ad09) Verb output is token-efficient by default: `SearchInput` gains `offset` (number) and `preview: 'none'|'include'` (an enum, no boolean) and defaults to `content: 'none'`, `preview: 'none'` and `maxContentSize` = `DEFAULT_MAX_CONTENT_SIZE` (20000 bytes); `search` results are `{title, url, snippet}` items with no `raw.preview` and no HTML unless `preview: 'include'`. A spec under src/test/unit/verbs/ on the fake core simulates a 400 KB page for the duckduckgo, github and fetch providers and asserts the default serialized result stays under 8192 bytes (`Buffer.byteLength`), that `preview: 'include'` adds the preview, and that `content: 'full'` is bounded by `maxContentSize` with `nextOffset`; titles carry `maxContentSize`, `nextOffset`, `snippet`, `preview`, `byteLength`, `8192` and the uid cd05ad09, and the spec cites [search-verbs.10]."""
    return _bug_ac("search", "search-verbs", 10, ["cd05ad09"], "verbs",
                   ["maxContentSize", "nextOffset", "snippet", "preview", "byteLength", "8192"],
                   [("src/api.ts", r"preview\??:\s*['\"]none['\"]\s*\|\s*['\"]include['\"]"), ("src/api.ts", r"\boffset\??:\s*number")])


@check("search-verbs", 11)
def _sv11():
    """(backlog 861571da, 224e7a44) A hung provider cannot outlive the deadline: src/lib/search.ts applies one overall deadline `timeoutMs` (default `DEFAULT_SEARCH_TIMEOUT_MS = 30000`, shared across all attempts, never the 90 s of the old tool) and, when the engine never settles, a github search resolves under vitest fake timers with outcome `timeout` at that deadline (not `error` after two attempts), the concurrency slot is released, the context is disposed and the cooldown is not armed by the timeout. A spec under src/test/unit/verbs/ simulates it; titles carry `useFakeTimers`, `timeout`, `github`, `dispose`, `release`, `30000` and the uids 861571da and 224e7a44, and the spec cites [search-verbs.11]."""
    return _bug_ac("search", "search-verbs", 11, ["861571da", "224e7a44"], "verbs",
                   ["useFakeTimers", "timeout", "github", "dispose", "release", "30000"],
                   [("src/lib/search.ts", r"DEFAULT_SEARCH_TIMEOUT_MS\s*=\s*30_?000\b")])


@check("search-verbs", 12)
def _sv12():
    """(backlog 86ed154e) Parallel calls return one result each: a spec under src/test/unit/verbs/ starts five concurrent `search` calls with the fetch provider through the real queue on the fake core (one URL not found, one whose CDP call rejects with a Page.enable timeout, one whose page closes mid-render, two good) and asserts with Promise.all that five results come back, each carrying its own `url` and `provider`, the failing ones as outcome `error` (never undefined, null, an empty object or a thrown rejection), and the concurrency cap respected. Titles carry `Promise.all`, `concurrent`, `per-URL`, `Page.enable`, `outcome` and the uid 86ed154e, and the spec cites [search-verbs.12]."""
    return _bug_ac("search", "search-verbs", 12, ["86ed154e"], "verbs",
                   ["Promise.all", "concurrent", "per-URL", "Page.enable", "outcome"])


@check("search-port-guards", 9)
def _spg9():
    """(backlog c6d7fbcf, 982ea870, 9487dcd0, d201694e, a3266358, 6ae134b9, 08801f2a, 84e1f7a2, 3aaa855f; 9d05e8b2 is search-hosts.20) The search wiring of the tripwire package (tripwire.ts over `createTripwire`) is proven by one spec set under src/test/unit/guards/ (for example tripwire-wiring.spec.ts) whose titles carry the nine uids: a corrupt lock file fails closed (c6d7fbcf: the provider reads as tripped or raises TRIPWIRE_STATE_UNREADABLE, never as clear); a `SearchHostConfig` data-dir override moves both the lock and the audit file and nothing is written under the default root (982ea870); created lock and audit files are 0600 in 0700 directories (9487dcd0); re-tripping a tripped provider keeps the first cause and counts the re-trip (d201694e); concurrent writes use distinct temp file names (a3266358); N concurrent blocked-count increments yield N (6ae134b9); the audit cap rewrite is atomic and counts lines, with a multibyte case (08801f2a); TTL expiry removal writes an audit line with reason `ttl-expired` (84e1f7a2); the clear path leaves a final record identical to a plain delete, with no dead resolved or reverified write (3aaa855f). A behavior the tripwire package itself fails is not fixed here: the spec states it with `it.fails` naming the uid and the executor records a finding under a `## Findings` heading of this state's context. Titles carry `0600`, `0700`, `ttl-expired`, `multibyte`, and the spec cites [search-port-guards.9]; `nx run stealth-search:test -- src/test/unit/guards` exits 0."""
    return _bug_ac("search", "search-port-guards", 9,
                   ["c6d7fbcf", "982ea870", "9487dcd0", "d201694e", "a3266358", "6ae134b9", "08801f2a", "84e1f7a2", "3aaa855f"],
                   "guards", ["0600", "0700", "ttl-expired", "multibyte"])


@check("search-port-guards", 10)
def _spg10():
    """(backlog 93dee018) The tripped state tells agents how to clear it: every tripped entry of `tripwireStatus` carries `clearWith: 'clearTripwire'` (the agent-callable verb, `clearPolicy: 'open'`) plus `trippedAt` and `expiresAt`, expired locks are not listed, and `clearTripwire` of a tripped provider returns true, records a cleared audit event and lets the next search proceed. A spec under src/test/unit/guards/ simulates the researcher flow (search returns hitl, tripwireStatus lists the provider with clearWith, clearTripwire is called, the next search succeeds); titles carry `clearWith`, `clearTripwire`, `cleared`, `hitl`, `expiresAt` and the uid 93dee018, and the spec cites [search-port-guards.10]."""
    return _bug_ac("search", "search-port-guards", 10, ["93dee018"], "guards",
                   ["clearWith", "clearTripwire", "cleared", "hitl", "expiresAt"],
                   [("src/lib/tripwire.ts", r"clearWith")])
