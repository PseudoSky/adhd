# Guards for the search-side group 2: search-hosts, search-usecases, search-examples, tracing-log-validation, search-cutover, consumer-relink.
# exec()d into guard.py's globals (check, sh, git, read, jread, exists, walk, code_lines, ownership_ok, nx_run, pkg_json, project_json, nontest_ts,
# spec_files_of, cites, offenders, env_readers, untyped_error_sites, mcp_run, code_tree, CORE_DIR, SEARCH_DIR, ... are in scope). Every check is red on an untouched tree and never raises.
import glob as _b_glob
import shutil as _b_shutil
import socket as _b_socket
import tempfile as _b_tempfile

_B_OPS = ["search", "listProviders", "describeProvider", "tripwireStatus", "clearTripwire", "chromeStatus", "launchChrome", "shutdownChrome",
          "listPageTargets", "checkChromeActivity", "getPageContext"]
_B_PKGS = {"tripwire": ("@adhd/resilience-core-tripwire", TW), "core": (CORE_PKG, CORE_DIR), "search": (SEARCH_PKG, SEARCH_DIR)}
_B_CACHE = {}
_B_HOME = os.path.expanduser("~")
_B_EV = f"{PLAN}/evidence"
_B_LOG_RX = re.compile(r"^adhd\..+\.(start|finish|error)$")


def _b_kebab(s):
    return re.sub(r"([A-Z])", lambda m: "-" + m.group(1).lower(), s)


def _b_decision():
    txt = read(f"{_B_EV}/naming-decision.md")
    style = re.search(r"^CLI-STYLE:\s*(camelCase|kebab-case)", txt, re.M)
    names = re.search(r"^MCP-NAMES:\s*(.+)$", txt, re.M)
    return {"style": style.group(1) if style else None, "names": [n.strip() for n in re.split(r"[,\s]+", names.group(1)) if n.strip()] if names else [], "text": txt}


def _b_cli_op(op, style=None):
    style = style or _b_decision()["style"] or "camelCase"
    return _b_kebab(op) if style == "kebab-case" else op


def _b_build():
    if "build" not in _B_CACHE:
        if not exists(f"{SEARCH_DIR}/project.json"):
            _B_CACHE["build"] = (1, "no stealth-search project")
        else:
            _B_CACHE["build"] = nx_run(SEARCH_PROJECT, "build-bin")
    return _B_CACHE["build"]


def _b_free_port():
    s = _b_socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _b_port_open(port):
    s = _b_socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def _b_cli(*args, timeout=120, env=None, cwd=None):
    return sh(["node", f"{SEARCH_DIR}/dist/bin/cli.js", *args], timeout=timeout, env=env, cwd=cwd)


def _b_ancestor(sha):
    return bool(sha) and sh(["git", "merge-base", "--is-ancestor", str(sha), "HEAD"])[0] == 0


def _b_under_worktrees(path):
    return ".worktrees" in str(path)


def _b_json_lines(lines):
    out, bad = [], []
    for ln in lines or []:
        try:
            out.append(json.loads(ln) if isinstance(ln, str) else dict(ln))
        except (ValueError, TypeError):
            bad.append(str(ln)[:80])
    return out, bad


def _b_attr(rec, key):
    for scope in (rec, rec.get("attrs") or {}, rec.get("attributes") or {}):
        if isinstance(scope, dict) and key in scope:
            return scope[key]
    return None


def _b_src_files(*names):
    return [f"{SEARCH_DIR}/{n}" for n in names]


def _b_texts(files):
    return {f: read(f) for f in files}


def _b_missing(files):
    return [f for f in files if not exists(f)]


# =============================================================== search-hosts
_HOSTS = "search-hosts"
_FLAGS = {"--cdp-port": "9222", "--listen-port": "3100", "--listen-host": "127.0.0.1", "--transport": "stdio", "--idle-shutdown": "120000",
          "--tripwire-ttl-ms": "7200000", "--cooldown-captcha-ms": "30000", "--cooldown-rate-ms": "20000", "--cooldown-banned-ms": "60000",
          "--max-concurrent": "2", "--max-siblings": "4"}
_FLAGS_NODEFAULT = ["--cdp-host", "--user-data-dir", "--keep-alive", "--restart-browser", "--monitor", "--pretty", "--verbose", "--log-level",
                    "--log-format", "--log-file", "--log-dir", "--data-dir", "--audit-path", "--audit-max-bytes", "--pid-file", "--trace-file"]


@check(_HOSTS, 1)
def _bh1():
    """src/server.ts, src/cli.ts, src/host-flags.ts, src/host-errors.ts, bin/cli.ts and bin/mcp.ts exist in entrypoint/stealth-search."""
    miss = _b_missing(_b_src_files("src/server.ts", "src/cli.ts", "src/host-flags.ts", "src/host-errors.ts", "bin/cli.ts", "bin/mcp.ts"))
    return not miss, f"missing: {miss}"


@check(_HOSTS, 2)
def _bh2():
    """package.json declares bins stealth-search and stealth-search-mcp into ./dist/bin/, depends on the apigen core-client/engine-runtime/plugin-mcp/plugin-cli-output/plugin-tracing packages, the core, tripwire and sox-telemetry packages, has no link:/file: value and no exports/module field."""
    if not (exists(f"{SEARCH_DIR}/src/server.ts") and exists(f"{SEARCH_DIR}/src/cli.ts")):
        return False, "src/server.ts and src/cli.ts (the state's own work products) do not exist yet"
    p = pkg_json(SEARCH_DIR)
    deps = {**(p.get("dependencies") or {}), **(p.get("devDependencies") or {})}
    need = ["@adhd/apigen-core-client", "@adhd/apigen-engine-runtime", "@adhd/apigen-plugin-mcp", "@adhd/apigen-plugin-cli-output",
            "@adhd/apigen-plugin-tracing", CORE_PKG, TW_PKG, "@adhd/sox-telemetry"]
    miss = [d for d in need if d not in deps]
    binm = p.get("bin") or {}
    ok_bin = binm.get("stealth-search") == "./dist/bin/cli.js" and binm.get("stealth-search-mcp") == "./dist/bin/mcp.js"
    linked = [k for k, v in deps.items() if str(v).startswith(("link:", "file:"))]
    return bool(p) and ok_bin and not miss and not linked and "exports" not in p and "module" not in p, f"bin={binm} missing={miss} linked={linked}"


@check(_HOSTS, 3)
def _bh3():
    """`nx run stealth-search:build-bin` exits 0 and emits dist/bin/cli.js and dist/bin/mcp.js."""
    rc, out = _b_build()
    gone = _b_missing(_b_src_files("dist/bin/cli.js", "dist/bin/mcp.js"))
    return rc == 0 and not gone, f"rc={rc} missing={gone} {out[-200:]}"


@check(_HOSTS, 4)
def _bh4():
    """`node dist/bin/cli.js --help` exits 0 and lists all eleven operations by the style recorded in naming-decision.md (the apigen extraction does not crash on SearchInput: probe U-BOOL)."""
    d = _b_decision()
    if not d["style"]:
        return False, "naming-decision.md has no CLI-STYLE"
    rc, out = _b_cli("--help")
    miss = [o for o in _B_OPS if _b_cli_op(o, d["style"]) not in out]
    return rc == 0 and not miss, f"rc={rc} missing ops: {miss} {out[-160:]}"


@check(_HOSTS, 5)
def _bh5():
    """The CLI reaches the real core through the --cdp-port flag: `chromeStatus --cdp-port 19999` against an unused port prints running=false and exits 0 (no environment variable, no stub)."""
    d = _b_decision()
    rc, out = _b_cli(_b_cli_op("chromeStatus", d["style"]), "--cdp-port", "19999")
    return rc == 0 and re.search(r"running\W+false", out, re.I) is not None, f"rc={rc} {out[-200:]}"


@check(_HOSTS, 6)
def _bh6():
    """Both bins print the whole host-flag table in --help, each flag with its default where it has one (cdp-port 9222, listen-port 3100, listen-host 127.0.0.1, transport stdio, idle-shutdown 120000, tripwire-ttl-ms 7200000, cooldowns 30000/20000/60000, max-concurrent 2, max-siblings 4)."""
    problems = []
    for name, cmd in (("cli", ["node", f"{SEARCH_DIR}/dist/bin/cli.js", "--help"]), ("mcp", ["node", f"{SEARCH_DIR}/dist/bin/mcp.js", "--help"])):
        rc, out = sh(cmd, timeout=60)
        if rc != 0:
            problems.append(f"{name} rc={rc}")
            continue
        for flag, dflt in _FLAGS.items():
            line = next((ln for ln in out.splitlines() if flag in ln), "")
            if not line or dflt not in line:
                problems.append(f"{name} {flag} default {dflt}")
        problems += [f"{name} {f}" for f in _FLAGS_NODEFAULT if f not in out]
    return not problems, "; ".join(problems[:10])


@check(_HOSTS, 7)
def _bh7():
    """The built MCP bin's tools/list names equal naming-decision.md MCP-NAMES (all stealth_*), every description is at least 40 characters, the launchChrome schema has no chromePath or extraArgs property, and a launchChrome call carrying extraArgs is rejected with nothing spawned (port 19997 stays closed, no profile dir)."""
    d = _b_decision()
    if sorted(d["names"]) != sorted(f"stealth_{o}" for o in _B_OPS):
        return False, f"naming-decision.md MCP-NAMES={d['names']}"
    prof = _b_tempfile.mkdtemp(prefix="guard-hosts-prof-")
    shutil_target = os.path.join(prof, "profile")
    try:
        r = mcp_run(["node", f"{SEARCH_DIR}/dist/bin/mcp.js", "--transport", "stdio"], [("launchChrome", {"port": 19997, "userDataDir": shutil_target, "extraArgs": ["--evil"]})], timeout=60, close_stdin=True)
        names = sorted(t["name"] for t in r["tools"])
        short = [t["name"] for t in r["tools"] if len(t.get("description") or "") < 40]
        lc = next((t for t in r["tools"] if t["name"].endswith("launchChrome")), {})
        props = ((lc.get("inputSchema") or {}).get("properties") or {})
        rejected = bool(r["calls"] and r["calls"][0]) and (r["calls"][0].get("error") is not None or (r["calls"][0].get("result") or {}).get("isError") is True)
        spawned = _b_port_open(19997) or os.path.exists(shutil_target)
        return names == sorted(d["names"]) and not short and "chromePath" not in props and "extraArgs" not in props and rejected and not spawned, \
            f"names={names} short={short} props={sorted(props)} rejected={rejected} spawned={spawned}"
    finally:
        _b_shutil.rmtree(prof, ignore_errors=True)


@check(_HOSTS, 8)
def _bh8():
    """evidence/naming-decision.md records `CLI-STYLE: camelCase|kebab-case`, `MCP-NAMES:` the eleven stealth_* tool names, `U1: resolved`, `U2: resolved` and `O12: commander|cliPlugin` (the first-step probe: whether cliPlugin parses the host flags itself, which decides whether `commander` stays a dependency; package.json agrees with the record)."""
    d = _b_decision()
    t = d["text"]
    o12 = re.search(r"^O12:\s*(commander|cliPlugin)\b", t, re.M)
    has_cmd = "commander" in {**(pkg_json(SEARCH_DIR).get("dependencies") or {})}
    agree = bool(o12) and ((o12.group(1) == "commander") == has_cmd)
    return bool(d["style"]) and len(d["names"]) == 11 and "U1: resolved" in t and "U2: resolved" in t and agree, f"style={d['style']} names={len(d['names'])} o12={o12.group(1) if o12 else None} commander_dep={has_cmd}"


@check(_HOSTS, 9)
def _bh9():
    """Node >= 22.5 preflight in both bins: each of bin/cli.ts and bin/mcp.ts compares process.versions.node against 22.5 and fails with the typed NODE_TOO_OLD code (one stderr line `NODE_TOO_OLD: <message>`, non-zero exit)."""
    bad = []
    for f in _b_src_files("bin/cli.ts", "bin/mcp.ts"):
        t = code_lines(read(f))
        if "NODE_TOO_OLD" not in t or not re.search(r"22\D{1,3}5|\[\s*22\s*,\s*5\s*\]", t) or "process.versions" not in t:
            bad.append(f)
    return len(bad) == 0 and exists(f"{SEARCH_DIR}/bin/cli.ts"), f"no preflight: {bad}"


@check(_HOSTS, 10)
def _bh10():
    """Host errors are typed (100%): src/host-errors.ts defines HOST_FLAG_INVALID, HOST_TRANSPORT_UNSUPPORTED, HOST_BOOT_FAILED (NODE_TOO_OLD is core-owned and reused) as StealthSearchError subclasses, the host files hold no bare `new Error(`, and `cli --cdp-port notanumber <chromeStatus>` fails non-zero with a stderr line starting `HOST_FLAG_INVALID:` and no stack trace."""
    t = code_lines(read(f"{SEARCH_DIR}/src/host-errors.ts"))
    codes = all(c in t for c in ("HOST_FLAG_INVALID", "HOST_TRANSPORT_UNSUPPORTED", "HOST_BOOT_FAILED")) and "StealthSearchError" in t
    files = [f for f in _b_src_files("src/server.ts", "src/cli.ts", "src/host-flags.ts", "src/host-errors.ts", "bin/cli.ts", "bin/mcp.ts") if exists(f)]
    untyped = untyped_error_sites(files)
    d = _b_decision()
    rc, out = _b_cli("--cdp-port", "notanumber", _b_cli_op("chromeStatus", d["style"]))
    line = next((ln for ln in out.splitlines() if ln.strip()), "")
    return codes and not untyped and rc != 0 and line.startswith("HOST_FLAG_INVALID:") and "    at " not in out, f"codes={codes} untyped={untyped} rc={rc} first={line[:100]!r}"


@check(_HOSTS, 11)
def _bh11():
    """No environment variable is read anywhere in src/ or bin/ of stealth-search (ADR-0001: every former SEARCH_* toggle is a typed option or host flag) and no tsx runtime import remains."""
    if not (exists(f"{SEARCH_DIR}/src/server.ts") and exists(f"{SEARCH_DIR}/src/cli.ts")):
        return False, "src/server.ts and src/cli.ts (the state's own work products) do not exist yet"
    files = nontest_ts(SEARCH_DIR)
    env = env_readers(files)
    tsx = offenders(files, r"from\s+['\"]tsx|require\(['\"]tsx|\bSEARCH_[A-Z_]{3,}\b")
    return bool(files) and not env and not tsx, f"env readers={env} tsx/SEARCH_*={tsx}"


@check(_HOSTS, 12)
def _bh12():
    """All three MCP transports boot from the built stealth-search-mcp bin: stdio answers tools/list, and `--transport sse` and `--transport streaming-http` bind --listen-port on an unused port (probe by connect) and exit cleanly on SIGTERM; an unknown transport fails with HOST_TRANSPORT_UNSUPPORTED."""
    if _b_missing(_b_src_files("dist/bin/mcp.js")):
        return False, "dist/bin/mcp.js missing"
    problems = []
    r = mcp_run(["node", f"{SEARCH_DIR}/dist/bin/mcp.js", "--transport", "stdio"], timeout=45, close_stdin=True)
    if len(r["tools"]) != 11:
        problems.append(f"stdio tools={len(r['tools'])}")
    for tr in ("sse", "streaming-http"):
        port = _b_free_port()
        p = subprocess.Popen(["node", f"{SEARCH_DIR}/dist/bin/mcp.js", "--transport", tr, "--listen-port", str(port)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        up = False
        end = time.time() + 25
        while time.time() < end and p.poll() is None:
            if _b_port_open(port):
                up = True
                break
            time.sleep(0.3)
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
        if not up:
            problems.append(f"{tr} did not bind {port}")
    rc, out = sh(["node", f"{SEARCH_DIR}/dist/bin/mcp.js", "--transport", "carrier-pigeon"], timeout=30)
    if rc == 0 or "HOST_TRANSPORT_UNSUPPORTED" not in out:
        problems.append("unknown transport not rejected with HOST_TRANSPORT_UNSUPPORTED")
    return not problems, "; ".join(problems)


@check(_HOSTS, 13)
def _bh13():
    """The lifecycle is wired in both hosts: server.ts and cli.ts call the core `lifecycle.installProcessExitHooks` with `chromeExitTarget`, the MCP host passes `stdinEof: true`, both call `configureManagers` with idleTimeoutMs, keepAlive, checkHistory:false-by-default-of-search (the search host passes the option explicitly), entryPath and a stderr logger, and --restart-browser maps to shutdownChrome."""
    s, c = code_lines(read(f"{SEARCH_DIR}/src/server.ts")), code_lines(read(f"{SEARCH_DIR}/src/cli.ts"))
    both = all("installProcessExitHooks" in t and "chromeExitTarget" in t and "configureManagers" in t and "idleTimeoutMs" in t and "keepAlive" in t and "entryPath" in t for t in (s, c))
    return bool(s and c) and both and re.search(r"stdinEof\s*:\s*true", s) is not None and "checkHistory" in (s + c + code_lines(read(f"{SEARCH_DIR}/src/host-flags.ts"))) and "shutdownChrome" in (s + c + code_lines(read(f"{SEARCH_DIR}/src/host-flags.ts"))), "lifecycle wiring incomplete"


@check(_HOSTS, 14)
def _bh14():
    """Boot behaviours of server.mjs are ported as flag-driven code: --trace-file boot trace, --pid-file registry with the --max-siblings warning, uncaughtException and unhandledRejection handlers doing a soft Chrome shutdown then exit 1, a bounded shutdown with a 5000 ms forced exit, and stdin-EOF orphan detection with a 1000 ms grace for stdio only."""
    t = "\n".join(code_lines(read(f)) for f in _b_src_files("src/server.ts", "src/cli.ts", "src/host-flags.ts", "bin/mcp.ts", "bin/cli.ts"))
    need = {"trace-file": r"traceFile|trace-file", "pid-file": r"pidFile|pid-file", "siblings": r"maxSiblings|max-siblings", "uncaughtException": r"uncaughtException",
            "unhandledRejection": r"unhandledRejection", "5000": r"5[_]?000", "stdin EOF": r"stdinEof|stdin.*end", "1000 grace": r"1[_]?000"}
    miss = [k for k, rx in need.items() if not re.search(rx, t)]
    return bool(t.strip()) and not miss, f"missing: {miss}"


@check(_HOSTS, 15)
def _bh15():
    """Tracing is mounted, not configured, by the hosts: server.ts and cli.ts import `tracingPlugin` from './tracing.js' and list it in `usePlugins`; no host or bin file holds a serviceName literal or imports the apigen package singleton `tracingPlugin`; each bin reaches telemetry only through './telemetry.js' (the one initTelemetry stays in src/telemetry.ts)."""
    s, c = read(f"{SEARCH_DIR}/src/server.ts"), read(f"{SEARCH_DIR}/src/cli.ts")
    mount = all(re.search(r"import\s*\{[^}]*tracingPlugin[^}]*\}\s*from\s*['\"]\./tracing\.js['\"]", t) and re.search(r"usePlugins\s*:\s*\[[^\]]*tracingPlugin", t) for t in (s, c))
    files = [f for f in _b_src_files("src/server.ts", "src/cli.ts", "bin/cli.ts", "bin/mcp.ts") if exists(f)]
    stray = offenders(files, r"serviceName|initTelemetry\(|@adhd/apigen-plugin-tracing")
    bins = all("telemetry.js" in read(f) for f in _b_src_files("bin/cli.ts", "bin/mcp.ts"))
    return bool(s and c) and mount and not stray and bins, f"mount={mount} stray={stray} bins_use_telemetry={bins}"


@check(_HOSTS, 16)
def _bh16():
    """Host unit specs simulate real use in-process: spec files under src/test/unit/hosts/ cite ticket 8468f7b1 and [search-hosts.16], import no child_process, and drive the real flag parser (every flag of the table, defaults, HOST_FLAG_INVALID for bad values), the extraArgs rejection, the NODE_TOO_OLD preflight function, the transport selection and exit-hook wiring through the exported host factories; `nx run stealth-search:test -- src/test/unit/hosts` exits 0."""
    files = spec_files_of(SEARCH_DIR, "unit/hosts")
    ok, why = cites(files, "search-hosts")
    spawn = offenders(files, r"child_process|\bspawn\(|\bexecFile?\(")
    if not ok or spawn:
        return False, f"{why} spawners={spawn}"
    rc, out = nx_run(SEARCH_PROJECT, "test", "--", "src/test/unit/hosts")
    return rc == 0, out[-300:]


@check(_HOSTS, 17)
def _bh17():
    """Only owned paths changed by [psm:search-hosts] commits."""
    return ownership_ok(_HOSTS)


# =============================================================== search-usecases
_UC = "search-usecases"
_UC_DIR = f"{SEARCH_DIR}/src/test/use-cases"


def _uc_text():
    return "\n".join(read(f) for f in spec_files_of(SEARCH_DIR, "use-cases"))


@check(_UC, 1)
def _bu1():
    """src/test/use-cases/ holds spec files that each cite ticket 8468f7b1 and a search-usecases.N id, with at least 14 test cases in total (ported e2e, guard and lifecycle scenarios, no e2e lane)."""
    files = spec_files_of(SEARCH_DIR, "use-cases")
    ok, why = cites(files, _UC)
    n = len(re.findall(r"^\s*(?:it|test)(?:\.each\([^)]*\))?\s*\(", _uc_text(), re.M))
    return ok and n >= 14, f"{why} cases={n}"


@check(_UC, 2)
def _bu2():
    """Engine scenarios are covered with the real modules: tripwire-gated search returns outcome hitl with zero Chrome calls; cooldown fail-fast returns rate_limited without opening a window; the concurrency cap of 2 queues the third call FIFO; managed-challenge recovery reveals, polls and retries once; HITL fires the tripwire and keeps the context alive; hostile outcomes arm the cooldown but hitl does not."""
    t = _uc_text()
    need = {"tripwire hitl zero chrome": r"hitl[\s\S]{0,400}(?:zero|0|no)\s*(?:Chrome|launch|calls)|(?:zero|no)\s+Chrome", "cooldown rate_limited": r"rate_limited", "concurrency cap": r"max-?concurrent|concurrency[\s\S]{0,80}\b2\b|FIFO",
            "managed challenge retry": r"managed[- ]challenge|challenge[\s\S]{0,120}retr", "hitl keeps context": r"keep(?:Page|\s+context|-alive)|pageDisposal[\s\S]{0,40}keep", "hitl not cooled": r"hitl[\s\S]{0,160}(?:not|never)[\s\S]{0,40}cool|cool[\s\S]{0,160}hitl"}
    miss = [k for k, rx in need.items() if not re.search(rx, t, re.I)]
    return bool(t) and not miss, f"uncovered: {miss}"


@check(_UC, 3)
def _bu3():
    """Fetch scenarios are covered: the SSRF refusal matrix (169.254.169.254, ::ffff:169.254.169.254, localhost., embedded credentials, file:) returns outcome error with FETCH_URL_REFUSED and no browser call, a PDF response takes the PDF branch, and markdown output is capped with the truncation marker."""
    t = _uc_text()
    need = {"metadata ip": r"169\.254\.169\.254", "mapped ipv6": r"::ffff:", "localhost dot": r"localhost\.", "credentials": r"user:pass@|credentials", "file scheme": r"file:", "FETCH_URL_REFUSED": r"FETCH_URL_REFUSED", "pdf": r"\bpdf\b", "truncation": r"truncat"}
    miss = [k for k, rx in need.items() if not re.search(rx, t, re.I)]
    return bool(t) and not miss, f"uncovered: {miss}"


@check(_UC, 4)
def _bu4():
    """Host scenarios are covered in-process through the exported host factories: an MCP-driven session lists the eleven stealth_* tools and calls stealth_search, a launchChrome call with extraArgs is rejected (P1), getPageContext output carries cookie names and counts but never the SECRET123 value (P2), exit hooks soft-shut Chrome down, and a wrong provider surfaces UNKNOWN_PROVIDER with the code and exit mapping."""
    t = _uc_text()
    need = {"tools list": r"stealth_search", "extraArgs": r"extraArgs", "redaction": r"SECRET123", "exit hook": r"shutdownIfIdle|installProcessExitHooks|soft shutdown", "typed code": r"UNKNOWN_PROVIDER"}
    miss = [k for k, rx in need.items() if not re.search(rx, t)]
    return bool(t) and not miss, f"uncovered: {miss}"


@check(_UC, 5)
def _bu5():
    """ADR-0009: the use-case specs spawn no process, open no real socket and touch no Chrome: no child_process, spawn/exec, WebSocket construction, port 9222 or non-loopback URL fetch appears in them, and none uses .skip, .only or .todo."""
    files = spec_files_of(SEARCH_DIR, "use-cases")
    bad = offenders(files, r"child_process|\bspawn\(|\bexecFile?\(|new\s+WebSocket\(|\b9222\b|\.(?:skip|only|todo)\b")
    return bool(files) and not bad, f"offending specs: {bad}"


@check(_UC, 6)
def _bu6():
    """The scenarios exercise the real code, not mocks of it: no spec replaces a stealth-search module with vi.mock of a relative src path, and every spec imports from src (relative '../../')."""
    files = spec_files_of(SEARCH_DIR, "use-cases")
    mocked = offenders(files, r"vi\.mock\(\s*['\"]\.{1,2}/")
    noimp = [f for f in files if not re.search(r"from\s+['\"]\.\./\.\./", read(f))]
    return bool(files) and not mocked and not noimp, f"mocked={mocked} no-src-import={noimp}"


@check(_UC, 7)
def _bu7():
    """`nx run stealth-search:test -- src/test/use-cases` exits 0."""
    if not spec_files_of(SEARCH_DIR, "use-cases"):
        return False, "no use-case specs"
    rc, out = nx_run(SEARCH_PROJECT, "test", "--", "src/test/use-cases")
    return rc == 0, out[-300:]


@check(_UC, 8)
def _bu8():
    """Only owned paths changed by [psm:search-usecases] commits."""
    return ownership_ok(_UC)


# =============================================================== search-examples
_EX = "search-examples"
_EX_DIR = f"{SEARCH_DIR}/examples"


def _readme_blocks():
    txt = read(f"{SEARCH_DIR}/README.md")
    return re.findall(r"^```[^\n]*\n[\s\S]*?^```", txt, re.M)


@check(_EX, 1)
def _bx1():
    """examples/ holds at least one runnable TypeScript example per operation (all eleven operation names appear in the example files) and each example file exports a `run` function and cites ticket 8468f7b1."""
    files = [f for f in walk(_EX_DIR) if not f.endswith(".d.ts")]
    t = {f: read(f) for f in files}
    miss = [o for o in _B_OPS if not any(o in x for x in t.values())]
    bad = [f for f, x in t.items() if "export" not in x or "run" not in x or TICKET not in x]
    return len(files) >= 6 and not miss and not bad, f"files={len(files)} ops missing={miss} bad={bad[:4]}"


@check(_EX, 2)
def _bx2():
    """examples/manifest.json lists every README code block: its entry count equals the number of fenced code blocks in README.md, and each entry has {id, block, kind: ts|sh|text|json, source} where ts/sh entries point at an existing examples/ file or an operation name."""
    m = jread(f"{_EX_DIR}/manifest.json", None)
    blocks = _readme_blocks()
    if not isinstance(m, list) or not blocks:
        return False, f"manifest={'ok' if m else 'missing'} readme blocks={len(blocks)}"
    bad = [e for e in m if not isinstance(e, dict) or not {"id", "block", "kind", "source"} <= set(e) or e["kind"] not in ("ts", "sh", "text", "json")]
    idx = sorted(e.get("block") for e in m if isinstance(e, dict))
    dangling = [e["source"] for e in m if isinstance(e, dict) and e.get("kind") == "ts" and not exists(f"{SEARCH_DIR}/{e.get('source')}")]
    return not bad and idx == list(range(len(blocks))) and not dangling, f"bad={bad[:2]} blocks={len(blocks)} indexed={idx} dangling={dangling}"


@check(_EX, 3)
def _bx3():
    """Every `stealth-search` / `stealth-search-mcp` command line in README.md names a real operation (in the style of naming-decision.md) and only flags that exist in src/host-flags.ts or are properties of the SearchInput/verb inputs."""
    readme = read(f"{SEARCH_DIR}/README.md")
    lines = [ln.strip().lstrip("$ ").strip() for ln in readme.splitlines() if re.match(r"^\s*\$?\s*(?:npx\s+(?:-y\s+)?)?stealth-search", ln)]
    d = _b_decision()
    if not lines or not d["style"]:
        return False, f"command lines={len(lines)} style={d['style']}"
    flags_src = read(f"{SEARCH_DIR}/src/host-flags.ts") + read(f"{SEARCH_DIR}/src/api.ts") + read(f"{SEARCH_DIR}/src/lib/types.ts")
    bad = []
    for ln in lines:
        for fl in re.findall(r"(--[a-z][a-z0-9-]*)", ln):
            camel = re.sub(r"-([a-z])", lambda m: m.group(1).upper(), fl[2:])
            if fl not in flags_src and camel not in flags_src and fl != "--help":
                bad.append(fl)
        if "stealth-search-mcp" not in ln and not any(_b_cli_op(o, d["style"]) in ln for o in _B_OPS) and "--help" not in ln:
            bad.append(f"no operation: {ln[:60]}")
    return not bad, f"bad: {bad[:6]}"


@check(_EX, 4)
def _bx4():
    """A unit test src/test/unit/examples/ runs every example's `run` (against injected fakes) and verifies every README manifest entry; it cites ticket 8468f7b1 and [search-examples.4], imports no child_process, and `nx run stealth-search:test -- src/test/unit/examples` exits 0 (100% README examples)."""
    files = spec_files_of(SEARCH_DIR, "unit/examples")
    ok, why = cites(files, _EX)
    t = "\n".join(read(f) for f in files)
    names = [os.path.basename(f) for f in walk(_EX_DIR) if f.endswith(".ts") and not f.endswith(".d.ts")]
    unseen = [n for n in names if n[:-3] not in t]
    if not ok or "manifest.json" not in t or "README.md" not in t or unseen or offenders(files, r"child_process|\bspawn\("):
        return False, f"{why} manifest/readme referenced={'manifest.json' in t}/{'README.md' in t} unexercised={unseen}"
    rc, out = nx_run(SEARCH_PROJECT, "test", "--", "src/test/unit/examples")
    return rc == 0, out[-300:]


@check(_EX, 5)
def _bx5():
    """Only owned paths changed by [psm:search-examples] commits."""
    return ownership_ok(_EX)


# =============================================================== tracing-log-validation (agent task; observable-file assertions only)
_TL = "tracing-log-validation"
_TL_JSON = f"{_B_EV}/tracing-log-validation.json"
_TL_MD = f"{_B_EV}/tracing-log-validation.md"
_TL_CHECKS = ["cli_pairs", "cli_forced_error", "mcp_pairs", "mcp_forced_error", "transport_attr", "role_attr", "no_apigen_events", "sink_dir", "log_dir_flag",
              "mcp_stdout_jsonrpc_only", "stdin_eof_shutdown", "every_command_spanned"]


def _tl():
    return jread(_TL_JSON, None)


def _tl_events(doc, names):
    out = []
    for c in doc.get("checks") or []:
        if c.get("name") in names:
            recs, _ = _b_json_lines(c.get("sample_lines"))
            out += [(c["name"], r) for r in recs]
    return out


@check(_TL, 1)
def _bl1():
    """evidence/tracing-log-validation.json and .md exist; the json records service stealth-search, namespace adhd, the validating agent, the scratch HOME (a temp directory, not the real home), and the stealth-search code tree it validated, which equals the current code tree (the run is not stale)."""
    d = _tl()
    if not isinstance(d, dict) or not exists(_TL_MD):
        return False, "json/md missing"
    home = str(d.get("home") or "")
    fresh = d.get("search_code_tree") == code_tree(SEARCH_DIR) and bool(code_tree(SEARCH_DIR))
    return d.get("service") == "stealth-search" and d.get("namespace") == "adhd" and bool(d.get("agent")) and home.startswith(("/var/", "/tmp/", "/private/", "/Users")) and not home.startswith(_B_HOME + "/.") and home != _B_HOME and fresh, \
        f"service={d.get('service')} namespace={d.get('namespace')} home={home} fresh={fresh}"


@check(_TL, 2)
def _bl2():
    """Every required check is present with status exactly PASS, non-empty sample_lines and non-empty log_files: cli_pairs, cli_forced_error, mcp_pairs, mcp_forced_error, transport_attr, role_attr, no_apigen_events, sink_dir, log_dir_flag, mcp_stdout_jsonrpc_only, stdin_eof_shutdown, every_command_spanned."""
    d = _tl() or {}
    by = {c.get("name"): c for c in d.get("checks") or [] if isinstance(c, dict)}
    bad = [n for n in _TL_CHECKS if n not in by or by[n].get("status") != "PASS" or not by[n].get("sample_lines") or not by[n].get("log_files")]
    return bool(d) and not bad, f"missing/not PASS: {bad}"


@check(_TL, 3)
def _bl3():
    """Every sample line of the span checks is a JSON log record whose `event` matches ^adhd\\..+\\.(start|finish|error)$, none begins with `apigen.`, and the literal operation ids seen are recorded under `op_ids_seen` (no guessed id)."""
    d = _tl() or {}
    evs = _tl_events(d, {"cli_pairs", "cli_forced_error", "mcp_pairs", "mcp_forced_error", "transport_attr", "role_attr", "every_command_spanned"})
    bad = [n for n, r in evs if not _B_LOG_RX.match(str(r.get("event", "")))]
    seen = d.get("op_ids_seen") or []
    ok_ops = bool(seen) and all(any(o in str(r.get("event")) for _, r in evs) for o in seen)
    return len(evs) >= 8 and not bad and ok_ops, f"events={len(evs)} bad checks={bad[:4]} op_ids_seen={seen}"


@check(_TL, 4)
def _bl4():
    """Spans pair: in cli_pairs and mcp_pairs every trace_id has an `.start` and a `.finish` of the same operation, in the forced-error checks a `.start` and an `.error` carrying the typed code UNKNOWN_PROVIDER, finish/error records carry a numeric duration_ms, and no sample line lacks trace_id."""
    d = _tl() or {}
    problems = []
    for name, closer in (("cli_pairs", "finish"), ("mcp_pairs", "finish"), ("cli_forced_error", "error"), ("mcp_forced_error", "error")):
        evs = [r for n, r in _tl_events(d, {name})]
        if not evs:
            problems.append(f"{name}: no events")
            continue
        by = {}
        for r in evs:
            by.setdefault(r.get("trace_id"), []).append(str(r.get("event", "")))
            if not r.get("trace_id"):
                problems.append(f"{name}: record without trace_id")
            if str(r.get("event", "")).endswith((".finish", ".error")) and not isinstance(_b_attr(r, "duration_ms"), (int, float)):
                problems.append(f"{name}: no duration_ms")
        for tid, es in by.items():
            if not (any(e.endswith(".start") for e in es) and any(e.endswith("." + closer) for e in es)):
                problems.append(f"{name}: trace {tid} has {es}")
        if closer == "error" and "UNKNOWN_PROVIDER" not in json.dumps(evs):
            problems.append(f"{name}: no UNKNOWN_PROVIDER")
    return not problems, "; ".join(problems[:6])


@check(_TL, 5)
def _bl5():
    """Attributes are right per host: records of CLI checks carry adhd.transport = cli and role = cli, records of MCP checks adhd.transport = mcp and role = live-service, all carry adhd.op, session_id and worktree, and the `transport_attr` and `role_attr` checks sample both hosts."""
    d = _tl() or {}
    problems = []
    for prefix, transport, role in (("cli_", "cli", "cli"), ("mcp_", "mcp", "live-service")):
        evs = [r for n, r in _tl_events(d, {x for x in _TL_CHECKS if x.startswith(prefix) and x.endswith(("pairs", "forced_error"))})]
        if not evs:
            problems.append(f"{prefix}: no events")
        for r in evs:
            if _b_attr(r, "adhd.transport") != transport:
                problems.append(f"{prefix} transport={_b_attr(r, 'adhd.transport')}")
            if r.get("role", _b_attr(r, "role")) != role:
                problems.append(f"{prefix} role={r.get('role')}")
            for k in ("adhd.op", "session_id", "worktree"):
                if _b_attr(r, k) in (None, ""):
                    problems.append(f"{prefix} missing {k}")
    both = {_b_attr(r, "adhd.transport") for _, r in _tl_events(d, {"transport_attr"})} >= {"cli", "mcp"}
    return not problems and both, "; ".join(sorted(set(problems))[:6]) + f" both={both}"


@check(_TL, 6)
def _bl6():
    """The sinks are the real ones: every recorded log file ends .jsonl, lives under <home>/.adhd/sox-ecosystem/stealth-search/logs/ (default run) or the --log-dir directory (flag run), was non-empty before the process exited (log_files_detail with bytes > 0), and the real home directory's stealth-search log directory was not written by the run."""
    d = _tl() or {}
    home = str(d.get("home") or "")
    flag_dir = str(d.get("log_dir_flag_dir") or "")
    files = [f for c in d.get("checks") or [] for f in (c.get("log_files") or [])]
    default_rx = os.path.join(home, ".adhd/sox-ecosystem/stealth-search/logs") + "/"
    bad = [f for f in files if not f.endswith(".jsonl") or not (f.startswith(default_rx) or (flag_dir and f.startswith(flag_dir.rstrip("/") + "/")))]
    detail = d.get("log_files_detail") or []
    empty = [x for x in detail if not isinstance(x, dict) or not x.get("bytes")]
    return bool(files) and bool(home) and not bad and bool(detail) and not empty and bool(flag_dir) and flag_dir != "", f"bad={bad[:3]} detail={len(detail)} empty={empty[:2]} flag_dir={flag_dir!r}"


@check(_TL, 7)
def _bl7():
    """Coverage is complete and observed: `commands_run` lists --help for each of the eleven operations plus listProviders, describeProvider, tripwireStatus, chromeStatus (dead port) and the forced describeProvider error through the CLI, and the same five calls through the MCP stdio client; `mcp_stdout_jsonrpc_only` and `stdin_eof_shutdown` samples record that every MCP stdout line parsed as JSON-RPC and the process exited 0 after stdin closed; `tests_added` is 0."""
    d = _tl() or {}
    cmds = " ".join(str(c) for c in d.get("commands_run") or [])
    need = [f"{o}" for o in _B_OPS] + ["listProviders", "describeProvider", "tripwireStatus", "chromeStatus", "nope"]
    miss = [n for n in need if n.lower() not in cmds.lower() and _b_kebab(n) not in cmds]
    mcp_calls = d.get("mcp_calls") or []
    by = {c.get("name"): c for c in d.get("checks") or [] if isinstance(c, dict)}
    jr = (by.get("mcp_stdout_jsonrpc_only") or {}).get("non_jsonrpc_stdout_lines")
    eof = (by.get("stdin_eof_shutdown") or {}).get("exit_code")
    return bool(d) and not miss and len(mcp_calls) >= 5 and jr == 0 and eof == 0 and d.get("tests_added") == 0, f"missing cmds={miss} mcp_calls={len(mcp_calls)} non_jsonrpc={jr} eof_exit={eof} tests_added={d.get('tests_added')}"


@check(_TL, 8)
def _bl8():
    """evidence/tracing-log-validation.md states PASS for every required check name next to its first recorded sample line (verbatim from the json) and names the validating agent; it records no FAIL line."""
    d, md = _tl() or {}, read(_TL_MD)
    by = {c.get("name"): c for c in d.get("checks") or [] if isinstance(c, dict)}
    bad = []
    for n in _TL_CHECKS:
        c = by.get(n) or {}
        first = (c.get("sample_lines") or [""])[0]
        if not md or not re.search(rf"{re.escape(n)}[^\n]*PASS", md) or str(first)[:60] not in md:
            bad.append(n)
    return bool(d) and not bad and "FAIL" not in md and str(d.get("agent", "")) in md, f"unrecorded: {bad}"


@check(_TL, 9)
def _bl9():
    """Only owned paths changed by [psm:tracing-log-validation] commits (the two evidence files; no source, no spec, no test)."""
    return ownership_ok(_TL)


# =============================================================== search-cutover
_CO = "search-cutover"
_CO_EV = f"{_B_EV}/cutover"
_REMOVED = ["adhd", "server.mjs", "search-cli.mjs", "cdp-search.ts", "search-mcp-source.ts", "search-providers.ts", "search-guard.ts", "search-tripwire.ts",
            "search-fetch.ts", "fetch-policy.ts", "apigen-client-common.mjs"]
_BACKLOG_IDS = ["B-028", "B-029", "B-030", "B-031", "B-032", "B-033", "B-034", "B-035", "19dfb641"]


def _tar_member(tarball, member):
    try:
        r = subprocess.run(["tar", "-xOf", tarball, member], capture_output=True, timeout=60)
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _tar_list(tarball):
    rc, out = sh(["tar", "-tzf", tarball], timeout=60)
    return out.split() if rc == 0 else []


@check(_CO, 1)
def _bc1():
    """`before` is captured before any scratch change: evidence/cutover/before.json records the twelve provider ids, the help keys of listProviders, the old MCP tool list, a seeded legacy lock that blocks a search with outcome hitl and zero Chrome calls, and a captured_at earlier than the first [psm:search-cutover] commit in the scratch repo."""
    b = jread(f"{_CO_EV}/before.json", None)
    if not isinstance(b, dict):
        return False, "evidence/cutover/before.json missing"
    lock = b.get("legacy_lock") or {}
    first = [int(x) for x in git("-C", SCRATCH, "log", "--all", "--grep", r"\[psm:search-cutover\]", "--format=%at").split() if x.isdigit()]
    t = b.get("captured_at_epoch")
    return len(b.get("provider_ids") or []) == 12 and bool(b.get("help_keys")) and bool(b.get("tools")) and lock.get("outcome") == "hitl" and lock.get("chrome_calls") == 0 and isinstance(t, int) and (not first or t < min(first)), \
        f"providers={len(b.get('provider_ids') or [])} lock={lock} captured={t} first_commit={min(first) if first else None}"


@check(_CO, 2)
def _bc2():
    """The packages under test are the ones built from THIS worktree, in dependency order tripwire, stealth-core-browser, stealth-search: evidence/cutover/tarballs.json records for each a `tarball` outside every .worktrees/ directory, its `sha256` (equal to the file's), `packed_from_head` (an ancestor of HEAD), `packed_from_tree` (equal to that package's tree at that commit) and the pack_cmd; each tarball lists its dist/index.js and the search tarball also package/dist/bin/cli.js and package/dist/bin/mcp.js."""
    t = jread(f"{_CO_EV}/tarballs.json", None)
    if not isinstance(t, dict) or list(t.get("order") or []) != ["tripwire", "core", "search"]:
        return False, "tarballs.json missing or order != tripwire, core, search"
    problems = []
    for key, (name, d) in _B_PKGS.items():
        e = (t.get("packages") or {}).get(key) or {}
        tb = str(e.get("tarball") or "")
        if not tb or _b_under_worktrees(tb) or tb.startswith(TOP) or not os.path.isfile(tb):
            problems.append(f"{key}: tarball {tb!r}")
            continue
        if hashlib.sha256(open(tb, "rb").read()).hexdigest() != e.get("sha256"):
            problems.append(f"{key}: sha256")
        head = e.get("packed_from_head")
        if not _b_ancestor(head) or git("rev-parse", f"{head}:{d}") != e.get("packed_from_tree") or not e.get("pack_cmd"):
            problems.append(f"{key}: head/tree/pack_cmd")
        members = _tar_list(tb)
        want = ["package/dist/index.js"] + (["package/dist/bin/cli.js", "package/dist/bin/mcp.js"] if key == "search" else [])
        problems += [f"{key}: member {w}" for w in want if w not in members]
    return not problems, "; ".join(problems[:6])


@check(_CO, 3)
def _bc3():
    """The proof consumer is a scratch temp project outside every repository and .worktrees/ (evidence/cutover/consumer.json: consumer_dir) whose node_modules/@adhd/{resilience-core-tripwire,stealth-core-browser,stealth-search} are real directories (not symlinks) with dist/index.js byte-identical to the recorded tarball's member, and no committed file carries a link:/file:/.worktrees value for them."""
    c = jread(f"{_CO_EV}/consumer.json", None)
    t = jread(f"{_CO_EV}/tarballs.json", None)
    if not isinstance(c, dict) or not isinstance(t, dict):
        return False, "consumer.json / tarballs.json missing"
    cd = str(c.get("consumer_dir") or "")
    if not cd or _b_under_worktrees(cd) or cd.startswith(TOP) or cd.startswith(SCRATCH):
        return False, f"consumer_dir {cd!r}"
    problems = []
    for key, (name, _) in _B_PKGS.items():
        nm = os.path.join(cd, "node_modules", name)
        tb = ((t.get("packages") or {}).get(key) or {}).get("tarball", "")
        if os.path.islink(nm) or not os.path.isdir(nm):
            problems.append(f"{key}: not a real directory")
            continue
        idx = os.path.join(nm, "dist/index.js")
        if not os.path.isfile(idx) or _tar_member(tb, "package/dist/index.js") != open(idx, "rb").read():
            problems.append(f"{key}: dist/index.js differs from tarball")
    committed = git("grep", "-nE", r"(link:|file:)[^\"]*\.worktrees|\.worktrees/[^\"]*(stealth|tripwire)", "--", "package.json", "**/package.json", "docs/plan/stealth-browser/evidence")
    return not problems and not committed.strip(), "; ".join(problems[:5]) + f" committed refs: {committed[:120]}"


@check(_CO, 4)
def _bc4():
    """evidence/cutover/live-vs-recorded.md states precisely what is LIVE and what is only RECORDED: a `LIVE:` line (the consumer node_modules content = the three tarballs, with all three sha256 values), a `RECORDED:` line (the dependency ranges of the three packages ^0.1.0, which resolve only once released) and a `NOT-CHANGED:` line naming pnpm-lock.yaml of the adhd checkout; the adhd main checkout's pnpm-lock.yaml is unmodified."""
    md = read(f"{_CO_EV}/live-vs-recorded.md")
    t = jread(f"{_CO_EV}/tarballs.json", {}) or {}
    shas = [((t.get("packages") or {}).get(k) or {}).get("sha256") for k in _B_PKGS]
    live = next((ln for ln in md.splitlines() if ln.startswith("LIVE:")), "")
    rec = next((ln for ln in md.splitlines() if ln.startswith("RECORDED:")), "")
    nc = next((ln for ln in md.splitlines() if ln.startswith("NOT-CHANGED:")), "")
    main_lock = git("-C", MAIN, "status", "--porcelain", "--", "pnpm-lock.yaml")
    return bool(live and rec and nc) and all(s and s in md for s in shas) and "pnpm-lock.yaml" in nc and "^0.1.0" in rec and not main_lock, \
        f"LIVE={bool(live)} RECORDED={bool(rec)} NOT-CHANGED={bool(nc)} shas={shas} main lock={main_lock!r}"


@check(_CO, 5)
def _bc5():
    """Behaviour parity through the installed packages: evidence/cutover/parity.json has `before` and `after`; after.provider_ids equals before.provider_ids (twelve), after.tools is the eleven stealth_* names, the seeded legacy lock still blocks a search with outcome hitl and zero Chrome calls, and a live re-run of the installed consumer's `stealth-search-mcp --transport stdio` returns the same tool names as `after`."""
    p = jread(f"{_CO_EV}/parity.json", None)
    c = jread(f"{_CO_EV}/consumer.json", {}) or {}
    if not isinstance(p, dict) or not c.get("consumer_dir"):
        return False, "parity.json / consumer.json missing"
    a, b = p.get("after") or {}, p.get("before") or {}
    lock = a.get("legacy_lock") or {}
    ok = len(b.get("provider_ids") or []) == 12 and a.get("provider_ids") == b.get("provider_ids") and sorted(a.get("tools") or []) == sorted(f"stealth_{o}" for o in _B_OPS) \
        and lock.get("outcome") == "hitl" and lock.get("chrome_calls") == 0
    if not ok:
        return False, f"parity shapes differ: providers={len(a.get('provider_ids') or [])} tools={a.get('tools')} lock={lock}"
    mcp = os.path.join(c["consumer_dir"], "node_modules/@adhd/stealth-search/dist/bin/mcp.js")
    home = _b_tempfile.mkdtemp(prefix="guard-cutover-")
    try:
        r = mcp_run(["node", mcp, "--transport", "stdio"], timeout=60, env={"HOME": home}, close_stdin=True)
    finally:
        _b_shutil.rmtree(home, ignore_errors=True)
    live = sorted(t["name"] for t in r["tools"])
    return live == sorted(a.get("tools") or []), f"live tools={live}"


@check(_CO, 6)
def _bc6():
    """The scratch agent-browser project is gone: evidence/cutover/removal.json lists every removed path and none of the authored runner paths remains under /Users/nix/dev/ai/scratch/agent-browser (adhd/, server.mjs, search-cli.mjs, cdp-search.ts, search-mcp-source.ts, search-providers.ts, search-guard.ts, search-tripwire.ts, search-fetch.ts, fetch-policy.ts, apigen-client-common.mjs), the bin/scratch-agent-search* shims are removed, and docs/GIT-POLICY.md no longer references them."""
    r = jread(f"{_CO_EV}/removal.json", None)
    left = [p for p in _REMOVED if exists(f"{SRC}/{p}")]
    shims = _b_glob.glob(f"{SCRATCH}/bin/scratch-agent-search*")
    pol = sh(["rg", "-n", "scratch-agent-search", f"{SCRATCH}/docs/GIT-POLICY.md"])[1] if exists(f"{SCRATCH}/docs/GIT-POLICY.md") else ""
    listed = isinstance(r, dict) and set(_REMOVED) <= {os.path.basename(str(x).rstrip("/")) for x in r.get("removed") or []}
    return listed and not left and not shims and not pol.strip(), f"listed={listed} left={left} shims={shims} policy refs={pol[:80]!r}"


@check(_CO, 7)
def _bc7():
    """Scratch hygiene: at least one [psm:search-cutover] commit exists in the scratch repo, they are local-only (the branch has no upstream containing them), each touches only agent-browser/, bin/scratch-agent-search* and docs/GIT-POLICY.md, and none touches INDEX.md or agent-browser/metrics.json (another agent's uncommitted work)."""
    shas = git("-C", SCRATCH, "log", "--all", "--grep", r"\[psm:search-cutover\]", "--format=%H").split()
    if not shas:
        return False, "no scratch [psm:search-cutover] commits"
    bad = []
    for s in shas:
        for f in git("-C", SCRATCH, "diff-tree", "--no-commit-id", "--name-only", "-r", s).splitlines():
            if f in ("INDEX.md", "agent-browser/metrics.json") or not (f.startswith("agent-browser/") or f.startswith("bin/scratch-agent-search") or f == "docs/GIT-POLICY.md"):
                bad.append(f"{s[:8]}:{f}")
    up = sh(["git", "-C", SCRATCH, "rev-parse", "--abbrev-ref", "@{u}"])
    pushed = [s for s in shas if up[0] == 0 and sh(["git", "-C", SCRATCH, "merge-base", "--is-ancestor", s, up[1].strip()])[0] == 0]
    return not bad and not pushed, f"outside scope={bad[:5]} pushed={pushed}"


@check(_CO, 8)
def _bc8():
    """Backlog findings of the retired project are dispositioned through the graph (never a hand edit of BACKLOG.md): evidence/cutover/backlog.json has an entry for each of B-028..B-035 and 19dfb641 with `id`, `status` (resolved|closed|superseded) and a `citation` naming the stealth-search or core path that supersedes it."""
    b = jread(f"{_CO_EV}/backlog.json", None)
    by = {e.get("id"): e for e in (b if isinstance(b, list) else (b or {}).get("items", [])) if isinstance(e, dict)}
    bad = [i for i in _BACKLOG_IDS if i not in by or by[i].get("status") not in ("resolved", "closed", "superseded") or not str(by[i].get("citation") or by[i].get("commit") or "").strip()]
    return bool(by) and not bad, f"missing/undispositioned: {bad}"


@check(_CO, 9)
def _bc9():
    """No lockfile moved: [psm:search-cutover] commits in the adhd worktree do not touch pnpm-lock.yaml, and the edits to the retired project's tracked package.json left no `@adhd/` dependency behind (the project is deleted)."""
    log = sh(["git", "log", "--grep", r"\[psm:search-cutover\]", "--format=%H"])[1].split()
    touched = [s[:8] for s in log if "pnpm-lock.yaml" in git("diff-tree", "--no-commit-id", "--name-only", "-r", s).splitlines()]
    leftover = exists(f"{SRC}/package.json") and "@adhd/" in read(f"{SRC}/package.json")
    return bool(log) and not touched and not leftover, f"commits={len(log)} lockfile touched by {touched} leftover @adhd deps={leftover}"


@check(_CO, 10)
def _bc10():
    """Only owned paths changed by [psm:search-cutover] commits in the adhd worktree (the evidence/cutover/ files)."""
    return ownership_ok(_CO)


# =============================================================== consumer-relink
_CR = "consumer-relink"
_CR_EV = f"{_B_EV}/relink"
_OLD_TOOL = "agent_browser_search_mcp_source"
_HOME_CONSUMERS = [f"{_B_HOME}/.claude/agents/{n}.md" for n in ("researcher", "product", "performance", "doc-evangelist")] + \
                  [f"{_B_HOME}/.config/opencode/agents/{n}.md" for n in ("researcher", "doc-evangelist")] + [f"{_B_HOME}/.config/opencode/DOC-TRIO.md"]
_SOX_SUFFIXES = [f"extensions/agents/{n}/" for n in ("researcher", "performance", "product", "doc-evangelist")] + \
                ["extensions/agents/researcher/agent.md", "libs/host-registry/README.md", "libs/host-registry/src/agent-renderers.spec.ts",
                 "libs/host-registry/src/agent-manifests.shell-policy.spec.ts", "tools/test-c1b17653-researcher-single-definition.mjs"]


def _cr_consumers():
    c = jread(f"{_CR_EV}/consumers.json", None)
    return c if isinstance(c, list) else (c or {}).get("consumers", []) if isinstance(c, dict) else []


@check(_CR, 1)
def _br1():
    """Publish order is proven: evidence/relink/publish-order.json has order [@adhd/resilience-core-tripwire, @adhd/stealth-core-browser, @adhd/stealth-search] and published versions for all three (>= 0.1.0), each confirmed live by `npm view <pkg>@<version> version` now; RELEASE-DECISION.md records DECISION: publish for each of the three packages."""
    p = jread(f"{_CR_EV}/publish-order.json", None)
    names = [n for n, _ in (_B_PKGS["tripwire"], _B_PKGS["core"], _B_PKGS["search"])]
    if not isinstance(p, dict) or list(p.get("order") or []) != names:
        return False, "publish-order.json missing or wrong order"
    pub = p.get("published") or {}
    miss = [n for n in names if not re.match(r"^\d+\.\d+\.\d+", str(pub.get(n, "")))]
    if miss:
        return False, f"unpublished: {miss}"
    dead = [n for n in names if sh(["npm", "view", f"{n}@{pub[n]}", "version"], timeout=90)[0] != 0]
    rd = read(f"{PLAN}/RELEASE-DECISION.md")
    undecided = [n for n in names if not re.search(rf"{re.escape(n)}[^\n]*publish|DECISION[^\n]*{re.escape(n)}[^\n]*publish", rd, re.I)]
    return not dead and not undecided, f"not on registry: {dead}; no publish decision: {undecided}"


@check(_CR, 2)
def _br2():
    """The relink is dispatcher-gated: evidence/relink/dispatcher-approval.json records approved_by (dispatcher or human), an ISO timestamp, the repos in scope and that approval came after the publish check (approved_at later than publish-order.json verified_at)."""
    a, p = jread(f"{_CR_EV}/dispatcher-approval.json", None), jread(f"{_CR_EV}/publish-order.json", {}) or {}
    return isinstance(a, dict) and a.get("approved_by") in ("dispatcher", "human") and bool(a.get("repos")) and bool(a.get("approved_at")) and bool(p.get("verified_at")) and str(a["approved_at"]) >= str(p["verified_at"]), f"approval={a}"


@check(_CR, 3)
def _br3():
    """evidence/relink/consumers.json inventories EVERY consumer of the old tool names: the six home agent files (~/.claude/agents researcher, product, performance, doc-evangelist; ~/.config/opencode/agents researcher, doc-evangelist), ~/.config/opencode/DOC-TRIO.md, the opencode `search` server entry, and in sox-ecosystem extensions/agents/{researcher,performance,product,doc-evangelist}/, researcher/agent.md, libs/host-registry/{README.md,src/agent-renderers.spec.ts,src/agent-manifests.shell-policy.spec.ts} and tools/test-c1b17653-researcher-single-definition.mjs, each with status relinked and a commit (or null when the file is not in a repository)."""
    cs = _cr_consumers()
    paths = [str(c.get("path", "")) for c in cs if isinstance(c, dict)]
    miss = [h for h in _HOME_CONSUMERS if h not in paths]
    miss += [s for s in _SOX_SUFFIXES if not any(p.endswith(s) or s in p for p in paths)]
    if not any("opencode" in p and p.endswith((".json", ".jsonc")) for p in paths):
        miss.append("opencode config")
    notdone = [c.get("path") for c in cs if isinstance(c, dict) and c.get("status") != "relinked"]
    return bool(cs) and not miss and not notdone, f"missing: {miss[:6]} not relinked: {notdone[:4]}"


@check(_CR, 4)
def _br4():
    """No consumer still names the retired tools: none of the inventoried files nor anything under ~/.claude/agents, ~/.config/opencode matches `agent_browser_search_mcp_source`, and the files that allow the search tools use `mcp__search__stealth_*` names that are all among the eleven MCP-NAMES of naming-decision.md."""
    cs = _cr_consumers()
    files = []
    for c in cs:
        p = str(c.get("path", "")) if isinstance(c, dict) else ""
        files += [f for f in (_b_glob.glob(os.path.join(p, "**/*"), recursive=True) if os.path.isdir(p) else [p]) if os.path.isfile(f)]
    files = sorted(set(files + _HOME_CONSUMERS))
    old = [f for f in files if exists(f) and _OLD_TOOL in read(f)]
    sweep = sh(["rg", "-l", _OLD_TOOL, f"{_B_HOME}/.claude/agents", f"{_B_HOME}/.config/opencode"], timeout=60)
    names = set(_b_decision()["names"])
    used = set()
    for f in files:
        if exists(f):
            used |= set(re.findall(r"mcp__search__(stealth_\w+)", read(f)))
    return bool(cs) and not old and sweep[0] == 1 and len(names) == 11 and bool(used) and used <= names, f"old refs={old[:4]} rg rc={sweep[0]} used={sorted(used)[:4]} unknown={sorted(used - names)}"


@check(_CR, 5)
def _br5():
    """The opencode `search` MCP server entry runs the published package: ~/.config/opencode config has an entry named search whose command runs `@adhd/stealth-search` / `stealth-search-mcp` (stdio) or whose url targets the daemon started with `--transport sse`, and no longer the retired `http://127.0.0.1:3100/sse` agent-search endpoint."""
    for name in ("opencode.json", "opencode.jsonc"):
        t = read(f"{_B_HOME}/.config/opencode/{name}")
        if t:
            return ("@adhd/stealth-search" in t or "stealth-search-mcp" in t) and "127.0.0.1:3100/sse" not in t, f"{name}: stealth-search present={'stealth-search' in t}"
    return False, "no opencode config found"


@check(_CR, 6)
def _br6():
    """The published package answers as the configured entry does: `npx -y -p @adhd/stealth-search stealth-search-mcp --transport stdio` (scratch HOME) lists the eleven stealth_* tools of naming-decision.md through a real MCP stdio client."""
    d = _b_decision()
    if len(d["names"]) != 11:
        return False, "naming-decision.md has no MCP-NAMES"
    home = _b_tempfile.mkdtemp(prefix="guard-relink-")
    try:
        r = mcp_run(["npx", "-y", "-p", SEARCH_PKG, "stealth-search-mcp", "--transport", "stdio"], timeout=180, env={"HOME": home}, close_stdin=True)
    finally:
        _b_shutil.rmtree(home, ignore_errors=True)
    names = sorted(t["name"] for t in r["tools"])
    return names == sorted(d["names"]), f"tools={names} stderr={r['stderr'][-120:]!r}"


@check(_CR, 7)
def _br7():
    """The consumer repos' own gates are green and recorded: evidence/relink/consumer-gates.json has, for sox-ecosystem, commands (including node tools/test-c1b17653-researcher-single-definition.mjs and the host-registry specs) each with exit 0, run after the edits, and one entry per other edited repository."""
    g = jread(f"{_CR_EV}/consumer-gates.json", None)
    repos = g.get("repos") if isinstance(g, dict) else g
    if not isinstance(repos, list) or not repos:
        return False, "consumer-gates.json missing"
    sox = next((r for r in repos if "sox-ecosystem" in str(r.get("repo", ""))), None)
    if not sox:
        return False, "no sox-ecosystem entry"
    cmds = sox.get("commands") or []
    bad = [c for c in cmds if c.get("exit") != 0]
    return bool(cmds) and not bad and any("c1b17653" in str(c.get("cmd")) for c in cmds) and any("host-registry" in str(c.get("cmd")) for c in cmds), f"commands={len(cmds)} nonzero={bad[:2]}"


@check(_CR, 8)
def _br8():
    """Edits in other repositories are explicit-path and only to inventoried files: every consumers.json commit exists in its repository (git cat-file), touches only inventoried paths of that repo, and no commit message carries an AI attribution trailer."""
    cs = _cr_consumers()
    if not cs:
        return False, "no consumers"
    paths = {str(c.get("path")) for c in cs if isinstance(c, dict)}
    bad = []
    for c in cs:
        sha, path = c.get("commit"), str(c.get("path", ""))
        if not sha:
            continue
        repo = c.get("repo") or os.path.dirname(path)
        top = git("-C", repo, "rev-parse", "--show-toplevel")
        if not top or sh(["git", "-C", top, "cat-file", "-e", f"{sha}^{{commit}}"])[0] != 0:
            bad.append(f"{path}: commit {sha}")
            continue
        for f in git("-C", top, "diff-tree", "--no-commit-id", "--name-only", "-r", sha).splitlines():
            full = os.path.join(top, f)
            if not any(full == p or full.startswith(p.rstrip("/") + "/") for p in paths):
                bad.append(f"{sha[:8]} touched {full}")
        if re.search(r"co-authored-by|generated with", git("-C", top, "log", "-1", "--format=%B", sha), re.I):
            bad.append(f"{sha[:8]} attribution")
    return not bad, "; ".join(bad[:5])


@check(_CR, 9)
def _br9():
    """Only owned paths changed by [psm:consumer-relink] commits in the adhd worktree (evidence/relink/)."""
    return ownership_ok(_CR)


# ============================================================ backlog fold-in (2026-10-14 search bugs): hosts
@check("search-hosts", 18)
def _sh18():
    """(backlog abeedba8) The CLI exits as soon as its JSON is written: the host closes every browser handle, flushes stdout, then exits 0. Proven by (a) a spec under src/test/unit/hosts/ on the exported CLI runner with an injected stdout sink and exit function asserting the order write, flush, handles closed, exit(0), and that no timer or socket handle is left open (the idle-shutdown child is detached with stdio ignored and never inherits stdout), and (b) a real-process probe run by this guard: three `node dist/bin/cli.js chromeStatus --cdp-port 19999` processes started together with stdout redirected to files each exit 0 within 15 s and each file holds one parseable JSON document with running=false (a 0-byte output fails). Titles carry `flush`, `exit`, `detached`, `idleShutdown`, `stdout` and the uid abeedba8, and the spec cites [search-hosts.18]."""
    ok, detail = _bug_ac("search", "search-hosts", 18, ["abeedba8"], "hosts", ["flush", "exit", "detached", "idleShutdown", "stdout"])
    if not ok:
        return False, detail
    g = _sa_gate("build-bin")
    if not g[0]:
        return g
    import subprocess, tempfile, time
    bin_ = f"{SEARCH_DIR}/dist/bin/cli.js"
    if not exists(bin_):
        return False, f"{bin_} missing"
    d = tempfile.mkdtemp(prefix="sh18-")
    procs = []
    for i in range(3):
        fh = open(f"{d}/out{i}.json", "wb")
        procs.append((subprocess.Popen(["node", bin_, "chromeStatus", "--cdp-port", "19999"], stdout=fh, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL), fh))
    deadline = time.time() + 15
    bad = []
    for i, (p, fh) in enumerate(procs):
        try:
            p.wait(timeout=max(0.1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            p.kill()
            bad.append(f"proc {i} did not exit within 15 s")
        fh.close()
        try:
            doc = json.loads(read(f"{d}/out{i}.json"))
            if p.returncode != 0 or json.dumps(doc).find("false") < 0:
                bad.append(f"proc {i} exit {p.returncode} doc {str(doc)[:80]}")
        except ValueError:
            bad.append(f"proc {i}: output not one JSON document ({len(read(f'{d}/out{i}.json'))} chars)")
    return not bad, "; ".join(bad) or "three backgrounded CLI runs exited 0 with JSON"


@check("search-hosts", 19)
def _sh19():
    """(backlog 657bd597) Human-in-the-loop prompts never hang on a closed or non-interactive stdin: the CLI's `InteractionPort` implementation checks `process.stdin.isTTY` and the stream end; with a closed stdin or no TTY the gate prompt and the solved confirmation reject immediately with StealthSearchError HITL_ABORTED (no new code; the exit code comes from `exitCodeFor`, stable and non-zero) within 1000 ms and the tripped provider stays tripped. A spec under src/test/unit/hosts/ simulates a closed stdin stream and a non-TTY stdin through the real prompter with fake streams and fake timers; titles carry `isTTY`, `closed stdin`, `HITL_ABORTED`, `1000` and the uid 657bd597, and the spec cites [search-hosts.19]."""
    files = nontest_ts(SEARCH_DIR)
    if not any(re.search(r"isTTY", code_lines(read(f))) for f in files):
        return False, "no host source checks stdin.isTTY"
    return _bug_ac("search", "search-hosts", 19, ["657bd597"], "hosts", ["isTTY", "closed stdin", "HITL_ABORTED", "1000"])


@check("search-hosts", 20)
def _sh20():
    """(backlog 9d05e8b2) The CLI and the MCP host report the same tripwire status: both route `tripwireStatus` through the one verb (neither src/cli.ts nor src/server.ts holds an expiry or TTL predicate of its own), and a spec under src/test/unit/hosts/ seeds a data dir with one live and one expired lock and asserts that the CLI projection and the MCP tool result list exactly the same tripped set (the expired lock in neither). Titles carry `tripwireStatus`, `expired`, `CLI`, `MCP`, `same` and the uid 9d05e8b2, and the spec cites [search-hosts.20]."""
    own = [f for f in (f"{SEARCH_DIR}/src/cli.ts", f"{SEARCH_DIR}/src/server.ts") if exists(f)]
    dup = [f for f in own if re.search(r"expiresAt|\bttl\b|Date\.now\(\)", code_lines(read(f)), re.I)]
    if len(own) < 2 or dup:
        return False, f"hosts present={len(own)} own expiry predicate in {dup}"
    return _bug_ac("search", "search-hosts", 20, ["9d05e8b2"], "hosts", ["tripwireStatus", "expired", "CLI", "MCP", "same"])


@check("search-hosts", 21)
def _sh21():
    """(backlog 86ed154e) The CLI never exits 0 with empty output: every operation writes one non-empty JSON document to stdout before exit 0, and an empty or undefined verb result becomes a typed HOST_BOOT_FAILED failure with a non-zero exit (`HOST_BOOT_FAILED: <message>` on one stderr line) instead of a silent exit 0. A spec under src/test/unit/hosts/ runs three CLI runner invocations concurrently with fake verbs (one returning undefined) and asserts three stdout documents or a typed failure each; titles carry `empty`, `undefined`, `HOST_BOOT_FAILED`, `stdout`, `concurrent` and the uid 86ed154e, and the spec cites [search-hosts.21]."""
    return _bug_ac("search", "search-hosts", 21, ["86ed154e"], "hosts", ["empty", "undefined", "HOST_BOOT_FAILED", "stdout", "concurrent"])
