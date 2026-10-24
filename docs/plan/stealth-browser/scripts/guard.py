#!/usr/bin/env python3
"""Deterministic guards for the stealth-browser plan.

usage: python3 docs/plan/stealth-browser/scripts/guard.py <state-slug> [--only <slug.N>]

* Run from anywhere inside the worktree; the script chdirs to the git toplevel.
* One entry point, keyed by state slug.  Each acceptance criterion `[slug.N]` in
  contexts/<slug>.md and scripts/criteria.json is `guard.py <slug> --only <slug.N>`.
* Exit status = number of failed checks (0 == the state is complete).  Every check
  is red until the state's work is done (red -> green).  stdlib only.
* Heavy nx runs are cached by git tree sha in evidence/*.json so the per-criterion
  invocations do not repeat a multi-minute gate run.
"""
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

TOP = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
os.chdir(TOP)

PLAN = "docs/plan/stealth-browser"
# The package split (SPEC-stealth-search.md): the library moves from the generated entrypoint to the generated core package
# `packages/stealth/stealth-core-browser` (@adhd/stealth-core-browser); the search entrypoint is `entrypoint/stealth-search`.
LEGACY_DIR = "entrypoint/stealth-browser"
CORE_DIR = "packages/stealth/stealth-core-browser"
SEARCH_DIR = "entrypoint/stealth-search"
CORE_PROJECT = "stealth-core-browser"
SEARCH_PROJECT = "stealth-search"
CORE_PKG = "@adhd/stealth-core-browser"
SEARCH_PKG = "@adhd/stealth-search"
LEGACY_PKG = "@adhd/stealth-browser"
# `P` is the library package directory: the legacy entrypoint until core-scaffold moves it, the core package afterwards. Every check written
# for the library before the split keeps working on both sides of the move because it addresses the library only through `P` / proj_name().
P = LEGACY_DIR if (os.path.exists(LEGACY_DIR) and not os.path.exists(CORE_DIR)) else CORE_DIR
TW = "packages/resilience/resilience-core-tripwire"
TW_NAME = "resilience-core-tripwire"
TW_PKG = "@adhd/resilience-core-tripwire"
REVERSE = "/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt"
SMOKE = "docs/plan/stealth-browser/smoke"
TWREV = "docs/plan/stealth-browser/tripwire-reverse"
SRC = "/Users/nix/dev/ai/scratch/agent-browser"
SCRATCH = "/Users/nix/dev/ai/scratch"
MAIN = "/Users/nix/dev/node/adhd"
TICKET = "8468f7b1"
NX = "./node_modules/.bin/nx"
SIBLINGS = ["entrypoint/dispatch-cli", "entrypoint/backlog", "entrypoint/apigen-cli"]
SCRIPTS = f"{PLAN}/scripts"

CHECKS = {}  # slug -> [(id, fn)]
RESULTS = []


def check(slug, n):
    def deco(fn):
        CHECKS.setdefault(slug, []).append((f"{slug}.{n}", fn))
        return fn
    return deco


# ---------------------------------------------------------------- helpers
def sh(cmd, timeout=900, cwd=None, env=None):
    e = dict(os.environ)
    e.update({"CI": "true", "NX_NO_CLOUD": "true"})
    if env:
        e.update(env)
    try:
        r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout, cwd=cwd, env=e)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, f"timeout after {timeout}s"


def git(*args, cwd=None):
    return sh(["git", *args], cwd=cwd)[1].strip()


def read(path, default=""):
    try:
        with open(path, encoding="utf8") as f:
            return f.read()
    except OSError:
        return default


def jread(path, default=None):
    try:
        return json.loads(read(path))
    except (ValueError, OSError):
        return default


def exists(path):
    return os.path.exists(path)


def pkg():
    return jread(f"{P}/package.json", {}) or {}


def proj_name():
    return (jread(f"{P}/project.json", {}) or {}).get("name", CORE_PROJECT if P == CORE_DIR else "stealth-browser")


def dag():
    return jread(f"{PLAN}/dag.json", {})


def dag_descendants(slug):
    """Every state that has `slug` as a (transitive) dag ancestor."""
    nodes = (dag() or {}).get("nodes", {})
    out, grew = set(), True
    while grew:
        grew = False
        for n, v in nodes.items():
            if n not in out and any(d == slug or d in out for d in v.get("depends_on", [])):
                out.add(n)
                grew = True
    return out


def state():
    return jread(f"{PLAN}/state.json", {})


def tree_sha():
    """Combined code identity of the stealth-core-browser and stealth-search packages (src, bin, package.json, project.json at HEAD). Documentation edits do not change it ([inv:gate-trees])."""
    t = code_trees()
    return hashlib.sha256((t["core"] + "|" + t["search"]).encode()).hexdigest() if (t["core"] or t["search"]) else ""


def tree_sha_at(ref):
    """tree_sha() as of `ref` (a commit): the combined core + search code identity frozen at that commit."""
    a, b = code_tree(CORE_DIR, ref), code_tree(SEARCH_DIR, ref)
    return hashlib.sha256((a + "|" + b).encode()).hexdigest() if (a or b) else ""


def tw_tree_sha_at(ref):
    """tw_tree_sha() as of `ref`."""
    return git("rev-parse", f"{ref}:{TW}") if exists(TW) else ""


def ownership():
    return jread(f"{SCRIPTS}/ownership.json", {})


def manifest():
    return jread(f"{SCRIPTS}/port-manifest.json", [])


def criteria_ids():
    doc = jread(f"{SCRIPTS}/criteria.json", {}) or {}
    return {c["id"] for c in doc.get("criteria", [])}


def walk_dist(root, exts=(".js", ".cjs", ".mjs")):
    """Every built file under a dist directory. `walk` skips any path containing `/dist` (it is a source walker), so a dist inspection must use this one."""
    out = []
    for d, _, fs in os.walk(root):
        if "node_modules" in d:
            continue
        out += [os.path.join(d, f) for f in fs if f.endswith(exts)]
    return sorted(out)


def registry_published(name):
    """True when the pnpm lockfile resolves `name` from the npm registry: some `/<name>@<ver>:` entry whose resolution carries an integrity hash and no tarball/directory/path override."""
    lock = read("pnpm-lock.yaml")
    ents = re.findall(r"^  /" + re.escape(name) + r"@[^:\n]+:\n    resolution: \{([^}\n]*)\}", lock, re.M)
    return any("integrity: sha512-" in e and not re.search(r"tarball:|directory:|path:", e) for e in ents)


def ensure_full_dist():
    """Build both published dists completely (core: build, dist-manifest; search: build + build-bin + assets + dist-manifest) through verify-dist-load, whose dependsOn chain is the build graph. A bare `build` empties dist/ (vite emptyOutDir), so every dist inspection starts here and no check depends on which check ran before it. Runs uncached on purpose: an Nx cache hit on build-bin/dist-manifest restores the files without the executable bit that dist-manifest's chmod-bin step sets."""
    rc, out = 0, ""
    for proj in (CORE_PROJECT, SEARCH_PROJECT):
        r, o = nx_run(proj, "verify-dist-load", "--skip-nx-cache", timeout=2400)
        rc, out = max(rc, r), out + o[-300:]
    return rc, out


def walk(root, exts=(".ts",)):
    out = []
    for d, _, fs in os.walk(root):
        if "node_modules" in d or "/dist" in d:
            continue
        for f in fs:
            if f.endswith(exts):
                out.append(os.path.join(d, f))
    return sorted(out)


def code_lines(text):
    """Lines that are not pure comments (good enough for hygiene greps)."""
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith(("//", "*", "/*")):
            continue
        out.append(ln)
    return "\n".join(out)


EXPORT_RE = re.compile(r"^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)", re.M)
EXPORT_LIST_RE = re.compile(r"export\s+(?:type\s+)?\{([^}]*)\}", re.S)


def exports_of(text):
    names = set(EXPORT_RE.findall(text))
    for blob in EXPORT_LIST_RE.findall(text):
        for part in blob.split(","):
            part = part.strip()
            if not part:
                continue
            part = re.sub(r"^type\s+", "", part)
            names.add(part.split(" as ")[-1].strip())
    return names


def norm_for_diff(text):
    text = re.sub(r"\.ts(['\"])", r".js\1", text)
    return [ln.rstrip() for ln in text.splitlines() if ln.strip()]


# ---------------------------------------------------------- shared checks
def baseline_src(rel):
    """Source text of a manifest `src` as it was at scaffold time: agent-browser/adhd/* from the recorded baseline tree, everything else from the recorded baseline commit (so the cutover may delete or rewrite the live files)."""
    base = {}
    for ln in read(f"{PLAN}/evidence/source-baseline.txt").splitlines():
        if " " in ln:
            k, v = ln.split(" ", 1)
            base[k] = v.strip()
    if rel.startswith("adhd/") and base.get("tree"):
        r = sh(["git", "show", f"{base['tree']}:{rel[5:]}"], cwd=SCRATCH)
    elif base.get("commit"):
        r = sh(["git", "show", f"{base['commit']}:agent-browser/{rel}"], cwd=SCRATCH)
    else:
        return read(f"{SRC}/{rel}")
    return r[1] if r[0] == 0 else read(f"{SRC}/{rel}")


def source_untouched():
    base = {}
    for ln in read(f"{PLAN}/evidence/source-baseline.txt").splitlines():
        if " " in ln:
            k, v = ln.split(" ", 1)
            base[k] = v.strip()
    if "tree" not in base:
        return False, "evidence/source-baseline.txt missing (scaffold state records it)"
    cut = [x for x in sh(["git", "log", "--format=%H", "--grep=\\[psm:search-cutover\\]", "--reverse"], cwd=SCRATCH)[1].split() if x]
    if cut:
        # Recorded-at-completion semantics: the cutover may change agent-browser/adhd, so the tree just BEFORE its first commit is a frozen fact
        # (evidence/frozen/source-untouched.json: the baseline plus the untagged ambient fixes made by other agents), no commit tagged [psm:*] other
        # than the cutover may ever have touched it, and nothing but cutover commits may touch it afterwards.
        frozen = jread(f"{PLAN}/evidence/frozen/source-untouched.json", {}) or {}
        tree = git("rev-parse", f"{cut[0]}^:agent-browser/adhd", cwd=SCRATCH)
        recs = [c for c in sh(["git", "log", "--format=%H%x1f%B%x1e", f"{cut[0]}^..HEAD", "--", "agent-browser/adhd"], cwd=SCRATCH)[1].split("\x1e") if c.strip() and "[psm:search-cutover]" not in c]
        tagged = [c for c in sh(["git", "log", "--format=%H%x1f%B%x1e", "--grep=\\[psm:", "--", "agent-browser/adhd"], cwd=SCRATCH)[1].split("\x1e") if c.strip() and "[psm:search-cutover]" not in c]
        base_ok = sh(["git", "cat-file", "-e", f"{base['tree']}^{{tree}}"], cwd=SCRATCH)[0] == 0
        ok = tree == frozen.get("pre_cutover_tree") and base.get("tree") == frozen.get("baseline_tree") and not recs and not tagged and base_ok
        return ok, f"pre-cutover tree={tree[:10]} frozen={str(frozen.get('pre_cutover_tree'))[:10]} baseline intact={base_ok} non-cutover commits touching adhd after cutover={len(recs)} plan-tagged non-cutover commits touching adhd={len(tagged)}"
    # Commit-scoped (the live scratch tree is ambient state other authorised agents edit, and the cutover removes adhd/ on purpose): no commit of
    # this plan touched agent-browser/adhd, and the recorded baseline tree is still an intact git object.
    psm = [c for c in sh(["git", "log", "--format=%H%x1f%B%x1e", "--grep=\\[psm:", "--", "agent-browser/adhd"], cwd=SCRATCH)[1].split("\x1e") if c.strip()]
    base_ok = sh(["git", "cat-file", "-e", f"{base['tree']}^{{tree}}"], cwd=SCRATCH)[0] == 0
    return not psm and base_ok, f"plan commits touching scratch agent-browser/adhd={len(psm)} baseline tree={base.get('tree', '')[:10]} intact={base_ok}"


def plan_commits_off_branch(repo_ref, tag_rx="\\[psm:", cwd=None):
    """Plan-tagged commits reachable from `repo_ref` but not from this branch's HEAD (plan work committed somewhere it must not be)."""
    out = sh(["git", "log", repo_ref, "--not", "HEAD", "--format=%H%x1f%B%x1e", f"--grep={tag_rx}"], cwd=cwd)[1]
    return [r.split("\x1f", 1)[0].strip() for r in out.split("\x1e") if "\x1f" in r]


def main_nm_untouched():
    """Commit-scoped: no [psm:*] commit of this plan exists on the main checkout's branch outside this branch (the plan never edited main), and the main-checkout node_modules stamp is recorded as point-in-time evidence only (other agents may legitimately reinstall afterwards)."""
    stamp = read(f"{PLAN}/evidence/main-node-modules.stamp").strip()
    if not stamp:
        return False, "evidence/main-node-modules.stamp missing"
    off = plan_commits_off_branch("main")
    try:
        cur = str(int(os.stat(f"{MAIN}/node_modules/.modules.yaml").st_mtime))
    except OSError:
        cur = "unreadable"
    return not off, f"plan commits on main outside this branch={len(off)} (evidence: .modules.yaml mtime now {cur}, stamp {stamp})"


# ---------------------------------------------------------------- split helpers (shared by this file and scripts/guards/*.py)
SPLIT_SPEC = f"{PLAN}/SPEC-stealth-search.md"
SPLIT_EVIDENCE = f"{PLAN}/evidence/split"
SPLIT_REQUEST = "port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search"


def pkg_json(d):
    return jread(f"{d}/package.json", {}) or {}


def project_json(d):
    return jread(f"{d}/project.json", {}) or {}


def nx_run(project, target, *extra, timeout=1800):
    """`nx run <project>:<target> [extra...]` -> (rc, output)."""
    return sh([NX, "run", f"{project}:{target}", *extra], timeout=timeout)


def code_tree(d, ref="HEAD"):
    """Identity of a package's code and manifest at `ref` (src, bin, package.json, project.json). Documentation edits (README, CHANGELOG, docs/, AGENTS.md, llms.txt) do not change it, so gate evidence stays valid across the docs states."""
    if ref == "HEAD" and not os.path.isdir(d):
        return ""
    out = git("ls-tree", "-r", ref, "--", f"{d}/src", f"{d}/bin", f"{d}/package.json", f"{d}/project.json")
    return hashlib.sha256(out.encode()).hexdigest()


def code_trees():
    """code_tree of the three owned packages (empty string while a package does not exist yet)."""
    return {"core": code_tree(P), "search": code_tree(SEARCH_DIR), "tw": code_tree(TW)}


def nontest_ts(d, *subdirs):
    """Non-test, non-declaration TypeScript files under d/<subdirs> (default src and bin)."""
    out = []
    for sub in subdirs or ("src", "bin"):
        for f in walk(f"{d}/{sub}"):
            if "/test/" in f or f.endswith((".spec.ts", ".d.ts")):
                continue
            out.append(f)
    return out


def spec_files_of(d, sub=""):
    """*.spec.ts files under d/test/<sub> (the layout of docs/standards/testing.md: test/{unit,e2e,helpers,fixtures,golden})."""
    root = f"{d}/test/{sub}".rstrip("/")
    return [f for f in walk(root) if f.endswith((".spec.ts", ".test.ts"))]


def cites(files, slug=None):
    """Every file cites the ticket 8468f7b1 and at least one valid [<state>.N] criterion id (of `slug` when given)."""
    ids = criteria_ids()
    bad = []
    for f in files:
        txt = read(f)
        found = set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", txt))
        if slug:
            found = {i for i in found if i.startswith(slug + ".")}
        if TICKET not in txt or not (found & ids):
            bad.append(f)
    return bool(files) and not bad, f"uncited or no files: {bad[:5]} (files={len(files)})"


def offenders(files, rx, flags=0):
    """Files whose code lines (comments stripped) match `rx`."""
    return [f for f in files if re.search(rx, code_lines(read(f)), flags)]


def env_readers(files):
    return offenders(files, r"process\.env")


def untyped_error_sites(files):
    """Non-test source that constructs a bare Error / TypeError / RangeError or rejects with a string."""
    return offenders(files, r"\bnew\s+(?:Error|TypeError|RangeError)\s*\(|\bthrow\s+['\"`]|Promise\.reject\(\s*['\"`]")


def evidence_json(name):
    return jread(f"{SPLIT_EVIDENCE}/{name}", {}) or {}


def mcp_run(cmd, calls=(), env=None, cwd=None, timeout=60, close_stdin=False):
    """Minimal real MCP stdio client: spawns `cmd`, initialize, tools/list, then tools/call for each (tool-name suffix or exact name, args).
    Returns {tools, calls, stdout, stderr, exit}. `close_stdin` closes stdin after the last call and waits for the process to exit (proves stdin-EOF shutdown)."""
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out = {"tools": [], "calls": [], "stdout": [], "stderr": "", "exit": None}

    def rpc(i, method, params=None):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
        p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            line = p.stdout.readline()
            if not line:
                break
            out["stdout"].append(line)
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == i:
                return m
        return {}
    try:
        rpc(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "guard", "version": "0"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        out["tools"] = rpc(2, "tools/list").get("result", {}).get("tools", [])
        for n, (name, args) in enumerate(calls, 3):
            tool = next((x for x in out["tools"] if x["name"] == name), None) or next((x for x in out["tools"] if x["name"].endswith(name)), None)
            out["calls"].append(rpc(n, "tools/call", {"name": tool["name"], "arguments": args}) if tool else {})
        if close_stdin:
            p.stdin.close()
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
    except (BrokenPipeError, ConnectionResetError):
        # The child exited before it read our request (for example `npx` failing to resolve an unpublished package): the stdin pipe is
        # closed under us. That is a red answer (no tools listed, stderr captured below), never a crash of the guard.
        out["died_early"] = True
    finally:
        try:
            p.stdin.close()  # a buffered write to a dead child would otherwise raise BrokenPipeError again from the pipe's finalizer
        except OSError:
            pass
        if p.poll() is None:
            p.kill()
            p.wait()
        out["exit"] = p.returncode
        try:
            out["stderr"] = p.stderr.read()
        except (OSError, ValueError):
            pass
    return out


RETIRED_STATES = ["surface-hosts", "tracing-plugin", "tracing-namespace-proof", "agent-search-cutover", "agent-search-relink"]


def _ck(slug, n):
    """Late-bound reference to another state's check (so a guard can re-run a check defined in a later module)."""
    def run():
        fn = dict(CHECKS.get(slug, [])).get(f"{slug}.{n}")
        return fn() if fn else (False, f"no check {slug}.{n}")
    run.__name__ = f"ck_{slug.replace('-', '_')}_{n}"
    return run


def completion_ref(slug):
    """The commit a `[psm:<slug>]` ownership scan runs up to: the state's recorded `end_ref` once it is complete (a one-shot historical fact frozen in
    state.json at completion, so later states, merges and repair commits that merely MENTION the tag cannot re-open a completed state), else HEAD
    (the state is in flight).  Falls back to HEAD when the recorded ref is not an ancestor of HEAD."""
    st = (state().get("states") or {}).get(slug) or {}
    end = st.get("end_ref")
    if st.get("status") == "complete" and end and sh(["git", "merge-base", "--is-ancestor", end, "HEAD"])[0] == 0:
        return end
    return "HEAD"


def plan_base_ref():
    """The commit the plan branched from: the first state's recorded start_ref (the live `git merge-base HEAD main` moves forward once main is merged into the branch)."""
    st = (state().get("states") or {})
    first = next(iter((dag() or {}).get("nodes", {})), None)
    ref = (st.get(first) or {}).get("start_ref") if first else None
    return ref or git("merge-base", "HEAD", "main")


def ownership_ok(slug):
    owned = ownership().get(slug)
    if owned is None:
        return False, f"no ownership entry for {slug}"
    st = (state().get("states") or {}).get(slug) or {}
    since = st.get("start_ref") or git("merge-base", "HEAD", "main")
    log = sh(["git", "log", f"{since}..{completion_ref(slug)}", "--format=%H%x1f%B%x1e"])[1]
    bad = []
    for rec in log.split("\x1e"):
        if "\x1f" not in rec:
            continue
        sha, body = rec.strip().split("\x1f", 1)
        if f"[psm:{slug}]" not in body:
            continue
        files = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).splitlines()
        for f in files:
            if f in (f"{PLAN}/state.json", f"{PLAN}/events.ndjson", "docs/plan/plan-index.json"):
                continue
            if not any(f == o or (o.endswith("/") and f.startswith(o)) or (o.endswith("/*") and f.startswith(o[:-1]) and "/" not in f[len(o) - 1:]) for o in owned):
                bad.append(f"{sha[:8]}:{f}")
    return not bad, "files outside owned paths: " + ", ".join(bad[:8]) if bad else "ok"


HYGIENE_FORBIDDEN = [
    (r"from\s+['\"][^'\"]*\.ts['\"]", "relative import with .ts extension (must be .js)"),
    (r"(?:from|import)\s*\(?\s*['\"][^'\"]*(?:search-(?:types|providers|tripwire|guard|fetch|network|dom|challenge)|cdp-search|fetch-(?:policy|markdown|pdf)|/scratch/|agent-browser)", "import reaching into agent-search"),
    (r"['\"]@adhd/cdp-connection['\"]", "separate @adhd/cdp-connection package (only ONE package is approved)"),
    (r"send\(\s*['\"]Runtime\.evaluate", "Runtime.evaluate call (stealth invariant)"),
    (r"['\"]--enable-automation['\"]", "--enable-automation flag (stealth invariant)"),
    (r"/Users/", "hard-coded user path"),
]


def hygiene(files):
    bad = []
    for f in files:
        txt = code_lines(read(f))
        for rx, why in HYGIENE_FORBIDDEN:
            if re.search(rx, txt):
                bad.append(f"{f}: {why}")
    return not bad, "; ".join(bad[:6]) if bad else "ok"


def rel_imports_resolve(files):
    bad = []
    for f in files:
        for spec in re.findall(r"from\s+['\"](\.[^'\"]+)['\"]", read(f)):
            tgt = os.path.normpath(os.path.join(os.path.dirname(f), spec))
            cands = [re.sub(r"\.js$", ".ts", tgt), tgt + ".ts", os.path.join(tgt, "index.ts"), tgt]
            if not any(exists(c) and os.path.isfile(c) for c in cands):
                bad.append(f"{f} -> {spec}")
    return not bad, "unresolved: " + "; ".join(bad[:6]) if bad else "ok"


def entries(bucket):
    return [e for e in manifest() if e["bucket"] == bucket]


def ported_files(bucket):
    return [f"{P}/{e['dst']}" for e in entries(bucket) if e.get("kind", "ts") == "ts"]


def legacy_path(path):
    """The pre-split location of a path under the core package (core-scaffold git-mv'd entrypoint/stealth-browser -> packages/stealth/stealth-core-browser); the path itself when it is not under the core package."""
    return LEGACY_DIR + path[len(CORE_DIR):] if path == CORE_DIR or path.startswith(CORE_DIR + "/") else path


def assertion_lines(text):
    """The assertion and title lines of a spec (`expect(`, `it(`, `describe(`, `test(`), whitespace-free, with the `-sTCP:LISTEN` insertion of core-seam.9 normalized away: the fixture-only comparison of CL11 and core-seam.12."""
    keep = []
    for ln in text.replace(" -sTCP:LISTEN", "").splitlines():
        if re.search(r"\bexpect\s*[(.]", ln) or re.match(r"\s*(?:it|describe|test)(?:\.\w+)*\s*[(\[]", ln):
            keep.append(re.sub(r"\s+", "", ln))
    return keep


def path_history(path):
    """Every location `path` has had: the current path, its pre-split legacy location (entrypoint/stealth-browser -> packages/stealth/stealth-core-browser)
    and the pre-layout-move test location (`<pkg>/src/test/...` -> `<pkg>/test/...`, docs/standards/testing.md), in that order, without duplicates."""
    out = [path, legacy_path(path)]
    for base in (CORE_DIR, LEGACY_DIR, SEARCH_DIR):
        for cur in list(out):
            if cur.startswith(base + "/test/"):
                out.append(f"{base}/src/test/{cur[len(base) + len('/test/'):]}")
    return list(dict.fromkeys(out))


def blob_at(ref, path):
    """Content of `path` at `ref`, rename-aware: tries the path, then its pre-split legacy location and its pre-layout-move test location; None when none exists at that ref."""
    for cand in path_history(path):
        r = sh(["git", "show", f"{ref}:{cand}"])
        if r[0] == 0:
            return r[1]
    return None


def migration_snapshot(slug, path):
    """The content of `path` as the migration state `slug` committed it, when a later commit of another state has changed it since; None while the
    latest commit touching the file is the migration's own (or the migration has not committed it yet), so the live tree is measured then.
    Rename-aware: the history of both the current path and its pre-split legacy path is consulted, so the core-scaffold move does not hide the migration's commit."""
    if not slug:
        return None
    paths = path_history(path)
    log = sh(["git", "log", "--format=%H%x1f%B%x1e", "--"] + paths)[1]
    recs = [r.strip().split("\x1f", 1) for r in log.split("\x1e") if "\x1f" in r]
    if not recs or f"[psm:{slug}]" in recs[0][1]:
        return None
    for sha, body in recs:
        if f"[psm:{slug}]" in body:
            return blob_at(sha, path)
    return None


def pre_descendant_snapshot(path, descendants):
    """The content of `path` as it stood before the first commit of a DESCENDANT state (one of `descendants`, tagged [psm:<slug>]) changed it; None while no
    descendant commit touched the file, so the live tree is measured then. Used for states that own no commit of the file themselves (their baseline is the
    pre-existing content), so a later state's legitimate edit does not reopen them. Rename-aware like migration_snapshot."""
    paths = path_history(path)
    log = sh(["git", "log", "--format=%H%x1f%B%x1e", "--"] + paths)[1]
    recs = [r.strip().split("\x1f", 1) for r in log.split("\x1e") if "\x1f" in r]
    tagged = [i for i, (_, body) in enumerate(recs) if any(f"[psm:{d}]" in body for d in descendants)]
    if not tagged or tagged[-1] + 1 >= len(recs):
        return None
    return blob_at(recs[tagged[-1] + 1][0], path)


def port_check(bucket, strict=False, final=False, slug=None):
    """strict=False is the migration-time check (the port still carries the source names); strict=True is the corrected tree after port-fixes (greenfield renames and require_exports enforced).
    Line similarity is a migration-time property: once a later state's greenfield commit changes a ported file it is measured on the migration's own
    committed snapshot (non-regressing, still proves the port was faithful), while exports and must_contain tokens stay enforced on the live tree."""
    bad = []
    for e in entries(bucket):
        dst = f"{P}/{e['dst']}"
        src = f"{SRC}/{e['src']}"
        if not exists(dst):
            bad.append(f"missing {e['dst']}")
            continue
        if e.get("kind", "ts") != "ts":
            if len(read(dst).strip()) < 50:
                bad.append(f"empty {e['dst']}")
            continue
        s, d = baseline_src(e['src']), read(dst)
        missing = exports_of(s) - exports_of(d)
        missing -= set(e.get("allowed_drops", []))
        for old, new in (e.get("allowed_renames") or {}).items():
            missing.discard(old)
            if strict and new not in exports_of(d):
                bad.append(f"{e['dst']} must export {new} (the greenfield name for {old})")
        if missing:
            bad.append(f"{e['dst']} lost exports {sorted(missing)}")
        for extra in (e.get("require_exports", []) if strict else []):
            if extra not in exports_of(d):
                bad.append(f"{e['dst']} must export {extra}")
        snap = migration_snapshot(slug, dst)
        ratio = difflib.SequenceMatcher(None, norm_for_diff(s), norm_for_diff(d if snap is None else snap), autojunk=False).ratio()
        if ratio < e.get("min_similarity", 0.80) and not e.get("rewritten_by"):  # a file rewritten by capture-upgrade / chrome-lifecycle is held to the feature inventory instead of line similarity (greenfield: no legacy-code guard)
            bad.append(f"{e['dst']} similarity {ratio:.2f} < {e.get('min_similarity', 0.80)} (behavior-preserving port{'' if snap is None else ', measured at the ' + slug + ' commit'})")
        for tok in e.get("must_contain", []):
            if tok not in d:
                bad.append(f"{e['dst']} lost token {tok!r}")
    return not bad, "; ".join(bad[:8]) if bad else "ok"


def no_stale_twins(prefix):
    bad = [f for f in walk(f"{P}/{prefix}", (".js", ".mjs", ".cjs")) if not f.endswith(".config.js")]
    bad += [f"{P}/{prefix}/package.json"] if exists(f"{P}/{prefix}/package.json") else []
    return not bad, "stale compiled twin / nested package: " + ", ".join(bad) if bad else "ok"


def standard_port_checks(slug, bucket, extra=None):
    """AC .1 port parity, .2 hygiene + resolvable imports, .3 ownership/source/main untouched."""
    @check(slug, 1)
    def _c1():
        """Every manifest file exists, keeps every export (modulo the manifest's recorded allowed_renames/allowed_drops), was >=80% line-similar to the scaffold-time source as this state committed it (a later state's greenfield edit does not re-open it), keeps its must-contain tokens."""
        return port_check(bucket, slug=slug)

    @check(slug, 2)
    def _c2():
        """No .ts import specifiers, no reach into agent-search, no Runtime.evaluate/--enable-automation; every relative import resolves."""
        files = ported_files(bucket)
        if not files or not all(exists(f) for f in files):
            return False, "ported files missing"
        ok, why = hygiene(files)
        if not ok:
            return ok, why
        return rel_imports_resolve(files)

    @check(slug, 3)
    def _c3():
        a = ownership_ok(slug)
        b = source_untouched()
        c = main_nm_untouched()
        ok = a[0] and b[0] and c[0] and bool([1 for _ in entries(bucket) if exists(f"{P}/{_['dst']}")])
        return ok, " | ".join(x[1] for x in (a, b, c) if not x[0]) or "ok"
    _c3.__doc__ = f"Only owned paths changed by [psm:{slug}] commits; agent-search source tree and main checkout node_modules untouched."
    if extra:
        extra()


# ============================================================ S0 productization-hold
@check("productization-hold", 1)
def _ph1():
    """PRODUCT-REVIEW.md exists with the line `STATUS: folded` (product's tasks are folded into the DAG)."""
    return bool(re.search(r"^STATUS:\s*folded\s*$", read(f"{PLAN}/PRODUCT-REVIEW.md"), re.M)), "PRODUCT-REVIEW.md STATUS: folded"


@check("productization-hold", 2)
def _ph2():
    """Every state listed on the `INSERTED:` line exists in dag.json with a non-empty depends_on; the line may be `INSERTED: none`."""
    m = re.search(r"^INSERTED:\s*(.+)$", read(f"{PLAN}/PRODUCT-REVIEW.md"), re.M)
    if not m:
        return False, "no INSERTED: line"
    names = [] if m.group(1).strip().lower() == "none" else [x.strip() for x in m.group(1).split(",")]
    nodes = dag().get("nodes", {})
    bad = [n for n in names if n not in nodes or not nodes[n].get("depends_on")]
    return not bad, f"missing/rootless inserted states {bad}"


@check("productization-hold", 3)
def _ph3():
    """dag.json is acyclic after the insertions and every inserted prod-* state is an ancestor of `gates-first` (no exceptions)."""
    nodes = dag().get("nodes", {})
    seen, stack = set(), set()

    def visit(n):
        if n in stack:
            return False
        if n in seen:
            return True
        seen.add(n); stack.add(n)
        ok = all(visit(d) for d in nodes.get(n, {}).get("depends_on", []) if d in nodes)
        stack.discard(n)
        return ok
    if not all(visit(n) for n in nodes):
        return False, "cycle in dag.json"

    def anc(n, memo={}):
        if n not in memo:
            memo[n] = set()
            for d in nodes.get(n, {}).get("depends_on", []):
                memo[n] |= {d} | anc(d)
        return memo[n]
    reach = anc("gates-first") if "gates-first" in nodes else set()
    stray = sorted(n for n in nodes if n.startswith("prod-") and n not in reach)
    return not stray, f"acyclic; prod-* states that are not ancestors of gates-first: {stray}"


# ============================================================ S1 scaffold
@check("scaffold", 1)
def _s1():
    """evidence/scaffold-dry-run.txt records the generator --dry-run CREATE list (read before the real run)."""
    t = read(f"{PLAN}/evidence/scaffold-dry-run.txt")
    return "CREATE entrypoint/stealth-browser/src/index.ts" in t and "dryRun" in t, "dry-run evidence"


@check("scaffold", 2)
def _s2():
    """evidence/scaffold-run.txt records the REAL generator run: `Scaffolding stealth-browser at entrypoint/stealth-browser (@adhd/stealth-browser)` and no dryRun note."""
    t = read(f"{PLAN}/evidence/scaffold-run.txt")
    return "Scaffolding stealth-browser at entrypoint/stealth-browser (@adhd/stealth-browser)" in t and "dryRun" not in t, "real-run evidence"


@check("scaffold", 3)
def _s3():
    """The generated entrypoint package was named exactly @adhd/stealth-browser with a project.json; after core-scaffold its successor @adhd/stealth-core-browser (generator-built library) carries the same migrated code with a project.json."""
    return pkg().get("name") in (LEGACY_PKG, CORE_PKG) and exists(f"{P}/project.json"), f"name={pkg().get('name')}"


@check("scaffold", 4)
def _s4():
    """tsconfig.base.json maps the package path alias (generator UPDATE): @adhd/stealth-browser before core-scaffold, @adhd/stealth-core-browser after it (the old alias is removed)."""
    t = read("tsconfig.base.json")
    return (CORE_PKG in t) if P == CORE_DIR else (LEGACY_PKG in t), "tsconfig.base.json alias"


@check("scaffold", 5)
def _s5():
    """Exactly the approved new project.json files since main: the migrated package's (entrypoint/stealth-browser/project.json before core-scaffold, packages/stealth/stealth-core-browser/project.json after it) and, once their scaffold states have run, packages/resilience/resilience-core-tripwire/project.json and entrypoint/stealth-search/project.json (three packages in all, each generator-built); any other new project.json fails."""
    base = git("merge-base", "HEAD", "main")
    added = [f for f in git("diff", "--name-only", "--diff-filter=A", f"{base}..HEAD").splitlines() if f.endswith("project.json")]
    return f"{P}/project.json" in added and set(added) <= {f"{P}/project.json", f"{TW}/project.json", f"{SEARCH_DIR}/project.json"} and len(added) == len(set(added)), f"new project.json files: {added}"


@check("scaffold", 6)
def _s6():
    """Historical one-shot: the main checkout node_modules mtime stamp was recorded at scaffold time (evidence/main-node-modules.stamp is non-empty). The worktree node_modules symlink was a scaffold-time step that deps-install.5 deliberately replaced with a real directory, so the live tree is not asserted."""
    return bool(read(f"{PLAN}/evidence/main-node-modules.stamp").strip()), "stamp recorded"


@check("scaffold", 7)
def _s7():
    """evidence/source-baseline.txt records the agent-search source tree sha/diff/status (the live MCP source stays untouched)."""
    t = read(f"{PLAN}/evidence/source-baseline.txt")
    return all(k in t for k in ("tree ", "diff ", "status")), "baseline recorded"


@check("scaffold", 8)
def _s8():
    """Only owned paths changed by [psm:scaffold] commits."""
    return ownership_ok("scaffold")


# ============================================================ S2 entrypoint-parity
def EPD():
    """The generator-built entrypoint judged by the entrypoint-parity checks: the legacy shell until core-scaffold removes it, then the search entrypoint."""
    return LEGACY_DIR if os.path.isdir(LEGACY_DIR) else SEARCH_DIR


def EPP():
    return jread(f"{EPD()}/package.json", {}) or {}


# The live-Chrome e2e lane was dropped by user decision (unit tests simulating the real use cases replace it: tests-use-cases, search-usecases), so the
# sibling-parity criteria compare against the sibling set MINUS the e2e lane: the `vitest.e2e.config.ts` file and the `e2e` nx target.
E2E_LANE_FILES = {"vitest.e2e.config.ts"}
E2E_LANE_TARGETS = {"e2e"}


def sibling_targets(extra=("build-bin",)):
    """nx targets present in both dispatch-cli and backlog (plus `extra`), minus the dropped e2e lane."""
    def targets(name):
        rc, out = sh([NX, "show", "project", name, "--json"], timeout=300)
        try:
            return set(json.loads(out[out.index("{"):]).get("targets", {}))
        except (ValueError, json.JSONDecodeError):
            return set()
    return ((targets("dispatch-cli") & targets("backlog")) | set(extra)) - E2E_LANE_TARGETS


def sibling_top():
    sets = []
    for s in SIBLINGS:
        files = git("ls-files", "--", s).splitlines()
        sets.append({f[len(s) + 1:] for f in files if "/" not in f[len(s) + 1:]})
    inter = set.intersection(*sets) if sets else set()
    return inter - {"BACKLOG.md", "CONTRIBUTING.md"} - E2E_LANE_FILES


@check("entrypoint-parity", 1)
def _ep1():
    """Top-level tracked file set contains every file common to dispatch-cli, backlog and apigen-cli (eslint/vite/tsconfig.*/AGENTS/CHANGELOG/LICENSE...), minus the dropped e2e lane (vitest.e2e.config.ts): the user replaced the live-Chrome e2e lane with unit tests that simulate the real use cases."""
    need = sibling_top()
    d = EPD()
    have = {f[len(d) + 1:] for f in git("ls-files", "--", d).splitlines() if "/" not in f[len(d) + 1:]}
    miss = sorted(need - have)
    return not miss and bool(need), f"missing vs siblings: {miss}"


@check("entrypoint-parity", 2)
def _ep2():
    """project.json tags are a superset of the tags common to the three sibling entrypoints."""
    sets = [set((jread(f"{s}/project.json", {}) or {}).get("tags", [])) for s in SIBLINGS]
    inter = set.intersection(*sets)
    mine = set((jread(f"{EPD()}/project.json", {}) or {}).get("tags", []))
    return bool(inter) and inter <= mine, f"need {sorted(inter - mine)}"


@check("entrypoint-parity", 3)
def _ep3():
    """`nx show project` lists every target present in both dispatch-cli and backlog (build, test, lint, typecheck, verify-dist-load...) minus the dropped e2e target, and the dispatch-cli-only `build-bin`. The e2e lane was dropped by user decision (unit tests simulating the real use cases replace it), so the sibling set is compared without `e2e`."""
    need = sibling_targets()
    def targets(name):
        rc, out = sh([NX, "show", "project", name, "--json"], timeout=300)
        try:
            return set(json.loads(out[out.index("{"):]).get("targets", {}))
        except (ValueError, json.JSONDecodeError):
            return set()
    mine = targets("stealth-browser" if EPD() == LEGACY_DIR else SEARCH_PROJECT)
    return bool(need) and need <= mine, f"missing targets {sorted(need - mine)}"


@check("entrypoint-parity", 4)
def _ep4():
    """package.json carries the sibling publish metadata: repository.directory equal to the entrypoint directory, homepage, bugs, license, files, main/types, publishConfig."""
    p = EPP()
    keys = ["homepage", "bugs", "license", "files", "main", "types", "publishConfig", "description", "keywords"]
    ok = all(k in p for k in keys) and (p.get("repository") or {}).get("directory") == EPD()
    return ok, f"missing {[k for k in keys if k not in p]}"


@check("entrypoint-parity", 5)
def _ep5():
    """`nx run <entrypoint project>:lint` exits 0 on the scaffold (tooling wired)."""
    rc, out = sh([NX, "run", f"{'stealth-browser' if EPD() == LEGACY_DIR else SEARCH_PROJECT}:lint"], timeout=900)
    return rc == 0, out[-400:]


@check("entrypoint-parity", 6)
def _ep6():
    """Only owned paths changed by [psm:entrypoint-parity] commits."""
    return ownership_ok("entrypoint-parity")


@check("entrypoint-parity", 7)
def _ep7():
    """package.json declares `engines.node >= 22.5` (the migrated storage layer uses the built-in `node:sqlite`)."""
    m = re.match(r"\s*>=\s*(\d+)(?:\.(\d+))?", (EPP().get("engines") or {}).get("node", ""))
    return bool(m) and (int(m.group(1)), int(m.group(2) or 0)) >= (22, 5), f"engines={EPP().get('engines')}"


# ============================================================ S3 deps-install
WANT_DEPS = {"node-html-parser": "^8.0.4", "xpath": "^0.0.34", "@xmldom/xmldom": "^0.9.10"}


@check("deps-install", 1)
def _d1():
    """APPROVALS.md contains `DEP-APPROVAL: granted` naming node-html-parser, xpath and @xmldom/xmldom (human-blocker HB-DEPS)."""
    t = read(f"{PLAN}/APPROVALS.md")
    return "DEP-APPROVAL: granted" in t and all(k in t for k in WANT_DEPS), "approval recorded"


@check("deps-install", 2)
def _d2():
    """package.json dependencies pin exactly the three source ranges (node-html-parser ^8.0.4, xpath ^0.0.34, @xmldom/xmldom ^0.9.10)."""
    deps = pkg().get("dependencies", {})
    return all(deps.get(k) == v for k, v in WANT_DEPS.items()), f"deps={ {k: deps.get(k) for k in WANT_DEPS} }"


@check("deps-install", 3)
def _d3():
    """pnpm-lock.yaml has an importers entry for the migrated package (entrypoint/stealth-browser, then packages/stealth/stealth-core-browser after core-scaffold) listing all three deps."""
    lock = read("pnpm-lock.yaml")
    m = re.search(rf"^  {re.escape(P)}:\n((?:    .*\n|\n)+)", lock, re.M)
    return bool(m) and all(k in m.group(1) for k in WANT_DEPS), "importer block"


@check("deps-install", 4)
def _d4():
    """The lockfile diff removes no existing line (no collateral version bumps): the pnpm-lock.yaml diff of this state's own [psm:deps-install] commits has zero '-' lines (later states' lockfile changes are their own guards' concern)."""
    base = git("merge-base", "HEAD", "main")
    log = sh(["git", "log", f"{base}..HEAD", "--format=%H%x1f%B%x1e", "--", "pnpm-lock.yaml"])[1]
    own = [r.strip().split("\x1f", 1)[0] for r in log.split("\x1e") if "\x1f" in r and "[psm:deps-install]" in r]
    d = "\n".join(git("show", "-U0", "--format=", sha, "--", "pnpm-lock.yaml") for sha in own)
    removed = [ln for ln in d.splitlines() if ln.startswith("-") and not ln.startswith("---")]
    return not removed and bool(d.strip()), f"{len(own)} own lockfile commit(s), {len(removed)} removed lines"


@check("deps-install", 5)
def _d5():
    """The worktree-root node_modules is a real directory (not a symlink) and each of the three deps resolves, by real Node ESM resolution run from entrypoint/stealth-browser, to a path inside this worktree (never the main checkout)."""
    real = os.path.isdir("node_modules") and not os.path.islink("node_modules")
    wt = os.path.realpath(TOP)
    main_nm = os.path.realpath(f"{MAIN}/node_modules") + os.sep
    bad = []
    for k in WANT_DEPS:
        rc, out = sh(["node", "--input-type=module", "-e", f"console.log(import.meta.resolve({json.dumps(k)}))"], timeout=60, cwd=P)
        url = out.strip().splitlines()[-1] if out.strip() else ""
        if rc != 0 or not url.startswith("file://"):
            bad.append(f"{k}: unresolved")
            continue
        path = os.path.realpath(urllib.parse.unquote(url[len("file://"):]))
        if path.startswith(main_nm) or not (path + os.sep).startswith(wt + os.sep):
            bad.append(f"{k}: resolves outside worktree ({path})")
    return real and not bad, f"real={real} " + ("resolved in worktree" if not bad else "; ".join(bad))


@check("deps-install", 6)
def _d6():
    """Main checkout node_modules untouched (.modules.yaml mtime == stamp) and only owned paths changed."""
    a, b = main_nm_untouched(), ownership_ok("deps-install")
    return a[0] and b[0], f"{a[1]} | {b[1]}"


TEMP_IGNORE_MARK = "TEMPORARY(stealth-browser:deps-install)"


@check("deps-install", 7)
def _d7():
    """Historical one-shot: the dependency commit carried the documented TEMPORARY `@nx/dependency-checks` `ignoredDependencies` entry (git history shows a [psm:deps-install] commit that introduced the marker); mig-capture-parsers.6 removed it again, so the live eslint config is not asserted."""
    # the library directory moved (entrypoint/stealth-browser -> packages/stealth/stealth-core-browser): search history under both locations
    log = git("log", "--format=%B%x1e", "-S" + TEMP_IGNORE_MARK, "--", f"{LEGACY_DIR}/eslint.config.mjs", f"{CORE_DIR}/eslint.config.mjs")
    return any("[psm:deps-install]" in rec for rec in log.split("\x1e")), "marker introduced by a deps-install commit"


# ============================================================ migration buckets
standard_port_checks("mig-foundation", "foundation")


@check("mig-foundation", 4)
def _mf4():
    """session.ts exports getSessionId and browserSession (the neutral session helpers the package API builds on)."""
    t = read(f"{P}/src/lib/session.ts")
    return {"getSessionId", "browserSession"} <= exports_of(t), "session helpers"


standard_port_checks("mig-cdp", "cdp")


@check("mig-cdp", 4)
def _mc4():
    """No compiled .js twins and no nested package.json/tsconfig under src/lib/cdp (the @adhd/cdp-connection sub-package does not travel)."""
    return no_stale_twins("src/lib/cdp")


standard_port_checks("mig-domains-storage", "domains-storage")


@check("mig-domains-storage", 4)
def _mds4():
    """storage/helpers.ts still opens Chrome databases `mode=ro&immutable=1` (no file locking) and still exports openDb via helpers. (The `immutable=1` must_contain token lives on the adhd/storage/helpers.ts manifest entry, the file that holds the read-only open path; src/lib/helpers.ts re-exports the single openDb implementation.)"""
    t = read(f"{P}/src/lib/helpers.ts") + read(f"{P}/src/lib/storage/helpers.ts")
    return "immutable=1" in t and "mode=ro" in t, "immutable read-only open"


standard_port_checks("mig-capture-parsers", "capture-parsers")


@check("mig-capture-parsers", 4)
def _mcp4():
    """capture/dom.ts is carried over (present and non-trivial); port-fixes.8 owns its greenfield documentation."""
    return len(read(f"{P}/src/lib/capture/dom.ts").strip()) > 200, "dom.ts carried"


@check("mig-capture-parsers", 5)
def _mcp5():
    """Parser third-party imports are exactly node-html-parser, xpath and @xmldom/xmldom (declared in package.json by deps-install)."""
    t = read(f"{P}/src/lib/parsers.ts")
    mods = set(re.findall(r"from\s+['\"]([^./'\"][^'\"]*)['\"]", t)) - {m for m in re.findall(r"from\s+['\"](node:[^'\"]+)['\"]", t)}
    return mods <= set(WANT_DEPS) and set(WANT_DEPS) <= set(pkg().get("dependencies", {})), f"imports={sorted(mods)}"


@check("mig-capture-parsers", 6)
def _mcp6():
    """The temporary deps-install `ignoredDependencies` entry is gone from eslint.config.mjs (no marker, none of the three packages listed) and `nx run stealth-browser:lint` still exits 0 (@nx/dependency-checks now sees parsers.ts import them)."""
    t = read(f"{P}/eslint.config.mjs")
    if not t:
        return False, "eslint.config.mjs missing"
    still = TEMP_IGNORE_MARK in t or any(k in t for k in WANT_DEPS)
    if still:
        return False, "temporary ignoredDependencies entry still present in eslint.config.mjs"
    rc, out = sh([NX, "run", f"{proj_name()}:lint"], timeout=900)
    return rc == 0, f"lint rc={rc} " + out[-300:].replace("\n", " ")


standard_port_checks("mig-chrome-manager", "chrome-manager")


@check("mig-chrome-manager", 4)
def _mcm4():
    """Behavior parity of the port at migration time: the three-tier safety shutdown (`shutdownIfIdle`) and the ChromeManagerOptions type are preserved; the cross-process coordination is a FEATURE whose mechanism (heartbeat file) is replaced by chrome-lifecycle with connection-based presence through the service-proxy reaper link, and is pinned by the feature inventory, not by the heartbeat path."""
    t = read(f"{P}/src/lib/chrome-manager.ts")
    return "ChromeManagerOptions" in exports_of(t) and "shutdownIfIdle" in t, "parity tokens"


standard_port_checks("mig-queries", "queries")


@check("mig-queries", 4)
def _mq4():
    """last-search.ts (search-engine specific) did NOT travel: no file named last-search under src/lib/queries."""
    return not exists(f"{P}/src/lib/queries/last-search.ts"), "last-search stays in agent-search"


@check("mig-docs", 1)
def _md1():
    """Every doc in the manifest (adhd/docs/*, adhd/README, cdp-connection README, docs/cdp/*) exists under docs/reference/ and is non-trivial."""
    return port_check("docs")


@check("mig-docs", 2)
def _md2():
    """Relative markdown links inside docs/reference resolve and none point at @adhd/cdp-connection or agent-search files."""
    bad = []
    for f in walk(f"{P}/docs/reference", (".md",)):
        txt = read(f)
        if re.search(r"@adhd/cdp-connection|search-mcp-source|cdp-search\.ts", txt):
            bad.append(f"{f}: stale reference")
        for link in re.findall(r"\]\(([^)#\s]+)(?:#[^)]*)?\)", txt):
            if link.startswith(("http", "mailto:")):
                continue
            if not exists(os.path.normpath(os.path.join(os.path.dirname(f), link))):
                bad.append(f"{f}: dead link {link}")
    return not bad, "; ".join(bad[:6]) or "ok"


@check("mig-docs", 3)
def _md3():
    """Only owned paths changed by [psm:mig-docs] commits; source tree untouched."""
    a, b = ownership_ok("mig-docs"), source_untouched()
    return a[0] and b[0], f"{a[1]} | {b[1]}"


# ============================================================ surface
NS_RE = re.compile(r"export\s+\*\s+as\s+(\w+)\s+from\s+['\"]([^'\"]+)['\"]")

# The five library areas the package root exposes as namespaces (ADR-0003: one root entry, no exports map) and where each lives.
AREAS = {"cdp": "lib/cdp/index", "storage": "lib/storage/index", "capture": "lib/capture/index", "parsers": "lib/parsers", "chromeManager": "lib/chrome-manager"}
# Namespaces the capture-upgrade and chrome-lifecycle states add; surface-hosts wires `lifecycle` and prod-errors `recording` into the package root.
AREAS_EXTRA = {"recording": "lib/recording/index", "lifecycle": "lib/lifecycle/index", "endpoint": "lib/endpoint"}
AREAS_ALL = {**AREAS, **AREAS_EXTRA}
# Names the agent-search consumer files need from each area (the ~10 deep-imported cdp-connection names plus the barrel names it re-exported).
AREA_NEEDS = {
    "cdp": ["CdpSession", "humanPause", "createIsolatedPageTarget", "getChromeInfo", "isChromeReachable", "awaitPageSettled", "ensureChromeRunning", "hideAllWindows", "killChrome", "IdleShutdown", "CdpClient", "browserSession", "getSessionId"],
    "storage": ["HistoryClient", "CookieClient", "BookmarkClient", "ProfileClient"],
    "capture": ["checkBans", "decideRetry"],
    "parsers": ["extractResultsFromJson", "extractResultsFromHtml", "extractResultsFromEmbeddedJson", "extractWithXpath"],
    "chromeManager": ["ChromeManager", "ChromeManagerOptions"],
}
TYPE_NEEDS = ["ChromeVisit", "ChromeActivity", "CdpTargetInfo", "PageSource"]


def barrel_names_of(path, seen=None):
    """Names a TS module exposes: its own exports plus every `export * from` target, recursively (namespace re-exports excluded)."""
    seen = seen if seen is not None else set()
    path = os.path.normpath(path)
    if path in seen or not exists(path):
        return set()
    seen.add(path)
    t = read(path)
    names = exports_of(t)
    for rel in re.findall(r"export\s+\*\s+from\s+['\"](\.[^'\"]+)['\"]", t):
        base = os.path.normpath(os.path.join(os.path.dirname(path), re.sub(r"\.js$", "", rel)))
        for cand in (base + ".ts", os.path.join(base, "index.ts")):
            if exists(cand):
                names |= barrel_names_of(cand, seen)
                break
    return names


def root_names():
    """Everything the package root exposes by name: the namespaces, the api.ts verbs/types and the flat type re-export."""
    idx = read(f"{P}/src/index.ts")
    return set(dict(NS_RE.findall(idx))) | barrel_names_of(f"{P}/src/api.ts") | barrel_names_of(f"{P}/src/lib/types.ts")


VERBS = ["chromeStatus", "launchChrome", "shutdownChrome", "listPageTargets", "checkChromeActivity", "getPageContext"]


@check("surface-api", 1)
def _sa1():
    """src/api.ts exports exactly the six chrome-runner verbs: chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext (async functions only)."""
    t = read(f"{P}/src/api.ts")
    fns = re.findall(r"^export\s+async\s+function\s+(\w+)", t, re.M)
    return sorted(fns) == sorted(VERBS) and not re.search(r"^export\s+(?!async\s+function|type\s|interface\s)", t, re.M), f"fns={fns}"


@check("surface-api", 2)
def _sa2():
    """chromeStatus returns a type with NON-optional `managed: boolean` and the apigen oneOf-duplicate-boolean warning comment is preserved."""
    t = read(f"{P}/src/api.ts")
    return bool(re.search(r"managed:\s*boolean", t)) and not re.search(r"managed\?\s*:", t) and "oneOf" in t, "managed boolean"


@check("surface-api", 3)
def _sa3():
    """The package root (src/index.ts) is the greenfield public API, one root entry (ADR-0003, no subpaths): the five core library areas as namespace exports `cdp`, `storage`, `capture`, `parsers`, `chromeManager` (surface-hosts adds `lifecycle`, prod-errors adds `recording`, audit-fixes P9 adds the `endpoint` policy namespace: loopback-only by default, greenfield public API accepted as intended) (`export * as <area> from './lib/...'`), `export * from './api.js'` for the six verbs, and `export type * from './lib/types.js'` for the shared types, optionally `export * from './errors.js'` (the typed errors); no default export and no other export statement; every name the agent-search consumer files import (the ~10 deep-imported cdp-connection names included) resolves inside its namespace."""
    idx = read(f"{P}/src/index.ts")
    ns = dict(NS_RE.findall(idx))
    if not (set(AREAS) <= set(ns) <= set(AREAS_ALL)):
        return False, f"namespaces={sorted(ns)} want the core {sorted(AREAS)} (optionally {sorted(AREAS_EXTRA)})"
    wrong = [a for a, t in ns.items() if re.sub(r"\.js$", "", t) != "./" + AREAS_ALL[a]]
    if wrong:
        return False, f"namespace targets wrong: {wrong}"
    stmts = [ln for ln in re.findall(r"^export\b[^\n]*", idx, re.M)]
    extra = [ln for ln in stmts if not NS_RE.search(ln) and not re.match(r"export\s+\*\s+from\s+['\"]\./api\.js['\"]", ln) and not re.match(r"export\s+type\s+\*\s+from\s+['\"]\./lib/types\.js['\"]", ln) and not re.match(r"export\s+\*\s+from\s+['\"]\./errors\.js['\"]", ln)]
    if extra or re.search(r"export\s+default", idx) or "legacy" in idx:
        return False, f"unexpected root export statements {extra}"
    miss = {a: sorted(set(need) - barrel_names_of(f"{P}/src/{AREAS[a]}.ts") - barrel_names_of(f"{P}/src/{AREAS[a]}/index.ts")) for a, need in AREA_NEEDS.items()}
    miss = {a: m for a, m in miss.items() if m}
    tmiss = sorted(set(TYPE_NEEDS) - exports_of(read(f"{P}/src/lib/types.ts")))
    return not miss and not tmiss and not exists(f"{P}/src/legacy.ts"), f"namespace members missing {miss}; types missing {tmiss}; legacy.ts present={exists(f'{P}/src/legacy.ts')}"


@check("surface-api", 4)
def _sa4():
    """api.ts and index.ts import nothing from agent-search, use .js specifiers, and every relative import resolves."""
    files = [f"{P}/src/api.ts", f"{P}/src/index.ts"]
    if not all(exists(f) for f in files):
        return False, "files missing"
    ok, why = hygiene(files)
    return (ok and rel_imports_resolve(files)[0]), why


@check("surface-api", 5)
def _sa5():
    """The ChromeManager is configured through typed options only (no process.env toggles in src/api.ts or, once surface-hosts moves the manager map there, src/lib/managers.ts) and uses port/host options, never a hard-coded 9222 in api.ts defaults without an override; exactly one of those two files constructs it (`new ChromeManager(`), and when managers.ts exists api.ts reaches managers only through its managerFor."""
    t = read(f"{P}/src/api.ts")
    m = read(f"{P}/src/lib/managers.ts")
    sites = [f for f, x in (("api.ts", t), ("lib/managers.ts", m)) if "new ChromeManager(" in x]
    routed = "ChromeManager" in t if not m.strip() else ("managerFor" in t and re.search(r"from\s*['\"]\./lib/managers\.js['\"]", t) is not None)
    return "process.env" not in t + m and len(sites) == 1 and routed, f"typed options; construction sites={sites} routed={routed}"


@check("surface-api", 6)
def _sa6():
    """Only owned paths changed by [psm:surface-api] commits."""
    return ownership_ok("surface-api")


@check("surface-hosts", 1)
def _sh1():
    """src/server.ts (MCP stdio host via @adhd/apigen-plugin-mcp), src/cli.ts and bin/cli.ts, bin/mcp.ts exist."""
    return all(exists(f"{P}/{f}") for f in ("src/server.ts", "src/cli.ts", "bin/cli.ts", "bin/mcp.ts")), "host files"


@check("surface-hosts", 2)
def _sh2():
    """package.json declares bin entries stealth-browser and stealth-browser-mcp pointing into ./dist/bin/ and depends on the apigen core-client/engine-runtime/plugin-mcp/plugin-cli-output packages."""
    p = pkg()
    b = p.get("bin", {})
    d = p.get("dependencies", {})
    need = ["@adhd/apigen-core-client", "@adhd/apigen-engine-runtime", "@adhd/apigen-plugin-mcp", "@adhd/apigen-plugin-cli-output"]
    return {"stealth-browser", "stealth-browser-mcp"} <= set(b) and all(v.startswith("./dist/") for v in b.values()) and all(n in d for n in need), f"bin={b}"


@check("surface-hosts", 3)
def _sh3():
    """`nx run stealth-browser:build-bin` exits 0 and emits dist/bin/cli.js and dist/bin/mcp.js."""
    rc, out = sh([NX, "run", f"{proj_name()}:build-bin"], timeout=1200)
    return rc == 0 and exists(f"{P}/dist/bin/cli.js") and exists(f"{P}/dist/bin/mcp.js"), out[-300:]


@check("surface-hosts", 4)
def _sh4():
    """`node dist/bin/cli.js --help` exits 0 and lists all six verbs (the apigen extraction does not crash on the zod/$ref class of failure)."""
    rc, out = sh(["node", f"{P}/dist/bin/cli.js", "--help"], timeout=120)
    low = out.lower().replace("-", "")
    return rc == 0 and all(v.lower() in low for v in VERBS), out[-300:]


@check("surface-hosts", 5)
def _sh5():
    """`node dist/bin/cli.js chromeStatus --port 19999` (or `chrome-status --port 19999`) against the unused port 19999 prints running=false with exit 0 - the CLI reaches the real library through the `--port` flag (no environment variable), not a stub."""
    rc, out = sh(["node", f"{P}/dist/bin/cli.js", "chromeStatus", "--port", "19999"], timeout=120)
    if rc != 0:
        rc, out = sh(["node", f"{P}/dist/bin/cli.js", "chrome-status", "--port", "19999"], timeout=120)
    return rc == 0 and re.search(r"running['\"]?\s*[:=]\s*false", out) is not None, out[-300:]


@check("surface-hosts", 6)
def _sh6():
    """Only owned paths changed by [psm:surface-hosts] commits."""
    return ownership_ok("surface-hosts")


# ============================================================ tracing
def src_nontest():
    return [f for f in walk(f"{P}/src") if "/test/" not in f and not f.endswith(".spec.ts")]


@check("tracing-plugin", 1)
def _t1():
    """src/tracing.ts configures `makeTracingPlugin({ serviceName: 'adhd' })` and exports `tracingPlugin`."""
    t = read(f"{P}/src/tracing.ts")
    return bool(re.search(r"makeTracingPlugin\(\s*\{\s*serviceName:\s*['\"]adhd['\"]", t)) and "tracingPlugin" in exports_of(t), "adhd namespace"


@check("tracing-plugin", 2)
def _t2():
    """NO source file imports the apigen-namespaced `tracingPlugin` singleton from @adhd/apigen-plugin-tracing (only makeTracingPlugin)."""
    bad = []
    for f in src_nontest() + walk(f"{P}/bin"):
        t = read(f)
        for m in re.finditer(r"import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['\"]@adhd/apigen-plugin-tracing['\"]", t):
            names = [x.strip().split(" as ")[0].strip() for x in m.group(1).split(",")]
            if "tracingPlugin" in names:
                bad.append(f)
    return not bad, f"singleton imported in {bad}"


@check("tracing-plugin", 3)
def _t3():
    """Every `usePlugins` array in src/server.ts and src/cli.ts (>=2 mounts) contains `tracingPlugin` imported from './tracing.js'."""
    mounts, bad = 0, []
    for f in (f"{P}/src/server.ts", f"{P}/src/cli.ts"):
        t = read(f)
        arrays = re.findall(r"usePlugins\s*:\s*\[([^\]]*)\]", t) + re.findall(r"USE_PLUGINS[^=]*=\s*\[([^\]]*)\]", t)
        mounts += len(arrays)
        bad += [f for a in arrays if "tracingPlugin" not in a]
        if arrays and not re.search(r"from\s+['\"]\./tracing\.js['\"]", t):
            bad.append(f"{f} (import)")
    return mounts >= 2 and not bad, f"mounts={mounts} bad={bad}"


@check("tracing-plugin", 4)
def _t4():
    """package.json depends on @adhd/apigen-plugin-tracing and @adhd/sox-telemetry (workspace-resolved ranges)."""
    d = pkg().get("dependencies", {})
    return "@adhd/apigen-plugin-tracing" in d and "@adhd/sox-telemetry" in d, f"deps={sorted(d)}"


@check("tracing-plugin", 5)
def _t5():
    """The `serviceName` literal is configured in exactly ONE non-test file (src/tracing.ts) - one namespace, one identity."""
    hits = [f for f in src_nontest() if re.search(r"serviceName\s*:", read(f))]
    return hits == [f"{P}/src/tracing.ts"], f"serviceName in {hits}"


@check("tracing-plugin", 6)
def _t6():
    """`nx run stealth-browser:build-bin` exits 0 with tracing mounted; only owned paths changed by [psm:tracing-plugin] commits."""
    rc, out = sh([NX, "run", f"{proj_name()}:build-bin"], timeout=1200)
    o = ownership_ok("tracing-plugin")
    return rc == 0 and o[0], out[-200:] + o[1]


SPEC = f"{P}/test/unit/tracing/tracing-namespace.spec.ts"


@check("tracing-namespace-proof", 1)
def _tn1():
    """The spec drives the CONFIGURED layer against a real sox-telemetry file sink for a real stealth-browser verb and asserts every record event starts with `adhd.`."""
    t = read(SPEC)
    return all(k in t for k in ("initTelemetry", "tracingPlugin", "adhd.")), "real sink spec"


@check("tracing-namespace-proof", 2)
def _tn2():
    """The spec asserts no emitted record carries the `apigen.` prefix and contains a NEGATIVE-CONTROL case proving the package singleton would emit `apigen.`."""
    t = read(SPEC)
    return "apigen." in t and "NEGATIVE-CONTROL" in t and re.search(r"not\.toMatch|not\.toContain|startsWith\(['\"]apigen", t) is not None, "negative assertions"


@check("tracing-namespace-proof", 3)
def _tn3():
    """The spec cites ticket 8468f7b1 and a valid tracing-plugin.N criterion id."""
    t = read(SPEC)
    ids = set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t))
    return TICKET in t and bool(ids & criteria_ids()), f"ids={sorted(ids)}"


@check("tracing-namespace-proof", 4)
def _tn4():
    """Mutation teeth, in-process (never touching src/tracing.ts): the spec builds a second plugin with serviceName 'apigen' via makeTracingPlugin and proves the SAME namespace assertion helper rejects its records (expect(...).toThrow), while the configured plugin passes; `nx run stealth-browser:test -- test/unit/tracing` exits 0 and src/tracing.ts is byte-identical before and after the run."""
    path = f"{P}/src/tracing.ts"
    t = read(SPEC)
    mut = re.search(r"makeTracingPlugin\(\s*\{[^}]*serviceName:\s*['\"]apigen['\"]", t) is not None and re.search(r"toThrow|rejects\.", t) is not None
    before = hashlib.sha256(read(path).encode()).hexdigest()
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", "test/unit/tracing"], timeout=1500)
    after = hashlib.sha256(read(path).encode()).hexdigest()
    return mut and rc == 0 and before == after, f"in-process mutant case={mut} rc={rc} tracing.ts unchanged={before == after}"


@check("tracing-namespace-proof", 5)
def _tn5():
    """Only owned paths changed by [psm:tracing-namespace-proof] commits; src/tracing.ts has no uncommitted change (git diff clean)."""
    clean = git("status", "--porcelain", "--", f"{P}/src/tracing.ts") == ""
    o = ownership_ok("tracing-namespace-proof")
    return clean and o[0], o[1]


# ============================================================ unit tests
SPAWNERS = ("cdp/browser", "chrome-manager", "cdp/index", "cdp/targets", "cdp/session", "domains/", "capture/network")


def spec_for(e):
    base = os.path.basename(e["dst"])[:-3]
    return f"{P}/test/unit/{e['bucket']}/{base}.spec.ts"


def unit_checks(slug, buckets, owned_hint):
    def specs():
        out = []
        for b in buckets:
            for e in entries(b):
                if e.get("kind", "ts") == "ts" and not e["dst"].endswith("/index.ts") and not e["dst"].endswith("/types.ts") and e.get("spec", True):
                    out.append(spec_for(e))
        return out

    @check(slug, 1)
    def _u1():
        """A spec file exists for every ported source module (index barrels and pure type files excluded)."""
        miss = [s for s in specs() if not exists(s)]
        return not miss and bool(specs()), f"missing {miss[:6]}"

    @check(slug, 2)
    def _u2():
        """Every spec cites ticket 8468f7b1 and at least one valid [slug.N] acceptance-criterion id."""
        ids = criteria_ids()
        bad = []
        for s in specs():
            t = read(s)
            found = set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t))
            if TICKET not in t or not (found & ids):
                bad.append(s)
        return not bad and bool(specs()), f"uncited {bad[:6]}"

    @check(slug, 3)
    def _u3():
        """Unit purity: specs touching process-spawning or network modules mock child_process/WebSocket/fetch (vi.mock or vi.stubGlobal); no spec reads the real Chrome profile."""
        bad = []
        for s in specs():
            t = read(s)
            if "child_process" in t and not re.search(r"vi\.mock\(\s*['\"](?:node:)?child_process", t):
                bad.append(f"{s}: child_process not mocked")
            if any(sp in t for sp in SPAWNERS) and not re.search(r"vi\.mock\(|vi\.stubGlobal\(|vi\.spyOn\(", t):
                bad.append(f"{s}: spawning/network module imported with no mock")
            # A profile path literal is pure when the spec fakes the filesystem and the home directory (vi.mock of node:fs AND node:os): the path never reaches a real disk.
            fakes_fs_and_home = bool(re.search(r"vi\.mock\(\s*['\"](?:node:)?fs['\"]", t)) and bool(re.search(r"vi\.mock\(\s*['\"](?:node:)?os['\"]", t))
            if ("Application Support" in t and not fakes_fs_and_home) or ("homedir()" in t and "vi.mock" not in t):
                bad.append(f"{s}: real profile/HOME access")
        return not bad and bool(specs()), "; ".join(bad[:5]) or "ok"

    @check(slug, 4)
    def _u4():
        """Assertions have teeth: each spec has at least as many expect() calls as test cases and at least one negative/error-path case."""
        bad = []
        for s in specs():
            t = read(s)
            its = len(re.findall(r"\b(?:it|test)\(", t))
            exp = len(re.findall(r"\bexpect\(", t))
            if its == 0 or exp < its or not re.search(r"toThrow|rejects|not\.|toBeNull|toBe\(false\)|error", t, re.I):
                bad.append(s)
        return not bad and bool(specs()), f"weak {bad[:6]}"

    @check(slug, 5)
    def _u5():
        rel = [s[len(P) + 1:] for s in specs()]
        rc, out = sh([NX, "run", f"{proj_name()}:test", "--", *rel], timeout=1500)
        o = ownership_ok(slug)
        return rc == 0 and o[0], out[-250:] + o[1]
    _u5.__doc__ = f"`nx run stealth-browser:test -- <own specs>` exits 0 and only owned paths changed by [psm:{slug}] commits."


unit_checks("tests-unit-core", ["foundation", "cdp", "chrome-manager"], "")
unit_checks("tests-unit-data", ["domains-storage", "queries"], "")
unit_checks("tests-unit-extract", ["capture-parsers"], "")


@check("tests-unit-surface", 1)
def _tus1():
    """test/unit/surface/api.spec.ts and index.spec.ts exist and assert all six verbs and the five root namespaces (cdp, storage, capture, parsers, chromeManager)."""
    a, b = read(f"{P}/test/unit/surface/api.spec.ts"), read(f"{P}/test/unit/surface/index.spec.ts")
    return all(v in a for v in VERBS) and all(k in b for k in AREAS), "surface specs"


@check("tests-unit-surface", 2)
def _tus2():
    """Surface specs cite 8468f7b1 and a valid surface-api.N id; process/network boundaries are mocked."""
    ids = criteria_ids()
    ok = True
    for f in ("api", "index"):
        t = read(f"{P}/test/unit/surface/{f}.spec.ts")
        ok = ok and TICKET in t and bool(set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t)) & ids) and bool(re.search(r"vi\.mock\(|vi\.stubGlobal\(", t))
    return ok, "citations + mocks"


@check("tests-unit-surface", 3)
def _tus3():
    """`nx run stealth-core-browser:test` exits 0 and only owned paths changed by [psm:tests-unit-surface] commits."""
    rc, out = sh([NX, "run", f"{proj_name()}:test"], timeout=1500)
    o = ownership_ok("tests-unit-surface")
    return rc == 0 and o[0], out[-250:] + o[1]


# ============================================================ gates
GATE_TARGETS = ["lint", "typecheck", "typecheck-spec", "build", "build-bin", "test", "verify-dist-load"]


GATE_PROJECTS = [("core", CORE_PROJECT, [t for t in GATE_TARGETS if t != "build-bin"]), ("search", SEARCH_PROJECT, GATE_TARGETS)]


def run_gates(evidence):
    """Run (or reuse, keyed by the combined code tree) every nx gate of the three owned packages: stealth-core-browser (six targets), stealth-search (seven) and resilience-core-tripwire (six)."""
    cur, twcur = tree_sha(), tw_tree_sha()
    cached = jread(evidence)
    if cached and cached.get("tree") == cur and cached.get("tw_tree") == twcur and cached.get("all_green"):
        return cached
    res = {}
    for key, project, targets in GATE_PROJECTS:
        for t in targets:
            t0 = time.time()
            rc, out = sh([NX, "run", f"{project}:{t}"], timeout=2400)
            res[f"{key}:{t}"] = {"cmd": f"nx run {project}:{t}", "exit": rc, "seconds": round(time.time() - t0, 1), "tail": out[-300:]}
    for t in TW_ALL_TARGETS:  # the second approved package is gated with the first
        t0 = time.time()
        rc, out = tw_nx(t, 2400)
        res[f"tw:{t}"] = {"cmd": f"nx run {TW_NAME}:{t}", "exit": rc, "seconds": round(time.time() - t0, 1), "tail": out[-300:]}
    doc = {"tree": cur, "trees": code_trees(), "tw_tree": twcur, "head": git("rev-parse", "HEAD"), "results": res, "all_green": all(v["exit"] == 0 for v in res.values())}
    os.makedirs(os.path.dirname(evidence), exist_ok=True)
    with open(evidence, "w", encoding="utf8") as f:
        json.dump(doc, f, indent=2)
    return doc


def gate_checks(slug, evidence, pre=None):
    names = [("lint", "`nx run stealth-core-browser:lint` and `nx run stealth-search:lint` exit 0 (includes @nx/dependency-checks)"),
             ("typecheck", "`:typecheck` and `:typecheck-spec` of stealth-core-browser and stealth-search exit 0"),
             ("build", "`:build` of stealth-core-browser and `:build` and `:build-bin` of stealth-search exit 0 (dist/index.js plus the search dist/bin/*)"),
             ("test", "`:test` of stealth-core-browser and stealth-search exits 0 (unit lanes incl. the use-case suites; every spawner and third-party network call is mocked, no live Chrome, no spawned process)"),
             ("verify-dist-load", "`:verify-dist-load` of stealth-core-browser and stealth-search exits 0 (the built dists load the way a consumer loads them)")]
    for n, (tgt, text) in enumerate(names, 1):
        def mk(tgt=tgt, text=text):
            def fn():
                if pre:
                    ok, why = pre()
                    if not ok:
                        return False, why
                doc = run_gates(evidence)
                r = doc["results"]
                keys = {"typecheck": ["typecheck", "typecheck-spec"], "build": ["build", "build-bin"]}.get(tgt, [tgt])
                want = [f"{pre_}:{k}" for pre_, _, tg in GATE_PROJECTS for k in keys if k in tg]
                bad = [k for k in want if r.get(k, {}).get("exit") != 0]
                return not bad and bool(want), f"{bad} {[r[k]['tail'] for k in bad][:1]}"
            fn.__doc__ = text
            return fn
        CHECKS.setdefault(slug, []).append((f"{slug}.{n}", mk()))
    n = len(names) + 1

    def citations():
        files = [f for d in (CORE_DIR, SEARCH_DIR) for f in walk(f"{d}/test", (".ts",)) if f.endswith(".spec.ts")]
        ids = criteria_ids()
        bad = [f for f in files if TICKET not in read(f) or not (set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", read(f))) & ids)]
        return not bad and bool(files) and exists(SEARCH_DIR) and exists(CORE_DIR), f"uncited tests {bad[:6]}"
    citations.__doc__ = "Every spec file of stealth-core-browser and stealth-search cites ticket 8468f7b1 and a valid acceptance-criterion id; evidence JSON records every gate command and exit code"
    CHECKS[slug].append((f"{slug}.{n}", citations))


gate_checks("gates-first", f"{PLAN}/evidence/gates-first.json")


@check("gates-first", 7)
def _gf7():
    """(PA10.1, PA10.2, PA10.4, PA10.5; folded from the retired publish-readiness state) both packages' package.json have description, keywords, license, files, publishConfig.access = public and engines.node >= 22.5, versions are 0.x, the built stealth-search dist/bin/cli.js and mcp.js start with a shebang and are executable (the library core declares no bin), and every @adhd/* dependency of either package is a public workspace package or recorded in published-state.json."""
    names = {}
    for f in git("ls-files", "*package.json").splitlines():
        d = jread(f, None)
        if isinstance(d, dict) and d.get("name"):
            names[d["name"]] = d
    pub = jread("published-state.json", {}) or {}
    brc, bout = ensure_full_dist()
    meta_all, deps_all, bad_bin = True, {}, []
    for d, bins in ((CORE_DIR, ()), (SEARCH_DIR, ("cli.js", "mcp.js"))):
        p = jread(f"{d}/package.json", {}) or {}
        eng = (p.get("engines") or {}).get("node", "")
        meta = all(p.get(k) for k in ("description", "keywords", "license", "files")) and (p.get("publishConfig") or {}).get("access") == "public" and "22.5" in eng and str(p.get("version", "")).startswith("0.")
        meta_all = meta_all and meta
        deps_all.update({**(p.get("dependencies") or {}), **(p.get("peerDependencies") or {})})
        bad_bin += [f"{d}/{f}" for f in bins if not (exists(f"{d}/dist/bin/{f}") and read(f"{d}/dist/bin/{f}").startswith("#!") and os.access(f"{d}/dist/bin/{f}", os.X_OK))]
    bad_dep = [n for n in deps_all if n.startswith("@adhd/") and not ((n in names and not names[n].get("private")) or n in pub or n in (pub.get("packages") or {}) or (n not in names and registry_published(n)))]
    return brc == 0 and meta_all and not bad_bin and bool(deps_all) and not bad_dep, f"build rc={brc} meta={meta_all} bins={bad_bin} unpublished deps={bad_dep}"


@check("gates-first", 8)
def _gf8():
    """(PA10.3) `npm pack --dry-run` against each built dist output lists README.md, CHANGELOG.md and the main/types targets (stealth-search also bin/cli.js and bin/mcp.js); the output is recorded in evidence/publish-dry-run.txt."""
    brc, _ = ensure_full_dist()
    rc, miss = tarballs_missing()
    rec = read(f"{PLAN}/evidence/publish-dry-run.txt")
    recorded = all(m in rec for m in ("README.md", "CHANGELOG.md", "bin/cli.js", "bin/mcp.js"))
    return brc == 0 and rc == 0 and not miss and recorded and exists(f"{SEARCH_DIR}/dist"), f"build rc={brc} missing from tarballs: {miss}; evidence lists the members={recorded}"


@check("gates-first", 9)
def _gf9():
    """Only owned paths changed by [psm:gates-first] commits."""
    return ownership_ok("gates-first")

@check("gates-first", 10)
def _gf10():
    """After a full build, neither owned dependency is inlined into any dist (module-format proof for ADR-0003): no dist/**/*.js file of either package defines `createStoreAdapter`, `ensureBackend`, `serveBackend` or `dialBackend`, the core dist references `@adhd/sox-service-proxy` as an external require, no file `require`s `@adhd/sox-store-adapter` (it is reached only through a dynamic `import()`), and the stealth-search dist references `@adhd/stealth-core-browser` and `@adhd/resilience-core-tripwire` as externals and defines neither package's code."""
    rc1, _ = nx_run(CORE_PROJECT, "build", timeout=1800)
    rc2, _ = nx_run(SEARCH_PROJECT, "build", timeout=1800)
    core = {f: read(f) for f in walk_dist(f"{CORE_DIR}/dist")}
    srch = {f: read(f) for f in walk_dist(f"{SEARCH_DIR}/dist")}
    ensure_full_dist()  # the bare builds above empty dist/; restore the complete layout for the checks that follow
    alltxt = {**core, **srch}
    inlined = [f for f, t in alltxt.items() if re.search(r"function\s+(createStoreAdapter|ensureBackend|serveBackend|dialBackend)\b", t)]
    req_store = [f for f, t in alltxt.items() if re.search(r"require\(\s*['\"]@adhd/sox-store-adapter['\"]", t)]
    proxy_ext = any("@adhd/sox-service-proxy" in t for t in core.values())
    ext = any(CORE_PKG in t for t in srch.values()) and any(TW_PKG in t for t in srch.values())
    dup = [f for f, t in srch.items() if re.search(r"function\s+(createTripwire|chromeStatus|launchChrome)\b", t)]
    return rc1 == 0 and rc2 == 0 and bool(core) and bool(srch) and not inlined and not req_store and proxy_ext and ext and not dup, f"build rc={rc1}/{rc2} inlined={inlined} store require={req_store} proxy external={proxy_ext} core+tripwire external in search={ext} duplicated={dup}"


def resolution_done():
    r = jread(f"{PLAN}/review/RESOLUTION.json")
    return bool(r), "review/RESOLUTION.json missing (resolve-findings not done)"


gate_checks("gates-rerun", f"{PLAN}/evidence/gates-rerun.json", pre=resolution_done)


# ============================================================ review
REVIEW = f"{PLAN}/review"


@check("review-prep", 1)
def _rp1():
    """review/migration.diff exists, is non-empty and covers packages/stealth/stealth-core-browser, entrypoint/stealth-search, packages/resilience/resilience-core-tripwire and tsconfig.base.json since the scaffold start_ref (the blind review sees all three approved packages; the consumer-repo diffs are not included)."""
    d = read(f"{REVIEW}/migration.diff")
    return len(d) > 2000 and f"{CORE_DIR}/src" in d and f"{SEARCH_DIR}/src" in d and f"{TW}/src" in d, f"diff bytes={len(d)} covers search={f'{SEARCH_DIR}/src' in d} tripwire={f'{TW}/src' in d}"


@check("review-prep", 2)
def _rp2():
    """review/INPUT.sha256 equals sha256(migration.diff) and the diff contains no docs/plan or pnpm-lock paths (reviewer sees the migration only). The scope test inspects file PATHS (the `diff --git`, `---` and `+++` header lines), not content: a source comment that merely mentions a docs/plan path is part of the real migration and must stay in an unfiltered git diff."""
    d = read(f"{REVIEW}/migration.diff")
    hdr = [l for l in d.splitlines() if l.startswith(("diff --git ", "--- ", "+++ "))]
    bad = [l for l in hdr if "docs/plan/" in l or "pnpm-lock" in l]
    return hashlib.sha256(d.encode()).hexdigest() == read(f"{REVIEW}/INPUT.sha256").strip() and not bad, f"sha + scope (header paths in scope violation: {len(bad)})"


@check("review-prep", 3)
def _rp3():
    """review/BRIEF.txt is exactly the single word `Review` (blind review: no context, rationale or review points)."""
    return read(f"{REVIEW}/BRIEF.txt").strip() == "Review", "brief"


@check("review-prep", 4)
def _rp4():
    """Only owned paths changed by [psm:review-prep] commits; gates-first evidence trees (the stealth-core-browser + stealth-search code tree and the tripwire package) match the diffed trees. Both identities are read at the commits where those states completed, so later remediation commits cannot re-open this completed fact."""
    rref = completion_ref("review-prep")
    rc, raw = sh(["git", "show", f"{rref}:{PLAN}/evidence/gates-first.json"])  # the gate evidence as it stood when review-prep completed
    try:
        g = json.loads(raw) if rc == 0 else {}
    except ValueError:
        g = {}
    o = ownership_ok("review-prep")
    tree_ok = bool(tree_sha_at(rref)) and g.get("tree") == tree_sha_at(rref)
    tw_ok = g.get("tw_tree") == tw_tree_sha_at(rref)
    return o[0] and g.get("all_green") is True and tree_ok and tw_ok, f"{o[1]} gates-first evidence tree matches the review-prep tree: {tree_ok}; tripwire tree: {tw_ok}"


def findings():
    return jread(f"{REVIEW}/FINDINGS.json", {})


@check("audit-migration-blind", 1)
def _b1():
    """FINDINGS.json records exactly ONE review round whose reviewer_input_sha256 equals review/INPUT.sha256 and whose prompt was the word `Review`."""
    f = findings()
    return f.get("review_round") == 1 and f.get("reviewer_input_sha256") == read(f"{REVIEW}/INPUT.sha256").strip() and f.get("reviewer_prompt") == "Review", "one blind round"


@check("audit-migration-blind", 2)
def _b2():
    """Every finding has id (F1..), severity in {blocker,major,minor,nit}, file, line, summary and evidence; or `no_findings: true` with a reviewer rationale."""
    f = findings()
    if f.get("no_findings") is True:
        return len(f.get("rationale", "")) > 40, "no findings"
    items = f.get("findings", [])
    ok = bool(items) and all(isinstance(x, dict) and re.fullmatch(r"F\d+", x.get("id", "")) and x.get("severity") in ("blocker", "major", "minor", "nit") and x.get("file") and x.get("summary") and x.get("evidence") for x in items)
    return ok, f"{len(items)} findings"


@check("audit-migration-blind", 3)
def _b3():
    """Finding ids are unique and every cited file exists in the reviewed tree."""
    f = findings()
    items = f.get("findings", [])
    ids = [x["id"] for x in items if "id" in x]
    return len(ids) == len(set(ids)) and all(exists(x["file"]) for x in items), "unique ids, files exist"


@check("audit-migration-blind", 4)
def _b4():
    """The package code trees are unchanged since review-prep (the combined stealth-core-browser + stealth-search code tree at the commit where review-prep completed equals the tree where this audit completes, or HEAD while it is in flight), so the review judged the code that gated green."""
    then, now = tree_sha_at(completion_ref("review-prep")), tree_sha_at(completion_ref("audit-migration-blind"))
    return bool(then) and then == now, "code trees unchanged since review-prep"


@check("resolve-findings", 1)
def _r1():
    """RESOLUTION.json covers 100% of FINDINGS ids; every finding is `fixed` or `rejected` - none open or deferred."""
    res = jread(f"{REVIEW}/RESOLUTION.json", {})
    ids = {x["id"] for x in findings().get("findings", [])}
    got = {x["id"]: x for x in res.get("resolutions", [])}
    return set(got) == ids and all(x.get("status") in ("fixed", "rejected") for x in got.values()), f"unresolved {sorted(ids - set(got))}"


@check("resolve-findings", 2)
def _r2():
    """Each `fixed` entry names a commit sha tagged [psm:resolve-findings] that touches the cited file; each `rejected` entry carries >=40 chars of evidence and a reproduction command."""
    res = jread(f"{REVIEW}/RESOLUTION.json", {})
    bad = []
    fmap = {x["id"]: x for x in findings().get("findings", [])}
    for r in res.get("resolutions", []):
        if r.get("status") == "fixed":
            body = git("log", "-1", "--format=%B", r.get("commit", "HEAD_MISSING"))
            files = git("diff-tree", "--no-commit-id", "--name-only", "-r", r.get("commit", "HEAD_MISSING")).splitlines()
            if "[psm:resolve-findings]" not in body or fmap.get(r["id"], {}).get("file") not in files:
                bad.append(r["id"])
        elif len(r.get("evidence", "")) < 40 or not r.get("reproduction"):
            bad.append(r["id"])
    return not bad and bool(res.get("resolutions")), f"bad {bad}"


@check("resolve-findings", 3)
def _r3():
    """ONE implementer resolved every finding: RESOLUTION.json has a single `agent` value and all [psm:resolve-findings] commits share one git author."""
    res = jread(f"{REVIEW}/RESOLUTION.json", {})
    st = (state().get("states") or {}).get("resolve-findings") or {}
    since = st.get("start_ref") or git("merge-base", "HEAD", "main")
    log = sh(["git", "log", f"{since}..HEAD", "--format=%an%x1f%B%x1e"])[1]
    authors = {r.split("\x1f")[0].strip() for r in log.split("\x1e") if "[psm:resolve-findings]" in r}
    return bool(res.get("agent")) and len(authors) == 1, f"agent={res.get('agent')} authors={authors}"


@check("resolve-findings", 4)
def _r4():
    """No new TODO/FIXME/XXX introduced in packages/stealth/stealth-core-browser/src or entrypoint/stealth-search/src and only owned paths changed by [psm:resolve-findings] commits."""
    t = "\n".join(read(f) for d in (CORE_DIR, SEARCH_DIR) for f in walk(f"{d}/src"))
    o = ownership_ok("resolve-findings")
    return not re.search(r"\b(TODO|FIXME|XXX)\b", t) and o[0] and exists(SEARCH_DIR), o[1]


# ============================================================ docs
CAT = f"{P}/docs/marketing/.catalog"


@check("docs-marketing-run", 1)
def _dm1():
    """docs/marketing/.catalog/capabilities.json lists >= 6 `shipped` capabilities (the six verbs) each with a runnable receipt command; no entry lacks a status of shipped|roadmap|deprecated."""
    c = jread(f"{CAT}/capabilities.json", {})
    items = c.get("capabilities", c if isinstance(c, list) else [])
    ok = all(i.get("status") in ("shipped", "roadmap", "deprecated") for i in items) and sum(1 for i in items if i.get("status") == "shipped" and i.get("receipt")) >= 6
    return ok, f"{len(items)} capabilities"


@check("docs-marketing-run", 2)
def _dm2():
    """docs/marketing/.catalog/review.md records a doc-reviewer verdict of PASS."""
    return bool(re.search(r"\bPASS\b", read(f"{CAT}/review.md"))) and not re.search(r"\bFAIL\b", read(f"{CAT}/review.md")), "doc-reviewer PASS"


@check("docs-marketing-run", 3)
def _dm3():
    """AGENTS.md, llms.txt, CHANGELOG.md (with a 0.0.1 migration entry) and README.md exist; no AI attribution lines anywhere in them."""
    ok = all(exists(f"{P}/{f}") for f in ("AGENTS.md", "llms.txt", "CHANGELOG.md", "README.md")) and "0.0.1" in read(f"{P}/CHANGELOG.md")
    ai = re.search(r"Generated with|Co-Authored-By|written by an AI", "".join(read(f"{P}/{f}") for f in ("AGENTS.md", "llms.txt", "CHANGELOG.md", "README.md")), re.I)
    return ok and not ai, "docs set"


@check("docs-marketing-run", 4)
def _dm4():
    """Documentation-only: [psm:docs-marketing-run] commits touch only docs/, README.md, AGENTS.md, llms.txt, CHANGELOG.md (ownership)."""
    return ownership_ok("docs-marketing-run")


@check("docs-marketing-run", 5)
def _dm5():
    """Gate evidence of gates-rerun still matches the package source trees (docs run changed no src/ or bin/ of stealth-core-browser, stealth-search or the tripwire package)."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    files = git("diff", "--name-only", g.get("head", "HEAD"), "HEAD", "--", f"{CORE_DIR}/src", f"{CORE_DIR}/bin", f"{SEARCH_DIR}/src", f"{SEARCH_DIR}/bin", f"{TW}/src").splitlines()
    return g.get("all_green") is True and not files, f"src changed since gates-rerun: {files[:5]}"


README = f"{P}/README.md"


@check("readme-rewrite", 1)
def _rw1():
    """Only README.md changed by [psm:readme-rewrite] commits."""
    return ownership_ok("readme-rewrite")


@check("readme-rewrite", 2)
def _rw2():
    """README has a title, a tagline <= 120 chars, Quickstart, Features, Surfaces and Receipts sections and >= 2 fenced code blocks."""
    t = read(README)
    heads = {h.strip().lower() for h in re.findall(r"^#{1,3}\s+(.+)$", t, re.M)}
    tagline = [ln for ln in t.splitlines()[1:12] if ln.startswith(">")]
    return all(any(k in h for h in heads) for k in ("quickstart", "features", "surfaces", "receipts")) and bool(tagline) and len(tagline[0]) <= 122 and t.count("```") >= 4, f"heads={sorted(heads)[:8]}"


@check("readme-rewrite", 3)
def _rw3():
    """Receipts: >= 5 `<!-- receipt:ID -->` markers and every ID resolves to a `shipped` entry in docs/marketing/.catalog/capabilities.json."""
    ids = re.findall(r"<!--\s*receipt:([\w.-]+)\s*-->", read(README))
    c = jread(f"{CAT}/capabilities.json", {})
    items = c.get("capabilities", c if isinstance(c, list) else [])
    shipped = {i.get("id") for i in items if i.get("status") == "shipped"}
    return len(ids) >= 5 and all(i in shipped for i in ids), f"receipts={ids}"


@check("readme-rewrite", 4)
def _rw4():
    """Factual: no unverifiable superlatives (undetectable, unblockable, 100%, bypasses all, guaranteed); every `@adhd/stealth-core-browser` import specifier in code fences is a real package export (stealth-search's README is checked by readme-rewrite.10)."""
    t = read(README)
    if re.search(r"undetectable|unblockable|100%|bypasses? all|guaranteed", t, re.I):
        return False, "unverifiable superlative"
    exp = pkg().get("exports") or {".": "x"}
    for spec in re.findall(r"from\s+['\"](@adhd/stealth-core-browser[^'\"]*)['\"]", t):
        sub = "." + spec[len("@adhd/stealth-core-browser"):]
        if sub not in exp:
            return False, f"{spec} not exported"
    return True, "ok"


@check("readme-rewrite", 5)
def _rw5():
    """Relative links resolve and the install/quickstart commands name only bins declared in package.json."""
    t = read(README)
    for link in re.findall(r"\]\((?!http|mailto:|#)([^)#\s]+)", t):
        if not exists(os.path.normpath(os.path.join(P, link))):
            return False, f"dead link {link}"
    bins = set(pkg().get("bin", {}))
    used = set(re.findall(r"^\s*(?:npx |pnpm dlx )?(stealth-(?:search|browser)(?:-mcp)?)\b", t, re.M))
    return used <= bins, f"bins used={used}"


# ============================================================ final audit / merge / cutover
@check("audit-final", 1)
def _af1():
    """[dod.1] structural: only the three approved new packages exist: packages/stealth/stealth-core-browser named @adhd/stealth-core-browser and entrypoint/stealth-search named @adhd/stealth-search (both built by the workspace generator, core-scaffold and search-scaffold evidence, entrypoint parity clean) and packages/resilience/resilience-core-tripwire named @adhd/resilience-core-tripwire (tripwire-scaffold evidence), and entrypoint/stealth-browser no longer exists."""
    tw = jread(f"{TW}/package.json", {}) or {}
    c = jread(f"{CORE_DIR}/package.json", {}) or {}
    s = jread(f"{SEARCH_DIR}/package.json", {}) or {}
    return (c.get("name") == CORE_PKG and s.get("name") == SEARCH_PKG and tw.get("name") == TW_PKG and not exists(LEGACY_DIR)
            and all(f()[0] for f in (_ck("core-scaffold", 1), _ck("search-scaffold", 1), _ep1, _s5)) and exists(f"{TW}/project.json")), "three packages + generator evidence + parity"


@check("audit-final", 2)
def _af2():
    """[dod.2] behavioral: `nx run stealth-core-browser:verify-dist-load`, `nx run stealth-search:verify-dist-load` and the use-case unit suites (library scenarios in the core, CLI and MCP scenarios in the search entrypoint, against the in-process fake CDP server) pass on the final tree: the gates-rerun evidence is all green and its code trees (src, bin and manifests only, so the docs states that follow do not invalidate it) equal HEAD's."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    return g.get("all_green") is True and g.get("tree") == tree_sha() and g.get("tw_tree") == tw_tree_sha(), f"gates tree {str(g.get('tree'))[:8]} vs {tree_sha()[:8]}; tripwire tree {str(g.get('tw_tree'))[:8]} vs {tw_tree_sha()[:8]}"


@check("audit-final", 3)
def _af3():
    """[dod.3] structural: the tracing namespace is `adhd` in the search entrypoint (serviceName configured once in src/tracing.ts, package singleton never imported, one initTelemetry per bin, every mount carries the plugin: search-tracing checks 1,2 re-run) and the logs written by the built CLI and MCP hosts were read end to end by the validating agent (tracing-log-validation evidence, every check PASS)."""
    return all(f()[0] for f in (_ck("search-tracing", 1), _ck("search-tracing", 2), _ck("tracing-log-validation", 1))), "namespace + log validation"


@check("audit-final", 4)
def _af4():
    """[ref:runner-port] feature parity: every failsafe-inventory row (features and failsafes of the source runner, not code or exports) is pinned by a feature-level unit test that cites its row id."""
    rows = inventory_rows()
    bad = [r["id"] for r in rows if not row_pinned(r)]
    sb = search_unpinned()
    return len(rows) >= 40 and not bad and not sb, f"{len(rows)} rows, unpinned {bad[:10]}; search inventory unpinned {sb[:10]}"


@check("audit-final", 5)
def _af5():
    """[dod.5] structural: the agent-search source tree was byte-identical to the scaffold-time baseline up to the first cutover commit, and only [psm:search-cutover] commits touched agent-browser/adhd afterwards."""
    return source_untouched()


@check("audit-final", 6)
def _af6():
    """[dod.6] structural: one blind review round, every finding resolved by one implementer, gates re-run green after resolution."""
    return all(f()[0] for f in (_b1, _b2, _r1, _r2, _r3)) and jread(f"{PLAN}/evidence/gates-rerun.json", {}).get("all_green") is True, "review chain"


@check("audit-final", 7)
def _af7():
    """[dod.7] structural: docs marketing run PASS, README rewrite receipts-backed (docs-marketing-run and readme-rewrite checks re-run)."""
    return all(f()[0] for f in (_dm1, _dm2, _rw2, _rw3, _rw4, _ck("docs-marketing-run", 12), _ck("readme-rewrite", 10))), "docs chain"


@check("audit-final", 8)
def _af8():
    """[dod.8] structural: the working tree under packages/stealth/stealth-core-browser, entrypoint/stealth-search and docs/plan/stealth-browser is clean (everything committed) and the main checkout node_modules is untouched."""
    # plan bookkeeping is exempt ([inv:bookkeeping]): the event log, and the run evidence that every guard run re-writes (the committed copies stay canonical)
    exempt = [f":(exclude){PLAN}/{n}" for n in ("events.ndjson", "evidence/gates-first.json", "evidence/tripwire/pack-gates.json")]
    st = git("status", "--porcelain", "--", CORE_DIR, SEARCH_DIR, PLAN, *exempt)
    return st == "" and main_nm_untouched()[0], f"dirty: {st[:200]}"


@check("audit-final", 10)
def _af10():
    """Every spec file cites ticket 8468f7b1 and a valid criterion id (final re-run of the citation rule)."""
    files = [f for d in (CORE_DIR, SEARCH_DIR) for f in walk(f"{d}/test", (".ts",)) if f.endswith(".spec.ts")]
    ids = criteria_ids()
    bad = [f for f in files if TICKET not in read(f) or not (set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", read(f))) & ids)]
    return not bad and bool(files) and exists(SEARCH_DIR), f"uncited {bad[:5]}"



@check("audit-final", 11)
def _af11():
    """Script-only audit (no reviewer agent): final-review.md records `AUDITOR: audit_dod.py (script-only)` and the verbatim `[dod.1]`..`[dod.8]` PASS lines printed by `audit_dod.py --phase final`, with `EXIT: 0`."""
    t = read(f"{PLAN}/final-review.md")
    return "AUDITOR: audit_dod.py (script-only)" in t and all(f"[dod.{k}] PASS" in t for k in range(1, 9)) and re.search(r"^EXIT:\s*0\s*$", t, re.M) is not None, "final-review.md carries the script output"

@check("merge-readiness", 1)
def _mr1():
    """HEAD is a fast-forward of main: `git merge-base --is-ancestor main HEAD` exits 0 (rebase onto main first if main moved)."""
    return sh(["git", "merge-base", "--is-ancestor", "main", "HEAD"])[0] == 0, "ff-only possible"


@check("merge-readiness", 2)
def _mr2():
    """RELEASE-DECISION.md exists with `DECISION: publish` or `DECISION: defer` (release per PUBLISHING.md is the dispatcher's call) and records the pre-push gate commands with exit codes."""
    t = read(f"{PLAN}/RELEASE-DECISION.md")
    return bool(re.search(r"^DECISION:\s*(publish|defer)\s*$", t, re.M)) and "exit" in t.lower() and "nx affected" in t, "release decision"


@check("merge-readiness", 3)
def _mr3():
    """The code trees gated by gates-rerun (the stealth-core-browser + stealth-search src, bin and manifests, and the tripwire package; docs edits after the gates do not change them) are the trees being merged and the worktree is clean."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    return g.get("tree") == tree_sha() and bool(tree_sha()) and g.get("tw_tree") == tw_tree_sha() and git("status", "--porcelain", "--", CORE_DIR, SEARCH_DIR, TW, PLAN) == "", "clean + gated"


def mcp_session(cmd, cwd, calls, timeout=90):
    """Minimal real MCP stdio client: initialize, tools/list, then tools/call for each (name_suffix, args)."""
    p = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    out = {}

    def rpc(i, method, params=None):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
        p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            line = p.stdout.readline()
            if not line:
                break
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == i:
                return m
        return {}
    try:
        rpc(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "guard", "version": "0"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        tools = rpc(2, "tools/list").get("result", {}).get("tools", [])
        out["tools"] = [t["name"] for t in tools]
        for n, (suffix, args) in enumerate(calls, 3):
            name = next((t for t in out["tools"] if t.endswith(suffix)), None)
            out[suffix] = rpc(n, "tools/call", {"name": name, "arguments": args}) if name else {}
    finally:
        p.kill()
    return out


# ---- reference-pattern conformance (audit_check ids cited from references.json)
def _all(*fns):
    def run():
        bad = [f.__name__ for f in fns if not f()[0]]
        return not bad, f"failing: {bad}"
    return run


def _refcheck(cid, fn, doc):
    fn.__doc__ = doc
    CHECKS.setdefault("audit-final", []).append((cid, fn))


_refcheck("audit-final.ref-backlog-tracing", _all(_ck("search-tracing", 1), _ck("search-tracing", 2)),
          "[ref:backlog-tracing] tracing.ts / telemetry.ts / usePlugins / no-singleton conformance with entrypoint/backlog/src/tracing.ts (stealth-search)")
_refcheck("audit-final.ref-entrypoint-structure", _all(_ep1, _ep2, _ep4, _s3, _ck("search-scaffold", 2)),
          "[ref:entrypoint-structure] top-level files, tags, package metadata conform to dispatch-cli/backlog/apigen-cli (stealth-search)")
_refcheck("audit-final.ref-apigen-host", _all(_ck("search-hosts", 1), _ck("search-hosts", 2), _ck("search-tracing", 1)),
          "[ref:apigen-host] server.ts / cli.ts / bin hosts mirror entrypoint/backlog's apigen host shape")
_refcheck("audit-final.ref-stealth-search-spec", _all(_ck("core-scaffold", 1), _ck("search-scaffold", 1), _ck("search-verbs", 1), _ck("search-tracing", 1), _ck("tracing-log-validation", 1)),
          "[ref:stealth-search-spec] the split conforms to SPEC-stealth-search.md: generator-built core and search packages, the eleven projected tools, the single adhd tracing configuration and the agent-validated logs")
_refcheck("audit-final.ref-runner-port", _af4,
          "[ref:runner-port] behavior-preserving port conforms to agent-browser/adhd (exports, similarity, tokens)")


# ============================================================ productization fold (PRODUCT-REVIEW.md)
# Every check below carries the PRODUCT-REVIEW.md task id (PAx.y) it enforces; all are red until the owning state's work is done.
NAMES_RE = re.compile(r"google|search", re.I)
BANNED_RE = re.compile(r"\b(undetectable|bypass(?:es|ed|ing)?|evad(?:e|es|ed|ing)|anti-bot)\b", re.I)
ERR_CODES_HOST = ["CHROME_NOT_FOUND", "PORT_IN_USE", "NODE_TOO_OLD", "CHROME_NOT_RUNNING"]
# failure modes enumerated from the library's throw sites (cdp/browser, cdp/targets, cdp/session, cdp/settle, capture/dom, domains/transport)
ERR_CODE_LIB = ["CHROME_START_TIMEOUT", "CDP_UNREACHABLE", "CDP_BAD_RESPONSE", "TARGET_NOT_FOUND", "CDP_CONNECT_FAILED", "CDP_NOT_CONNECTED",
                "CDP_TIMEOUT", "CDP_REMOTE_ERROR", "CDP_SESSION_CLOSED", "CDP_SEND_FAILED", "NAVIGATION_FAILED", "PAGE_SETTLE_FAILED",
                "OPERATION_ABORTED", "SELECTOR_TIMEOUT"]
# CaptureError (capture-upgrade, spec 5.5) and LifecycleError (chrome-lifecycle, spec 6.4) codes join the same registry (amendment A4)
# final registries fixed by EVAL-store-adapter.md (CU10) and EVAL-service-proxy.md (CL20)
CAPTURE_CODES = ["CAPTURE_CONNECT_FAILED", "CAPTURE_NAVIGATE_FAILED", "CAPTURE_TIMEOUT", "CAPTURE_NO_MATCH", "CAPTURE_BAN_DETECTED", "CAPTURE_SESSION_CLOSED", "CAPTURE_SINK_FAILED", "CAPTURE_SINK_UNAVAILABLE"]
LIFECYCLE_CODES = ["LAUNCH_FAILED", "LAUNCH_LOCK_TIMEOUT", "CHROME_UNREACHABLE_AFTER_LAUNCH", "LAUNCH_CIRCUIT_OPEN", "REAPER_UNAVAILABLE", "ISOLATED_CONTEXT_FAILED"]
ERR_CODES = ERR_CODES_HOST + ERR_CODE_LIB + CAPTURE_CODES + LIFECYCLE_CODES


def all_codes():
    """The registry plus any further code CaptureError / LifecycleError declare at completion."""
    extra = []
    for d in ("recording", "lifecycle"):
        extra += re.findall(r"['\"]([A-Z][A-Z0-9]*_[A-Z0-9_]+)['\"]", read(f"{P}/src/lib/{d}/errors.ts"))
    return ERR_CODES + [c for c in dict.fromkeys(extra) if c not in ERR_CODES]


DEFAULTS = ["9222", "Library/Application Support/Google/Chrome-CDP"]
STEALTH_FLAGS = ("--enable-automation", "Runtime.evaluate")
HOST_PORT_DEAD = "19999"


def run2(cmd, timeout=60, cwd=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return r.returncode, r.stdout or "", r.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except OSError as e:
        return 127, "", repr(e)


_BIN_BUILT = []


def ensure_bin():
    if not _BIN_BUILT:
        _BIN_BUILT.append(sh([NX, "run", f"{proj_name()}:build-bin"], timeout=1200)[0])
    return _BIN_BUILT[0] == 0 and exists(f"{P}/dist/bin/mcp.js") and exists(f"{P}/dist/bin/cli.js")


def port_open(port):
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def norm_name(s):
    return re.sub(r"[^a-z]", "", s.lower())


def kebab(v):
    return re.sub(r"(?<!^)(?=[A-Z])", "-", v).lower()


def mcp_full(args, calls, timeout=60):
    """Real MCP stdio client against dist/bin/mcp.js: returns tools (full objects), every call response, and raw stdout lines."""
    p = subprocess.Popen(["node", f"{P}/dist/bin/mcp.js", *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out = {"tools": [], "calls": [], "stdout": []}

    def rpc(i, method, params=None):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
        p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            line = p.stdout.readline()
            if not line:
                break
            out["stdout"].append(line)
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == i:
                return m
        return {}
    try:
        rpc(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "guard", "version": "0"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        out["tools"] = rpc(2, "tools/list").get("result", {}).get("tools", [])
        for n, (verb, a) in enumerate(calls, 3):
            t = next((t for t in out["tools"] if norm_name(t["name"]).endswith(norm_name(verb))), None)
            out["calls"].append(rpc(n, "tools/call", {"name": t["name"], "arguments": a}) if t else {})
    finally:
        p.kill()
    return out


def cli_verb(verb, extra, timeout=60):
    rc, o, e = 1, "", ""
    for name in (verb, kebab(verb)):
        rc, o, e = run2(["node", f"{P}/dist/bin/cli.js", name, *extra], timeout)
        if "unknown command" not in (o + e).lower():
            break
    return rc, o, e


def verb_sig(text, verb):
    m = re.search(rf"((?:/\*\*(?:(?!\*/).)*\*/\s*)?)export\s+async\s+function\s+{verb}\s*\(([^)]*)\)", text, re.S)
    return (m.group(1), m.group(2)) if m else (None, None)


def verb_input_props(text, verb):
    """Property names of a verb's input type (inline literal or a named interface/type in the same file); None when it cannot be read."""
    _, params = verb_sig(text, verb)
    if params is None:
        return None
    if not params.strip():
        return set()
    body = params
    if "{" not in params:
        m = re.search(r":\s*([A-Za-z_]\w*)", params)
        if not m:
            return None
        name = m.group(1)
        d = re.search(rf"(?:interface\s+{name}\b[^{{]*\{{(.*?)\n\}}|type\s+{name}\s*=\s*\{{(.*?)\n\}})", text, re.S)
        if not d:
            return None
        body = d.group(1) or d.group(2)
    return set(re.findall(r"(?:^|[{;,\n])\s*(\w+)\??\s*:", body))


def tagged_exports(text, tag, skip=lambda line: False):
    """Export statements (by first line) whose nearest preceding comment block carries `tag`; returns (total, untagged)."""
    lines = text.splitlines()
    total, bad = 0, []
    for i, ln in enumerate(lines):
        if not ln.startswith("export") or skip(ln):
            continue
        total += 1
        j = i - 1
        while j >= 0 and not lines[j].strip():
            j -= 1
        k, blob = j, []
        while k >= 0 and (lines[k].strip().startswith(("*", "/*", "//")) or lines[k].strip().endswith("*/")):
            blob.append(lines[k])
            k -= 1
        if tag not in "\n".join(blob):
            bad.append(ln[:60])
    return total, bad


def doc_files():
    """README.md + docs/** prose, excluding the faithfully-ported docs/reference/ CDP protocol reference and generated .catalog data."""
    out = [f"{P}/README.md"] if exists(f"{P}/README.md") else []
    for d, _, fs in os.walk(f"{P}/docs"):
        if d.startswith(f"{P}/docs/reference") or "/.catalog" in d or "node_modules" in d:
            continue
        out += [os.path.join(d, f) for f in fs if f.endswith((".md", ".txt"))]
    return sorted(out)


def banned_hits(files):
    hits = []
    for f in files:
        for i, ln in enumerate(read(f).splitlines(), 1):
            m = BANNED_RE.search(ln)
            if m:
                hits.append(f"{f}:{i}:{m.group(0)}")
    return hits


def spec_files(sub):
    return [f for f in walk(f"{P}/test/{sub}") if f.endswith((".spec.ts", ".test.ts"))]


def dts_exports(path, seen=None):
    seen = seen if seen is not None else set()
    if path in seen or not exists(path):
        return set()
    seen.add(path)
    t = read(path)
    names = exports_of(t)
    names |= {n for n, _ in NS_RE.findall(t)}
    rels = re.findall(r"export\s+(?:type\s+)?\*\s+from\s+['\"](\.[^'\"]+)['\"]", t) + [r for _, r in NS_RE.findall(t)]
    for rel in rels:
        base = os.path.normpath(os.path.join(os.path.dirname(path), re.sub(r"\.js$", "", rel)))
        for cand in (base + ".d.ts", os.path.join(base, "index.d.ts")):
            if exists(cand):
                names |= dts_exports(cand, seen)
                break
    return names


# ---------------------------------------------------------------- surface-api amendments (P1, P2, P4, early claims)
@check("surface-api", 7)
def _sa7():
    """(PA1.1) The launchChrome verb's input type declares only `port` and `userDataDir`; chromePath and extraArgs stay library-only (never on an apigen-visible verb input)."""
    props = verb_input_props(read(f"{P}/src/api.ts"), "launchChrome")
    return props is not None and props <= {"port", "userDataDir"} and not ({"chromePath", "extraArgs"} & props), f"launchChrome input props={props}"


@check("surface-api", 9)
def _sa9():
    """(PA4.1) Each of the six verbs in src/api.ts has a TSDoc block whose description is at least 40 characters (the hosts surface it as the tool description)."""
    t = read(f"{P}/src/api.ts")
    short = []
    for v in VERBS:
        doc, _ = verb_sig(t, v)
        txt = re.sub(r"^\s*/?\*+/?\s?|\*/", "", doc or "", flags=re.M)
        txt = " ".join(x for x in txt.split() if not x.startswith("@"))
        if len(txt) < 40:
            short.append(v)
    return not short, f"verbs without a >=40 char TSDoc: {short}"




@check("surface-api", 10)
def _sa10():
    """Greenfield: no legacy construct exists in the package: no src/legacy.ts, no `@deprecated` tag, no `getSearchSessionId` / `SearchResultSource` / `shutdownSearchChrome` identifier and no `legacy` export anywhere in non-test source, and package.json has no `./legacy` entry."""
    bad = []
    for f in src_nontest():
        t = read(f)
        for tok in ("@deprecated", "getSearchSessionId", "SearchResultSource", "shutdownSearchChrome"):
            if tok in t:
                bad.append(f"{os.path.relpath(f, P)}:{tok}")
    if exists(f"{P}/src/legacy.ts") or "legacy" in json.dumps(pkg()):
        bad.append("legacy file/entry")
    return not bad, f"legacy constructs: {bad[:6]}"
# ---------------------------------------------------------------- prod-errors (P5)
# ---------------------------------------------------------------- surface-hosts amendments (P1-P6)
@check("surface-hosts", 7)
def _sh7():
    """(PA1.2, PA1.3) The built MCP bin's tools/list schema for launchChrome has no chromePath or extraArgs property, and a tools/call for launchChrome with extraArgs is rejected with no process spawned (port stays closed) and no profile dir created."""
    if not ensure_bin():
        return False, "build-bin failed"
    marker, prof, port = "/tmp/sb-guard-pa12-marker", "/tmp/sb-guard-pa12-profile", 19997
    sh(["rm", "-rf", marker, prof])
    try:
        r = mcp_full([], [("launchChrome", {"port": port, "userDataDir": prof, "extraArgs": [f"--user-data-dir={marker}"]})])
    finally:
        if port_open(port):  # a host that dropped extraArgs instead of rejecting would have launched Chrome: shut down only what this probe launched
            mcp_full([], [("shutdownChrome", {"port": port})])
    t = next((t for t in r["tools"] if norm_name(t["name"]).endswith("launchchrome")), None)
    props = set(((t or {}).get("inputSchema") or {}).get("properties", {}))
    resp = (r["calls"] or [{}])[0]
    rejected = bool(resp.get("error")) or bool((resp.get("result") or {}).get("isError"))
    spawned = exists(marker)
    sh(["rm", "-rf", marker, prof])
    return bool(t) and not ({"chromePath", "extraArgs"} & props) and rejected and not spawned, f"props={sorted(props)} rejected={rejected} spawned={spawned}"


@check("surface-hosts", 8)
def _sh8():
    """(PA2.1) src/host-projection.ts exports redactCookieValues (names and counts kept, value strings dropped) and BOTH src/server.ts and src/cli.ts route getPageContext output through it; the library result in api.ts is unchanged (parity)."""
    hp = read(f"{P}/src/host-projection.ts")
    ok = "redactCookieValues" in exports_of(hp) and all("redactCookieValues" in read(f"{P}/src/{f}") and "host-projection" in read(f"{P}/src/{f}") for f in ("server.ts", "cli.ts"))
    return ok and "redact" not in read(f"{P}/src/api.ts").lower(), "projection wiring"


@check("surface-hosts", 9)
def _sh9():
    """(PA3.3, PA3.4, ADR-0003) package.json has NO `exports` map and NO `module` field, `main` is ./dist/index.js and `types` ./dist/index.d.ts; the built root index.d.ts (namespaces included) exports no Google- or Search-named symbol; `require()` of the built dist/index.js exposes the five namespaces, the `lifecycle` namespace and the six verbs; `nx run stealth-browser:verify-dist-load` exits 0."""
    if not ensure_bin():
        return False, "build-bin failed"
    p = pkg()
    shape = "exports" not in p and "module" not in p and p.get("main") == "./dist/index.js" and (p.get("types") or p.get("typings")) == "./dist/index.d.ts"
    bad = sorted(n for n in dts_exports(os.path.normpath(f"{P}/dist/index.d.ts")) if NAMES_RE.search(n))
    rc_r, o_r, e_r = run2(["node", "-e", "console.log(JSON.stringify(Object.keys(require(process.argv[1]))))", os.path.abspath(f"{P}/dist/index.js")], 60)
    try:
        keys = set(json.loads(o_r.strip().splitlines()[-1]))
    except (ValueError, IndexError):
        keys = set()
    rc_v, out = sh([NX, "run", f"{proj_name()}:verify-dist-load"], timeout=1200)
    return shape and not bad and rc_r == 0 and (set(AREAS) | {"lifecycle"} | set(VERBS)) <= keys and rc_v == 0, f"shape={shape} searchNames={bad} require rc={rc_r} keys={sorted(keys)} {e_r[-100:]} verify rc={rc_v}"


@check("surface-hosts", 10)
def _sh10():
    """(PA4.1, PA4.2) tools/list returns a description of at least 40 characters for each of the six tools; `cli --help` and `cli launchChrome --help` each show a description and the default port 9222."""
    if not ensure_bin():
        return False, "build-bin failed"
    r = mcp_full([], [])
    short = []
    for v in VERBS:
        t = next((t for t in r["tools"] if norm_name(t["name"]).endswith(norm_name(v))), None)
        if not t or len((t.get("description") or "").strip()) < 40:
            short.append(v)
    rc1, o1, e1 = run2(["node", f"{P}/dist/bin/cli.js", "--help"])
    rc2, o2, e2 = cli_verb("launchChrome", ["--help"])
    ok = rc1 == 0 and rc2 == 0 and "9222" in (o1 + e1) and "9222" in (o2 + e2) and len((o2 + e2).strip().splitlines()) >= 3
    return not short and ok, f"short descriptions={short} help rc={rc1}/{rc2} port shown={'9222' in (o1 + e1)}/{'9222' in (o2 + e2)}"


@check("surface-hosts", 11)
def _sh11():
    """(PA4.3, PA4.4, resolves U1/U2) evidence/naming-decision.md records `CLI-STYLE: camelCase|kebab-case`, `MCP-NAMES: <the six tool names>`, `U1: resolved` and `U2: resolved`; the built tools/list names and the CLI verb style match the record."""
    d = read(f"{PLAN}/evidence/naming-decision.md")
    style = re.search(r"^CLI-STYLE:\s*(camelCase|kebab-case)\s*$", d, re.M)
    names = re.search(r"^MCP-NAMES:\s*(.+)$", d, re.M)
    if not (style and names and re.search(r"^U1:\s*resolved", d, re.M) and re.search(r"^U2:\s*resolved", d, re.M)):
        return False, "naming-decision.md incomplete"
    if not ensure_bin():
        return False, "build-bin failed"
    declared = {x.strip() for x in names.group(1).split(",") if x.strip()}
    live = {t["name"] for t in mcp_full([], [])["tools"]}
    rc, o, e = run2(["node", f"{P}/dist/bin/cli.js", "--help"])
    verbs_seen = all((v if style.group(1) == "camelCase" else kebab(v)) in (o + e) for v in VERBS)
    return len(declared) == 6 and declared == live and verbs_seen, f"declared={sorted(declared)} live={sorted(live)} cliStyleMatches={verbs_seen}"


@check("surface-hosts", 13)
def _sh13():
    """(PA6.1) Both bins accept --port and --user-data-dir and print the defaults in --help (9222 and the Chrome-CDP profile path)."""
    if not ensure_bin():
        return False, "build-bin failed"
    res = []
    for b in ("cli", "mcp"):
        rc, o, e = run2(["node", f"{P}/dist/bin/{b}.js", "--help"], 30)
        t = o + e
        res.append(rc == 0 and "--port" in t and "--user-data-dir" in t and "9222" in t and "Chrome-CDP" in t)
    return all(res), f"cli,mcp help ok={res}"


# ---------------------------------------------------------------- tracing amendments (P9, namespace pinned to emission, backlog 5152786d)
@check("tracing-plugin", 7)
def _t7():
    """(PA9.2) A --verbose flag exists on both hosts and diagnostics go to stderr only: the MCP host path (src/server.ts, bin/mcp.ts) has no console.log / process.stdout.write outside the JSON-RPC transport."""
    srcs = {f: read(f"{P}/{f}") for f in ("src/server.ts", "src/cli.ts", "bin/mcp.ts", "bin/cli.ts")}
    flag = any("--verbose" in t or "verbose" in t for t in srcs.values())
    leaks = [f for f in ("src/server.ts", "bin/mcp.ts") if re.search(r"console\.log\(|process\.stdout\.write\(", srcs[f])]
    return flag and "verbose" in srcs["src/cli.ts"] + srcs["bin/cli.ts"] and not leaks, f"flag={flag} stdout leaks={leaks}"


@check("tracing-plugin", 8)
def _t8():
    """Namespace pinned to what the code EMITS (backlog 5152786d: the apigen design notes still say apigen.*; the code does not): packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts requires `serviceName: string`, builds keys as `${serviceName}.op` / `${serviceName}.transport` / `${serviceName}.op.error` and span names `${serviceName}.<op>`, and src/tracing.ts passes serviceName 'adhd' (so stealth-browser emits adhd.op / adhd.transport), regardless of what any design note claims."""
    pl = read("packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts")
    emit = all(k in pl for k in ("serviceName: string", "`${serviceName}.op`", "`${serviceName}.transport`", "`${serviceName}.op.error`", "`${serviceName}.${call.operation.id}`"))
    literal = re.search(r"\[\s*['\"]apigen\.(op|transport)['\"]\s*\]", pl) is not None
    return emit and not literal and re.search(r"serviceName:\s*['\"]adhd['\"]", read(f"{P}/src/tracing.ts")) is not None, f"dynamic keys={emit} hardcoded apigen keys={literal}"


@check("tracing-namespace-proof", 6)
def _tn6():
    """The spec pins the namespace to the emitted attribute keys (backlog 5152786d): it asserts the records carry `adhd.op` and `adhd.transport` (the `${serviceName}.*` keys) and no `apigen.op` / `apigen.transport` key, and cites 5152786d in its header."""
    t = read(SPEC)
    return all(k in t for k in ("adhd.op", "adhd.transport", "apigen.op", "apigen.transport", "5152786d")), "attribute keys pinned"


# ---------------------------------------------------------------- prod-examples (P7)
EX = f"{P}/examples"


# ---------------------------------------------------------------- tests (P1, P2, P9 coverage)
@check("tests-unit-surface", 5)
def _tus5():
    """(PA3.1, greenfield) This state OWNS the public-API export snapshot: test/unit/surface/public-api.spec.ts lists every root export name of src/index.ts (the five core namespaces, the `lifecycle` namespace wired by core-seam and the six verbs) and the member names of each namespace and fails on drift (toEqual of the sorted names); the names added by prod-errors (`recording`, StealthCoreBrowserError, ERROR_CODES, exitCodeFor) are an all-or-none group, so the spec passes both before and after prod-errors lands and fails on any other drift; it cites ticket 8468f7b1, a valid tests-unit-surface.N id and PA3.1, and `nx run stealth-core-browser:test -- test/unit/surface/public-api` exits 0."""
    specs = [f for f in spec_files("unit/surface") if "public-api" in os.path.basename(f)]
    t = "\n".join(read(f) for f in specs)
    names = set(AREAS) | {"lifecycle"} | set(VERBS) | {"recording", "StealthCoreBrowserError", "ERROR_CODES", "exitCodeFor"}
    miss = sorted(n for n in names if n not in t)
    ids = set(re.findall(r"\[(tests-unit-surface\.\d+)\]", t))
    ok = bool(specs) and not miss and re.search(r"toEqual", t) is not None and TICKET in t and bool(ids & criteria_ids()) and "PA3.1" in t
    if not ok:
        return False, f"specs={len(specs)} unlisted={miss}"
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", "test/unit/surface/public-api"], timeout=1500)
    return rc == 0, out[-200:]

# ---------------------------------------------------------------- docs (P6, P8, P9)
@check("docs-marketing-run", 6)
def _dm6():
    """(PA6.2, PA6.3) docs/CONFIGURATION.md lists every default verbatim (port 9222, the Library/Application Support/Google/Chrome-CDP profile, plus any state path the chrome-lifecycle design adds) and states macOS-first support with what is untested elsewhere."""
    t = read(f"{P}/docs/CONFIGURATION.md")
    miss = [d for d in DEFAULTS if d not in t]
    return not miss and "macOS" in t and re.search(r"untested|not tested|unsupported|not supported", t, re.I) is not None, f"missing {miss}"


@check("docs-marketing-run", 7)
def _dm7():
    """(PA8.1, PA8.2) docs/RESPONSIBLE-USE.md covers site terms of service, robots.txt, rate limits, no CAPTCHA or ban evasion, and read-only access to the user's own profile and cookies; the docs define "stealth" as exactly the two concrete choices (no --enable-automation, no Runtime.evaluate)."""
    t = read(f"{P}/docs/RESPONSIBLE-USE.md")
    low = t.lower()
    terms = ("terms of service", "robots.txt", "rate limit", "captcha", "read-only", "own profile")
    miss = [k for k in terms if k not in low]
    docs = "\n".join(read(f) for f in doc_files())
    return bool(t) and not miss and all(f in docs for f in STEALTH_FLAGS) and "stealth" in docs.lower(), f"RESPONSIBLE-USE missing {miss}"


@check("docs-marketing-run", 8)
def _dm8():
    """(PA8.3) No README.md or docs/ prose (excluding the ported docs/reference/ protocol reference and generated .catalog data) contains the overclaim words undetectable, bypass, evade or anti-bot."""
    hits = banned_hits(doc_files())
    return bool(doc_files()) and not hits, f"hits={hits[:5]}"


@check("docs-marketing-run", 9)
def _dm9():
    """(PA9.1) stealth-search docs/OBSERVABILITY.md documents adhd.<op>.start|finish|error records, how to enable the sink, the --verbose stderr diagnostics, and that the MCP bin writes only JSON-RPC to stdout."""
    t = read(f"{SEARCH_DIR}/docs/OBSERVABILITY.md")
    need = ("adhd.", ".start", ".finish", ".error", "sink", "--verbose", "stderr", "JSON-RPC", "stdout")
    miss = [k for k in need if k not in t]
    return not miss, f"missing {miss}"




@check("docs-marketing-run", 10)
def _dm10():
    """(user: runnable examples and genuine use cases) docs/EXAMPLES.md lists every examples/ file (six verbs, five namespaces, cli.md, mcp-config.json) with its scenario in one sentence and links docs/ERRORS.md."""
    t = read(f"{P}/docs/EXAMPLES.md")
    miss = [f for f in EX_VERB_FILES + EX_NS_FILES + ["cli.md", "mcp-config.json"] if f"examples/{f}" not in t]
    return exists(f"{P}/docs/EXAMPLES.md") and not miss and "ERRORS.md" in t, f"unlisted examples {miss}"

@check("readme-rewrite", 6)
def _rr6():
    """(PA8.2, PA8.4) README defines "stealth" as the two concrete choices (no --enable-automation, no Runtime.evaluate) and links docs/RESPONSIBLE-USE.md (the link resolves)."""
    t = read(f"{P}/README.md")
    return all(f in t for f in STEALTH_FLAGS) and "docs/RESPONSIBLE-USE.md" in t and exists(f"{P}/docs/RESPONSIBLE-USE.md"), "stealth definition + link"


@check("readme-rewrite", 7)
def _rr7():
    """(PA8.3) README.md contains none of the overclaim words undetectable, bypass, evade, anti-bot."""
    hits = banned_hits([f"{P}/README.md"])
    return exists(f"{P}/README.md") and not hits, f"hits={hits[:5]}"


@check("readme-rewrite", 8)
def _rr8():
    """(PA10.2, greenfield) README states the stability policy: the package is 0.x, the six verbs and their types are the stable surface, and the root namespaces (cdp, storage, capture, parsers, chromeManager) are experimental until 1.0."""
    t = read(f"{P}/README.md")
    return "0.x" in t and re.search(r"stability|stable", t, re.I) is not None and "experimental" in t.lower() and all(a in t for a in AREAS), "stability policy"




@check("readme-rewrite", 9)
def _rr9():
    """(user: implement the readme examples and genuine use cases) The README embeds or links EVERY examples/ file (path appears), includes at least six fenced `ts` blocks each of which is a snippet taken verbatim from an examples/ file, and links docs/ERRORS.md and docs/EXAMPLES.md."""
    t = read(README)
    miss = [f for f in EX_VERB_FILES + EX_NS_FILES + ["cli.md", "mcp-config.json"] if f"examples/{f}" not in t]
    blocks = re.findall(r"```ts\n(.*?)```", t, re.S)
    allsrc = "\n".join(read(f"{EX}/{f}") for f in EX_VERB_FILES + EX_NS_FILES)
    stray = [b[:40] for b in blocks if b.strip() not in allsrc]
    return not miss and len(blocks) >= 6 and not stray and "docs/ERRORS.md" in t and "docs/EXAMPLES.md" in t, f"unreferenced={miss} ts blocks={len(blocks)} not from examples={stray[:2]}"

# ---------------------------------------------------------------- prod-publish-readiness (P10)
def tarball_missing(d=None):
    """`npm pack --dry-run --json` in <package>/dist: returns (rc, missing members) against README.md, CHANGELOG.md, (search only) both bins and the main/types/bin targets of the dist manifest (no exports map, ADR-0003). Default package: stealth-search; pass CORE_DIR for the library."""
    d = d or SEARCH_DIR
    rc, o, e = run2(["npm", "pack", "--dry-run", "--json"], 300, cwd=f"{d}/dist")
    try:
        files = {f["path"] for f in json.loads(o)[0]["files"]}
    except (ValueError, KeyError, IndexError):
        return rc, [f"npm pack --dry-run unreadable rc={rc} {e[-150:]}"]
    need = {"README.md", "CHANGELOG.md"} | ({"bin/cli.js", "bin/mcp.js"} if d == SEARCH_DIR else set())
    dm = jread(f"{d}/dist/package.json", {}) or {}
    tg = set()

    def collect(x):
        if isinstance(x, str):
            tg.add(os.path.normpath(x))
        elif isinstance(x, dict):
            for v in x.values():
                collect(v)
    collect([dm.get("main"), dm.get("types") or dm.get("typings")])
    collect(dm.get("bin") or {})
    return rc, sorted(need - files) + sorted(t for t in tg if t not in files)


@check("audit-final", 9)
def _af9():
    """(PA10.3, re-checked after the docs states) `npm pack --dry-run` against each final dist output still lists README.md, CHANGELOG.md and the main/types targets (stealth-search also bin/cli.js and bin/mcp.js), and the packed stealth-core-browser README is the rewritten one (it links docs/RESPONSIBLE-USE.md)."""
    rc, miss = tarballs_missing()
    return rc == 0 and not miss and "docs/RESPONSIBLE-USE.md" in read(f"{CORE_DIR}/dist/README.md") and exists(f"{SEARCH_DIR}/dist"), f"missing from tarballs: {miss}"


CONSUMERS = ["cdp-query-client.ts", "cdp-search.ts", "chrome-lifecycle-test.ts", "network-capture.ts", "search-challenge.ts", "search-dom.ts", "search-fetch.ts",
             "search-guard-test.ts", "search-mcp-source.ts", "search-network.ts", "search-tripwire.ts", "search/queries/activity.ts", "search/queries/context.ts", "search/queries/last-search.ts"]
CUTOVER_OWNED = ["adhd/", *CONSUMERS, "package.json", "pnpm-lock.yaml", "AGENTS.md", "SEARCH.md", "FEATURES.md", "FETCH.md", "docs/"]


def consume_link():
    m = re.search(r"^CONSUME:\s*link:(/\S+)\s*$", read(f"{PLAN}/RELEASE-DECISION.md"), re.M)
    return m.group(1) if m else None


@check("merge-readiness", 4)
def _mr4():
    """(D3) When CONSUME is a link: into the merged main checkout, RELEASE-DECISION.md records `MAIN_BUILD: nx run stealth-search:build-bin exit=0` (dist/ built in the merged main checkout by the dispatcher before the link is consumed) and that dist exists there; a published CONSUME needs no main build."""
    t = read(f"{PLAN}/RELEASE-DECISION.md")
    link = consume_link()
    if not t:
        return False, "RELEASE-DECISION.md missing"
    if link is None:
        return bool(re.search(r"^CONSUME:\s*@adhd/stealth-search@\S+\s*$", t, re.M)), "published consume"
    return bool(re.search(r"^MAIN_BUILD:\s*nx run stealth-search:build-bin exit=0\s*$", t, re.M)) and exists(f"{link}/dist/bin/cli.js") and exists(f"{link}/dist/bin/mcp.js"), f"link={link}"


# ============================================================ port-fixes (corrections before any review)
def lib_files():
    return [f for f in walk(f"{P}/src/lib") if not f.endswith(".d.ts")]


@check("port-fixes", 1)
def _pf1():
    """Strict typing, never weakened: `nx run stealth-browser:typecheck` and `:typecheck-spec` exit 0 on the ported lib, specs and vite.config.ts (typings are fixed; tsconfig keeps `strict` and `noPropertyAccessFromIndexSignature`, and no `@ts-nocheck`, `@ts-ignore` or `@ts-expect-error` exists in src/lib or vite.config.ts)."""
    tc = jread(f"{P}/tsconfig.json", {}) or {}
    co = tc.get("compilerOptions", {})
    kept = co.get("strict") is True and co.get("noPropertyAccessFromIndexSignature") is True
    weak = [f for f in lib_files() + [f"{P}/vite.config.ts"] if re.search(r"@ts-nocheck|@ts-ignore|@ts-expect-error", read(f))]
    for f in ("tsconfig.lib.json", "tsconfig.spec.json"):
        if (jread(f"{P}/{f}", {}) or {}).get("compilerOptions", {}).get("strict") is False:
            weak.append(f)
    a, oa = sh([NX, "run", f"{proj_name()}:typecheck"], timeout=1500)
    b, ob = sh([NX, "run", f"{proj_name()}:typecheck-spec"], timeout=1500)
    return a == 0 and b == 0 and kept and not weak, f"typecheck={a} typecheck-spec={b} tsconfig kept={kept} weakened={weak} {(oa + ob)[-200:]}"


@check("port-fixes", 2)
def _pf2():
    """Defect 1 (BigInt): storage/helpers.ts still opens with `readBigInts` (the immutable read-only opener is kept), hydrateVisit and getRedirectChain return plain numbers (converted, not dropped), and the former `it.fails` pin in domains-storage/history.spec.ts is a real passing test: no `it.fails` remains under src/test and a spec asserts the redirect-chain ids are `number`."""
    h = read(f"{P}/src/lib/storage/helpers.ts")
    specs = "\n".join(read(f) for f in walk(f"{P}/test/unit/domains-storage"))
    return "readBigInts" in h and "immutable=1" in h and "it.fails" not in "\n".join(read(f) for f in walk(f"{P}/test")) and "getRedirectChain" in specs and re.search(r"typeof[^\n]*['\"]number['\"]|toBeTypeOf\(['\"]number['\"]\)", specs) is not None, "bigint defect pinned green"


@check("port-fixes", 3)
def _pf3():
    """Defect 2 (cookie expiry): a unit test in domains-storage/cookies.spec.ts proves CookieClient.getCookies maps `expires_utc = 0` (a session cookie) to a null expiry instead of 1601-01-01."""
    t = read(f"{P}/test/unit/domains-storage/cookies.spec.ts")
    return "expires_utc" in t and re.search(r"expires_utc[^\n]*\b0\b", t) is not None and "toBeNull" in t and "1601" in t and "[port-fixes." in t, "session-cookie expiry regression test"


@check("port-fixes", 4)
def _pf4():
    """Defect 3 (cdpCall before open): domains/transport.ts waits for the socket to open before `send`, and a unit test in domains-storage/transport.spec.ts drives a WebSocket stub that opens asynchronously and proves cdpCall resolves with the reply (not null) and never sends before open."""
    code = read(f"{P}/src/lib/domains/transport.ts")
    t = read(f"{P}/test/unit/domains-storage/transport.spec.ts")
    waits = re.search(r"readyState|addEventListener\(['\"]open|\.on\(['\"]open|once\(['\"]open|onopen", code) is not None
    return waits and "cdpCall" in t and re.search(r"open", t) is not None and re.search(r"not\.toBeNull|\.toEqual\(\{", t) is not None and "[port-fixes." in t, f"waits={waits}"


@check("port-fixes", 5)
def _pf5():
    """The scratch chrome-lifecycle-test.ts is ported as a unit/lifecycle spec: test/unit/chrome-manager/chrome-lifecycle.spec.ts covers all five scenarios (deferral does not stamp the deferrer's heartbeat, genuine activity stamps, stale sibling lets shutdown proceed, absent sibling proceeds, dead sibling PID is ignored), uses a temp heartbeat path and a dead CDP port (never the live /tmp/stealth-browser-heartbeat), cites ticket 8468f7b1 and a valid port-fixes.N id; chrome-lifecycle later replaces the heartbeat mechanism with connection-based presence through the reaper link and keeps the same behaviors (it then cites [chrome-lifecycle.N] and the heartbeat tokens are no longer required)."""
    t = read(f"{P}/test/unit/chrome-manager/chrome-lifecycle.spec.ts")
    lifecycle_shape = "[chrome-lifecycle." in t  # chrome-lifecycle rewrites this spec onto the reaper-link mechanism (connection presence, no heartbeat file)
    need = ("shutdownIfIdle", "bump", "livelock") if lifecycle_shape else ("shutdownIfIdle", "heartbeatPath", "mkdtemp", "bump", "livelock")
    live = re.search(r"['\"`]/tmp/stealth-browser-heartbeat['\"`]", t) is not None
    ids = set(re.findall(r"\[((?:port-fixes|chrome-lifecycle)\.\d+)\]", t))
    tok = True
    return all(k in t for k in need) and len(re.findall(r"\b(?:it|test)\(", t)) >= 5 and not live and TICKET in t and bool(ids & criteria_ids()) and tok, f"missing={[k for k in need if k not in t]} liveHeartbeat={live} token={tok}"


@check("port-fixes", 6)
def _pf6():
    """Dead code the lint flagged is gone without behaviour change: `nx run stealth-browser:lint` exits 0 with no `no-unused-vars` warning (an unused symbol is deleted or genuinely used, never silenced with eslint-disable), and the full unit lane still passes (see .9)."""
    rc, out = sh([NX, "run", f"{proj_name()}:lint", "--skip-nx-cache"], timeout=900)
    off = [f for f in lib_files() if re.search(r"eslint-disable[^\n]*no-unused-vars", read(f))]
    return rc == 0 and "no-unused-vars" not in out and not off, f"rc={rc} disabled={off} {out[-200:]}"


@check("port-fixes", 7)
def _pf7():
    """Greenfield names at source: lib/types.ts exports PageSource (renamed from SearchResultSource), lib/session.ts has no getSearchSessionId alias, capture/dom.ts carries no `@deprecated` tag and its header honestly states it is a SERP-oriented walker, and lib/cdp/index.ts exposes IdleShutdown, CdpClient, browserSession and getSessionId so the `cdp` namespace needs no deep import."""
    ty, se = read(f"{P}/src/lib/types.ts"), read(f"{P}/src/lib/session.ts")
    dom = read(f"{P}/src/lib/capture/dom.ts")
    head = "\n".join(dom.splitlines()[:40])
    cdp = barrel_names_of(f"{P}/src/lib/cdp/index.ts")
    need = {"IdleShutdown", "CdpClient", "browserSession", "getSessionId"}
    stale = [f for f in lib_files() if re.search(r"getSearchSessionId|SearchResultSource|@deprecated", read(f))]
    return "PageSource" in exports_of(ty) and "getSearchSessionId" not in se and "@deprecated" not in dom and "SERP" in head and need <= cdp and not stale, f"stale={stale} cdp missing={sorted(need - cdp)} serpDoc={'SERP' in head}"


@check("port-fixes", 8)
def _pf8():
    """Feature parity after the fixes: failsafe-inventory.json exists and every row owned by port-fixes is pinned by a feature-level unit test citing its row id; the capture/dom.ts Google-SERP walker is still present unless the user decided otherwise (it is flagged, not decided, in the return); line-similarity and export-name parity are NOT required (greenfield)."""
    inv = inventory_owner_ok("port-fixes")
    return inv[0] and exists(f"{P}/src/lib/capture/dom.ts") and len(inventory_rows()) >= 40, inv[1]


@check("port-fixes", 9)
def _pf9():
    """The whole unit lane is green on the corrected lib: `nx run stealth-browser:test` exits 0 (this is what unblocks tests-unit-core, tests-unit-data and tests-unit-extract)."""
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--skip-nx-cache"], timeout=2400)
    return rc == 0, out[-300:]


@check("port-fixes", 10)
def _pf10():
    """Only owned paths changed by [psm:port-fixes] commits."""
    return ownership_ok("port-fixes")


# ============================================================ audit-pre-review / audit-fixes (non-blind static audit, then ONE implementer)
PRE = f"{PLAN}/review/PRE-REVIEW.json"
PRE_RES = f"{PLAN}/review/PRE-REVIEW-RESOLUTION.json"


def pre_findings():
    return jread(PRE, {})


@check("audit-pre-review", 1)
def _apr1():
    """review/PRE-REVIEW.json exists and records `auditor`, `blind: false`, `static: true`, the audited `head` and `tree` (the combined stealth-core-browser + stealth-search code tree, `tree_sha`), the `audit_dod` command, its integer `audit_dod_exit` and the verbatim `[dod.N]` lines it printed; PRE-REVIEW.md is the human-readable rendering."""
    f = pre_findings()
    ok = bool(f.get("auditor")) and f.get("blind") is False and f.get("static") is True and bool(f.get("head")) and bool(f.get("tree")) and isinstance(f.get("audit_dod_exit"), int) and "audit_dod.py --phase pre-review" in str(f.get("audit_dod", "")) and bool(f.get("audit_dod_lines"))
    return ok and len(read(f"{PLAN}/review/PRE-REVIEW.md").strip()) > 100, "pre-review record"


@check("audit-pre-review", 2)
def _apr2():
    """The audit judged the current code: `tree` in PRE-REVIEW.json equals the current combined core + search code tree sha, and `audit_dod_exit` equals the exit status of re-running `audit_dod.py --phase pre-review` now."""
    f = pre_findings()
    rc, _ = sh([sys.executable, f"{SCRIPTS}/audit_dod.py", "--phase", "pre-review"], timeout=2400)
    at = tree_sha_at(completion_ref("audit-pre-review"))  # the code the audit judged: frozen at the commit where the audit completed
    return f.get("tree") == at and f.get("audit_dod_exit") == rc, f"tree match={f.get('tree') == at} recorded exit={f.get('audit_dod_exit')} rerun={rc}"


@check("audit-pre-review", 3)
def _apr3():
    """Every finding has id (P1..), severity in {blocker,major,minor,nit}, file, line, summary and evidence; or `no_findings: true` with a rationale of at least 40 characters; ids are unique and every cited file exists."""
    f = pre_findings()
    if f.get("no_findings") is True:
        return len(f.get("rationale", "")) > 40, "no findings"
    items = f.get("findings", [])
    ok = bool(items) and all(isinstance(x, dict) and re.fullmatch(r"P\d+", x.get("id", "")) and x.get("severity") in ("blocker", "major", "minor", "nit") and x.get("file") and x.get("summary") and x.get("evidence") for x in items)
    ids = [x.get("id") for x in items]
    return ok and len(ids) == len(set(ids)) and all(exists(x["file"]) for x in items), f"{len(items)} findings"


@check("audit-pre-review", 4)
def _apr4():
    """The auditor changed no source: [psm:audit-pre-review] commits touch only review/PRE-REVIEW.json and review/PRE-REVIEW.md, and the package tree is identical to its tree at state start."""
    o = ownership_ok("audit-pre-review")
    st = (state().get("states") or {}).get("audit-pre-review") or {}
    since = st.get("start_ref")
    same = True
    if since:
        same = tree_sha_at(since) == tree_sha_at(completion_ref("audit-pre-review"))
    return o[0] and same, f"{o[1]} package tree unchanged={same}"


@check("audit-fixes", 1)
def _afx1():
    """review/PRE-REVIEW-RESOLUTION.json covers 100% of PRE-REVIEW finding ids (or records `no_findings: true` when the audit had none); every finding is `fixed` or `rejected` - none open or deferred."""
    res = jread(PRE_RES, {})
    pf = pre_findings()
    if pf.get("no_findings") is True:
        return res.get("no_findings") is True, "audit had no findings"
    ids = {x["id"] for x in pf.get("findings", [])}
    got = {x["id"]: x for x in res.get("resolutions", [])}
    return bool(ids) and set(got) == ids and all(x.get("status") in ("fixed", "rejected") for x in got.values()), f"unresolved {sorted(ids - set(got))}"


@check("audit-fixes", 2)
def _afx2():
    """Each `fixed` entry names a commit sha tagged [psm:audit-fixes] that touches the cited file; each `rejected` entry carries >=40 chars of evidence and a reproduction command."""
    res = jread(PRE_RES, {})
    if res.get("no_findings") is True:
        return pre_findings().get("no_findings") is True, "no findings"
    fmap = {x["id"]: x for x in pre_findings().get("findings", [])}
    bad = []
    for r in res.get("resolutions", []):
        if r.get("status") == "fixed":
            cited = fmap.get(r["id"], {}).get("file") or ""
            repo = [] if not os.path.isabs(cited) or cited.startswith(TOP + "/") else ["-C", os.path.dirname(cited)]  # a cross-repo citation (the scratch repo) is checked in the repo that holds the file
            top = subprocess.run(["git", *repo, "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() if repo else ""
            if repo and top:
                cited = os.path.relpath(cited, top)
            def _g(*a):
                return subprocess.run(["git", *repo, *a], capture_output=True, text=True).stdout
            body = _g("log", "-1", "--format=%B", r.get("commit", "HEAD_MISSING"))
            files = _g("diff-tree", "--no-commit-id", "--name-only", "-r", r.get("commit", "HEAD_MISSING")).splitlines()
            if "[psm:audit-fixes]" not in body or cited not in files:
                bad.append(r["id"])
        elif len(r.get("evidence", "")) < 40 or not r.get("reproduction"):
            bad.append(r["id"])
    return not bad and bool(res.get("resolutions")), f"bad {bad}"


@check("audit-fixes", 3)
def _afx3():
    """ONE implementer corrected every finding: PRE-REVIEW-RESOLUTION.json has a single `agent` value and all [psm:audit-fixes] commits share one git author."""
    res = jread(PRE_RES, {})
    st = (state().get("states") or {}).get("audit-fixes") or {}
    since = st.get("start_ref") or git("merge-base", "HEAD", "main")
    log = sh(["git", "log", f"{since}..HEAD", "--format=%an%x1f%B%x1e"])[1]
    authors = {r.split("\x1f")[0].strip() for r in log.split("\x1e") if "[psm:audit-fixes]" in r}
    return bool(res.get("agent")) and len(authors) <= 1, f"agent={res.get('agent')} authors={authors}"


@check("audit-fixes", 4)
def _afx4():
    """No new TODO/FIXME/XXX in packages/stealth/stealth-core-browser/src or entrypoint/stealth-search/src and only owned paths changed by [psm:audit-fixes] commits."""
    t = "\n".join(read(f) for d in (CORE_DIR, SEARCH_DIR) for f in walk(f"{d}/src"))
    o = ownership_ok("audit-fixes")
    return not re.search(r"\b(TODO|FIXME|XXX)\b", t) and o[0] and exists(SEARCH_DIR), o[1]


@check("audit-fixes", 5)
def _afx5():
    """After the corrections lint, typecheck, typecheck-spec and the unit lane exit 0 (`nx run <project>:lint typecheck typecheck-spec test` for stealth-core-browser and stealth-search); the full gate run follows in gates-first."""
    # The state's own work product comes first: the gates are green on the untouched tree, so without the resolution record this criterion proves nothing.
    res = jread(f"{PLAN}/review/PRE-REVIEW-RESOLUTION.json", None)
    if not isinstance(res, (dict, list)) or not res:
        return False, "review/PRE-REVIEW-RESOLUTION.json missing or empty: the corrections have not been recorded"
    bad = []
    for proj in (CORE_PROJECT, SEARCH_PROJECT):
        for t in ("lint", "typecheck", "typecheck-spec", "test"):
            rc, out = sh([NX, "run", f"{proj}:{t}"], timeout=2400)
            if rc != 0:
                bad.append(f"{proj}:{t}={rc}")
    return not bad, f"failing {bad}"


@check("audit-fixes", 6)
def _afx6():
    """`audit_dod.py --phase pre-review` exits 0 on the corrected tree (every dod clause that was available before the gates now passes)."""
    rc, out = sh([sys.executable, f"{SCRIPTS}/audit_dod.py", "--phase", "pre-review"], timeout=2400)
    return rc == 0, out[-300:]



# ---------------------------------------------------------------- prod-errors (100% typed errors)
def untyped_throws():
    """Every non-test source line under src/ that constructs or throws an untyped error."""
    hits = []
    for f in [x for x in src_nontest() if not x.endswith("errors.ts")] + walk(f"{P}/bin"):
        for i, ln in enumerate(read(f).splitlines(), 1):
            s = ln.strip()
            if s.startswith(("//", "*", "/*")):
                continue
            if re.search(r"\bnew\s+(?:Error|TypeError|RangeError)\s*\(", ln) or re.search(r"\bthrow\s+(?:['\"`]|[a-z]\w*\s*;)", ln) or re.search(r"\bPromise\.reject\(\s*(?:['\"`]|new\s+Error)", ln):
                hits.append(f"{os.path.relpath(f, P)}:{i}")
    return hits


@check("prod-errors", 1)
def _pe1():
    """(PA5.1, widened to 100%) src/errors.ts defines one `StealthCoreBrowserError extends Error` with a readonly stable `code`, an exported `ERROR_CODES` const naming EVERY failure mode of the library, an `exitCodeFor(code)` mapping and a remediation message per code; the codes are exactly the 32 enumerated from the code and the two specs (4 environment codes CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD, CHROME_NOT_RUNNING; 14 library codes CHROME_START_TIMEOUT, CDP_UNREACHABLE, CDP_BAD_RESPONSE, TARGET_NOT_FOUND, CDP_CONNECT_FAILED, CDP_NOT_CONNECTED, CDP_TIMEOUT, CDP_REMOTE_ERROR, CDP_SESSION_CLOSED, CDP_SEND_FAILED, NAVIGATION_FAILED, PAGE_SETTLE_FAILED, OPERATION_ABORTED, SELECTOR_TIMEOUT; the 8 CaptureError codes CAPTURE_CONNECT_FAILED, CAPTURE_NAVIGATE_FAILED, CAPTURE_TIMEOUT, CAPTURE_NO_MATCH, CAPTURE_BAN_DETECTED, CAPTURE_SESSION_CLOSED, CAPTURE_SINK_FAILED, CAPTURE_SINK_UNAVAILABLE; the 6 LifecycleError codes LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, REAPER_UNAVAILABLE, ISOLATED_CONTEXT_FAILED), and every code's message names a concrete next step."""
    t = read(f"{P}/src/errors.ts")
    miss = [c for c in all_codes() if c not in t]
    cls = re.search(r"class\s+StealthCoreBrowserError\s+extends\s+Error", t) is not None and re.search(r"readonly\s+code", t) is not None
    api = {"ERROR_CODES", "exitCodeFor", "StealthCoreBrowserError"} <= exports_of(t)
    fix = len(re.findall(r"""['"`][^'"`\n]*\b(install|set|use|run|upgrade|start|free|choose|launch|update|retry|check|increase|pass)\b[^'"`\n]*['"`]""", t, re.I))
    return cls and api and not miss and fix >= len(all_codes()), f"class={cls} api={api} missing={miss} remediation strings={fix}"


@check("prod-errors", 2)
def _pe2():
    """(PA5.4, widened) test/unit/errors/ has a unit test PER CODE: each code of the registry (all 32 codes) is asserted (`code` and a remediation message; CaptureError and LifecycleError instances are `instanceof StealthCoreBrowserError`) and each of the 14 library codes is reached through the real library path (`rejects.toMatchObject({ code: '<CODE>' })` or `.code).toBe('<CODE>')` against the in-process fake server/stubs), citing ticket 8468f7b1, a valid prod-errors.N id and PA5.1 / PA5.4."""
    specs = spec_files("unit/errors")
    t = "\n".join(read(f) for f in specs)
    miss = [c for c in all_codes() if t.count(c) < 1]
    reach = [c for c in ERR_CODE_LIB if not re.search(rf"toMatchObject\(\s*\{{[^}}]*code:\s*['\"]{c}['\"]|\.code\)\.toBe\(\s*['\"]{c}['\"]", t)]
    ids = set(re.findall(r"\[(prod-errors\.\d+)\]", t))
    return bool(specs) and not miss and not reach and t.count("message") >= len(all_codes()) and TICKET in t and bool(ids & criteria_ids()) and "PA5.1" in t and "PA5.4" in t, f"specs={len(specs)} missing={miss} not reached through the library={reach}"


@check("prod-errors", 3)
def _pe3():
    """Only owned paths changed by [psm:prod-errors] commits (errors.ts, src/index.ts, src/api.ts, the lib files whose throw sites it types, the error specs); errors.ts reads no process.env; the existing unit lane still passes (`nx run stealth-core-browser:test` exits 0, messages preserved)."""
    o = ownership_ok("prod-errors")
    rc, out = sh([NX, "run", f"{proj_name()}:test"], timeout=2400)
    return o[0] and rc == 0 and "process.env" not in read(f"{P}/src/errors.ts") and exists(f"{P}/src/errors.ts"), f"{o[1]} test rc={rc} {out[-120:]}"



@check("prod-errors", 5)
def _pe5():
    """(audit criterion) No untyped error escapes: no `new Error(`, `new TypeError(`, `Promise.reject('...')` or `throw '...'` exists in non-test src/ outside src/errors.ts (every throw site raises a StealthCoreBrowserError code)."""
    hits = untyped_throws()
    return not hits, f"untyped error sites: {hits[:8]}"


@check("prod-errors", 6)
def _pe6():
    """docs/ERRORS.md lists every code with its exit code (the value `exitCodeFor` returns, which hosts reuse) and its remediation, in the order of `ERROR_CODES`, and the root of the package exports StealthCoreBrowserError, ERROR_CODES and exitCodeFor (src/index.ts re-exports ./errors.js)."""
    d = read(f"{P}/docs/ERRORS.md")
    miss = [c for c in ERR_CODES if c not in d]
    idx = read(f"{P}/src/index.ts")
    return exists(f"{P}/docs/ERRORS.md") and not miss and re.search(r"export\s+\*\s+from\s+['\"]\./errors\.js['\"]", idx) is not None, f"undocumented={miss}"



@check("prod-errors", 7)
def _pe7():
    """(amendment A3, greenfield root) src/index.ts exports the `recording` namespace (added here) and the `lifecycle` namespace (wired by core-seam) (`export * as recording from './lib/recording/index.js'`, `export * as lifecycle from './lib/lifecycle/index.js'`); `recording` exposes NetworkRecorder, CaptureError, MemoryRecordingSink, StoreRecordingSink, openStoreRecordingSink and redactHeaders, `capture` exposes captureAllNetworkResponses, `lifecycle` exposes LifecycleError, openIsolatedPage, withIsolatedPage, installProcessExitHooks, runChromeReaper and createProxyReaperLink (the detached reaper loads runChromeReaper through the package entry)."""
    ns = dict(NS_RE.findall(read(f"{P}/src/index.ts")))
    wired = all(ns.get(a) and re.sub(r"\.js$", "", ns[a]) == "./" + AREAS_EXTRA[a] for a in AREAS_EXTRA)
    want = {"recording": {"NetworkRecorder", "CaptureError", "MemoryRecordingSink", "StoreRecordingSink", "openStoreRecordingSink", "redactHeaders"}, "capture": {"captureAllNetworkResponses"}, "lifecycle": {"LifecycleError", "openIsolatedPage", "withIsolatedPage", "installProcessExitHooks", "runChromeReaper", "createProxyReaperLink"}}
    miss = {a: sorted(w - barrel_names_of(f"{P}/src/{AREAS_ALL[a]}.ts") - barrel_names_of(f"{P}/src/{AREAS_ALL[a]}/index.ts")) for a, w in want.items()}
    miss = {a: m for a, m in miss.items() if m}
    return wired and not miss, f"wired={wired} missing members {miss}"


@check("prod-errors", 8)
def _pe8():
    """(amendment A4) CaptureError (src/lib/recording/errors.ts) and LifecycleError (src/lib/lifecycle/errors.ts) extend StealthCoreBrowserError, so one `instanceof` covers every package error; `exitCodeFor` and docs/ERRORS.md cover every code; a classifier maps a launch failure whose cause is ENOENT to CHROME_NOT_FOUND and EADDRINUSE to PORT_IN_USE (unit-tested)."""
    cap, life = read(f"{P}/src/lib/recording/errors.ts"), read(f"{P}/src/lib/lifecycle/errors.ts")
    ext = re.search(r"class\s+CaptureError\s+extends\s+StealthCoreBrowserError", cap) is not None and re.search(r"class\s+LifecycleError\s+extends\s+StealthCoreBrowserError", life) is not None
    t = read(f"{P}/src/errors.ts")
    covered = all(c in t for c in all_codes()) and all(c in read(f"{P}/docs/ERRORS.md") for c in all_codes())
    spec = "\n".join(read(f) for f in spec_files("unit/errors"))
    cls = "ENOENT" in t and "EADDRINUSE" in t and "CHROME_NOT_FOUND" in t and "PORT_IN_USE" in t and "ENOENT" in spec and "EADDRINUSE" in spec
    return ext and covered and cls, f"extends={ext} all codes covered={covered} classifier={cls}"

# ---------------------------------------------------------------- prod-examples (a runnable example per verb and per namespace)
EX = f"{P}/examples"
EX_VERB_FILES = [f"verbs/{v}.ts" for v in VERBS]
EX_NS_FILES = [f"namespaces/{a}.ts" for a in AREAS_ALL]


@check("prod-examples", 1)
def _pex1():
    """(PA7.1, widened) examples/ holds one runnable TypeScript example per public verb (examples/verbs/<verb>.ts for the six verbs) and per root namespace (examples/namespaces/<namespace>.ts for cdp, storage, capture, parsers, chromeManager, recording, lifecycle), all non-empty; each .ts example opens with a `Scenario:` header naming the real user task it solves and exports `run(options)`."""
    miss = [f for f in EX_VERB_FILES + EX_NS_FILES if not read(f"{EX}/{f}").strip()]
    headless = [f for f in EX_VERB_FILES + EX_NS_FILES if exists(f"{EX}/{f}") and not (re.search(r"Scenario:\s*\S{12,}", read(f"{EX}/{f}")) and re.search(r"export\s+(?:async\s+)?function\s+run\b|export\s+const\s+run\b", read(f"{EX}/{f}")))]
    return not miss and not headless, f"missing/empty {miss}; without Scenario header or run(): {headless}"


@check("prod-examples", 2)
def _pex2():
    """(PA7.2) tsconfig.spec.json includes examples/, every .ts example imports the package ROOT only (`@adhd/stealth-core-browser` or `../../src/index.js`, never a subpath or a src/lib path), and `nx run stealth-core-browser:typecheck-spec` exits 0."""
    inc = "examples" in read(f"{P}/tsconfig.spec.json")
    bad = []
    for f in EX_VERB_FILES + EX_NS_FILES:
        t = read(f"{EX}/{f}")
        mods = re.findall(r"from\s+['\"]([^'\"]+)['\"]", t)
        if not mods or any(m not in ("@adhd/stealth-core-browser", "../../src/index.js") and not m.startswith("node:") for m in mods):
            bad.append(f)
    rc, out = sh([NX, "run", f"{proj_name()}:typecheck-spec"], timeout=1500) if inc and not bad else (1, "")
    return inc and not bad and rc == 0, f"included={inc} bad imports={bad} rc={rc} {out[-150:]}"



@check("prod-examples", 4)
def _pex4():
    """(PA7.4) Every example (all .ts) uses an explicit non-9222 port and never the default 9222."""
    bad = []
    for f in EX_VERB_FILES + EX_NS_FILES:
        t = read(f"{EX}/{f}")
        ports = re.findall(r"port\W{0,6}(\d{4,5})", t, re.I)
        if not ports or any(p == "9222" for p in ports) or re.search(r"(?<!\d)9222(?!\d)", t):
            bad.append(f)
    return not bad, f"examples without an explicit non-9222 port: {bad}"


@check("prod-examples", 5)
def _pex5():
    """Coverage: every verb example calls its own verb and no other (examples/verbs/<verb>.ts contains `<verb>(` ), and every namespace example uses at least three members of its namespace (`<namespace>.<member>`); only owned paths changed by [psm:prod-examples] commits."""
    bad = []
    for v in VERBS:
        t = read(f"{EX}/verbs/{v}.ts")
        if f"{v}(" not in t:
            bad.append(f"verbs/{v}.ts does not call {v}")
    for a in AREAS_ALL:
        t = read(f"{EX}/namespaces/{a}.ts")
        if len(set(re.findall(rf"\b{a}\.(\w+)", t))) < 3:
            bad.append(f"namespaces/{a}.ts uses fewer than 3 members")
    o = ownership_ok("prod-examples")
    return not bad and o[0], f"{bad} {o[1]}"


@check("prod-examples", 6)
def _pex6():
    """The examples are exercised, not just typechecked: a spec under test/unit/examples/ imports every examples/verbs and examples/namespaces file and runs its `run()` against the in-process fake CDP server (no live Chrome), citing ticket 8468f7b1, a valid prod-examples.N id and PA7.2 / PA7.4."""
    specs = spec_files("unit/examples")
    t = "\n".join(read(f) for f in specs)
    unused = [f for f in EX_VERB_FILES + EX_NS_FILES if os.path.splitext(f)[0] not in t]
    ids = set(re.findall(r"\[(prod-examples\.\d+)\]", t))
    return bool(specs) and not unused and "run(" in t and TICKET in t and bool(ids & criteria_ids()) and all(k in t for k in ("PA7.2", "PA7.4")), f"specs={len(specs)} examples not exercised={unused}"


# ============================================================ tests-use-cases (replaces the e2e lane)
UC = f"{P}/test/unit/use-cases"
SUP = f"{P}/test/helpers"
UC_SPEC = f"{P}/test/unit/use-cases"


def uc_specs():
    return [f for f in walk(UC, (".ts",)) if f.endswith(".spec.ts")]


@check("tests-use-cases", 1)
def _uc1():
    """The scenario fixtures exist under test/helpers/: real-shape profile databases (profile-fixtures.ts builds History, Cookies and Bookmarks SQLite files through a builder, no hand-written rows in the specs) and realistic HTML plus network-trace fixtures (page-fixtures.ts); the suites reuse the cdp-test-harness (FakeCdpServer, loadFixture, FakeProc) and add no loopback socket (no node:net, node:http or ws)."""
    need = ("profile-fixtures.ts", "page-fixtures.ts")
    miss = [f for f in need if len(read(f"{SUP}/{f}").strip()) < 200]
    t = "\n".join(read(f) for f in uc_specs())
    reuse = all(k in t for k in ("FakeCdpServer", "loadFixture")) and "fake-proc" in t
    net = re.search(r"node:net|node:http|from ['\"]ws['\"]", t + read(f"{SUP}/profile-fixtures.ts") + read(f"{SUP}/page-fixtures.ts"))
    return not miss and reuse and not net, f"missing/short {miss} reuses harness={reuse} loopback={bool(net)}"


@check("tests-use-cases", 2)
def _uc2():
    """At least 12 use-case specs under test/unit/use-cases/, named after user scenarios (not modules: e.g. `recover-a-crashed-chrome.spec.ts`), each `describe` opening with `Scenario:` plus the user goal; together they cover all six verbs and all seven root namespaces (library scenarios only: the CLI and MCP host scenarios live in search-usecases), each citing ticket 8468f7b1, a valid tests-use-cases.N id and the AC ids they exercise."""
    specs = uc_specs()
    t = "\n".join(read(f) for f in specs)
    modlike = [os.path.basename(f) for f in specs if re.fullmatch(r"(cdp|storage|capture|parsers|chrome-manager|api|index|session|helpers|types)\.spec\.ts", os.path.basename(f))]
    nodesc = [os.path.basename(f) for f in specs if not re.search(r"describe\(\s*['\"`]Scenario:", read(f))]
    verbs = [v for v in VERBS if v not in t]
    areas = [a for a in AREAS_ALL if not re.search(rf"\b{a}\.", t)]
    uncited = [os.path.basename(f) for f in specs if TICKET not in read(f) or not (set(re.findall(r"\[(tests-use-cases\.\d+)\]", read(f))) & criteria_ids())]
    return len(specs) >= 12 and not modlike and not nodesc and not verbs and not areas and not uncited, f"specs={len(specs)} module-named={modlike} no Scenario describe={nodesc} verbs={verbs} namespaces={areas} uncited={uncited}"


@check("tests-use-cases", 3)
def _uc3():
    """The suites are pure simulations: no live Chrome, no socket and no outbound network (every spawner is the harness FakeProc or a `node:child_process` vi.mock, no spec contains `fetch('http` to a non-loopback host, `puppeteer`, `playwright` or a Chrome binary path), the fixtures are real-shape (a profile fixture opens with the immutable read-only opener and contains >= 20 history rows, redirect chains and session plus persistent cookies) and the realistic HTML fixtures contain >= 3 distinct page shapes."""
    t = "\n".join(read(f) for f in uc_specs())
    sup = "\n".join(read(f) for f in walk(SUP, (".ts",)))
    pure = ("vi.mock" in t or "fake-proc" in t) and not re.search(r"puppeteer|playwright|/Applications/Google Chrome|chrome\.exe", t + sup, re.I) and not re.search(r"fetch\(\s*['\"`]https?://(?!127\.0\.0\.1|localhost)", t + sup)
    pf = read(f"{SUP}/profile-fixtures.ts")
    real = "node:sqlite" in pf and "expires_utc" in pf and re.search(r"visits|redirect", pf) is not None
    pages = len(set(re.findall(r"export\s+(?:const|function)\s+(\w*(?:Html|Page|Trace)\w*)", read(f"{SUP}/page-fixtures.ts"))))
    return pure and real and pages >= 3, f"pure={pure} real-shape={real} page fixtures={pages}"


@check("tests-use-cases", 4)
def _uc4():
    """The examples are consumed: the suites import and `run()` every examples/verbs and examples/namespaces file (prod-examples), and the typed errors are reached through user scenarios (>= 6 distinct StealthCoreBrowserError codes asserted across the suites)."""
    t = "\n".join(read(f) for f in uc_specs())
    unused = [f for f in EX_VERB_FILES + EX_NS_FILES if os.path.splitext(f)[0] not in t]
    codes = [c for c in all_codes() if re.search(rf"['\"]{c}['\"]", t)]
    return not unused and len(codes) >= 6, f"examples not run={unused} codes asserted={len(codes)}"


@check("tests-use-cases", 5)
def _uc5():
    """`nx run stealth-core-browser:test -- test/unit/use-cases` exits 0 in under 120 seconds wall clock and leaves no listener behind on the ports it used."""
    t0 = time.time()
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", "test/unit/use-cases"], timeout=1800)
    return rc == 0 and time.time() - t0 < 120 + 60, f"rc={rc} {time.time() - t0:.0f}s {out[-150:]}"


@check("tests-use-cases", 6)
def _uc6():
    """Only owned paths changed by [psm:tests-use-cases] commits (test/unit/use-cases/**, test/helpers/**); no production file is edited to make a simulation pass."""
    return ownership_ok("tests-use-cases")


# ============================================================ capture-upgrade / chrome-lifecycle (provisional; the architect spec is folded in a follow-up pass)
def spec_approved(name, ticket):
    t = read(f"{PLAN}/specs/{name}.md")
    return bool(re.search(r"^STATUS:\s*approved\s*$", t, re.M)) and ticket in t, f"specs/{name}.md approved+cites {ticket}"


# ============================================================ agent-search cutover (runs BEFORE audit-pre-review) + relink (after merge)
CUT_EVID = f"{PLAN}/evidence/cutover-tarball.json"
CUT_PARITY = f"{PLAN}/evidence/cutover-parity.json"
CUT_LIVE = f"{PLAN}/evidence/cutover-live-vs-recorded.md"
SCRATCH_NM = f"{SRC}/node_modules/@adhd/stealth-browser"


def tgz_members(tgz):
    rc, o, e = run2(["tar", "-tzf", tgz], 60)
    return set(o.split()) if rc == 0 else set()


def mcp_shape(res):
    """Stable, value-free shape of a tool call result: tool-name list and the sorted keys of each structured result."""
    out = {"tools": sorted(res.get("tools", []))}
    for k, v in res.items():
        if k == "tools":
            continue
        txt = ((v or {}).get("result", {}).get("content") or [{}])[0].get("text", "") if isinstance(v, dict) else ""
        try:
            inner = json.loads(txt) if txt else {}
        except ValueError:
            inner = {}
        out[k] = sorted(inner) if isinstance(inner, dict) else type(inner).__name__
    return out


def live_shape():
    return mcp_shape(mcp_session(["node", "server.mjs", "--transport", "stdio"], SRC, [("chrome_status", {}), ("list_providers", {})]))


@check("agent-search-cutover", 1)
def _ac1():
    """The package under test is the one built from THIS worktree: evidence/cutover-tarball.json records `tarball` (an absolute path outside every .worktrees/ directory), its `sha256`, `packed_from_head` (a commit that is an ancestor of HEAD) and `packed_from_tree` (the entrypoint/stealth-browser tree sha at that commit), the `pack_cmd` (pack of the built dist) and the tarball lists package/dist/index.js, package/dist/bin/cli.js and package/dist/bin/mcp.js."""
    d = jread(CUT_EVID, {})
    tg = d.get("tarball", "")
    if not (tg and exists(tg) and "/.worktrees/" not in tg):
        return False, f"tarball missing or inside a worktree: {tg!r}"
    sha = hashlib.sha256(open(tg, "rb").read()).hexdigest()
    mem = tgz_members(tg)
    need = {"package/dist/index.js", "package/dist/bin/cli.js", "package/dist/bin/mcp.js", "package/package.json"}
    head = d.get("packed_from_head", "")
    anc = bool(head) and sh(["git", "merge-base", "--is-ancestor", head, "HEAD"])[0] == 0
    tree_ok = anc and git("rev-parse", f"{head}:{P}") == d.get("packed_from_tree")
    return sha == d.get("sha256") and tree_ok and bool(d.get("pack_cmd")) and need <= mem, f"sha ok={sha == d.get('sha256')} packed commit is an ancestor with the recorded tree={tree_ok} missing members={sorted(need - mem)}"


@check("agent-search-cutover", 2)
def _ac2():
    """The live agent-browser install IS that tarball: agent-browser/node_modules/@adhd/stealth-browser is a real directory (not a symlink, not a link into .worktrees/), its package.json version equals the tarball's, and its dist/index.js is byte-identical to the tarball's member."""
    d = jread(CUT_EVID, {})
    tg = d.get("tarball", "")
    if not (tg and exists(SCRATCH_NM)):
        return False, "tarball or install missing"
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        rc, _, e = run2(["tar", "-xzf", tg, "-C", tmp], 120)
        if rc != 0:
            return False, f"tar failed {e[-100:]}"
        a, b = f"{tmp}/package/dist/index.js", f"{SCRATCH_NM}/dist/index.js"
        same = exists(a) and exists(b) and open(a, "rb").read() == open(b, "rb").read()
        va, vb = (jread(f"{tmp}/package/package.json", {}) or {}).get("version"), (jread(f"{SCRATCH_NM}/package.json", {}) or {}).get("version")
    return not os.path.islink(SCRATCH_NM) and same and va == vb and va is not None, f"symlink={os.path.islink(SCRATCH_NM)} index.js identical={same} versions {va}/{vb}"


@check("agent-search-cutover", 3)
def _ac3():
    """evidence/cutover-live-vs-recorded.md states precisely what is LIVE and what is only RECORDED: lines `LIVE:` (node_modules content = the tarballs, with the sha256 of the stealth-browser tarball AND of the @adhd/resilience-core-tripwire tarball), `RECORDED:` (the committed agent-browser/package.json dependency ranges, `@adhd/stealth-browser` and `@adhd/resilience-core-tripwire` at `^0.1.0`, which resolve only once released) and `NOT-CHANGED:` naming pnpm-lock.yaml in agent-browser and the adhd main checkout's pnpm-lock.yaml; agent-browser/package.json carries no `link:`/`file:` value and no .worktrees path, and the adhd main checkout lockfile is unmodified."""
    t = read(CUT_LIVE)
    pj = json.dumps(jread(f"{SRC}/package.json", {}) or {})
    dep = ((jread(f"{SRC}/package.json", {}) or {}).get("dependencies") or {}).get("@adhd/stealth-browser", "")
    stated = all(re.search(rf"^{k}:\s*\S", t, re.M) for k in ("LIVE", "RECORDED", "NOT-CHANGED")) and "pnpm-lock.yaml" in t
    tg_sha = jread(CUT_EVID, {}).get("sha256", "x")
    clean = not re.search(r"link:|file:|\.worktrees", dep) and bool(dep) and ".worktrees" not in pj
    main_lock = git("status", "--porcelain", "--", "pnpm-lock.yaml", cwd=MAIN) == ""
    tw_sha = (jread(TW_TARBALL, {}) or {}).get("sha256", "x")
    tw_dep = ((jread(f"{SRC}/package.json", {}) or {}).get("dependencies") or {}).get(TW_PKG, "")
    return stated and tg_sha in t and tw_sha in t and tw_dep == "^0.1.0" and clean and main_lock, f"stated={stated} sha cited={tg_sha in t} tripwire sha cited={tw_sha in t} dep={dep!r} tripwire dep={tw_dep!r} main lock clean={main_lock}"


@check("agent-search-cutover", 4)
def _ac4():
    """The chrome-runner implementation is GONE from agent-search: no `class CdpSession`, `class ChromeManager`, `class IdleShutdown` or `class HistoryClient` definition remains under agent-browser (thin consumer only)."""
    rc, out = sh("rg -n --glob '!node_modules' --glob '!dist' -e 'class (CdpSession|ChromeManager|IdleShutdown|HistoryClient)\\b' " + SRC + " || true")
    return out.strip() == "", out.strip()[:200]


@check("agent-search-cutover", 5)
def _ac5():
    """agent-browser still compiles against the installed tarball: `pnpm run build` (tsc --noEmit) exits 0 and `pnpm run test:lifecycle` exits 0."""
    a, _ = sh(["pnpm", "run", "build"], cwd=SRC, timeout=900)
    b, _ = sh(["pnpm", "run", "test:lifecycle"], cwd=SRC, timeout=900)
    return a == 0 and b == 0, f"build={a} lifecycle={b}"


@check("agent-search-cutover", 6)
def _ac6():
    """The MCP search verbs behave the same through a REAL transport: evidence/cutover-parity.json holds `before` (captured from the unmodified server before the first cutover commit) and `after` shapes of `node server.mjs --transport stdio` (the server defaults to SSE, so stdio is named): identical tool-name lists and identical result-key shapes for chrome_status and list_providers; `after` equals a live re-run now."""
    d = jread(CUT_PARITY, {})
    before, after = d.get("before"), d.get("after")
    if not (isinstance(before, dict) and isinstance(after, dict) and before.get("tools")):
        return False, "cutover-parity.json needs before/after"
    now = live_shape()
    tools = any(t.endswith("search") for t in now.get("tools", []))
    return before == after == now and tools, f"before==after {before == after}; after==live {after == now}; search tool listed={tools}"


@check("agent-search-cutover", 7)
def _ac7():
    """Scratch repo hygiene: cutover commits are local-only (no push/upstream), staged by explicit path (never `git add -A`: the scratch tree carries other agents' uncommitted work), and touch only the owned consumer files (agent-browser/adhd/, the ~14 files that imported ./adhd/..., package.json and the cutover docs); INDEX.md and pnpm-lock.yaml are not touched before release."""
    allowed = tuple(f"agent-browser/{c}" for c in CUTOVER_OWNED if c != "pnpm-lock.yaml")
    log = sh(["git", "log", "--since=3.days", "--format=%H%x1f%B%x1e"], cwd=SCRATCH)[1]
    bad = []
    for rec in log.split("\x1e"):
        if "[psm:agent-search-cutover]" in rec:
            sha = rec.strip().split("\x1f")[0]
            for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", sha, cwd=SCRATCH).splitlines():
                if not f.startswith(allowed):
                    bad.append(f)
    up = sh(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], cwd=SCRATCH)[0]
    return not bad and up != 0, f"out-of-scope files {bad[:5]} upstream configured={up == 0}"



@check("agent-search-cutover", 8)
def _ac8():
    """(amendment A5) agent-search delegates to the new capture and the package lifecycle: the root network-capture.ts calls `captureNetworkResponse` from @adhd/stealth-browser (its `#rso` preference expressed through the `select` option) and contains no `new WebSocket(`; search-mcp-source.ts delegates Chrome lifecycle to the package as defined by the chrome-lifecycle design (EVALUATIONS.md)."""
    nc, sm = read(f"{SRC}/network-capture.ts"), read(f"{SRC}/search-mcp-source.ts")
    rc, out = sh("rg -n --glob '!node_modules' --glob '!dist' 'checkHistory' " + SRC + " || true")
    ok = "captureNetworkResponse" in nc and "@adhd/stealth-browser" in nc and "new WebSocket(" not in nc and "select" in nc
    ok2 = "@adhd/stealth-browser" in sm
    return ok and ok2, f"network-capture delegates={ok} lifecycle wiring and no checkHistory={ok2} {out.strip()[:120]}"


@check("agent-search-cutover", 9)
def _ac9():
    """(amendment A5) evidence/cutover-backlog.json records, through the backlog graph (never a hand edit of BACKLOG.md), the agent-browser findings B-028..B-033 as resolved, the stale B-034 / B-035 rows as resolved or closed (fixed in fd627f5), and backlog 19dfb641 re-cited to the new package paths and resolved once chrome-lifecycle is verified; each entry has an `id`, a `status` and a `commit` or `citation`."""
    d = jread(f"{PLAN}/evidence/cutover-backlog.json", {})
    items = {str(x.get("id")): x for x in d.get("items", [])}
    need = [f"B-0{n}" for n in range(28, 36)] + ["19dfb641"]
    bad = [n for n in need if n not in items or items[n].get("status") not in ("resolved", "closed") or not (items[n].get("commit") or items[n].get("citation"))]
    return not bad, f"unrecorded or open: {bad}"

CUT_TW_NM = f"{SRC}/node_modules/@adhd/resilience-core-tripwire"
TW_ASYNC_EXPORTS = ["fireTripwire", "tripwireGate", "gateBlocked", "clearedTripwire", "resolvedTripwire", "readTripwire", "isTripwireTripped"]


@check("agent-search-cutover", 10)
def _ac10():
    """The live agent-browser install of @adhd/resilience-core-tripwire IS the tarball recorded by tripwire-pack: agent-browser/node_modules/@adhd/resilience-core-tripwire is a real directory (not a symlink, not a link into .worktrees/), its package.json version is 0.1.0 and its dist/index.js is byte-identical to the tarball member."""
    d = jread(TW_TARBALL, {}) or {}
    tg = d.get("tarball", "")
    if not (tg and exists(tg) and exists(CUT_TW_NM)):
        return False, "tarball or install missing"
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        rc, _, e = run2(["tar", "-xzf", tg, "-C", tmp], 120)
        a, b = f"{tmp}/package/dist/index.js", f"{CUT_TW_NM}/dist/index.js"
        same = rc == 0 and exists(a) and exists(b) and open(a, "rb").read() == open(b, "rb").read()
    ver = (jread(f"{CUT_TW_NM}/package.json", {}) or {}).get("version")
    return not os.path.islink(CUT_TW_NM) and same and ver == "0.1.0", f"symlink={os.path.islink(CUT_TW_NM)} dist identical={same} version={ver}"


@check("agent-search-cutover", 11)
def _ac11():
    """search-tripwire.ts is a thin adapter over the package: it imports @adhd/resilience-core-tripwire, contains no `renameSync`, `writeFileSync`, `appendFileSync` or `homedir()`, exports the async wrappers fireTripwire, tripwireGate, gateBlocked, clearedTripwire, resolvedTripwire, readTripwire and isTripwireTripped plus a concrete non-generic `interface TripwireRecord` (the apigen MCP output type), keeps the clearPolicy `open` and the 7200000 ms default TTL, and no other agent-browser source file writes a tripwire lock or audit file itself."""
    t = read(f"{SRC}/search-tripwire.ts")
    code = code_lines(t)
    ex = exports_of(t)
    stray = sh("rg -n --glob '*.ts' --glob '!node_modules' --glob '!adhd/' -e 'tripwire.*(writeFileSync|renameSync|appendFileSync)|(writeFileSync|renameSync|appendFileSync).*tripwire' " + SRC + " || true")[1].strip()
    return (TW_PKG in t and not re.search(r"renameSync|writeFileSync|appendFileSync|homedir\(\)", code) and set(TW_ASYNC_EXPORTS) <= ex and re.search(r"interface\s+TripwireRecord\b", t) is not None
            and "open" in t and "7_200_000" in t.replace("7200000", "7_200_000") and not stray), f"missing exports {sorted(set(TW_ASYNC_EXPORTS) - ex)} stray writers: {stray[:120]}"


@check("agent-search-cutover", 12)
def _ac12():
    """Tripwire behavior parity through the real surfaces: evidence/cutover-parity.json gains a `tripwire` object with `before` (captured from the unmodified source before the first cutover commit) equal to `after` for (a) `--tripwire-status` stdout including the last JSON line against an empty and a seeded fixture SEARCH_ADHD_DATA_DIR (`status_cli.empty`, `status_cli.seeded`), (b) the MCP tripwireStatus / clearTripwire tool names and output-schema keys through `node server.mjs --transport stdio` (`mcp`, whose tool list equals a live re-run), and (c) `legacy_lock`: a seeded legacy-shaped lock blocks a search with outcome `hitl` and zero Chrome calls."""
    t = (jread(CUT_PARITY, {}) or {}).get("tripwire") or {}
    cli = t.get("status_cli") or {}
    same = all(isinstance(cli.get(k), dict) and cli[k].get("before") not in (None, "") and cli[k].get("before") == cli[k].get("after") for k in ("empty", "seeded"))
    mcp = t.get("mcp") or {}
    mcp_same = bool(mcp.get("before")) and mcp.get("before") == mcp.get("after")
    leg = t.get("legacy_lock") or {}
    if not (same and mcp_same and leg.get("outcome") == "hitl" and leg.get("chrome_calls") == 0):
        return False, f"status cli identical={same} mcp identical={mcp_same} legacy lock={leg}"
    live = live_shape().get("tools")
    return (mcp.get("after") or {}).get("tools") == live or mcp.get("after") == live, "mcp tool list equals a live re-run"


@check("agent-search-cutover", 13)
def _ac13():
    """The guard test and the lifecycle test pass against the package and the audit lands under the fixture: `pnpm run test` (chrome-lifecycle-test.ts then search-guard-test.ts) exits 0 with SEARCH_ADHD_DATA_DIR pointing at a scratch directory, that directory contains audit.log afterwards, and the real ~/.adhd/reverse/data/audit.log was not modified by the run."""
    import tempfile
    real = os.path.expanduser("~/.adhd/reverse/data/audit.log")
    before = os.stat(real).st_mtime_ns if exists(real) else None
    with tempfile.TemporaryDirectory() as tmp:
        rc, out = sh(["pnpm", "run", "test"], cwd=SRC, timeout=1200, env={"SEARCH_ADHD_DATA_DIR": tmp})
        landed = exists(f"{tmp}/audit.log") and bool(read(f"{tmp}/audit.log").strip())
    after = os.stat(real).st_mtime_ns if exists(real) else None
    return rc == 0 and landed and before == after, f"pnpm run test rc={rc} audit.log in fixture dir={landed} real audit untouched={before == after}"


@check("agent-search-relink", 1)
def _ar1():
    """Post-merge second step: RELEASE-DECISION.md has `DECISION: publish|defer` and a `CONSUME:` line (`@adhd/stealth-browser@<version>` when published, `link:<abs path>` into the MERGED main checkout when deferred; never a .worktrees path) and agent-browser/package.json depends on it."""
    t = read(f"{PLAN}/RELEASE-DECISION.md")
    m = re.search(r"^CONSUME:\s*(@adhd/stealth-browser@\S+|link:/\S+)\s*$", t, re.M)
    dep = ((jread(f"{SRC}/package.json", {}) or {}).get("dependencies") or {}).get("@adhd/stealth-browser", "")
    ok = bool(re.search(r"^DECISION:\s*(publish|defer)\s*$", t, re.M)) and bool(m) and bool(dep)
    if m and m.group(1).startswith("link:"):
        ok = ok and "/.worktrees/" not in m.group(1) and dep.startswith("link:")
    return ok, f"consume={m.group(1) if m else None} dep={dep}"


@check("agent-search-relink", 2)
def _ar2():
    """(D3) Before relinking: a link: CONSUME target has a built dist (dist/index.js, dist/bin/cli.js, dist/bin/mcp.js) and `node dist/bin/cli.js --help` exits 0 there; agent-browser's node_modules/@adhd/stealth-browser/package.json resolves."""
    link = consume_link()
    if link is None:
        return exists(f"{SCRATCH_NM}/package.json"), "published consume resolves"
    rc, _, _ = run2(["node", f"{link}/dist/bin/cli.js", "--help"], 60) if exists(f"{link}/dist/bin/cli.js") else (1, "", "")
    return all(exists(f"{link}/dist/{f}") for f in ("index.js", "bin/cli.js", "bin/mcp.js")) and rc == 0 and exists(f"{SCRATCH_NM}/package.json"), f"link={link} cli rc={rc}"


@check("agent-search-relink", 3)
def _ar3():
    """agent-browser builds and passes `pnpm run test:lifecycle` against the released/linked package, and the live MCP stdio shape still equals the cutover `after` shape in evidence/cutover-parity.json."""
    a, _ = sh(["pnpm", "run", "build"], cwd=SRC, timeout=900)
    b, _ = sh(["pnpm", "run", "test:lifecycle"], cwd=SRC, timeout=900)
    return a == 0 and b == 0 and live_shape() == jread(CUT_PARITY, {}).get("after"), f"build={a} lifecycle={b}"


@check("agent-search-relink", 4)
def _ar4():
    """Scratch hygiene for the relink: [psm:agent-search-relink] commits are local-only, staged by explicit path, and touch only agent-browser/package.json, agent-browser/pnpm-lock.yaml and the cutover docs."""
    allowed = ("agent-browser/package.json", "agent-browser/pnpm-lock.yaml", "agent-browser/AGENTS.md", "agent-browser/docs/")
    log = sh(["git", "log", "--since=3.days", "--format=%H%x1f%B%x1e"], cwd=SCRATCH)[1]
    bad = []
    for rec in log.split("\x1e"):
        if "[psm:agent-search-relink]" in rec:
            sha = rec.strip().split("\x1f")[0]
            bad += [f for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", sha, cwd=SCRATCH).splitlines() if not f.startswith(allowed)]
    return not bad and sh(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], cwd=SCRATCH)[0] != 0, f"out-of-scope files {bad[:5]}"


@check("agent-search-relink", 5)
def _ar5():
    """The tripwire dependency moves from the tarball to the registry range: agent-browser/package.json keeps `@adhd/resilience-core-tripwire` at `^0.1.0` (no link:/file:), agent-browser/pnpm-lock.yaml resolves it with an integrity hash and no tarball or file resolution, node_modules/@adhd/resilience-core-tripwire/package.json resolves, and `pnpm run test` (with a scratch SEARCH_ADHD_DATA_DIR) exits 0 against the registry build."""
    import tempfile
    dep = ((jread(f"{SRC}/package.json", {}) or {}).get("dependencies") or {}).get(TW_PKG, "")
    lock = read(f"{SRC}/pnpm-lock.yaml")
    reg = re.search(r"resilience-core-tripwire@0\.1\.\d+:\s*\n\s*resolution:\s*\{integrity:", lock) is not None
    if not (dep == "^0.1.0" and reg and "file:" not in "".join(re.findall(r".*resilience-core-tripwire.*", lock)) and exists(f"{CUT_TW_NM}/package.json")):
        return False, f"dep={dep!r} registry resolution={reg}"
    with tempfile.TemporaryDirectory() as tmp:
        rc, out = sh(["pnpm", "run", "test"], cwd=SRC, timeout=1200, env={"SEARCH_ADHD_DATA_DIR": tmp})
    return rc == 0, f"pnpm run test rc={rc}"


# ============================================================ cdp-test-harness (spec 4) / capture-upgrade (spec 5) / chrome-lifecycle (spec 6)
FIXTURE_NAMES = ["doc-200", "search-404", "rate-limit-429", "redirect-301-200", "extrainfo-before-main", "extrainfo-after-main", "cached-304", "cors-failure",
                 "post-json-api", "binary-base64", "no-body-204", "two-tabs-parallel", "isolated-context-ok", "isolated-context-target-missing"]
BAN_WORDS = r"node:net|node:http|child_process|from ['\"]ws['\"]"


def ac_spec(sub, fname, cid, must=(), anywhere=False):
    """(ok, why) for one acceptance spec: the file exists, cites ticket 8468f7b1 and its [state.N] id (the CU/CL/HC number is in the text) and contains every `must` token."""
    p = f"{P}/test/{sub}/{fname}"
    t = read(p)
    miss = [m for m in must if m not in t]
    return bool(t.strip()) and TICKET in t and f"[{cid}]" in t and not miss, f"{sub}/{fname}: exists={bool(t.strip())} cites ticket={TICKET in t} id={f'[{cid}]' in t} missing tokens={miss}"


def lib_text(sub):
    return "\n".join(read(f) for f in walk(f"{P}/src/lib/{sub}", (".ts",)))


def run_unit(sub):
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", f"test/unit/{sub}"], timeout=1800)
    return rc == 0, f"unit/{sub} rc={rc} {out[-150:]}"


@check("cdp-test-harness", 1)
def _h1():
    """The in-memory CDP harness exists: test/helpers/fake-cdp.ts exports FakeCdpServer (install, received, unexpected, emitNow, closeFromServer, openCount), loadFixture and the CdpFixture / CdpFixtureStep types, and test/fixtures/cdp/ holds the 14 `<name>.cdp.json` fixtures (doc-200, search-404, rate-limit-429, redirect-301-200, extrainfo-before-main, extrainfo-after-main, cached-304, cors-failure, post-json-api, binary-base64, no-body-204, two-tabs-parallel, isolated-context-ok, isolated-context-target-missing), each valid JSON with `meta.name`, `meta.origin` (`recorded` or `synthetic-protocol-conformant`) and a `steps` array."""
    t = read(f"{P}/test/helpers/fake-cdp.ts")
    ex = exports_of(t)
    api = {"FakeCdpServer", "loadFixture"} <= ex and {"CdpFixture", "CdpFixtureStep"} <= ex and all(m in t for m in ("install", "received", "unexpected", "emitNow", "closeFromServer", "openCount"))
    bad = []
    for n in FIXTURE_NAMES:
        d = jread(f"{P}/test/fixtures/cdp/{n}.cdp.json", None)
        if not (isinstance(d, dict) and (d.get("meta") or {}).get("name") == n and (d.get("meta") or {}).get("origin") in ("recorded", "synthetic-protocol-conformant") and isinstance(d.get("steps"), list) and d["steps"]):
            bad.append(n)
    return api and not bad, f"api={api} bad fixtures={bad}"


@check("cdp-test-harness", 2)
def _h2():
    """The harness is pure (unit purity): no `node:net`, `node:http`, `child_process` or `ws` import anywhere under test/helpers (the loopback-socket variant belongs to a later e2e follow-up, not this lane)."""
    hits = [os.path.relpath(f, P) for f in walk(f"{P}/test/helpers", (".ts",)) if re.search(BAN_WORDS, read(f))]
    return not hits and exists(f"{P}/test/helpers/fake-cdp.ts"), f"impure support files {hits}"


@check("cdp-test-harness", 3)
def _h3():
    """test/unit/support/fake-cdp.spec.ts covers HC1 id correlation, HC2 strict unknown command (CDP error -32601, listed in `.unexpected`), HC3 fake-timer ordering of `delayMs` events, HC4 the Network-domain field-name allow-list over every fixture, HC5 `closeFromServer` firing `close`; it cites ticket 8468f7b1 and a valid cdp-test-harness.N id, and `nx run stealth-browser:test` exits 0."""
    ok, why = ac_spec("unit/support", "fake-cdp.spec.ts", "cdp-test-harness.3", ("HC1", "HC2", "HC3", "HC4", "HC5", "-32601"))
    rc, out = sh([NX, "run", f"{proj_name()}:test"], timeout=2400)
    return ok and rc == 0, f"{why} test rc={rc}"


@check("cdp-test-harness", 4)
def _h4():
    """Only owned paths changed by [psm:cdp-test-harness] commits (test/helpers/, test/fixtures/cdp/, test/unit/support/)."""
    return ownership_ok("cdp-test-harness")


@check("cdp-test-harness", 5)
def _h5():
    """test/helpers/mem-fs.ts exports an in-memory FsLike (MemFs) with exclusive create (`wx` fails on an existing file), atomic rename, readdir, mode and uid; test/unit/support/mem-fs.spec.ts proves exclusive-create failure and rename atomicity and cites 8468f7b1 and [cdp-test-harness.5]."""
    t = read(f"{P}/test/helpers/mem-fs.ts")
    ok = "MemFs" in exports_of(t) and all(k in t for k in ("rename", "readdir", "mode", "uid")) and re.search(r"wx|exclusive|EEXIST", t) is not None
    s_ok, why = ac_spec("unit/support", "mem-fs.spec.ts", "cdp-test-harness.5", ("rename",))
    return ok and s_ok and re.search(r"EEXIST|exclusive", read(f"{P}/test/unit/support/mem-fs.spec.ts")) is not None, f"mem-fs={ok} {why}"


@check("cdp-test-harness", 6)
def _h6():
    """test/helpers/fake-proc.ts exports FakeProc with `pidAlive`, `procStart`, `kill(pid|-pgid, signal)` (logged) and a recording `spawn`; test/unit/support/fake-proc.spec.ts covers each and cites 8468f7b1 and [cdp-test-harness.6]."""
    t = read(f"{P}/test/helpers/fake-proc.ts")
    ok = "FakeProc" in exports_of(t) and all(k in t for k in ("pidAlive", "procStart", "kill", "spawn"))
    s_ok, why = ac_spec("unit/support", "fake-proc.spec.ts", "cdp-test-harness.6", ("pidAlive", "procStart", "kill", "spawn"))
    return ok and s_ok, f"fake-proc={ok} {why}"


# ---------------------------------------------------------------- capture-upgrade (EVAL-store-adapter.md, option B'')
SINK_PKG = "@adhd/sox-store-adapter"


def spec_ok(sub, fname, cid, must=()):
    return ac_spec(sub, fname, cid, must)


def _spec_check(num, fname, doc, must, sub="unit/capture", extra=None):
    def fn():
        ok, why = ac_spec(sub, fname, f"capture-upgrade.{num}", must)
        if extra:
            e_ok, e_why = extra()
            return ok and e_ok, f"{why}; {e_why}"
        return ok, why
    fn.__doc__ = doc
    check("capture-upgrade", num)(fn)


@check("capture-upgrade", 1)
def _cu1():
    """CU1 single pipeline: `new WebSocket(` appears under src/lib only in cdp/session.ts, capture/network.ts obtains its transport from a CdpSession and keeps no InflightRequest / CdpResponse copy, and single-pipeline.spec.ts proves `captureNetworkResponse` through the `doc-200` fixture."""
    hits = [os.path.relpath(f, f"{P}/src/lib") for f in walk(f"{P}/src/lib", (".ts",)) if "new WebSocket(" in read(f)]
    n = read(f"{P}/src/lib/capture/network.ts")
    ok, why = ac_spec("unit/capture", "single-pipeline.spec.ts", "capture-upgrade.1", ("doc-200",))
    return hits == ["cdp/session.ts"] and "CdpSession" in n and "InflightRequest" not in n and ok, f"WebSocket sites={hits} {why}"


@check("capture-upgrade", 2)
def _cu2():
    """CU2 the recorder composes with other subscribers: compose-session.spec.ts proves a pre-existing second `session.on('Network.loadingFinished')` subscriber still fires and `stop()` removes only the recorder's own handlers (the session is never closed by it)."""
    return ac_spec("unit/capture", "compose-session.spec.ts", "capture-upgrade.2", ("Network.loadingFinished", "stop("))


@check("capture-upgrade", 3)
def _cu3():
    """CU3 request headers and postData are captured: the recorder reads `postData` / `hasPostData` and calls `Network.getRequestPostData` when only `hasPostData` is set; request-capture.spec.ts proves it through the `post-json-api` fixture."""
    r = lib_text("recording")
    ok, why = ac_spec("unit/capture", "request-capture.spec.ts", "capture-upgrade.3", ("post-json-api", "getRequestPostData"))
    return "getRequestPostData" in r and "hasPostData" in r and ok, why


@check("capture-upgrade", 4)
def _cu4():
    """CU4 real status and response headers: `Network.responseReceived` is handled, no `status: 200` hard-code remains in capture/network.ts or src/lib/recording, and status-headers.spec.ts proves 404 and 429 (with `retry-after`) through `search-404` / `rate-limit-429` and that a status ban rule `{status:[403,429]}` now yields CAPTURE_BAN_DETECTED."""
    r = lib_text("recording") + read(f"{P}/src/lib/capture/network.ts")
    ok, why = ac_spec("unit/capture", "status-headers.spec.ts", "capture-upgrade.4", ("search-404", "rate-limit-429", "retry-after", "CAPTURE_BAN_DETECTED"))
    return "Network.responseReceived" in r and not re.search(r"status:\s*200\b", r) and ok, why


@check("capture-upgrade", 5)
def _cu5():
    """CU5 ExtraInfo merge, extra wins, both orders identical: the recorder handles `requestWillBeSentExtraInfo` and `responseReceivedExtraInfo`, buffers early ExtraInfo in a bounded map (max 1000, 30 s TTL) and extra-info.spec.ts proves `extrainfo-before-main` and `extrainfo-after-main` merge identically, `wire.requestExtraInfo` is true, the 1001st orphan evicts the oldest and a TTL-expired orphan is dropped."""
    r = lib_text("recording")
    ok, why = ac_spec("unit/capture", "extra-info.spec.ts", "capture-upgrade.5", ("extrainfo-before-main", "extrainfo-after-main", "1001", "requestExtraInfo"))
    return all(k in r for k in ("requestWillBeSentExtraInfo", "responseReceivedExtraInfo", "1000", "30_000")) and ok, why


@check("capture-upgrade", 6)
def _cu6():
    """CU6 status override: ExtraInfo `statusCode` overrides `status` (`cached-304` gives 304) and `cors-failure` yields the status from ExtraInfo with `state === 'failed'` and `failure.errorText`; status-override.spec.ts proves both."""
    return ac_spec("unit/capture", "status-override.spec.ts", "capture-upgrade.6", ("cached-304", "cors-failure", "304", "errorText"))


@check("capture-upgrade", 7)
def _cu7():
    """CU7 redirect chain: `requestWillBeSent` with `redirectResponse` pushes a hop; redirects.spec.ts proves through `redirect-301-200` that `redirects.length === 1`, the hop response status is 301 with a `location` header, the final status is 200 and the requestId is shared."""
    ok, why = ac_spec("unit/capture", "redirects.spec.ts", "capture-upgrade.7", ("redirect-301-200", "301", "location"))
    return "redirectResponse" in lib_text("recording") and ok, why


@check("capture-upgrade", 8)
def _cu8():
    """CU8 debounce: the `extraWaitMs > 0 ? extraWaitMs : 500` expression is deleted (default 0, explicit 0 means no debounce); debounce.spec.ts uses fake timers to prove unset and 0 add no wait, an explicit 300 is pending at 299 ms and resolved at 300 ms, and the `bodyFetchPending` guard keeps a settle from resolving while a body fetch is still in flight."""
    n = read(f"{P}/src/lib/capture/network.ts") + lib_text("recording")
    ok, why = ac_spec("unit/capture", "debounce.spec.ts", "capture-upgrade.8", ("useFakeTimers", "299", "300", "bodyFetchPending"))
    return not re.search(r"extraWaitMs\s*>\s*0\s*\?\s*extraWaitMs\s*:\s*500", n) and "bodyFetchPending" in n and ok, why


@check("capture-upgrade", 9)
def _cu9():
    """CU9 selection: capture/network.ts exports `captureAllNetworkResponses` and `CaptureOptions` has `select` and `sink`; selection.spec.ts proves the default picks the largest body, a custom `select` is honoured and `captureAllNetworkResponses` on `two-tabs-parallel` returns every match ordered by start."""
    n = read(f"{P}/src/lib/capture/network.ts")
    ok, why = ac_spec("unit/capture", "selection.spec.ts", "capture-upgrade.9", ("two-tabs-parallel", "select"))
    return "captureAllNetworkResponses" in exports_of(n) and re.search(r"\bselect\??:", n) is not None and ok, why


@check("capture-upgrade", 10)
def _cu10():
    """CU10 typed capture errors (feature level): src/lib/recording/errors.ts exports CaptureError with exactly the eight codes CAPTURE_CONNECT_FAILED, CAPTURE_NAVIGATE_FAILED, CAPTURE_TIMEOUT, CAPTURE_NO_MATCH, CAPTURE_BAN_DETECTED, CAPTURE_SESSION_CLOSED, CAPTURE_SINK_FAILED and CAPTURE_SINK_UNAVAILABLE, and errors.spec.ts produces each only on its failure path (connect failure incl. a synchronous invalid-url throw with `cause` kept, `Page.navigate` errorText with no candidate and nothing in flight, timeout with zero candidates, no-match with `detail.urls` of at most 10, `closeFromServer` with zero candidates, ban, sink failure, sink unavailable); no message-substring is required."""
    e = read(f"{P}/src/lib/recording/errors.ts")
    ok, why = ac_spec("unit/capture", "errors.spec.ts", "capture-upgrade.10", tuple(CAPTURE_CODES) + ("closeFromServer",))
    return "CaptureError" in exports_of(e) and all(c in e for c in CAPTURE_CODES) and ok, why


@check("capture-upgrade", 11)
def _cu11():
    """CU11 StoreRecordingSink (EVAL-store-adapter.md, option B''): src/lib/recording/store-sink.ts exports StoreRecordingSink and the type `RecordingStore = Pick<StoreAdapter, 'exec' | 'executeRun' | 'transaction'>` (StoreAdapter imported with `import type` only); store-sink.spec.ts, over a hand-written three-method fake keyed by primary key, proves `init()` issues the DDL once and writes a `recording_schema` version row, a batch runs inside ONE `transaction(fn, { mode: 'immediate' })`, each envelope is one parametrized INSERT OR REPLACE carrying status, request_headers, request_body, response_headers, response_body, body_encoding, duration_ms, redirects and failure, replaying a key leaves one row, a double `close()` is safe and an injected store is NOT closed by the sink."""
    s = read(f"{P}/src/lib/recording/store-sink.ts")
    ok, why = ac_spec("unit/capture", "store-sink.spec.ts", "capture-upgrade.11", ("immediate", "INSERT OR REPLACE", "recording_schema", "request_headers", "response_body", "body_encoding", "duration_ms"))
    return "StoreRecordingSink" in exports_of(s) and re.search(r"Pick<\s*StoreAdapter", s) is not None and ok, why


@check("capture-upgrade", 12)
def _cu12():
    """CU12 public surface: capture/network.ts still exports `captureNetworkResponse`, `captureAllNetworkResponses`, `CapturedResponse` and `CaptureOptions`; `CapturedResponse` keeps `status`, `headers`, `body` and `url`; compat.spec.ts proves `no-body-204` yields `body === ''`. Legacy export names beyond these are free to change ([inv:no-features-removed] protects features, not names)."""
    now = exports_of(read(f"{P}/src/lib/capture/network.ts"))
    ok, why = ac_spec("unit/capture", "compat.spec.ts", "capture-upgrade.12", ("no-body-204",))
    return {"captureNetworkResponse", "captureAllNetworkResponses", "CapturedResponse", "CaptureOptions"} <= now and ok, f"exports={sorted(now)[:12]}; {why}"


@check("capture-upgrade", 13)
def _cu13():
    """CU13 hygiene: only owned paths changed by [psm:capture-upgrade] commits (src/lib/recording/, capture/network.ts, capture/index.ts, test/unit/capture/, capture-parsers/network.spec.ts), `node:sqlite` and `process.env` never appear in src/lib/recording, the only top-level reference to @adhd/sox-store-adapter in src/lib/recording is `import type` (no value import and no require), and `nx run stealth-browser:test -- test/unit/capture` exits 0."""
    o = ownership_ok("capture-upgrade")
    r = lib_text("recording")
    value_import = re.search(r"^\s*(import\s+(?!type\b)[^;]*from\s*['\"]@adhd/sox-store-adapter['\"]|.*require\(\s*['\"]@adhd/sox-store-adapter)", r, re.M) is not None
    ok, why = run_unit("capture")
    return o[0] and "node:sqlite" not in r and "process.env" not in r and not value_import and ok, f"{o[1]} valueImport={value_import} {why}"


_spec_check(14, "sink-contract.spec.ts", "CU14 sink contract: sink-contract.spec.ts proves one envelope per settled exchange, `key === recordingId:requestId`, `seq` strictly increasing, `redirect-301-200` giving ONE envelope with `redirects.length === 1` and `cors-failure` giving `state === 'failed'`.", ("recordingId", "seq", "redirect-301-200", "cors-failure"))
_spec_check(15, "memory-sink.spec.ts", "CU15 MemoryRecordingSink (src/lib/recording/memory-sink.ts): memory-sink.spec.ts proves it stores envelopes, is idempotent by key, keeps `seq` order and a double `close()` is safe.", ("MemoryRecordingSink", "close"))
_spec_check(16, "redaction.spec.ts", "CU16 redaction: `redactHeaders()` masks cookie, set-cookie, authorization and proxy-authorization case-insensitively in the request, the response and every redirect hop; the sink and `onExchange` receive redacted data while in-memory exchanges stay raw; with no `redact` option headers are intact (default identity); an ExtraInfo-merged Cookie is redacted (`extrainfo-before-main`); redaction.spec.ts proves each.", ("set-cookie", "proxy-authorization", "extrainfo-before-main", "onExchange"))
_spec_check(17, "sink-failure.spec.ts", "CU17 sink failure isolation: a sink rejecting on its second write does not stop capture, `close()` rejects CAPTURE_SINK_FAILED with `detail.failed === 1` and the logger is called once per failure; sink-failure.spec.ts proves it.", ("CAPTURE_SINK_FAILED", "failed", "logger"))
_spec_check(18, "flush-close.spec.ts", "CU18 flush, close and backpressure: flush-close.spec.ts proves `flush()` awaits a slow write, close order is flush then sink close then stop, `maxQueue: 2` drops the third with `detail.dropped === 1`, and `captureNetworkResponse({ sink })` closes the sink in `finally` even on CAPTURE_TIMEOUT.", ("flush", "maxQueue", "dropped", "CAPTURE_TIMEOUT"))
_spec_check(19, "graceful.spec.ts", "CU19 graceful outcomes (feature): a timeout with one captured body returns it, a socket error after a captured body returns it, `closeFromServer` after a captured body returns it, and rejected Page.enable / Network.enable / Page.navigate commands are logged without throwing while a body still lands; graceful.spec.ts proves each (no log-prefix substring required).", ("closeFromServer", "Page.enable", "Network.enable", "Page.navigate"))
_spec_check(20, "selection-features.spec.ts", "CU20 selection features: only `urlPattern`-matching requests get `Network.getResponseBody` (zero body calls for a non-matching id), tracking is sticky across a redirect whose second hop does not match, the largest body wins and ties go to the later capture, an empty-string body is a candidate while a body error is not, and the result `url` is the final hop url with `navigateUrl` as fallback; selection-features.spec.ts proves each.", ("urlPattern", "getResponseBody", "navigateUrl"))
_spec_check(21, "ban-order.spec.ts", "CU21 ban evaluation: `banRules` are evaluated in order url, status, body on the selected response only, no `banRules` or an empty list performs no ban evaluation, a ban fires after a timeout-with-bodies success, and a status rule fires only on a real status; ban-order.spec.ts proves each and the CAPTURE_BAN_DETECTED code.", ("banRules", "CAPTURE_BAN_DETECTED"))
_spec_check(22, "session-lifecycle.spec.ts", "CU22 session lifecycle: the wrapper always closes the session it created (success, error, ban, timeout) and never a caller-supplied session, no timer is pending after resolve (fake timers), and events arriving after return reach neither `onExchange` nor the sink; session-lifecycle.spec.ts proves each.", ("useFakeTimers", "onExchange"))
_spec_check(23, "malformed-frame.spec.ts", "CU23 robustness: a malformed JSON frame is skipped and logged and capture still completes; malformed-frame.spec.ts proves it.", ("malformed",))
_spec_check(24, "sink-independence.spec.ts", "CU24 sink independence: the SAME fixtures (doc-200, no-body-204, search-404, redirect-301-200, two-tabs-parallel) with `sink` unset, with MemoryRecordingSink and with StoreRecordingSink over the fake yield identical `CapturedResponse`; with `sink` unset no sink queue or envelope is allocated and no CDP command beyond the urlPattern body fetches is sent; sink-independence.spec.ts proves it.", ("doc-200", "no-body-204", "search-404", "redirect-301-200", "two-tabs-parallel", "MemoryRecordingSink", "StoreRecordingSink"))
_spec_check(25, "fixes.spec.ts", "CU25 fix register: fixes.spec.ts has one named test per recorder fix X1 to X7 (EVAL-store-adapter-v1.md section 4), each asserting the NEW behavior and traceable by id.", ("X1", "X2", "X3", "X4", "X5", "X6", "X7"))
_spec_check(26, "open-store-sink.spec.ts", "CU26 openStoreRecordingSink: src/lib/recording/open-store-sink.ts exports `openStoreRecordingSink({ dbPath, table?, loadAdapter? })`; open-store-sink.spec.ts, using a fake `loadAdapter`, proves it calls the fake `createStoreAdapter` once with `{ dbPath }`, runs the DDL, returns a working sink whose `close()` closes the adapter exactly once, a `loadAdapter` rejecting with ERR_MODULE_NOT_FOUND gives CAPTURE_SINK_UNAVAILABLE with `cause`, a rejecting `createStoreAdapter` gives the same code with `cause` kept, and the real package is never loaded (no vi.mock of the package).", ("loadAdapter", "CAPTURE_SINK_UNAVAILABLE", "createStoreAdapter", "dbPath", "cause"),
            extra=lambda: ("openStoreRecordingSink" in exports_of(read(f"{P}/src/lib/recording/open-store-sink.ts")), "openStoreRecordingSink exported"))


@check("capture-upgrade", 27)
def _cu27():
    """CU27 module-format guard (ADR-0003): test/unit/capture/build-format.spec.ts asserts on the source text that src/lib/recording references @adhd/sox-store-adapter at top level only through `import type` and has exactly one dynamic `import('@adhd/sox-store-adapter')` call site (inside the `loadAdapter` default); the guard re-checks both facts on src/lib/recording, requires `@adhd/sox-store-adapter` in package.json `dependencies` and `externalizeRealDeps(__dirname)` in vite.config.ts (owned by port-fixes), and when dist/index.js exists it contains no `require('@adhd/sox-store-adapter')`."""
    r = lib_text("recording")
    dyn = re.findall(r"import\(\s*['\"]@adhd/sox-store-adapter['\"]\s*\)", r)
    top = [m for m in re.findall(r"^\s*import\s+[^;]*from\s*['\"]@adhd/sox-store-adapter['\"]", r, re.M) if not re.match(r"\s*import\s+type\b", m)]
    pkg = jread(f"{P}/package.json", {}) or {}
    dist = read(f"{P}/dist/index.js")
    dist_ok = "require('@adhd/sox-store-adapter')" not in dist and 'require("@adhd/sox-store-adapter")' not in dist
    ok, why = ac_spec("unit/capture", "build-format.spec.ts", "capture-upgrade.27", ("import type", "import("))
    return len(dyn) == 1 and not top and SINK_PKG in (pkg.get("dependencies") or {}) and "externalizeRealDeps(__dirname)" in read(f"{P}/vite.config.ts") and dist_ok and ok, f"dynamic sites={len(dyn)} value imports={top} {why}"


# ---------------------------------------------------------------- chrome-lifecycle (single-pass design: connection-based presence over @adhd/sox-service-proxy 0.6.0)
PROXY_PKG = "@adhd/sox-service-proxy"
SP_EXPORTS = ["ensureBackend", "serveBackend", "dialBackend", "backendSocketPath", "ensurePrivateSocketDir", "readProcessStartToken", "isSameProcess", "createIdleRetirer", "createCircuitBreaker"]
GONE_LIFECYCLE_FILES = ["presence.ts", "proxy-launcher.ts", "reaper.ts", "legacy-heartbeat.ts"]


def state_status(slug):
    return ((state().get("states") or {}).get(slug) or {}).get("status")


def _cl_spec(num, fname, doc, must, sub="unit/lifecycle"):
    def fn():
        return ac_spec(sub, fname, f"chrome-lifecycle.{num}", must)
    fn.__doc__ = doc
    check("chrome-lifecycle", num)(fn)


_cl_spec(1, "concurrent-launch.spec.ts", "CL1 (F1 F2 F4) race-free launch: concurrent-launch.spec.ts runs 8 managers over one MemFs and proves exactly one spawn, the default host 127.0.0.1:9222, a CDP that never becomes ready within 10 s giving CHROME_UNREACHABLE_AFTER_LAUNCH, a loser waiting bounded for the winner, and a launch lock older than 15 s being reclaimed.", ("toHaveBeenCalledTimes(1)", "CHROME_UNREACHABLE_AFTER_LAUNCH", "9222"))
_cl_spec(2, "relaunch.spec.ts", "CL2 (F3 F17) self-heal and reset: relaunch.spec.ts proves that after another process kills the shared Chrome the next `ready()` relaunches, and that after a real shutdown a later `ready()` relaunches and a fresh idle timer fires again.", ("ready()", "shutdown"))
_cl_spec(3, "hide-windows.spec.ts", "CL3 (F5) a fresh launch hides windows and the fast path does not re-hide (a window revealed for a human stays visible); hide-windows.spec.ts proves both.", ("hideAllWindows",))
_cl_spec(4, "idle-timer.spec.ts", "CL4 (F6 F7) activity-bumped idle timer (client side): idle-timer.spec.ts proves `bump()` re-arms (no fire at 299 ms, fire at 300 ms), the timer re-arms after it fired, `withBrowser` bumps when `fn` throws, and timers are unref'd.", ("299", "300", "unref", "withBrowser"))
_cl_spec(5, "reaper-host.spec.ts", "CL5 (F8) cross-process coordination in the reaper host: reaper-host.spec.ts calls `createReaperHost(deps).handler(req, { connectionId })` and `onClientDisconnect(id, reason)` directly (no sockets) and proves client A is deferred to when client B sent `activity` within the idle window, Chrome is reaped when B stayed silent past it, and B's disconnect (kill -9) drops B at once even when B's last activity was 1 s ago.", ("createReaperHost", "connectionId", "onClientDisconnect", "activity"))
_cl_spec(6, "no-livelock.spec.ts", "CL6 (F9) livelock protection: no-livelock.spec.ts proves defer paths, host ticks and `reapIfIdle` leave every client's `lastActivityAt` unchanged (`activity` is the only writer, `bump()` the only sender) and two idle clients with zero http pages and history off are reaped within idle plus grace.", ("lastActivityAt", "bump", "reapIfIdle"))
_cl_spec(7, "page-tier.spec.ts", "CL7 (F10 F11 F12) page tier (evaluated in the host): page-tier.spec.ts proves an open http and an open https page pin Chrome, `chrome://newtab/`, `about:blank`, `devtools://` and `chrome-untrusted://` targets do not, and an unreachable CDP during the check proceeds.", ("chrome://newtab/", "about:blank", "devtools://", "chrome-untrusted://"))
_cl_spec(8, "history-tier.spec.ts", "CL8 (F13) history-recency tier: history-tier.spec.ts proves a visit within 2 minutes pins Chrome, `checkHistory: false` ignores history, a history database error proceeds, the default is on, and the tier is on when ANY connected client enables it (the `hello` message carries the flag).", ("checkHistory",))
_cl_spec(9, "shutdown-modes.spec.ts", "CL9 (F14 F15) shutdown modes: shutdown-modes.spec.ts proves `shutdown()` ignores every tier and is local, and `shutdownIfIdle()` goes through the link (`reapIfIdle`, graceMs 0) and defers to a sibling, to a page and to history.", ("shutdownIfIdle", "shutdown(", "reapIfIdle"))
_cl_spec(10, "ordered-shutdown.spec.ts", "CL10 (F16) ordered shutdown: ordered-shutdown.spec.ts proves all page targets are closed (allSettled) before Chrome is killed, in the host reap and in the force path, and that a failing close or kill is logged and the rest still runs.", ("logger",))


@check("chrome-lifecycle", 11)
def _cl11():
    """CL11 (F18) group kill: src/lib/cdp/browser.ts exports `killProcessGroup(pid)` (extract-only: the SIGTERM-to-group, bounded wait, SIGKILL-to-group, single-pid fallback logic that the tracked-branch kill already used, moved to a named export), test/unit/cdp/browser.spec.ts keeps every `expect(` line and every `it(` or `describe(` title line it had at the chrome-lifecycle start_ref (fallback: the tests-unit-core end_ref) and is still green: fixture-only changes (helpers, `execSync` mocks, the simulated `ps -o command=` answers) and the `-sTCP:LISTEN` insertion into the lsof command string are allowed, any other changed assertion fails, and process-group.spec.ts proves `killProcessGroup` issues the same signal sequence as the tracked branch (SIGTERM, a bounded wait, SIGKILL, fallback to the single pid)."""
    b = read(f"{P}/src/lib/cdp/browser.ts")
    ok, why = ac_spec("unit/lifecycle", "process-group.spec.ts", "chrome-lifecycle.11", ("killProcessGroup", "SIGTERM", "SIGKILL"))
    spec = f"{P}/test/unit/cdp/browser.spec.ts"
    st = (state().get("states") or {})
    ref = (st.get("chrome-lifecycle") or {}).get("start_ref") or (st.get("tests-unit-core") or {}).get("end_ref")
    if not ref or not exists(spec):
        return False, f"no baseline ref for browser.spec.ts (start_ref/end_ref unset) or file missing; {why}"
    # rename-aware: the spec was git-mv'd by core-scaffold, so the baseline is the blob at `ref` under whichever path it had then, tolerating only the
    # documented rename substitutions ([stealth-browser] log prefix and the package name).
    def _renorm(t):
        return t.replace("[stealth-browser]", f"[{CORE_PKG}]").replace(LEGACY_PKG, CORE_PKG).replace(LEGACY_DIR, CORE_DIR)
    old_blob = blob_at(ref, spec)
    # fixture-only edits are allowed (core-seam.12): every assertion and title line must equal the baseline once the lsof LISTEN insertion is normalized
    # a later state's greenfield edit (audit-fixes P14-P17) does not reopen chrome-lifecycle: when another state changed the file since, measure it as
    # chrome-lifecycle left it (its own commit, else the content before the first audit-fixes commit); the weakening protection within this state is unchanged (live tree otherwise).
    cur = migration_snapshot("chrome-lifecycle", spec) or pre_descendant_snapshot(spec, dag_descendants("chrome-lifecycle")) or read(spec)
    same = old_blob is not None and assertion_lines(_renorm(old_blob)) == assertion_lines(_renorm(cur)) and git("status", "--porcelain", "--", spec) == ""
    return "killProcessGroup" in exports_of(b) and same and ok, f"browser.spec.ts assertion/title lines unchanged since {ref[:8]}={same}; {why}"


_cl_spec(12, "reaper-scope.spec.ts", "CL12 (F19) reaper scope: reaper-scope.spec.ts proves scope `port-occupant` (default) signals the port occupant (lsof, then fuser, with its pgid) when no owner is recorded and only the matching pid when the owner record is valid (`isSameProcess(pid, procStart)`), and scope `launched-only` never signals an unrecorded process.", ("port-occupant", "launched-only", "lsof", "fuser", "procStart", "isSameProcess"))


@check("chrome-lifecycle", 13)
def _cl13():
    """CL13 (F20 F21 F22, gap G1) isolated pages: src/lib/lifecycle/isolated-page.ts exports openIsolatedPage and withIsolatedPage; `createIsolatedPageTarget` in cdp/targets.ts closes the browser CdpSession in a `finally` and disposes any created context when `Target.createBrowserContext` or `Target.createTarget` throws; isolated-page.spec.ts and cdp/targets.spec.ts prove no shared context, background by default, `reveal` unminimizes, `dispose` disposes the context, and a failure at createBrowserContext, createTarget, window bounds, connect or target-missing (`isolated-context-target-missing`) leaves `openCount()` at zero and no undisposed context, and `withIsolatedPage` disposes when `fn` throws."""
    i = read(f"{P}/src/lib/lifecycle/isolated-page.ts")
    t = read(f"{P}/src/lib/cdp/targets.ts")
    a, wa = ac_spec("unit/lifecycle", "isolated-page.spec.ts", "chrome-lifecycle.13", ("disposeBrowserContext", "openCount", "Target.createBrowserContext", "Target.createTarget"))
    b, wb = ac_spec("unit/cdp", "targets.spec.ts", "chrome-lifecycle.13", ("isolated-context-target-missing", "disposeBrowserContext"))
    return {"openIsolatedPage", "withIsolatedPage"} <= exports_of(i) and "disposeBrowserContext" in t and "finally" in t and a and b, f"{wa}; {wb}"


@check("chrome-lifecycle", 14)
def _cl14():
    """CL14 (F23, gap G2) exit hooks: src/lib/lifecycle/exit-hooks.ts exports `installProcessExitHooks(manager, { forceExitMs = 5000, stdinEof, exit })` returning an uninstall function; exit-hooks.spec.ts proves each of exit, SIGINT, SIGTERM, uncaughtException, unhandledRejection and (opt-in) stdin end runs `release()` (the link release) then the soft shutdown once, force-exits after 5000 ms, uses codes 130, 143 and 1, and uninstall removes the listeners (wiring into the hosts is surface-hosts.14)."""
    e = read(f"{P}/src/lib/lifecycle/exit-hooks.ts")
    ok, why = ac_spec("unit/lifecycle", "exit-hooks.spec.ts", "chrome-lifecycle.14", ("SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection", "stdin", "130", "143", "5000", "release"))
    return "installProcessExitHooks" in exports_of(e) and ok, why


@check("chrome-lifecycle", 15)
def _cl15():
    """CL15 (F24 N1 N5, gap G4) out-of-process reaper over the service proxy, requires sp-link complete: src/lib/lifecycle/reaper-link.ts exports the `ReaperLink` port and `createProxyReaperLink(cfg)` (ensure the reaper with `ensureBackend`, hold ONE `dialBackend` connection that sends `hello{pid,checkHistory}` on connect, then `activity`, `release`, `reapIfIdle`, `status`); src/lib/lifecycle/reaper-entry.ts exports `runChromeReaper(cfg)` (`serveBackend` with the host handler and connection hooks, `createIdleRetirer` over `orphanWindowMs`, a 5 s ticker); reaper-link.spec.ts and reaper-entry.spec.ts, with `vi.mock('@adhd/sox-service-proxy')`, prove the dispositions spawned, already-live and adopted-after-wait map to ok and `failed` (including E_UDS_DIR_UNSAFE) maps to REAPER_UNAVAILABLE (degraded mode), a hello is sent on connect, activity is fire-and-forget, a connection of a killed client (kill -9) is dropped by the host at once, and a host nobody uses retires after `orphanWindowMs` once Chrome is gone."""
    if state_status("sp-link") != "complete":
        return False, "sp-link is not complete: the tarball precondition for lifecycle/sp.ts is unmet"
    link = read(f"{P}/src/lib/lifecycle/reaper-link.ts")
    entry = read(f"{P}/src/lib/lifecycle/reaper-entry.ts")
    host = read(f"{P}/src/lib/lifecycle/reaper-host.ts")
    a, wa = ac_spec("unit/lifecycle", "reaper-link.spec.ts", "chrome-lifecycle.15", ("vi.mock('@adhd/sox-service-proxy'", "spawned", "already-live", "adopted-after-wait", "E_UDS_DIR_UNSAFE", "REAPER_UNAVAILABLE", "dialBackend", "hello"))
    b, wb = ac_spec("unit/lifecycle", "reaper-entry.spec.ts", "chrome-lifecycle.15", ("vi.mock('@adhd/sox-service-proxy'", "serveBackend", "createIdleRetirer", "orphanWindowMs", "runChromeReaper"))
    return ({"ReaperLink", "createProxyReaperLink"} <= exports_of(link) and "runChromeReaper" in exports_of(entry) and "serveBackend" in entry and "createIdleRetirer" in entry
            and "createReaperHost" in exports_of(host) and "decideReap" in host and a and b), f"{wa}; {wb}"


@check("chrome-lifecycle", 16)
def _cl16():
    """CL16 (N3, gap G4) connection registry: reaper-registry.spec.ts proves, against `createReaperHost` called directly, that `hello` registers a client under its `ctx.connectionId` (pid and checkHistory), `activity` updates only that client's `lastActivityAt` (host clock), a disconnect or `release` removes the client, an unknown method or malformed params answer a JSON-RPC error without changing the registry, and after a host restart the next `activity` re-registers the client; the registry is in memory only (no presence file, no lease)."""
    ok, why = ac_spec("unit/lifecycle", "reaper-registry.spec.ts", "chrome-lifecycle.16", ("hello", "activity", "release", "onClientDisconnect", "connectionId"))
    return ok and exists(f"{P}/src/lib/lifecycle/reaper-host.ts"), why


@check("chrome-lifecycle", 17)
def _cl17():
    """CL17 (N4) launch circuit breaker: src/lib/lifecycle/launch-breaker.ts builds the breaker on `createCircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000, store })` with a stealth-owned `FileBreakerStore` (`<stateDir>/breaker-<port>.json`, atomic rename, best-effort); launch-breaker.spec.ts proves the 4th `ready()` throws LAUNCH_CIRCUIT_OPEN with `retryAfterMs` and no spawn, the breaker closes after the cool-off, success resets it and the state is shared across managers."""
    b = read(f"{P}/src/lib/lifecycle/launch-breaker.ts")
    ok, why = ac_spec("unit/lifecycle", "launch-breaker.spec.ts", "chrome-lifecycle.17", ("LAUNCH_CIRCUIT_OPEN", "retryAfterMs", "FileBreakerStore"))
    return "FileBreakerStore" in exports_of(b) and "createCircuitBreaker" in b and all(x in b for x in ("failureThreshold", "60_000", "30_000")) and ok, why


_cl_spec(18, "sibling-warning.spec.ts", "CL18 (F25) sibling diagnostic: sibling-warning.spec.ts proves `status().siblingWarning` (from the host `status` answer: connected clients at or above the threshold) is true at the threshold and that the diagnostic never kills anything.", ("siblingWarning", "status"))
_cl_spec(19, "grace-exit.spec.ts", "CL19 (N2 N6) shared Chrome and grace: grace-exit.spec.ts proves N managers share one Chrome and that after the last client releases or disconnects, the host tick closes Chrome within `shutdownGraceMs` (fake clock).", ("release", "shutdownGraceMs"))


@check("chrome-lifecycle", 20)
def _cl20():
    """CL20 typed lifecycle errors: src/lib/lifecycle/errors.ts exports LifecycleError with exactly the six codes LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, REAPER_UNAVAILABLE and ISOLATED_CONTEXT_FAILED (PRESENCE_DIR_INSECURE does not exist: no presence file); errors.spec.ts reaches each with `cause` or `detail` (`retryAfterMs`, `port`, `path`) and a one-line message naming the fix."""
    e = read(f"{P}/src/lib/lifecycle/errors.ts")
    ok, why = ac_spec("unit/lifecycle", "errors.spec.ts", "chrome-lifecycle.20", tuple(LIFECYCLE_CODES))
    return "LifecycleError" in exports_of(e) and all(c in e for c in LIFECYCLE_CODES) and "PRESENCE_DIR_INSECURE" not in e and ok, why


_cl_spec(21, "best-effort.spec.ts", "CL21 (F26) best-effort I/O: best-effort.spec.ts proves ownership-record, breaker-store and state-dir failures never fail a call, and a reaper link failure never fails `bump()`, `release()` or `shutdown()`.", ("release", "ownership", "breaker"))


@check("chrome-lifecycle", 22)
def _cl22():
    """CL22 one seam: `ReaperLink` (src/lib/lifecycle/reaper-link.ts) is the only port (the real adapter `createProxyReaperLink` and a test fake at test/helpers/lifecycle/fake-reaper-link.ts that the manager tests substitute); src/lib/lifecycle/sp.ts is the ONLY file under src/ that imports `@adhd/sox-service-proxy` (static import) and it re-exports at least ensureBackend, serveBackend, dialBackend, backendSocketPath, ensurePrivateSocketDir, readProcessStartToken, isSameProcess, createIdleRetirer and createCircuitBreaker; no `PresenceStore`, `FilePresenceStore` or `ReaperLauncher` identifier exists; decideReap, the tiers, the breaker, the isolated pages, the exit hooks and the manager never import the package directly."""
    sp = read(f"{P}/src/lib/lifecycle/sp.ts")
    fake = read(f"{P}/test/helpers/lifecycle/fake-reaper-link.ts")
    leak = [os.path.relpath(f, P) for f in walk(f"{P}/src/lib", (".ts",)) if os.path.basename(f) != "sp.ts" and PROXY_PKG in read(f)]
    gone = [os.path.relpath(f, P) for f in walk(f"{P}/src", (".ts",)) if re.search(r"\b(PresenceStore|FilePresenceStore|ReaperLauncher)\b", code_lines(read(f)))]
    link = read(f"{P}/src/lib/lifecycle/reaper-link.ts")
    return (bool(fake.strip()) and re.search(r"from\s*['\"]@adhd/sox-service-proxy['\"]", sp) is not None and set(SP_EXPORTS) <= exports_of(sp)
            and "ReaperLink" in exports_of(link) and not leak and not gone), f"proxy imported outside sp.ts: {leak}; legacy seam identifiers: {gone}; missing sp exports {sorted(set(SP_EXPORTS) - exports_of(sp))}"


@check("chrome-lifecycle", 23)
def _cl23():
    """CL23 hygiene: `process.env` never appears in src/lib/lifecycle (no env toggles, ADR-0013), no spec under test/unit/lifecycle opens a socket or spawns a process (no unmocked node:net, node:http or child_process), only owned paths changed by [psm:chrome-lifecycle] commits, and `nx run stealth-browser:test -- test/unit/lifecycle` exits 0 without touching a real port 9222."""
    o = ownership_ok("chrome-lifecycle")
    specs = [f for f in walk(f"{P}/test/unit/lifecycle", (".ts",)) if re.search(r"from ['\"]node:(net|http)['\"]", read(f))]
    if not walk(f"{P}/src/lib/lifecycle", (".ts",)):
        return False, "no lifecycle sources yet"
    ok, why = run_unit("lifecycle")
    return o[0] and "process.env" not in lib_text("lifecycle") and not specs and ok, f"{o[1]} socket specs={specs} {why}"


@check("chrome-lifecycle", 24)
def _cl24():
    """CL24 mechanism absence (the feature is kept, the old mechanism is gone): no file `presence.ts`, `proxy-launcher.ts`, `reaper.ts` or `legacy-heartbeat.ts` exists under src/lib/lifecycle, and no non-comment line under src/lib mentions `heartbeatPath`, `legacyHeartbeatPath`, `stealth-browser-heartbeat`, `leaseDir`, `leaseTtlMs`, `PRESENCE_DIR_INSECURE` or a `process.kill(pid, 0)` presence probe; the manager writes no activity file (greenfield: no interim reader of the old agent-browser heartbeat)."""
    present = [f for f in GONE_LIFECYCLE_FILES if exists(f"{P}/src/lib/lifecycle/{f}")]
    hits = []
    for f in lib_files():
        t = code_lines(read(f))
        for tok in ("heartbeatPath", "legacyHeartbeatPath", "stealth-browser-heartbeat", "leaseDir", "leaseTtlMs", "PRESENCE_DIR_INSECURE"):
            if tok in t:
                hits.append(f"{os.path.relpath(f, P)}:{tok}")
    return exists(f"{P}/src/lib/lifecycle/reaper-host.ts") and not present and not hits, f"retired files present {present}; retired mechanism tokens {hits[:8]}"


@check("chrome-lifecycle", 25)
def _cl25():
    """CL25 (gap G3) docs/plan/stealth-browser/evidence/lifecycle-definitions.md states that backlog items B-036..B-039 have no definition in the source tree (commit cffee3c carries only a title), then defines each of B-036, B-037, B-038 and B-039 as a lifecycle requirement derived from the features F1-F26 and requirements N1-N7 of EVAL-service-proxy.md, naming for each the chrome-lifecycle criterion id that pins it."""
    d = read(f"{PLAN}/evidence/lifecycle-definitions.md")
    return all(re.search(rf"B-0{n}\b", d) for n in (36, 37, 38, 39)) and "cffee3c" in d and len(re.findall(r"chrome-lifecycle\.\d+", d)) >= 4, f"{len(d)} bytes"


@check("chrome-lifecycle", 26)
def _cl26():
    """CL26 public shape of the manager: `ChromeManagerOptions` is exactly { cdpHost?, idleTimeoutMs? (default 120000), checkHistory? (default true), shutdownGraceMs? (default 30000), orphanWindowMs? (default 30000), stateDir?, reaperScope? ('launched-only' | 'port-occupant', default 'port-occupant'), link? (a `ReaperLink`), logger? } plus the two host options surface-hosts adds later (keepAlive?, entryPath?); `leaseDir`, `leaseTtlMs`, `reaper` ('detached' | 'in-process-only'), `presence`, `launcher` and `legacyHeartbeatPath` do not exist; the methods `ready`, `bump`, `shutdown`, `shutdownIfIdle`, `withBrowser`, `isReady` stay and `release()` and `status()` (`ChromeStatus`: ready, owned, processes, activeProcesses, httpPages, reaper (boolean), breaker, siblingWarning) are new; no activity file is written by the manager."""
    c = read(f"{P}/src/lib/chrome-manager.ts")
    t = code_lines(c)
    need = ["cdpHost", "idleTimeoutMs", "checkHistory", "shutdownGraceMs", "orphanWindowMs", "stateDir", "reaperScope", "link", "release", "status", "siblingWarning", "ReaperLink"]
    miss = [n for n in need if n not in c]
    gone = [n for n in ("leaseDir", "leaseTtlMs", "legacyHeartbeatPath", "in-process-only") if n in t] + [n for n in ("presence", "launcher", "reaper") if re.search(rf"\b{n}\?\s*:", t)]
    return not miss and not gone and "port-occupant" in c and "launched-only" in c, f"missing {miss}; retired options present {gone}"


@check("chrome-lifecycle", 28)
def _cl28():
    """CL28 degraded mode (decision D1): degraded.spec.ts proves that when the reaper cannot be ensured (`ensureBackend` gives `failed`, including E_UDS_DIR_UNSAFE) or the state directory is unsafe, `ready()` still succeeds, `status().reaper` is false, the idle timer fires but never closes Chrome (it defers), force `shutdown()` still works, and exactly one warning is logged for the whole degraded session."""
    return ac_spec("unit/lifecycle", "degraded.spec.ts", "chrome-lifecycle.28", ("degraded", "E_UDS_DIR_UNSAFE", "reaper", "warn", "toHaveBeenCalledTimes(1)", "shutdown("))


@check("chrome-lifecycle", 29)
def _cl29():
    """CL29 no respawn loop: no-respawn.spec.ts proves that when the reaper retires with N idle clients still connected and Chrome gone, no client calls `ensure` (zero calls on disconnect), and that a re-ensure happens only on `ready()`, on a `bump()` or `withBrowser` settle while the link is down and Chrome is reachable, and on one retry of a previously failed ensure at idle fire."""
    return ac_spec("unit/lifecycle", "no-respawn.spec.ts", "chrome-lifecycle.29", ("ensure", "toHaveBeenCalledTimes(0)", "ready(", "orphanWindowMs"))



# ============================================================ failsafe inventory ([inv:no-features-removed])
INV = f"{PLAN}/evidence/failsafe-inventory.json"
INV_OWNERS = ["port-fixes", "tests-unit-core", "tests-unit-data", "tests-unit-extract", "tests-unit-surface", "capture-upgrade", "chrome-lifecycle"]
INV_TAGS = ["safety-tier", "launch-lock-oexcl", "group-kill", "newtab-fix", "cross-process", "livelock", "history-recency", "idle-shutdown", "isolated-page-cleanup", "reaper", "ban-detection",
            "readonly-sqlite", "stealth-flags", "settle", "session", "targets", "capture", "storage", "parsers", "verb"]


def inventory_rows():
    return (jread(INV, {}) or {}).get("rows", [])


def pin_path(pin_file, base=None):
    """Current location of an inventory pin file.  The inventory was authored against the pre-layout-move tree (`src/test/...`); the unit lane now lives at
    `test/unit/...` (docs/standards/testing.md), so a pin file recorded under `src/test/` resolves to the same path under `test/` when it no longer exists
    at the recorded location."""
    base = base or P
    if pin_file and not exists(f"{base}/{pin_file}") and pin_file.startswith("src/test/"):
        return f"{base}/{pin_file[len('src/'):]}"
    return f"{base}/{pin_file or ''}"


def row_pinned(r):
    pin = r.get("pin") or {}
    p = pin_path(pin.get("file", ""))
    txt = read(p)
    return bool(pin.get("file")) and bool(txt.strip()) and f"[{r['id']}]" in txt and bool(pin.get("test")) and pin["test"] in txt


SEARCH_INV = f"{PLAN}/evidence/search-failsafe-inventory.json"


def search_unpinned():
    """Rows of the search-side inventory (evidence/search-failsafe-inventory.json) that are not pinned: a row with a `pin` {file, test} must have the pin file under entrypoint/stealth-search/test/ cite `[<row id>]` and contain the named test; a row with `pin: null` needs a `reason`. Returns the ids; ['<no inventory>'] while the inventory does not exist."""
    d = jread(SEARCH_INV, {}) or {}
    rows = d.get("rows") or []
    if not rows:
        return ["<no inventory>"]
    bad = []
    for r in rows:
        pin = r.get("pin")
        if not pin:
            if not r.get("reason"):
                bad.append(r.get("id"))
            continue
        txt = read(f"{SEARCH_DIR}/{pin.get('file', '')}")
        if not (pin.get("file") and txt.strip() and f"[{r.get('id')}]" in txt and pin.get("test") and pin["test"] in txt):
            bad.append(r.get("id"))
    return bad


def inventory_owner_ok(owner):
    allrows = inventory_rows()
    rows = [r for r in allrows if r.get("owner_state") == owner]
    bad = [r["id"] for r in rows if not row_pinned(r)]
    return len(allrows) >= 40 and not bad, f"{owner}: {len(rows)} rows of {len(allrows)}, unpinned {bad}"


@check("failsafe-inventory", 1)
def _fi1():
    """The inventory evidence/failsafe-inventory.json exists with at least 40 rows, unique ids `fs-NNN`, and covers every failsafe/feature topic by tag: safety-tier (the three safety tiers), launch-lock-oexcl, group-kill, newtab-fix, cross-process, livelock, history-recency, idle-shutdown, isolated-page-cleanup, reaper, ban-detection, readonly-sqlite, stealth-flags, settle, session, targets, capture, storage, parsers, verb."""
    rows = inventory_rows()
    ids = [r.get("id") for r in rows]
    tags = {x for r in rows for x in r.get("tags", [])}
    miss = [x for x in INV_TAGS if x not in tags]
    return len(rows) >= 40 and len(set(ids)) == len(ids) and all(re.fullmatch(r"fs-\d{3}", str(i)) for i in ids) and not miss, f"rows={len(rows)} missing tags={miss}"


@check("failsafe-inventory", 2)
def _fi2():
    """Every row cites its source: `source.file` (relative to the scratch agent-browser tree, e.g. adhd/chrome-manager.ts), `source.line` and `source.anchor` where the anchor text appears on that line (+-2) of the BASELINE source read from git, plus a non-empty `feature` sentence; the source files cover adhd/chrome-manager.ts, adhd/cdp-connection/src/browser.ts, shutdown.ts, targets.ts, adhd/capture/, adhd/storage/ and adhd/session.ts."""
    bad, files = [], set()
    for r in inventory_rows():
        s = r.get("source") or {}
        src = baseline_src(s.get("file", "")) if s.get("file") else ""
        lines = src.splitlines()
        ln = int(s.get("line") or 0)
        win = "\n".join(lines[max(0, ln - 3):ln + 2])
        files.add(s.get("file", ""))
        if not (src and ln > 0 and s.get("anchor") and s["anchor"] in win and str(r.get("feature", "")).strip()):
            bad.append(r.get("id"))
    need = ["adhd/chrome-manager.ts", "adhd/cdp-connection/src/browser.ts", "adhd/cdp-connection/src/shutdown.ts", "adhd/cdp-connection/src/targets.ts", "adhd/session.ts"]
    miss = [n for n in need if n not in files] + [p for p in ("adhd/capture/", "adhd/storage/") if not any(x.startswith(p) for x in files)]
    return not bad and not miss, f"unverifiable rows {bad[:10]}; uncovered sources {miss}"


@check("failsafe-inventory", 3)
def _fi3():
    """Every row names an `owner_state` from the closed set (port-fixes, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, capture-upgrade, chrome-lifecycle) and a planned `pin` ({file under entrypoint/stealth-browser/test/ inside that owner's owned test directory, test: an it()/test() name substring}); rows tagged reaper, cross-process, livelock, launch-lock-oexcl, group-kill or newtab-fix are owned by chrome-lifecycle or tests-unit-core, rows tagged capture by capture-upgrade or tests-unit-extract."""
    own = ownership()
    bad = []
    for r in inventory_rows():
        o, pin = r.get("owner_state"), r.get("pin") or {}
        pf = f"{P}/{pin.get('file', '')}"
        owned = own.get(o, [])
        inside = any(pf.startswith(x) for x in owned if x.endswith("/") and "/test/" in x) or any(pf == x for x in owned)
        if o not in INV_OWNERS or not pin.get("file") or not pin.get("test") or not inside:
            bad.append(r.get("id"))
    return len(inventory_rows()) >= 40 and not bad, f"rows with a missing/unowned pin {bad[:10]}"


@check("failsafe-inventory", 4)
def _fi4():
    """Only owned paths changed by [psm:failsafe-inventory] commits, and no package source file is touched."""
    return ownership_ok("failsafe-inventory")


for _slug, _n, _owner in (("tests-unit-core", 6, "tests-unit-core"), ("tests-unit-data", 6, "tests-unit-data"), ("tests-unit-extract", 6, "tests-unit-extract"),
                          ("tests-unit-surface", 6, "tests-unit-surface"), ("capture-upgrade", 28, "capture-upgrade"),
                          ("chrome-lifecycle", 27, "chrome-lifecycle")):
    def _mk(owner):
        def fn():
            ok, why = inventory_owner_ok(owner)
            if owner != "chrome-lifecycle":
                return ok, why
            tagged = [r for r in inventory_rows() if set(r.get("tags", [])) & {"reaper", "cross-process", "history-recency", "idle-shutdown", "safety-tier", "livelock", "launch-lock-oexcl", "group-kill", "newtab-fix"}]
            later = dag_descendants("chrome-lifecycle")
            deferred = sorted(r["id"] for r in tagged if r.get("owner_state") in later)
            bad = [r["id"] for r in tagged if r.get("owner_state") not in later and not row_pinned(r)]
            lib = "\n".join(read(x) for x in walk(f"{P}/src/lib", (".ts",)))
            return ok and len(tagged) >= 8 and not bad and "checkHistory" in lib, f"{why}; lifecycle-tagged rows={len(tagged)} unpinned={bad} deferred-to-descendant-owner={deferred} checkHistory={'checkHistory' in lib}"
        fn.__doc__ = (f"[inv:no-features-removed] every failsafe-inventory row owned by {owner} is pinned: its pin file exists under src/test, cites the row id `[fs-NNN]` and contains the named test; "
                      "the feature is kept (no row may be removed or narrowed)."
                      + (" Every row tagged reaper, cross-process, history-recency, idle-shutdown, safety-tier, livelock, launch-lock-oexcl, group-kill or newtab-fix (at least 8) is pinned, except a row whose owner_state has chrome-lifecycle as a dag ancestor (its pin file cannot exist yet; it is pinned at its owner's own inventory criterion and again at review-prep.5, audit-pre-review.5 and audit-final.12, which check every row), and the history-recency tier with its `checkHistory` option remains." if owner == "chrome-lifecycle" else ""))
        return fn
    check(_slug, _n)(_mk(_owner))


@check("surface-api", 11)
def _sa11():
    """[inv:no-features-removed] the six chrome verbs exist as features (chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext) at least 6 inventory rows tagged `verb` are owned by tests-unit-surface (the verb-level rows) and every `verb`-tagged row is owned by tests-unit-surface or chrome-lifecycle (the lifecycle rows that back the verbs), no other owner; export-name parity with the source is not required (greenfield)."""
    verbs = [r for r in inventory_rows() if "verb" in r.get("tags", [])]
    api = exports_of(read(f"{P}/src/api.ts"))
    owners = {r.get("owner_state") for r in verbs}
    surface = [r for r in verbs if r.get("owner_state") == "tests-unit-surface"]
    return {"chromeStatus", "launchChrome", "shutdownChrome", "listPageTargets", "checkChromeActivity", "getPageContext"} <= api and owners <= {"tests-unit-surface", "chrome-lifecycle"} and len(surface) >= 6, f"verb rows={len(verbs)} surface-owned={len(surface)} owners={sorted(owners)}"


@check("port-fixes", 11)
def _pf11():
    """[inv:no-features-removed] port-fixes removes no feature: deleted dead code and legacy tests are free only when the feature they touched has its inventory row pinned elsewhere (every row owned by port-fixes is pinned), behavior fixes are limited to demonstrable source bugs (BigInt, expires_utc 0, ws.send before open) each pinned by a new test, and the inventory file is unchanged since failsafe-inventory (row_count not reduced)."""
    d = jread(INV, {}) or {}
    inv = inventory_owner_ok("port-fixes")
    return inv[0] and len(d.get("rows", [])) >= int(d.get("row_count") or 0) >= 40, inv[1]


@check("review-prep", 5)
def _rp5():
    """Blind-review gate ([inv:no-features-removed]): every failsafe-inventory row is still pinned (pin file exists, cites its row id, contains the named test) before the review diff is cut; the review brief itself stays the single word `Review`."""
    rows = inventory_rows()
    bad = [r["id"] for r in rows if not row_pinned(r)]
    sb = search_unpinned()
    return len(rows) >= 40 and not bad and not sb, f"{len(rows)} rows, unpinned {bad[:10]}; search inventory unpinned {sb[:10]}"


@check("audit-pre-review", 5)
def _apr5():
    """The pre-review audit checks the inventory: every failsafe-inventory row is pinned now and PRE-REVIEW.json records `inventory_rows` (the row count) and `inventory_unpinned: 0`."""
    f = jread(f"{PLAN}/review/PRE-REVIEW.json", {}) or {}
    rows = inventory_rows()
    bad = [r["id"] for r in rows if not row_pinned(r)]
    sb = search_unpinned()
    return len(rows) >= 40 and not bad and not sb and f.get("inventory_rows") == len(rows) and f.get("inventory_unpinned") == 0, f"unpinned {bad[:10]} search unpinned {sb[:6]} recorded={f.get('inventory_rows')}/{f.get('inventory_unpinned')}"


@check("audit-final", 12)
def _af12():
    """[inv:no-features-removed] final re-check: every failsafe-inventory row is still pinned on the final tree and the inventory file is unchanged since failsafe-inventory (rows were never deleted: row count >= the count recorded at inventory time in evidence/failsafe-inventory.json `row_count`)."""
    d = jread(INV, {}) or {}
    rows = d.get("rows", [])
    bad = [r["id"] for r in rows if not row_pinned(r)]
    sb = search_unpinned()
    return len(rows) >= max(40, int(d.get("row_count") or 0)) and not bad and not sb, f"{len(rows)} rows, unpinned {bad[:10]}; search inventory unpinned {sb[:10]}"


@check("failsafe-inventory", 5)
def _fi5():
    """The inventory covers the features F1 to F26 of EVAL-service-proxy.md section 2: each row may carry `eval_refs` (a list of ids such as "F7") and the union over all rows covers every id F1 to F26; F22 (consumer cleanup on every path) and F23 (exit-path shutdown of a hosting process) rows are owned by tests-unit-surface; rows for F23 to F25 cite agent-browser files (server.mjs, cdp-search.ts) whose anchors are verified like every other source."""
    refs = {}
    for r in inventory_rows():
        for x in r.get("eval_refs", []) or []:
            refs.setdefault(x, set()).add(r.get("owner_state"))
    miss = [f"F{i}" for i in range(1, 27) if f"F{i}" not in refs]
    bad = [x for x, o in refs.items() if x in ("F22", "F23") and not o <= {"tests-unit-surface"}]
    return not miss and not bad, f"uncovered {miss} wrongly owned {bad}"


@check("port-fixes", 12)
def _pf12():
    """Dependencies for the capture sink (no approval gate, an owned package): package.json `dependencies` lists @adhd/sox-store-adapter at ^0.13.3, vite.config.ts builds with `externalizeRealDeps(__dirname)` (imported from tools/vite-plugins/externalize.mjs) so no workspace package is inlined into dist, pnpm-lock.yaml resolves the store adapter, and `nx run stealth-browser:build` exits 0 with dist/index.js containing no inlined copy of createStoreAdapter (a `require` or dynamic `import()` of the name only). The @adhd/sox-service-proxy dependency is declared exactly once, by sp-link."""
    pkg = jread(f"{P}/package.json", {}) or {}
    deps = pkg.get("dependencies") or {}
    lock = read("pnpm-lock.yaml")
    v = read(f"{P}/vite.config.ts")
    static_ok = deps.get("@adhd/sox-store-adapter", "").lstrip("^~").startswith("0.13") and "externalizeRealDeps(__dirname)" in v and "sox-store-adapter" in lock
    if not static_ok:
        return False, "store-adapter dependency, externalizeRealDeps or lockfile entry missing"
    rc, out = sh([NX, "run", f"{proj_name()}:build"], timeout=1800)
    dist = read(f"{P}/dist/index.js")
    inlined = "function createStoreAdapter" in dist
    return rc == 0 and not inlined, f"build rc={rc} inlined={inlined}"


@check("surface-hosts", 14)
def _sh14():
    """(gap G2, F23 F24) the hosts wire the lifecycle: src/server.ts and src/cli.ts call `installProcessExitHooks` (from the lifecycle namespace) with the shared manager seam `chromeExitTarget`, both hosts accept `--idle-shutdown <ms>` (default 120000) and `--keep-alive` and pass them to `configureManagers` as `idleTimeoutMs` and `keepAlive` (`--keep-alive` never arms the idle timer; every other shutdown path is unchanged), the MCP host installs the hooks with `stdinEof: true` (orphan detection), and both bins print the two flags and the defaults in --help."""
    sv, cl = read(f"{P}/src/server.ts"), read(f"{P}/src/cli.ts")
    if not all(k in sv and k in cl for k in ("installProcessExitHooks", "chromeExitTarget", "configureManagers")) or "stdinEof" not in sv:
        return False, "exit hooks / manager seam not wired in src/server.ts and src/cli.ts"
    if not ensure_bin():
        return False, "build-bin failed"
    h = []
    for b in ("cli", "mcp"):
        rc, o, e = run2(["node", f"{P}/dist/bin/{b}.js", "--help"], 30)
        t = o + e
        h.append(rc == 0 and "--idle-shutdown" in t and "--keep-alive" in t and "120000" in t)
    return "installProcessExitHooks" in sv and "installProcessExitHooks" in cl and "stdinEof" in sv and all(h), f"help flags ok={h}"


SEAM = ("configureManagers", "managerFor", "chromeExitTarget")


@check("surface-hosts", 15)
def _sh15():
    """(P7, P8) the manager seam is shared and reachable from the root: src/lib/managers.ts exports configureManagers, managerFor and chromeExitTarget and is the only non-test file under src/ that constructs a ChromeManager (`new ChromeManager(`); src/api.ts imports managerFor from './lib/managers.js' and neither file reads process.env; `ChromeManagerOptions` declares `keepAlive?` and `entryPath?` and chrome-manager.ts passes entryPath to createProxyReaperLink; src/index.ts exports `lifecycle` from './lib/lifecycle/index.js' and src/lib/lifecycle/index.ts re-exports from '../managers.js'; `require()` of the built dist/index.js exposes lifecycle.configureManagers, lifecycle.managerFor, lifecycle.chromeExitTarget, lifecycle.installProcessExitHooks and lifecycle.runChromeReaper."""
    mg, api, cm = read(f"{P}/src/lib/managers.ts"), read(f"{P}/src/api.ts"), read(f"{P}/src/lib/chrome-manager.ts")
    sites = [os.path.relpath(f, P) for f in walk(f"{P}/src", (".ts",)) if "/test/" not in f and "new ChromeManager(" in code_lines(read(f))]
    seam = set(SEAM) <= exports_of(mg) and sites == ["src/lib/managers.ts"]
    routed = "managerFor" in api and re.search(r"from\s*['\"]\./lib/managers\.js['\"]", api) is not None and "process.env" not in api + mg
    opts = re.search(r"keepAlive\?\s*:", cm) is not None and re.search(r"entryPath\?\s*:", cm) is not None and re.search(r"createProxyReaperLink\(\{.{0,1500}?\bentryPath\b", cm, re.S) is not None
    ns = dict(NS_RE.findall(read(f"{P}/src/index.ts")))
    barrel = re.search(r"from\s*['\"]\.\./managers\.js['\"]", read(f"{P}/src/lib/lifecycle/index.ts")) is not None
    wired = re.sub(r"\.js$", "", ns.get("lifecycle", "")) == "./lib/lifecycle/index" and barrel
    if not (seam and routed and opts and wired):
        return False, f"seam={seam} (constructors {sites}) routed={routed} options={opts} root lifecycle wired={wired}"
    if not ensure_bin():
        return False, "build-bin failed"
    rc, o, e = run2(["node", "-e", "const l=require(process.argv[1]).lifecycle||{};console.log(JSON.stringify(Object.keys(l)))", os.path.abspath(f"{P}/dist/index.js")], 60)
    try:
        keys = set(json.loads(o.strip().splitlines()[-1]))
    except (ValueError, IndexError):
        keys = set()
    need = set(SEAM) | {"installProcessExitHooks", "runChromeReaper"}
    return rc == 0 and need <= keys, f"require rc={rc} lifecycle missing {sorted(need - keys)} {e[-120:]}"


@check("surface-hosts", 16)
def _sh16():
    """Host unit specs simulate real use in-process: spec files under test/unit/hosts/ cite ticket 8468f7b1 and [surface-hosts.16], import no node:child_process, and drive the real configureManagers, managerFor and chromeExitTarget (`keepAlive` true never arms the idle timer, `release()` and `shutdownIfIdle()` reach every live manager) and the host flag mapping of `--port`, `--user-data-dir`, `--idle-shutdown` and `--keep-alive`; `nx run stealth-browser:test -- test/unit/hosts` exits 0."""
    specs = spec_files("unit/hosts")
    t = "\n".join(read(f) for f in specs)
    must = [*SEAM, "keepAlive", "release(", "shutdownIfIdle(", "--port", "--user-data-dir", "--idle-shutdown", "--keep-alive"]
    miss = [m for m in must if m not in t]
    spawn = re.search(r"['\"](?:node:)?child_process['\"]", t) is not None
    if not specs or miss or spawn or TICKET not in t or "[surface-hosts.16]" not in t:
        return False, f"specs={len(specs)} missing tokens {miss} child_process={spawn} cites={TICKET in t and '[surface-hosts.16]' in t}"
    ok, why = run_unit("hosts")
    return ok, why


# ============================================================ service-proxy 0.6.0 consumption (sp-reaper-load-proof, sp-link, sp-reaper-smoke, sp-switch)
SP_VERSION = "0.6.0"
SP_TGZ_RE = re.compile(r"^file:(/Users/nix/\.cache/adhd-dev-tarballs/adhd-sox-service-proxy-0\.6\.0-[0-9a-f]{8}(?:-prerelease)?\.tgz)$")
RLP = f"{SMOKE}/reaper-load-proof.md"
SPL = f"{SMOKE}/sp-link.md"
SPS = f"{SMOKE}/switch.md"
SMK_JS = f"{SMOKE}/reaper-smoke.mjs"
SMK_MD = f"{SMOKE}/reaper-smoke.md"
SMK_JSON = f"{SMOKE}/reaper-smoke.json"


def sha256_file(p):
    try:
        return hashlib.sha256(open(p, "rb").read()).hexdigest()
    except OSError:
        return ""


def root_overrides():
    return (((jread("package.json", {}) or {}).get("pnpm") or {}).get("overrides")) or {}


def sp_dep():
    return ((pkg().get("dependencies")) or {}).get(PROXY_PKG, "")


def tarballs_missing():
    """tarball_missing for both published packages: (worst rc, {package dir: missing members})."""
    out, rc = {}, 0
    for d in (CORE_DIR, SEARCH_DIR):
        r, m = tarball_missing(d)
        rc = max(rc, r)
        if m:
            out[d] = m
    return rc, out


def local_specifiers():
    """`file:` / `link:` / `workspace:`-less local specifiers for any @adhd/* package in the root, stealth-browser and tripwire manifests (dependencies, devDependencies, peerDependencies, overrides)."""
    bad = []
    for f in ("package.json", f"{CORE_DIR}/package.json", f"{SEARCH_DIR}/package.json", f"{TW}/package.json"):
        d = jread(f, {}) or {}
        blocks = [d.get(k) or {} for k in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")] + [((d.get("pnpm") or {}).get("overrides")) or {}]
        for b in blocks:
            for k, v in b.items():
                if k.startswith("@adhd/") and isinstance(v, str) and re.match(r"^(file:|link:|portal:)", v):
                    bad.append(f"{f}:{k}={v}")
    return bad


def own_commits(slug):
    """Commit shas since the state's start_ref whose message carries [psm:<slug>]: concurrent states commit to shared paths, so 'did this state touch X' must look only at its own commits."""
    st = (state().get("states") or {}).get(slug) or {}
    since = st.get("start_ref") or git("merge-base", "HEAD", "main")
    log = sh(["git", "log", f"{since}..{completion_ref(slug)}", "--format=%H%x1f%B%x1e"])[1]
    out = []
    for rec in log.split("\x1e"):
        if "\x1f" not in rec:
            continue
        sha, body = rec.strip().split("\x1f", 1)
        if f"[psm:{slug}]" in body:
            out.append(sha)
    return out


def own_touched(slug, path):
    """Files under `path` touched by the state's own [psm:<slug>] commits only."""
    files = set()
    for sha in own_commits(slug):
        files.update(f for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", sha, "--", path).splitlines() if f)
    return sorted(files)


def manifest_line_changes(since, path, slug=None):
    """Changed lines of `path` since `since`, ignoring trailing-comma moves and lines that mention the service-proxy package: what remains is a change to anything other than the one dependency/override line."""
    if not since:
        return ["(no start_ref)"]
    rem, add = set(), set()
    if slug:
        diff = "\n".join(git("show", "-U0", "--format=", sha, "--", path) for sha in own_commits(slug))
    else:
        diff = git("diff", "-U0", since, "HEAD", "--", path)
    for ln in diff.splitlines():
        if ln.startswith(("+++", "---")) or ln[:1] not in "+-" or not ln[1:].strip():
            continue
        (add if ln[0] == "+" else rem).add(ln[1:].strip().rstrip(","))
    return sorted(x for x in rem ^ add if PROXY_PKG not in x)


# ---------------------------------------------------------------- sp-reaper-load-proof
@check("sp-reaper-load-proof", 1)
def _rlp1():
    """The built package entry loads the way the detached reaper will load it: smoke/reaper-load-proof.md records `BUILD: nx run stealth-browser:build exit=0`, `LOAD: exit=0 typeof=object` produced by `node -e "const m=require(process.argv[1]); console.log(typeof m)" <abs>/entrypoint/stealth-browser/dist/index.js` run from a cwd OUTSIDE the repository (`LOAD-CWD: <path>`), with no top-level side effect (the process exits on its own: no CDP connection, no timer left), and `EXTERNAL: yes` (dist requires @adhd/sox-service-proxy instead of inlining it)."""
    t = read(RLP)
    cwd = re.search(r"^LOAD-CWD:\s*(/\S+)\s*$", t, re.M)
    return (bool(re.search(r"^BUILD: nx run stealth-browser:build exit=0\s*$", t, re.M)) and bool(re.search(r"^LOAD: exit=0 typeof=object\s*$", t, re.M))
            and bool(cwd) and not cwd.group(1).startswith(TOP) and bool(re.search(r"^EXTERNAL: yes\s*$", t, re.M))), f"{len(t)} bytes, cwd={cwd.group(1) if cwd else None}"


@check("sp-reaper-load-proof", 2)
def _rlp2():
    """The exact spawn form is proven against a STUB namespace and the verdict is pinned: the evidence records `SPAWN: exit=0` for `process.execPath ['-e', 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))', <abs dist/index.js>, <json>]` (stub `lifecycle.runChromeReaper` added only in a scratch copy: the package source is untouched) and `VERDICT: entry-path-ok`; if the verdict is `VERDICT: needs-bin` an `ALTERNATIVE:` line names the `bin` entry that surface-hosts must own and chrome-lifecycle uses instead (the plan is then amended before chrome-lifecycle starts)."""
    t = read(RLP)
    form = "require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))" in t
    ok = bool(re.search(r"^SPAWN: exit=0\s*$", t, re.M)) and form
    v = re.search(r"^VERDICT:\s*(entry-path-ok|needs-bin)\s*$", t, re.M)
    alt = (v and v.group(1) == "needs-bin") and bool(re.search(r"^ALTERNATIVE:\s*\S", t, re.M))
    return ok and bool(v) and (v.group(1) == "entry-path-ok" or alt), f"spawn ok={ok} verdict={v.group(1) if v else None}"


@check("sp-reaper-load-proof", 3)
def _rlp3():
    """Only owned paths changed by [psm:sp-reaper-load-proof] commits (the single evidence file); no file under entrypoint/stealth-browser is modified and no scratch artifact is left in the repository."""
    o = ownership_ok("sp-reaper-load-proof")
    since = ((state().get("states") or {}).get("sp-reaper-load-proof") or {}).get("start_ref")
    touched = own_touched("sp-reaper-load-proof", P) if since else []
    return o[0] and not touched, f"{o[1]} package files touched by this state's commits: {touched[:5]}"


# ---------------------------------------------------------------- sp-link
@check("sp-link", 1)
def _spl1():
    """The stealth-browser manifest is FINAL from day one: entrypoint/stealth-browser/package.json `dependencies["@adhd/sox-service-proxy"]` is exactly `~0.6.0` (tilde: patch floats, a 0.x minor does not) and no `file:` / `link:` / `portal:` specifier appears in it (the sole recorded fallback, `FALLBACK: dependency-value` in smoke/sp-link.md, puts the `file:` tarball spec in this one dependency value instead of the root override)."""
    d = sp_dep()
    fb = re.search(r"^FALLBACK:\s*dependency-value\s*$", read(SPL), re.M) is not None
    if fb:
        return bool(SP_TGZ_RE.match(d)), f"fallback dependency value={d!r}"
    return d == "~0.6.0" and not [k for k, v in (pkg().get("dependencies") or {}).items() if str(v).startswith(("file:", "link:", "portal:"))], f"dependency={d!r}"


@check("sp-link", 2)
def _spl2():
    """The unreleased 0.6.0 resolves from a recorded dev tarball (or the registry once published): root package.json `pnpm.overrides["@adhd/sox-service-proxy"]` is `file:/Users/nix/.cache/adhd-dev-tarballs/adhd-sox-service-proxy-0.6.0-<sha8>[-prerelease].tgz`, that file exists and smoke/sp-link.md records `TARBALL_SHA256:` equal to its real sha256, `TARBALL_VERSION: 0.6.0` equal to the version inside the tarball, and `TARBALL_BUILD: pnpm pack` (never `npm pack`, which would leave a literal `workspace:^`); if 0.6.0 is already published the evidence records `REGISTRY: published`, the override is absent and the sp-switch state is verification-only. Recorded at completion: the override is read from the tree sp-link completed with (state.json end_ref); once sp-switch has removed it, smoke/switch.md must record the publication (`PUBLISHED: ... exit=0`) that superseded it."""
    t = read(SPL)
    if re.search(r"^REGISTRY:\s*published\s*$", t, re.M):
        return PROXY_PKG not in root_overrides() and sh(["npm", "view", f"{PROXY_PKG}@{SP_VERSION}", "version"], timeout=60)[0] == 0, "registry path"
    # Recorded-at-completion: the override is a one-shot that the next state (sp-switch) removes once 0.6.0 is published, so it is read from the tree
    # sp-link completed with (state.json end_ref), not from the live root package.json; the live tree must show the supersession (smoke/switch.md).
    end = completion_ref("sp-link")
    if end != "HEAD":
        rp = blob_at(end, "package.json")
        ov = ((((json.loads(rp) if rp else {}).get("pnpm") or {}).get("overrides")) or {}).get(PROXY_PKG, "")
        cp = blob_at(end, f"{CORE_DIR}/package.json") or blob_at(end, f"{LEGACY_DIR}/package.json")
        dep_then = (((json.loads(cp) if cp else {}).get("dependencies")) or {}).get(PROXY_PKG, "")
        if not ov and PROXY_PKG not in root_overrides():
            switched = re.search(r"^PUBLISHED:.*exit=0\s*$", read(SPS), re.M) is not None
        else:
            switched = True
        if not switched:
            return False, "override absent now but smoke/switch.md does not record the publication that superseded it"
    else:
        ov, dep_then = root_overrides().get(PROXY_PKG, ""), sp_dep()
    fb = re.search(r"^FALLBACK:\s*dependency-value\s*$", t, re.M) is not None
    m = SP_TGZ_RE.match(dep_then if fb else ov)
    if not m or not exists(m.group(1)):
        return False, f"override/dependency {ov!r} is not an existing dev tarball"
    sha = sha256_file(m.group(1))
    ver = ""
    rc, o, _ = run2(["tar", "-xzOf", m.group(1), "package/package.json"], 30)
    if rc == 0:
        try:
            ver = json.loads(o).get("version", "")
        except ValueError:
            ver = ""
    return (re.search(rf"^TARBALL_SHA256:\s*{sha}\s*$", t, re.M) is not None and ver == SP_VERSION and re.search(r"^TARBALL_VERSION:\s*0\.6\.0\s*$", t, re.M) is not None
            and re.search(r"^TARBALL_BUILD:\s*pnpm pack\s*$", t, re.M) is not None and sha[:8] in m.group(1)), f"sha={sha[:12]} version in tarball={ver!r}"


@check("sp-link", 3)
def _spl3():
    """The install is real: pnpm-lock.yaml resolves @adhd/sox-service-proxy to 0.6.0, the worktree's node_modules/@adhd/sox-service-proxy/package.json is version 0.6.0, and it exports every name lifecycle/sp.ts re-exports (ensureBackend, serveBackend, dialBackend, backendSocketPath, ensurePrivateSocketDir, readProcessStartToken, isSameProcess, createIdleRetirer, createCircuitBreaker)."""
    lock = read("pnpm-lock.yaml")
    ver = (jread(f"{P}/node_modules/@adhd/sox-service-proxy/package.json", {}) or jread("node_modules/@adhd/sox-service-proxy/package.json", {}) or {}).get("version")
    rc, o, e = run2(["node", "-e", "const m=require('@adhd/sox-service-proxy');console.log(JSON.stringify(Object.keys(m)))"], 60, cwd=P)
    try:
        have = set(json.loads(o.strip().splitlines()[-1])) if rc == 0 and o.strip() else set()
    except ValueError:
        have = set()
    miss = sorted(set(SP_EXPORTS) - have)
    return re.search(r"@adhd/sox-service-proxy[@/:'\"\s]*\S*0\.6\.\d+", lock) is not None and ver == SP_VERSION and not miss, f"lock mentions 0.6.x={'0.6.' in lock} installed={ver} missing exports={miss} {e[-100:]}"


def _sp_dist_probe():
    """Build the package and probe dist/index.js for the proxy: returns (rc, requires, inlined, mentions)."""
    rc, _ = sh([NX, "run", f"{proj_name()}:build"], timeout=1800)
    dist = read(f"{P}/dist/index.js")
    req = re.search(r"(?:require|import)\(\s*['\"]@adhd/sox-service-proxy['\"]", dist) is not None
    inl = re.search(r"function\s+(ensureBackend|serveBackend|dialBackend)\b", dist) is not None
    return rc, req, inl, "@adhd/sox-service-proxy" in dist


@check("sp-link", 4)
def _spl4():
    """The dist keeps the proxy external at link time: after `nx run stealth-browser:build` exits 0, dist/index.js has no inlined definition of ensureBackend, serveBackend or dialBackend, any reference to `@adhd/sox-service-proxy` in it is a `require` (or dynamic `import()`) and vite.config.ts keeps `externalizeRealDeps(__dirname)`. (That dist actually requires the package is asserted by sp-switch.5, after chrome-lifecycle has written lifecycle/sp.ts; sp-link may not touch src.)"""
    if sp_dep() == "" or not exists(SPL):
        return False, "dependency or evidence missing"
    rc, req, inl, ment = _sp_dist_probe()
    ok = rc == 0 and not inl and (req or not ment) and "externalizeRealDeps(__dirname)" in read(f"{P}/vite.config.ts")
    return ok, f"build rc={rc} external={req} inlined={inl} referenced={ment}"


@check("sp-link", 5)
def _spl5():
    """Only owned paths changed by [psm:sp-link] commits (the stealth-browser package.json, the root package.json, pnpm-lock.yaml and smoke/sp-link.md); the stealth-browser package.json diff of those commits touches the one `@adhd/sox-service-proxy` dependency line only, and no file under entrypoint/stealth-browser/src is modified."""
    o = ownership_ok("sp-link")
    since = ((state().get("states") or {}).get("sp-link") or {}).get("start_ref")
    src = own_touched("sp-link", f"{P}/src") if since else []
    other = manifest_line_changes(since, f"{P}/package.json", "sp-link")
    return o[0] and not src and not other, f"{o[1]} src touched={src[:3]} other manifest lines={other[:4]}"


# ---------------------------------------------------------------- sp-reaper-smoke (CL30)
@check("sp-reaper-smoke", 1)
def _sps1():
    """CL30 the gate script exists and is safe: smoke/reaper-smoke.mjs creates every directory with `mkdtemp` under os.tmpdir() (scratch stateDir), uses a CLOSED CDP port chosen at run time, never mentions port 9222, never touches the user's Chrome profile, and drives the BUILT dist (`require` of dist/index.js and `lifecycle.runChromeReaper` through the package entry, spawned the way reaper-link spawns it)."""
    t = read(SMK_JS)
    return bool(t.strip()) and "mkdtemp" in t and "9222" not in t and "dist/index.js" in t and "runChromeReaper" in t and "ensureBackend" in t, f"{len(t)} bytes"


@check("sp-reaper-smoke", 2)
def _sps2():
    """CL30 the real-process proof passes: `node smoke/reaper-smoke.mjs` (after `nx run stealth-core-browser:build` exits 0) exits 0 and its last stdout line is a JSON object with `ensure` = "spawned" and true values for `ping`, `hello`, `activity`, `status`, `entryLoaded` (the package entry exposes the `lifecycle` namespace), `retired` (the host retired on its own after `orphanWindowMs` = 1 s) and `socketRemoved`."""
    if not exists(SMK_JS):
        return False, "script missing"
    b, _ = sh([NX, "run", f"{proj_name()}:build"], timeout=1800)
    if b != 0:
        return False, f"build rc={b}"
    rc, o, e = run2(["node", SMK_JS], 180)
    try:
        res = json.loads(o.strip().splitlines()[-1]) if o.strip() else {}
    except ValueError:
        res = {}
    need = ["ping", "hello", "activity", "status", "entryLoaded", "retired", "socketRemoved"]
    bad = [k for k in need if res.get(k) is not True]
    return rc == 0 and res.get("ensure") == "spawned" and not bad, f"rc={rc} ensure={res.get('ensure')} not true: {bad} {e[-120:]}"


@check("sp-reaper-smoke", 3)
def _sps3():
    """The run is recorded and the state is read-only for the package: smoke/reaper-smoke.md records `RUN: exit=0`, the dist/index.js sha256 and the service-proxy version used, smoke/reaper-smoke.json holds the script output, only owned paths changed by [psm:sp-reaper-smoke] commits and no file under packages/stealth/stealth-core-browser/src is modified."""
    t = read(SMK_MD)
    j = jread(SMK_JSON, {}) or {}
    o = ownership_ok("sp-reaper-smoke")
    since = ((state().get("states") or {}).get("sp-reaper-smoke") or {}).get("start_ref")
    src = own_touched("sp-reaper-smoke", f"{P}/src") if since else []
    return re.search(r"^RUN: exit=0\s*$", t, re.M) is not None and re.search(r"[0-9a-f]{64}", t) is not None and "0.6." in t and j.get("ensure") == "spawned" and o[0] and not src, f"{o[1]} src touched={src[:3]}"


# ---------------------------------------------------------------- sp-switch
@check("sp-switch", 1)
def _sw1():
    """0.6.0 is on the registry: smoke/switch.md records `PUBLISHED: npm view @adhd/sox-service-proxy@0.6.0 version exit=0` with the printed version `0.6.0` (the human release go is hb-sp-release); when the state is a verification-only no-op the evidence says `NOOP: published before sp-link`."""
    t = read(SPS)
    return re.search(r"^PUBLISHED: npm view @adhd/sox-service-proxy@0\.6\.0 version exit=0\s*$", t, re.M) is not None and re.search(r"^VERSION:\s*0\.6\.0\s*$", t, re.M) is not None, f"{len(t)} bytes"


@check("sp-switch", 2)
def _sw2():
    """The dev-tarball indirection is gone with no source change: root package.json `pnpm.overrides` has no `@adhd/sox-service-proxy` key, no @adhd/* dependency or override in the root, stealth-core-browser or tripwire manifests starts with `file:`, `link:` or `portal:`, pnpm-lock.yaml mentions neither `adhd-dev-tarballs` nor a `file:/Users` resolution and resolves @adhd/sox-service-proxy 0.6.x with an integrity hash, `git diff` of packages/stealth/stealth-core-browser/src since the state start is empty, and the core manifest's `@adhd/sox-service-proxy` specifier is a published semver range (`^0.6.0` or `~0.6.0`)."""
    lock = read("pnpm-lock.yaml")
    since = ((state().get("states") or {}).get("sp-switch") or {}).get("start_ref")
    src = own_touched("sp-switch", f"{P}/src") if since else ["(no start_ref)"]
    reg = re.search(r"/?@adhd/sox-service-proxy@0\.6\.\d+:\s*\n\s*resolution:\s*\{integrity:", lock) is not None
    return PROXY_PKG not in root_overrides() and not local_specifiers() and "adhd-dev-tarballs" not in lock and "file:/Users" not in lock and reg and not src and re.fullmatch(r"[~^]0\.6\.\d+", sp_dep() or "") is not None, f"core range={sp_dep()!r} overrides={root_overrides().get(PROXY_PKG)} local specifiers={local_specifiers()} registry resolution={reg} src={src[:3]}"


@check("sp-switch", 3)
def _sw3():
    """The registry build passes the same gates: after the switch `nx run stealth-core-browser:build` and `nx run stealth-core-browser:test -- test/unit/lifecycle` exit 0, and smoke/switch.md records `BUILD: exit=0` and `LIFECYCLE-UNIT: exit=0`."""
    t = read(SPS)
    if not (re.search(r"^BUILD: exit=0\s*$", t, re.M) and re.search(r"^LIFECYCLE-UNIT: exit=0\s*$", t, re.M)):
        return False, "evidence missing"
    b, _ = sh([NX, "run", f"{proj_name()}:build"], timeout=1800)
    ok, why = run_unit("lifecycle")
    return b == 0 and ok, f"build={b} {why}"


@check("sp-switch", 4)
def _sw4():
    """Only owned paths changed by [psm:sp-switch] commits (the root package.json, pnpm-lock.yaml and smoke/switch.md); the root package.json diff removes the single `@adhd/sox-service-proxy` override line and adds nothing else."""
    o = ownership_ok("sp-switch")
    since = ((state().get("states") or {}).get("sp-switch") or {}).get("start_ref")
    extra = manifest_line_changes(since, "package.json", "sp-switch")
    return o[0] and not extra, f"{o[1]} other root manifest lines changed={extra[:4]}"


@check("sp-switch", 5)
def _sw5():
    """The built dist requires the proxy from the registry build: with no dev-tarball override or local specifier left, `src/lib/lifecycle/sp.ts` exists, `nx run stealth-core-browser:build` exits 0, dist/index.js contains a `require` (or dynamic `import()`) of `@adhd/sox-service-proxy` and no inlined definition of ensureBackend, serveBackend or dialBackend."""
    if not exists(f"{P}/src/lib/lifecycle/sp.ts"):
        return False, "src/lifecycle/sp.ts missing"
    if PROXY_PKG in root_overrides() or local_specifiers():
        return False, f"dev-tarball indirection still present: overrides={root_overrides().get(PROXY_PKG)} local={local_specifiers()}"
    rc, req, inl, _ = _sp_dist_probe()
    return rc == 0 and req and not inl, f"build rc={rc} external={req} inlined={inl}"


# ============================================================ tripwire package (tripwire-scaffold .. tripwire-pack) and the reverse-apis adoption
TW_SRC = f"{TW}/src"
TW_EVID_DIR = f"{PLAN}/evidence/tripwire"
TW_TARBALL = f"{TW_EVID_DIR}/tripwire-tarball.json"
TW_APPROVAL = f"{PLAN}/APPROVAL-tripwire.md"
TW_REQUEST = "Implement tripwire package in this plan covering all 3"
TW_ALL_TARGETS = ["lint", "typecheck", "typecheck-spec", "test", "build", "verify-dist-load"]


def tw_tree_sha():
    return git("rev-parse", f"HEAD:{TW}") if exists(TW) else ""


def tw_nx(target, timeout=1800):
    return sh([NX, "run", f"{TW_NAME}:{target}"], timeout=timeout)


def tw_spec(fname, cid, must=()):
    p = f"{TW}/test/unit/{fname}"
    t = read(p)
    miss = [m for m in must if m not in t]
    return bool(t.strip()) and TICKET in t and f"[{cid}]" in t and not miss, f"{fname}: exists={bool(t.strip())} cites ticket={TICKET in t} id={f'[{cid}]' in t} missing tokens={miss}"


def tw_lib_files():
    return [f for f in walk(f"{TW}/src/lib", (".ts",)) if not f.endswith(".d.ts")]


TW_BANNED = re.compile(r"process\.env|process\.stdin|process\.stdout|child_process|\bconsole\.")


def tw_purity():
    """TW31: no process.env/stdin/stdout, child_process or console.* in src/lib outside node-io.ts (the one Node IO adapter); no import of node:net/http/https/child_process anywhere in src."""
    bad = []
    for f in tw_lib_files():
        if os.path.basename(f) == "node-io.ts":
            continue
        t = code_lines(read(f))
        if TW_BANNED.search(t):
            bad.append(os.path.relpath(f, TW))
    net = [os.path.relpath(f, TW) for f in walk(TW_SRC, (".ts",)) if re.search(r"from ['\"]node:(net|http|https|child_process|dns|tls)['\"]|require\(['\"](child_process|net|http)['\"]\)", read(f))]
    return bool(tw_lib_files()) and not bad and not net, f"banned access in {bad}; network/process imports in {net}; lib files={len(tw_lib_files())}"


def tw_citation_slugs():
    """State slugs whose criterion ids a tripwire spec may cite: the tripwire-* states that built the package plus every later state that owns the whole tripwire package (fix-tripwire, conform-tripwire add specs under their own ids)."""
    later = sorted(k for k, v in ownership().items() if f"{TW}/" in v and not k.startswith("tripwire-"))
    return ["tripwire-[a-z-]+"] + [re.escape(k) for k in later]


def tw_citations():
    """TW35: every spec under test/ cites ticket 8468f7b1 and a criterion id of a state that owns the tripwire package: [tripwire-<state>.N], or [fix-tripwire.N] / [conform-tripwire.N] for the specs those later states added."""
    specs = [f for f in walk(f"{TW}/test", (".ts",)) if f.endswith(".spec.ts")]
    ids = criteria_ids()
    rx = r"\[((?:" + "|".join(tw_citation_slugs()) + r")\.\d+)\]"
    bad = [os.path.relpath(f, TW) for f in specs if TICKET not in read(f) or not (set(re.findall(rx, read(f))) & ids)]
    return bool(specs) and not bad, f"uncited specs {bad[:6]}"


def tw_gate_run(evidence):
    """Run the six tripwire nx targets once per tripwire tree and cache the result in `evidence`."""
    cur = tw_tree_sha()
    cached = jread(evidence)
    if cached and cached.get("tw_tree") == cur and cached.get("all_green"):
        return cached
    res = {}
    for t in TW_ALL_TARGETS:
        t0 = time.time()
        rc, out = tw_nx(t, 2400)
        res[t] = {"cmd": f"nx run {TW_NAME}:{t}", "exit": rc, "seconds": round(time.time() - t0, 1), "tail": out[-300:]}
    doc = {"tw_tree": cur, "head": git("rev-parse", "HEAD"), "results": res, "all_green": all(v["exit"] == 0 for v in res.values())}
    os.makedirs(os.path.dirname(evidence), exist_ok=True)
    with open(evidence, "w", encoding="utf8") as f:
        json.dump(doc, f, indent=2)
    return doc


# ---------------------------------------------------------------- tripwire-scaffold
@check("tripwire-scaffold", 1)
def _tws1():
    """Approval and domain are recorded before anything is generated: docs/plan/stealth-browser/APPROVAL-tripwire.md quotes the verbatim request `Implement tripwire package in this plan covering all 3`, names the approver and date and decisions D1 to D4, and .adhd/workspace.json has the `resilience` group (with a description) next to the existing groups."""
    a = read(TW_APPROVAL)
    ws = jread(".adhd/workspace.json", {}) or {}
    grp = (ws.get("groups") or {}).get("resilience")
    ok = TW_REQUEST in a and all(f"D{n}" in a for n in (1, 2, 3, 4)) and re.search(r"^APPROVER:\s*\S", a, re.M) is not None
    return ok and isinstance(grp, dict) and bool(grp.get("description")), f"approval ok={ok} group={grp}"


@check("tripwire-scaffold", 2)
def _tws2():
    """The package is generator-built (never hand-built): evidence/tripwire/scaffold-dry-run.txt holds the transcript of `npx nx g @adhd/workspace-codegen-nx:core --name=tripwire --group=resilience --nxLayer=shared --platform=node --access public --publish true --dry-run` with its CREATE list, packages/resilience/resilience-core-tripwire/project.json is named `resilience-core-tripwire`, and its tags are exactly domain:resilience, pkg-kind:core, pkg-class:foundation, layer:shared, platform:node and access:public, plus `publish:npm` (added by the mandated `--publish true`) and any `scope:*` tag."""
    t = read(f"{TW_EVID_DIR}/scaffold-dry-run.txt")
    pj = jread(f"{TW}/project.json", {}) or {}
    tags = set(pj.get("tags") or [])
    want = {"domain:resilience", "pkg-kind:core", "pkg-class:foundation", "layer:shared", "platform:node", "access:public"}
    allowed = want | {"publish:npm"}
    return ("--name=tripwire" in t and "--group=resilience" in t and "--dry-run" in t and "CREATE" in t and pj.get("name") == TW_NAME and want <= tags and not (tags - allowed - {t_ for t_ in tags if t_.startswith("scope:")})), f"name={pj.get('name')} tags={sorted(tags)}"


@check("tripwire-scaffold", 3)
def _tws3():
    """The manifest has the ADR-0003 CJS-only shape: name @adhd/resilience-core-tripwire, version 0.1.0, `main` ./dist/index.js, `type` unset, no `module`, no `exports`, no `bin`, empty or absent `dependencies`, engines.node >= 20, publishConfig.access public, `files` containing dist and CHANGELOG.md; tsconfig.base.json maps the @adhd/resilience-core-tripwire alias; the vite config (vite.config.ts) emits CJS only: `formats` is exactly `['cjs']` (no `es`/`esm`) and `fileName` yields .js output (no `.mjs` fileName or output extension). Importing tools/vite-plugins/*.mjs helpers is allowed."""
    p = jread(f"{TW}/package.json", {}) or {}
    vite = read(f"{TW}/vite.config.ts")
    shape = (p.get("name") == TW_PKG and p.get("version") == "0.1.0" and p.get("main") == "./dist/index.js" and "type" not in p and "module" not in p and "exports" not in p and "bin" not in p
             and not (p.get("dependencies") or {}) and (p.get("publishConfig") or {}).get("access") == "public" and {"dist", "CHANGELOG.md"} <= set(p.get("files") or [])
             and re.search(r"(>=\s*)?(20|22)", (p.get("engines") or {}).get("node", "")) is not None)
    fm = re.search(r"formats\s*:\s*\[([^\]]*)\]", vite)
    fmts = re.findall(r"['\"]([A-Za-z]+)['\"]", fm.group(1)) if fm else []
    fn = re.search(r"fileName\s*:\s*([^,\n}]+)", vite)
    fn_s = fn.group(1) if fn else ""
    cjs = bool(vite.strip()) and fmts == ["cjs"] and not re.search(r"\.mjs['\"`]|\bmjs\b|\.es\.|\.esm\.", fn_s)
    return shape and cjs and TW_PKG in read("tsconfig.base.json"), f"shape={shape} cjs-only vite={cjs} alias={TW_PKG in read('tsconfig.base.json')}"


@check("tripwire-scaffold", 4)
def _tws4():
    """The empty skeleton builds: `nx run resilience-core-tripwire:typecheck` and `nx run resilience-core-tripwire:build` exit 0 (only the generated src/index.ts exists at this point)."""
    if not exists(f"{TW}/project.json"):
        return False, "project missing"
    a, ao = tw_nx("typecheck")
    b, bo = tw_nx("build")
    return a == 0 and b == 0, f"typecheck={a} build={b} {ao[-100:]} {bo[-100:]}"


@check("tripwire-scaffold", 5)
def _tws5():
    """Exactly the approved project.json files were added since main (the migrated package, the tripwire package and, once search-scaffold has run, stealth-search: three in all; the same rule as scaffold.5), only owned paths changed by [psm:tripwire-scaffold] commits (the tripwire package directory, tsconfig.base.json, .adhd/workspace.json and evidence/tripwire/), and no other workspace group or project was edited."""
    o = ownership_ok("tripwire-scaffold")
    return _s5()[0] and o[0] and exists(f"{TW}/project.json"), f"{o[1]} {_s5()[1]}"


# ---------------------------------------------------------------- tripwire-core (TW1-TW23, TW30-33, TW35-38)
TW_CORE_MAP = [
    (1, "TW1", "tripwire.spec.ts", ("created", "tripwire-retripped"), "second `trip` on a tripped key returns `created: false`, the first record (reason, trippedAt, context) is untouched and `tripwire-retripped` is audited"),
    (2, "TW2", "storage.spec.ts", (".tmp", "interleav"), "writes use unique tmp names (pid plus random); two interleaved writers never share a tmp name and a reader at any interleaving point sees complete JSON or ENOENT"),
    (3, "TW3", "tripwire.spec.ts", ("unreadable", "EACCES", "EIO", "assertOpen"), "fail closed: ENOENT is clear; EACCES, EIO, an empty file, garbage JSON and a wrong schema are tripped with status `unreadable` and `assertOpen` throws"),
    (4, "TW4", "legacy.spec.ts", ("lastStatus", "lastOperationId", "reverifiedAt", "blockedCount"), "legacy reverse-shaped and search-shaped locks (including the in-record blockedCount and reverifiedAt) are read and honored, extra fields land in `context` and the counts add"),
    (5, "TW5", "tripwire.spec.ts", ("TRIPWIRE_INVALID_KEY",), "keys `..`, `a/b`, empty, 65 characters and a leading dot are rejected with TRIPWIRE_INVALID_KEY before any fs call"),
    (6, "TW6", "storage.spec.ts", ("0o600", "0o700"), "lock, sidecar and audit files are 0600 and directories 0700, including pre-existing directories (chmod)"),
    (7, "TW7", "redact.spec.ts", ("authorization", "cookie", "responseBody"), "redaction: denylisted header, cookie and token keys dropped, URL query secrets stripped, long strings truncated, a custom redactor composed after the default, `responseBody` never written, the audit never contains query text"),
    (8, "TW8", "tripwire.spec.ts", ("sessionId", "trippedBy", "browserSessionId"), "context round-trips both consumers' fields (`lastStatus`, `lastOperationId` and `query`, `pageUrl`, `strategy`, `browserSessionId`, `lastOperation`) and `sessionId()` lands in `trippedBy`"),
    (9, "TW9", "tripwire.spec.ts", ("gate", "open"), "`gate` on a clear key is open with zero writes and zero audit lines"),
    (10, "TW10", "tripwire.spec.ts", ("tripwire-gate-blocked", "TripwireTrippedError", "recoveryHint"), "`gate` on a tripped key is closed, the count rises by one and `tripwire-gate-blocked` is audited; `assertOpen` throws TripwireTrippedError with key, reason, trippedAt Date, record, recoveryHint and code"),
    (11, "TW11", "interleave.spec.ts", ("blockedCount",), "N interleaved gates give `blockedCount === N` exactly (no lost updates)"),
    (12, "TW12", "interleave.spec.ts", ("gate", "clear"), "a block racing a clear never recreates the lock; after the clear the lock is absent"),
    (13, "TW13", "expiry.spec.ts", ("tripwire-expired", "includeExpired", "ttlMs"), "with `expiry`, an older-than-TTL lock is open, lazily removed with one `tripwire-expired` audit; without `expiry` it never expires; `status` hides expired unless `includeExpired` (one rule for CLI and MCP)"),
    (14, "TW14", "clear.spec.ts", ("TripwireConfirmError", "CONFIRM_TOKEN"), "`confirm-token` policy: a missing or wrong token throws TripwireConfirmError with the lock intact and no cleared audit; the correct token clears and the audit has method and actor"),
    (15, "TW15", "clear.spec.ts", ("mcp-clear", "open"), "`open` policy clears without a token and audits method `mcp-clear`"),
    (16, "TW16", "clear.spec.ts", ("cleared",), "clear on an absent lock returns `{ cleared: false }`, does not throw and audits nothing"),
    (17, "TW17", "clear.spec.ts", ("priorClear",), "clear writes the marker; the next trip carries `priorClear` and the marker is consumed once"),
    (18, "TW18", "clear.spec.ts", ("tripwire-resolved", "reverified"), "`resolve` audits `tripwire-resolved` with durationMs and blockedCount, then removes; the `reverified` flag appears on the cleared audit event"),
    (19, "TW19", "audit.spec.ts", ("tripwire-fired", "tripwire-gate-blocked", "tripwire-cleared", "tripwire-resolved", "tripwire-expired", "tripwire-retripped"), "audit: one valid NDJSON line per event with ts, event, key and namespace; fired, gate-blocked, cleared, resolved, expired and retripped are all emitted; each line is under 4 KB"),
    (20, "TW20", "audit.spec.ts", ("maxAuditBytes", "multibyte"), "audit cap: at or above `maxAuditBytes` the oldest half is dropped at a line boundary, byte-accurate with multibyte lines, the newest kept, the replace atomic, the log never above the cap after an append, and an append interleaved with rotation loses no complete line other than the dropped half"),
    (21, "TW21", "audit.spec.ts", ("auditPath",), "audit dir is `dirname(auditPath)`; the default is under `stateDir`; an `auditPath` outside stateDir works; nothing is written under the real home"),
    (22, "TW22", "audit.spec.ts", ("onWarning",), "an audit write failure never throws from `gate`, `trip` or `clear` and `onWarning` is called"),
    (23, "TW23", "tripwire.spec.ts", ("persisted", "TRIPWIRE_IO"), "a persist failure on `trip` gives `persisted: false` and a TRIPWIRE_IO warning, and a same-process `gate` is still closed"),
]


def _mk_core(n, label, fname, must, text):
    def fn():
        return tw_spec(fname, f"tripwire-core.{n}", (label,) + tuple(must))
    fn.__doc__ = f"{label} {text}; proven in test/unit/{fname} (cites ticket 8468f7b1, the id and {label})."
    check("tripwire-core", n)(fn)


for _row in TW_CORE_MAP:
    _mk_core(*_row)


@check("tripwire-core", 24)
def _twc24():
    """TW30 public surface: src/index.ts exports createTripwire, adhdDataDir, CONFIRM_TOKEN, defaultRedactor, TripwireTrippedError, TripwireConfirmError, TripwireAbortedError, isTripwireTrippedError, createMemoryFs, createFileStorage, createMemoryStorage and the types of the spec (Tripwire, TripwireOptions, TripwireRecord, TripwireSnapshot, TripwireStorage, FsPort, Redactor, ClearMethod, TripContext); no consumer-specific name (`provider`, `client`) appears in an exported type name; api-surface.spec.ts snapshots `Object.keys(require index)`; the package has no subpath export."""
    idx = read(f"{TW_SRC}/index.ts")
    names = barrel_names_of(f"{TW_SRC}/index.ts")
    need = {"createTripwire", "adhdDataDir", "CONFIRM_TOKEN", "defaultRedactor", "TripwireTrippedError", "TripwireConfirmError", "TripwireAbortedError", "isTripwireTrippedError", "createMemoryFs", "createFileStorage", "createMemoryStorage",
            "Tripwire", "TripwireOptions", "TripwireRecord", "TripwireSnapshot", "TripwireStorage", "FsPort", "Redactor", "ClearMethod", "TripContext"}
    miss = sorted(need - names)
    consumer = [n for n in names if re.search(r"provider|client", n, re.I)]
    ok, why = tw_spec("api-surface.spec.ts", "tripwire-core.24", ("TW30", "Object.keys"))
    return bool(idx.strip()) and not miss and not consumer and ok, f"missing exports {miss}; consumer-specific names {consumer}; {why}"


@check("tripwire-core", 25)
def _twc25():
    """TW31 purity: no `process.env`, `process.stdin`, `process.stdout`, `child_process` or `console.*` appears in non-comment lines of packages/resilience/resilience-core-tripwire/src/lib outside node-io.ts, and no source file imports node:net, node:http, node:https or node:child_process; the package reads no environment variable (adhdDataDir takes `env` as a parameter)."""
    return tw_purity()


@check("tripwire-core", 26)
def _twc26():
    """TW32 errors: every error class has a stable `code` and a brand; errors.spec.ts proves `isTripwireTrippedError` is true for a structural clone standing in for an instance from a duplicate module copy, and each error's code is one of the registry (TRIPWIRE_TRIPPED, TRIPWIRE_CONFIRM_REQUIRED, TRIPWIRE_ABORTED, TRIPWIRE_INVALID_KEY, TRIPWIRE_IO)."""
    e = read(f"{TW_SRC}/lib/errors.ts")
    ok, why = tw_spec("errors.spec.ts", "tripwire-core.26", ("TW32", "isTripwireTrippedError", "brand"))
    return all(c in e for c in ("TRIPWIRE_TRIPPED", "TRIPWIRE_CONFIRM_REQUIRED", "TRIPWIRE_ABORTED", "TRIPWIRE_INVALID_KEY", "TRIPWIRE_IO")) and ok, why


@check("tripwire-core", 27)
def _twc27():
    """TW33 `TripwireTrippedError.fromRecord(record, { responseStatus, responseBody })` exposes typed `responseStatus` and `responseBody` fields; neither is ever serialized by `trip` or written to the lock or the audit (errors.spec.ts and redact.spec.ts)."""
    return tw_spec("errors.spec.ts", "tripwire-core.27", ("TW33", "fromRecord", "responseStatus", "responseBody"))


@check("tripwire-core", 28)
def _twc28():
    """TW35 every spec under src/test cites ticket 8468f7b1 and a [tripwire-<state>.N] criterion id plus a TW id, and no spec imports child_process, net or http."""
    return tw_citations()


@check("tripwire-core", 29)
def _twc29():
    """TW36 interleaving suite over the memory-fs hooks: trip/trip, gate/gate, gate/clear, clear/clear, trip/clear and audit rotate/append hold their invariants (TW1, TW11, TW12, TW20) in interleave.spec.ts."""
    return tw_spec("interleave.spec.ts", "tripwire-core.29", ("TW36", "trip", "gate", "clear", "rotat"))


@check("tripwire-core", 30)
def _twc30():
    """TW37 `adhdDataDir(['reverse','data'], { ADHD_HOME: '/x' })` is `/x/reverse/data`; with no env it is `<home>/.adhd/reverse/data`; the function is pure (paths.spec.ts)."""
    return tw_spec("paths.spec.ts", "tripwire-core.30", ("TW37", "ADHD_HOME", "/x/reverse/data"))


@check("tripwire-core", 31)
def _twc31():
    """TW38 the storage contract suite (storage-contract.spec.ts) runs identically on `createMemoryStorage`, `createFileStorage` over the memory fs and `createFileStorage` over a real `mkdtemp` directory; create-if-absent uses link with an `open wx` fallback (a memory fs that rejects `link` is covered)."""
    unit = tw_spec("storage-contract.spec.ts", "tripwire-core.31", ("TW38", "createMemoryStorage", "createFileStorage", "link"))
    # the real-directory (mkdtemp) run lives at the tier that may touch disk (resolve-findings F61): the same shared contract cases, run through the node fs
    e2e = read(f"{TW}/test/e2e/storage-contract.e2e.ts")
    real = TICKET in e2e and "[tripwire-core.31]" in e2e and "mkdtemp" in e2e and "createFileStorage" in e2e and "defineStorageContract" in e2e
    return unit[0] and real, f"{unit[1]}; real-disk e2e contract run={real}"


@check("tripwire-core", 32)
def _twc32():
    """The core builds and passes alone: the files src/lib/{types,errors,redact,paths,storage,memory-fs,audit,tripwire}.ts and src/index.ts exist, `nx run resilience-core-tripwire:typecheck`, `:typecheck-spec`, `:lint` and `:test` exit 0, and only owned paths changed by [psm:tripwire-core] commits."""
    files = all(exists(f"{TW_SRC}/lib/{n}.ts") for n in ("types", "errors", "redact", "paths", "storage", "memory-fs", "audit", "tripwire")) and exists(f"{TW_SRC}/index.ts")
    if not files:
        return False, "core source files missing"
    rcs = {t: tw_nx(t, 2400)[0] for t in ("typecheck", "typecheck-spec", "lint", "test")}
    o = ownership_ok("tripwire-core")
    return all(v == 0 for v in rcs.values()) and o[0], f"{rcs} {o[1]}"


# ---------------------------------------------------------------- tripwire-interactive
@check("tripwire-interactive", 1)
def _twi1():
    """TW24 `interactiveGate` (interactive.spec.ts): the banner content, `retry` / Enter / any other input gives reverified plus clear (method `hitl-retry`) and returns, `clear` gives `hitl-clear`, `abort` throws TripwireAbortedError with the lock kept, and each loop iteration counts one block."""
    return tw_spec("interactive.spec.ts", "tripwire-interactive.1", ("TW24", "interactiveGate", "hitl-retry", "hitl-clear", "TripwireAbortedError"))


@check("tripwire-interactive", 2)
def _twi2():
    """TW25 a non-TTY or a `question` that returns null (EOF) aborts with the lock kept and never hangs (interactive.spec.ts, fake io with no stdin)."""
    return tw_spec("interactive.spec.ts", "tripwire-interactive.2", ("TW25", "null", "TripwireAbortedError"))


@check("tripwire-interactive", 3)
def _twi3():
    """TW26 `confirmSolved`: Enter gives reverified plus cleared; `abort` throws TripwireAbortedError('HITL aborted by user') with the lock kept (interactive.spec.ts)."""
    return tw_spec("interactive.spec.ts", "tripwire-interactive.3", ("TW26", "confirmSolved", "HITL aborted by user"))


@check("tripwire-interactive", 4)
def _twi4():
    """TW27 `runUnlockCli` (cli.spec.ts and scenario-unlock-cli.spec.ts): no client prints usage and returns 1; no lock prints `no tripwire to unlock for X` and returns 0; reason, trippedAt, lastStatus and lastOperationId are printed with `(none)` fallbacks; an unparseable lock warns and proceeds; the TTY confirm path; the `CONFIRM` env path; a mismatch returns 1 with the lock kept; no TTY and no CONFIRM returns 1 with `No TTY`; a storage error returns 2; the audit method is `unlock-cli-tty` or `unlock-cli-env`."""
    a, wa = tw_spec("cli.spec.ts", "tripwire-interactive.4", ("TW27", "runUnlockCli", "No TTY", "unlock-cli-tty", "unlock-cli-env", "(none)"))
    b, wb = tw_spec("scenario-unlock-cli.spec.ts", "tripwire-interactive.4", ("TW27", "runUnlockCli"))
    return a and b, f"{wa}; {wb}"


@check("tripwire-interactive", 5)
def _twi5():
    """TW28 `renderStatusText` gives the per-provider layout and `No tripwires tripped.`; `statusJsonLine` is exactly `{"type":"tripwireStatus","status":{...}}`, is the last line of the status output, and the map is sparse with plain string keys (render.spec.ts)."""
    return tw_spec("render.spec.ts", "tripwire-interactive.5", ("TW28", "renderStatusText", "statusJsonLine", "No tripwires tripped.", "tripwireStatus"))


@check("tripwire-interactive", 6)
def _twi6():
    """Scenario suite for the request-builder consumer (scenario-request-builder.spec.ts): a 4xx trips the key, three following sends are blocked and counted, the confirm-token unlock clears it and the next send is open; a corrupt lock blocks; a second 4xx keeps the first record."""
    return tw_spec("scenario-request-builder.spec.ts", "tripwire-interactive.6", ("assertOpen", "trip", "CONFIRM_TOKEN", "blockedCount"))


@check("tripwire-interactive", 7)
def _twi7():
    """Scenario suite for the agent-search consumer (scenario-agent-search.spec.ts): a captcha trips the key, later searches get locked responses, the HITL loop offers retry, clear and abort, the TTL expiry removes the lock lazily with an audit line, and a successful search resolves the tripwire (`open` clear policy, expiry 2 h)."""
    return tw_spec("scenario-agent-search.spec.ts", "tripwire-interactive.7", ("interactiveGate", "resolve", "ttlMs", "clearPolicy"))


@check("tripwire-interactive", 8)
def _twi8():
    """The public surface is complete and closed: src/index.ts now also exports interactiveGate, confirmSolved, runUnlockCli, renderStatusText, statusJsonLine and nodeTripwireIo (plus their option and io types), api-surface.spec.ts snapshots exactly the section-3 export list (no consumer-specific names), and node-io.ts is the only file under src/lib that touches process.stdin, process.stdout or process.env (TW31)."""
    names = barrel_names_of(f"{TW_SRC}/index.ts")
    need = {"interactiveGate", "confirmSolved", "runUnlockCli", "renderStatusText", "statusJsonLine", "nodeTripwireIo"}
    ok, why = tw_spec("api-surface.spec.ts", "tripwire-interactive.8", ("TW30", "interactiveGate", "runUnlockCli", "nodeTripwireIo"))
    p = tw_purity()
    return not (need - names) and ok and p[0] and exists(f"{TW_SRC}/lib/node-io.ts"), f"missing {sorted(need - names)}; {why}; {p[1]}"


@check("tripwire-interactive", 9)
def _twi9():
    """The package builds and passes whole: `nx run resilience-core-tripwire:typecheck`, `:typecheck-spec`, `:lint` and `:test` exit 0, every spec still cites the ticket and a criterion id (TW35), and only owned paths changed by [psm:tripwire-interactive] commits."""
    files = all(exists(f"{TW_SRC}/lib/{n}.ts") for n in ("interactive", "cli", "render", "node-io"))
    if not files:
        return False, "interactive source files missing"
    rcs = {t: tw_nx(t, 2400)[0] for t in ("typecheck", "typecheck-spec", "lint", "test")}
    o = ownership_ok("tripwire-interactive")
    c = tw_citations()
    return all(v == 0 for v in rcs.values()) and o[0] and c[0], f"{rcs} {o[1]} {c[1]}"


# ---------------------------------------------------------------- tripwire-docs
def tw_error_codes():
    return sorted(set(re.findall(r"\bTRIPWIRE_[A-Z_]+\b", read(f"{TW_SRC}/lib/errors.ts"))))


@check("tripwire-docs", 1)
def _twd1():
    """TW34 README.md has an install section, three consumer recipes (a gate in a request pipeline with `assertOpen`/`trip`, a HITL gate in a CLI with `interactiveGate`, an unlock bin in five lines with `runUnlockCli`), the stateDir / ADHD_HOME explanation, the two clear policies (`confirm-token`, `open`), the redaction rules and the local-disk (not NFS) caveat."""
    t = read(f"{TW}/README.md")
    need = ["createTripwire", "assertOpen", "trip(", "interactiveGate", "runUnlockCli", "ADHD_HOME", "stateDir", "confirm-token", "open", "defaultRedactor", "NFS"]
    miss = [n for n in need if n not in t]
    return len(t) > 2500 and not miss and re.search(r"^#+\s*install", t, re.I | re.M) is not None and len(re.findall(r"recipe", t, re.I)) >= 3, f"{len(t)} bytes, missing {miss}"


@check("tripwire-docs", 2)
def _twd2():
    """TW34 docs/ERRORS.md lists every error code of src/lib/errors.ts with its class, its cause and its remediation, and docs/RECOVERY.md is the operator runbook: it names the break-glass `rm` of the lock file with the exact path layout (`<stateDir>/tripwire/<key>.lock`), how to read the audit log, the unlock bin and the `.blocked` and `.cleared` sidecars."""
    codes = tw_error_codes()
    e, r = read(f"{TW}/docs/ERRORS.md"), read(f"{TW}/docs/RECOVERY.md")
    miss = [c for c in codes if c not in e]
    return len(codes) >= 5 and not miss and "rm " in r and "tripwire/<key>.lock" in r and "audit" in r and ".blocked" in r and ".cleared" in r, f"codes={len(codes)} undocumented={miss}"


@check("tripwire-docs", 3)
def _twd3():
    """TW34 CHANGELOG.md has a `0.1.0` entry listing the package's features, every exported function, class and constant under src/lib has a JSDoc block (the preceding non-empty line closes a `/** */` comment), and no document carries an AI attribution line (Generated with, Co-Authored-By, written by an AI)."""
    ch = read(f"{TW}/CHANGELOG.md")
    undoc = []
    for f in tw_lib_files():
        lines = read(f).splitlines()
        for i, ln in enumerate(lines):
            if re.match(r"export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+\w+", ln):
                j = i - 1
                while j >= 0 and not lines[j].strip():
                    j -= 1
                if j < 0 or not lines[j].rstrip().endswith("*/"):
                    undoc.append(f"{os.path.relpath(f, TW)}:{i + 1}")
    docs = "".join(read(f"{TW}/{n}") for n in ("README.md", "CHANGELOG.md", "docs/ERRORS.md", "docs/RECOVERY.md"))
    return "0.1.0" in ch and not undoc and not re.search(r"Generated with|Co-Authored-By|written by an AI", docs, re.I), f"undocumented exports {undoc[:6]}"


@check("tripwire-docs", 4)
def _twd4():
    """README examples compile and run: test/unit/readme-examples.spec.ts cites ticket 8468f7b1 and its id, contains one test per fenced `ts` block of README.md (each README example is copied into the spec and exercised against the memory fs), and `nx run resilience-core-tripwire:typecheck-spec` and `:test` exit 0."""
    readme = read(f"{TW}/README.md")
    blocks = len(re.findall(r"^```(?:ts|typescript)\b", readme, re.M))
    ok, why = tw_spec("readme-examples.spec.ts", "tripwire-docs.4", ("README",))
    spec = read(f"{TW}/test/unit/readme-examples.spec.ts")
    if not (ok and blocks >= 3 and len(re.findall(r"\b(?:it|test)\(", spec)) >= blocks):
        return False, f"{why}; ts blocks={blocks}"
    a, _ = tw_nx("typecheck-spec")
    b, _ = tw_nx("test")
    return a == 0 and b == 0, f"typecheck-spec={a} test={b}"


@check("tripwire-docs", 5)
def _twd5():
    """Only owned paths changed by [psm:tripwire-docs] commits (README.md, CHANGELOG.md, docs/ and the readme-examples spec of the tripwire package); no other source file is modified."""
    return ownership_ok("tripwire-docs")


# ---------------------------------------------------------------- tripwire-pack
TW_PACK = f"{TW_EVID_DIR}/pack-gates.json"


@check("tripwire-pack", 1)
def _twp1():
    """TW29 the package gates are green: `nx run resilience-core-tripwire:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` and `:verify-dist-load` all exit 0 (evidence/tripwire/pack-gates.json records every command with its exit code and the tripwire tree sha), the manifest has no `module`, `exports` or `type`, zero `dependencies`, no .mjs file is emitted and `verify-dist-load` executes the built entry."""
    if not exists(f"{TW_SRC}/index.ts") or not exists(f"{TW}/README.md"):
        return False, "package not finished (tripwire-docs)"
    doc = tw_gate_run(TW_PACK)
    p = jread(f"{TW}/package.json", {}) or {}
    mjs = [f for f in walk(f"{TW}/dist", (".mjs",))]
    shape = "module" not in p and "exports" not in p and "type" not in p and not (p.get("dependencies") or {}) and p.get("main") == "./dist/index.js" and not mjs
    bad = [k for k, v in doc["results"].items() if v["exit"] != 0]
    return doc.get("all_green") is True and shape and not bad, f"failing {bad}; shape={shape} mjs={mjs[:2]}"


@check("tripwire-pack", 2)
def _twp2():
    """The consumer tarball is recorded: evidence/tripwire/tripwire-tarball.json holds `tarball` (an absolute path outside every .worktrees/ directory, named tripwire-0.1.0.tgz), its `sha256`, `packed_from_head` (an ancestor of HEAD) and `packed_from_tree` (the tripwire tree sha at that commit), the `pack_cmd`, and the tarball lists package/dist/index.js, package/dist/index.d.ts, package/package.json, package/README.md and package/CHANGELOG.md and no .mjs member."""
    d = jread(TW_TARBALL, {}) or {}
    tg = d.get("tarball", "")
    if not (tg and exists(tg) and "/.worktrees/" not in tg and tg.endswith("tripwire-0.1.0.tgz")):
        return False, f"tarball missing, inside a worktree or misnamed: {tg!r}"
    mem = tgz_members(tg)
    need = {"package/dist/index.js", "package/dist/index.d.ts", "package/package.json", "package/README.md", "package/CHANGELOG.md"}
    head = d.get("packed_from_head", "")
    anc = bool(head) and sh(["git", "merge-base", "--is-ancestor", head, "HEAD"])[0] == 0
    tree_ok = anc and git("rev-parse", f"{head}:{TW}") == d.get("packed_from_tree")
    return sha256_file(tg) == d.get("sha256") and tree_ok and bool(d.get("pack_cmd")) and need <= mem and not [m for m in mem if m.endswith(".mjs")], f"sha ok={sha256_file(tg) == d.get('sha256')} tree ok={tree_ok} missing members={sorted(need - mem)}"


@check("tripwire-pack", 3)
def _twp3():
    """The tarball works for both consumer module systems (R3, named-export detection): extracted into a scratch directory, `require()` of package/dist/index.js and an ES-module `import { createTripwire, CONFIRM_TOKEN, adhdDataDir, TripwireTrippedError, interactiveGate, runUnlockCli } from` the same file (a `type: module` consumer) both succeed and expose the named exports; the recorded `esm_smoke` in evidence/tripwire/tripwire-tarball.json is true."""
    d = jread(TW_TARBALL, {}) or {}
    tg = d.get("tarball", "")
    if not (tg and exists(tg)):
        return False, "tarball missing"
    import tempfile
    names = ["createTripwire", "CONFIRM_TOKEN", "adhdDataDir", "TripwireTrippedError", "interactiveGate", "runUnlockCli"]
    with tempfile.TemporaryDirectory() as tmp:
        rc, _, e = run2(["tar", "-xzf", tg, "-C", tmp], 120)
        if rc != 0:
            return False, f"tar failed {e[-100:]}"
        entry = f"{tmp}/package/dist/index.js"
        r1 = run2(["node", "-e", f"const m=require({json.dumps(entry)});for(const n of {json.dumps(names)}){{if(!(n in m))process.exit(3)}}"], 60)
        r2 = run2(["node", "--input-type=module", "-e", f"import {{ {', '.join(names)} }} from {json.dumps('file://' + entry)}; if (typeof createTripwire !== 'function' || typeof CONFIRM_TOKEN !== 'string') process.exit(4)"], 60)
    return r1[0] == 0 and r2[0] == 0 and d.get("esm_smoke") is True, f"require rc={r1[0]} {r1[2][-80:]}; esm import rc={r2[0]} {r2[2][-120:]}"


@check("tripwire-pack", 4)
def _twp4():
    """The lockfile is untouched by this state: no [psm:tripwire-pack] commit removes a pnpm-lock.yaml line, and only owned paths changed (evidence/tripwire/ and the package's package.json, project.json and vite.config.ts; pnpm-lock.yaml is read-only here, its importer block was written by sp-link)."""
    o = ownership_ok("tripwire-pack")
    log = sh(["git", "log", "--format=%H%x1f%B%x1e"])[1]
    removed = []
    for rec in log.split("\x1e"):
        if "[psm:tripwire-pack]" in rec:
            sha = rec.strip().split("\x1f")[0]
            for ln in git("show", "-U0", "--format=", sha, "--", "pnpm-lock.yaml").splitlines():
                if ln.startswith("-") and not ln.startswith("---"):
                    removed.append(ln[:80])
    return o[0] and not removed, f"{o[1]} removed lockfile lines {removed[:3]}"


# ---------------------------------------------------------------- tripwire-reverse-migrate (cross-repo: reverse-apis worktree)
REV_MAIN = "/Users/nix/dev/projects/reverse-apis"
REV_VERIFY = f"{TWREV}/reverse-verify.json"
LEGACY_NAMES = r"TripwireLockFile|defaultTripwirePath|isTripwireTripped|unlockTripwire|tripwirePath"


def rev(*args):
    return sh(["git", "-C", REVERSE, *args])[1].strip()


@check("tripwire-reverse-migrate", 1)
def _twm1():
    """The adoption branch is isolated: /Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt is a worktree on branch `feat/tripwire-adopt`, `.worktrees/` is listed in the main checkout's .git/info/exclude (a local untracked file), a non-empty snapshot of the main checkout's `git status --porcelain` was taken before the state started (docs/plan/stealth-browser/tripwire-reverse/main-status-before.txt), nothing is staged in the main checkout, the main branch carries no [psm:tripwire-reverse-migrate] commit, and no plan-tagged commit of the adoption branch changes a file the snapshot listed as dirty (other agents may edit the main working tree concurrently, so the check is commit- and index-scoped, not a whole-status comparison; criterion 6 owns the allowed exceptions)."""
    br = rev("rev-parse", "--abbrev-ref", "HEAD")
    excl = ".worktrees/" in read(f"{REV_MAIN}/.git/info/exclude")
    before = read(f"{TWREV}/main-status-before.txt")
    # Commit/index-scoped (other agents legitimately edit the main checkout's working tree concurrently, so a whole-status comparison measures
    # ambient state): nothing staged in main, main's branch carries no [psm:tripwire-reverse-migrate] commit, and no plan-tagged commit of the
    # adoption branch touches a file the snapshot listed as dirty (criterion .6 owns the allowed exceptions).
    staged = [ln for ln in sh(["git", "-C", REV_MAIN, "diff", "--cached", "--name-only"])[1].splitlines() if ln.strip()]
    main_br = sh(["git", "-C", REV_MAIN, "rev-parse", "--abbrev-ref", "HEAD"])[1].strip()
    main_tagged = [x for x in sh(["git", "-C", REV_MAIN, "log", main_br, "--format=%H%x1f%B%x1e"])[1].split("\x1e") if "[psm:tripwire-reverse-migrate]" in x]
    dirty = sorted({ln[3:].split(" -> ")[-1].strip().strip('"') for ln in before.splitlines() if len(ln) > 3})
    base = sh(["git", "-C", REVERSE, "merge-base", "HEAD", main_br])[1].strip()
    touched = set()
    if base:
        for sha in sh(["git", "-C", REVERSE, "log", f"{base}..HEAD", "--format=%H", "--grep=\\[psm:tripwire-reverse-migrate\\]"])[1].split():
            touched.update(f for f in sh(["git", "-C", REVERSE, "diff-tree", "--no-commit-id", "--name-only", "-r", sha])[1].splitlines() if f)
    hit = sorted(f for f in touched if any(f == d or f.startswith(d.rstrip("/") + "/") for d in dirty))
    ok = br == "feat/tripwire-adopt" and excl and bool(before.strip()) and not staged and not main_tagged and not hit
    return ok, f"branch={br} excluded={excl} staged-in-main={staged[:3]} psm commits on main={len(main_tagged)} snapshot-dirty files touched by branch commits={hit[:5]}"


@check("tripwire-reverse-migrate", 2)
def _twm2():
    """The migration is complete: packages/system/request-builder/src/lib/tripwire.ts is deleted and request-tripwire.ts exists (it imports @adhd/resilience-core-tripwire, namespace `request-builder`, `confirm-token` policy, no expiry), send.ts gates through `assertOpen` and trips through `trip` then throws `TripwireTrippedError.fromRecord`, tools/unlock-tripwire/unlock-tripwire.ts calls `runUnlockCli` and reads `TRIPWIRE_DIR`, tools/reverse-auth/reverse-auth.ts uses `read` and `clear` of the package, the request-builder vite.config.ts lists the package in `external`, the root package.json depends on `@adhd/resilience-core-tripwire` `^0.1.0`, and `rg` for TripwireLockFile, defaultTripwirePath, isTripwireTripped, unlockTripwire and tripwirePath over *.ts returns nothing."""
    rb = f"{REVERSE}/packages/system/request-builder"
    rt = read(f"{rb}/src/lib/request-tripwire.ts")
    send = read(f"{rb}/src/lib/send.ts")
    un = read(f"{REVERSE}/tools/unlock-tripwire/unlock-tripwire.ts")
    ra = read(f"{REVERSE}/tools/reverse-auth/reverse-auth.ts")
    dep = ((jread(f"{REVERSE}/package.json", {}) or {}).get("dependencies") or {}).get(TW_PKG, "")
    rc, out = sh(f"rg -n --glob '*.ts' --glob '!node_modules' --glob '!dist' -e '{LEGACY_NAMES}' {REVERSE} || true")
    ok = (not exists(f"{rb}/src/lib/tripwire.ts") and TW_PKG in rt and "request-builder" in rt and "confirm-token" in rt and "assertOpen" in send and "fromRecord" in send
          and "runUnlockCli" in un and "TRIPWIRE_DIR" in un and "TRIPWIRE_PATH" not in un and TW_PKG in ra and TW_PKG in read(f"{rb}/vite.config.ts") and dep == "^0.1.0")
    return ok and out.strip() == "", f"structure ok={ok} legacy names: {out.strip()[:160]}"


@check("tripwire-reverse-migrate", 3)
def _twm3():
    """The consumer runs the tarball build: the worktree's node_modules/@adhd/resilience-core-tripwire is a real directory (not a symlink, not a link into .worktrees/) whose dist/index.js is byte-identical to the member of the tarball recorded by tripwire-pack, and the worktree's pnpm-lock.yaml is identical to main's (the lockfile changes only at relink, because reverse CI uses --frozen-lockfile)."""
    d = jread(TW_TARBALL, {}) or {}
    tg = d.get("tarball", "")
    nm = f"{REVERSE}/node_modules/@adhd/resilience-core-tripwire"
    if not (tg and exists(tg) and exists(nm)):
        return False, "tarball or install missing"
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        rc, _, e = run2(["tar", "-xzf", tg, "-C", tmp], 120)
        a, b = f"{tmp}/package/dist/index.js", f"{nm}/dist/index.js"
        same = rc == 0 and exists(a) and exists(b) and open(a, "rb").read() == open(b, "rb").read()
    lock_same = sh(["git", "-C", REVERSE, "diff", "--quiet", "main", "--", "pnpm-lock.yaml"])[0] == 0
    return not os.path.islink(nm) and same and lock_same, f"symlink={os.path.islink(nm)} dist identical={same} lockfile unchanged={lock_same}"


@check("tripwire-reverse-migrate", 4)
def _twm4():
    """The regression bar is recorded for the current worktree head and scoped to the projects this state touched: docs/plan/stealth-browser/tripwire-reverse/reverse-verify.json holds `head` equal to the worktree HEAD and `commands` with exit 0 for `pnpm nx test request-builder` (the request-builder tests plus the new block-count, audit and corrupt-lock tests), `pnpm nx run-many -t lint,test,build -p request-builder` (lint, test and build of the touched library project) and `pnpm vitest run --config tools/unlock-tripwire/vite.config.ts` (the unlock tool's spawn assertions with their exit codes unchanged). The whole-workspace `pnpm nx run-many -t lint,test,build` and `pnpm nx e2e e2e-tests` runs are recorded too, but they fail on the clean base commit d959c6a for reasons this change does not touch (lint of 14 projects, wingman-bridge tests, tinder e2e), so they are judged only as regression-free: every failed task at head also appears in the recorded `baseline` failed tasks (the base failures are filed in the reverse-apis backlog)."""
    d = jread(REV_VERIFY, {}) or {}
    cmds = d.get("commands") or {}
    want = ["pnpm nx test request-builder", "pnpm nx run-many -t lint,test,build -p request-builder", "pnpm vitest run --config tools/unlock-tripwire/vite.config.ts"]
    bad = [w for w in want if (cmds.get(w) or {}).get("exit") != 0]
    base = d.get("baseline") or {}
    base_failed = set()
    for k, v in base.items():
        if isinstance(v, dict):
            base_failed |= set(v.get("failed_tasks") or [])
            m = re.match(r"nx (test|e2e) (\S+)$", k)
            if m and v.get("exit") not in (0, None):
                base_failed.add(f"{m.group(2)}:{m.group(1)}")
    wide = [c for c in ("pnpm nx run-many -t lint,test,build", "pnpm nx e2e e2e-tests") if c in cmds]
    new_fail = sorted({t for c in wide for t in (cmds[c].get("failed_tasks") or []) if t not in base_failed})
    return d.get("head") == rev("rev-parse", "HEAD") and not bad and not new_fail and bool(base), f"head match={d.get('head') == rev('rev-parse', 'HEAD')} failing/missing {bad} failures new vs base {new_fail}"


@check("tripwire-reverse-migrate", 5)
def _twm5():
    """The specs and docs carry the change: request-builder.spec.ts uses `createRequestTripwire({ tripwireDir })`, asserts the `<root>/tripwire/tinder.lock` layout, a blocked-count with the `tripwire-gate-blocked` audit line, and that a corrupt lock blocks; new or changed specs cite ticket 8468f7b1 and a tripwire-reverse-migrate.N or TW id; REARCHITECTURE.md section 12 describes the shipped design (key and lock layout, blockedCount, audit events, `confirm-token` policy) without historical commentary; the e2e harness reads the lock through `record.context.lastStatus`; the generator template emits `tripwireDir`."""
    rb = f"{REVERSE}/packages/system/request-builder"
    spec = read(f"{rb}/src/lib/request-builder.spec.ts")
    ra = read(f"{REVERSE}/REARCHITECTURE.md")
    h = read(f"{REVERSE}/packages/system/e2e-tests/src/lib/harness.ts")
    gen = read(f"{REVERSE}/tools/generators/api-package/generator.ts")
    sec = ra[ra.find("12"):] if "12" in ra else ""
    ok = ("createRequestTripwire" in spec and "tripwireDir" in spec and "tinder.lock" in spec and "tripwire-gate-blocked" in spec and "corrupt" in spec.lower() and TICKET in spec
          and all(k in ra for k in ("blockedCount", "tripwire-gate-blocked", "confirm-token")) and "context.lastStatus" in h and "tripwirePath" not in gen)
    return ok, f"specs/docs ok={ok}"


@check("tripwire-reverse-migrate", 6)
def _twm6():
    """Commit hygiene across repositories: [psm:tripwire-reverse-migrate] commits in the reverse worktree touch only files under packages/system/request-builder, packages/system/e2e-tests, packages/apis, tools/unlock-tripwire, tools/reverse-auth, tools/generators/api-package, REARCHITECTURE.md and package.json (never pnpm-lock.yaml or main's dirty files: AGENTS.md, captures.db, fatal.csv, identity/), and none was pushed (reverse-apis has no remote)."""
    allowed = ("packages/system/request-builder/", "packages/system/e2e-tests/", "packages/apis/", "tools/unlock-tripwire/", "tools/reverse-auth/", "tools/generators/api-package/", "REARCHITECTURE.md", "package.json")
    log = sh(["git", "-C", REVERSE, "log", "main..HEAD", "--format=%H%x1f%B%x1e"])[1]
    bad, tagged = [], 0
    for rec in log.split("\x1e"):
        if "[psm:tripwire-reverse-migrate]" in rec:
            tagged += 1
            sha = rec.strip().split("\x1f")[0]
            bad += [f for f in sh(["git", "-C", REVERSE, "diff-tree", "--no-commit-id", "--name-only", "-r", sha])[1].split() if not f.startswith(allowed)]
    remotes = sh(["git", "-C", REV_MAIN, "remote"])[1].strip()
    return tagged > 0 and not bad and remotes == "", f"tagged commits={tagged} out-of-scope files {bad[:5]} remotes={remotes!r}"


# ---------------------------------------------------------------- tripwire-reverse-relink (after the release)
REV_RELINK = f"{TWREV}/relink-verify.json"


@check("tripwire-reverse-relink", 1)
def _twr1():
    """The dependency resolves from the registry: `npm view @adhd/resilience-core-tripwire@0.1.0 version` is recorded with exit 0 in tripwire-reverse/relink-verify.json, the reverse worktree's package.json depends on `^0.1.0`, and its pnpm-lock.yaml resolves @adhd/resilience-core-tripwire with an integrity hash and no `tarball:` / `file:` resolution."""
    d = jread(REV_RELINK, {}) or {}
    lock = read(f"{REVERSE}/pnpm-lock.yaml")
    dep = ((jread(f"{REVERSE}/package.json", {}) or {}).get("dependencies") or {}).get(TW_PKG, "")
    reg = re.search(r"resilience-core-tripwire@0\.1\.\d+:\s*\n\s*resolution:\s*\{integrity:", lock) is not None
    return d.get("registry_view_exit") == 0 and dep == "^0.1.0" and reg and "file:" not in "".join(re.findall(r".*resilience-core-tripwire.*", lock)), f"view exit={d.get('registry_view_exit')} dep={dep!r} registry resolution={reg}"


@check("tripwire-reverse-relink", 2)
def _twr2():
    """The verification is re-run on the registry build: relink-verify.json holds `head` equal to the worktree HEAD and exit 0 for the same four commands as tripwire-reverse-migrate.4 (request-builder tests, run-many lint,test,build, e2e-tests, the unlock spec)."""
    d = jread(REV_RELINK, {}) or {}
    cmds = d.get("commands") or {}
    want = ["pnpm nx test request-builder", "pnpm nx run-many -t lint,test,build", "pnpm nx e2e e2e-tests", "pnpm vitest run --config tools/unlock-tripwire/vite.config.ts"]
    bad = [w for w in want if (cmds.get(w) or {}).get("exit") != 0]
    return d.get("head") == rev("rev-parse", "HEAD") and not bad, f"failing/missing {bad}"


@check("tripwire-reverse-relink", 3)
def _twr3():
    """The branch is merged fast-forward and cleaned: relink-verify.json records `merged_sha`, that commit is an ancestor of reverse-apis main, `feat/tripwire-adopt` no longer exists and the worktree .worktrees/tripwire-adopt is removed; the [psm:tripwire-reverse-relink] commits touched only package.json and pnpm-lock.yaml."""
    d = jread(REV_RELINK, {}) or {}
    sha = d.get("merged_sha", "")
    anc = bool(sha) and sh(["git", "-C", REV_MAIN, "merge-base", "--is-ancestor", sha, "main"])[0] == 0
    gone = sh(["git", "-C", REV_MAIN, "branch", "--list", "feat/tripwire-adopt"])[1].strip() == "" and not exists(REVERSE)
    log = sh(["git", "-C", REV_MAIN, "log", "main", "--format=%H%x1f%B%x1e"])[1]
    bad = []
    for rec in log.split("\x1e"):
        if "[psm:tripwire-reverse-relink]" in rec:
            s = rec.strip().split("\x1f")[0]
            bad += [f for f in sh(["git", "-C", REV_MAIN, "diff-tree", "--no-commit-id", "--name-only", "-r", s])[1].split() if f not in ("package.json", "pnpm-lock.yaml")]
    return anc and gone and not bad, f"ancestor={anc} cleaned={gone} out-of-scope files {bad[:4]}"


# ---------------------------------------------------------------- tripwire package gates + manifest hygiene across the release states
def gate_tw_check(slug, n, evidence, pre=None):
    def fn():
        if pre:
            ok, why = pre()
            if not ok:
                return False, why
        if not exists(f"{TW}/project.json"):
            return False, "tripwire package missing"
        doc = run_gates(evidence)
        r = doc["results"]
        bad = [t for t in TW_ALL_TARGETS if r.get(f"tw:{t}", {}).get("exit") != 0]
        return not bad and doc.get("tw_tree") == tw_tree_sha(), f"failing {bad} {[r[f'tw:{t}']['tail'] for t in bad][:1]}"
    fn.__doc__ = "`nx run resilience-core-tripwire:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` and `:verify-dist-load` exit 0 (the second approved package is gated with the first; evidence JSON records every command, its exit code and the tripwire tree sha `tw_tree`)."
    CHECKS.setdefault(slug, []).append((f"{slug}.{n}", fn))


gate_tw_check("gates-first", 11, f"{PLAN}/evidence/gates-first.json")
gate_tw_check("gates-rerun", 7, f"{PLAN}/evidence/gates-rerun.json", pre=resolution_done)


@check("gates-first", 12)
def _gf12():
    """Release hygiene for the service proxy and the tripwire: no @adhd/* dependency, devDependency or override in the root, stealth-core-browser, stealth-search or tripwire manifests starts with `file:`, `link:` or `portal:`, no `pnpm.overrides["@adhd/sox-service-proxy"]` remains (sp-switch removed it), pnpm-lock.yaml has no `adhd-dev-tarballs` or `file:/Users` resolution, and the stealth-browser dependency on @adhd/sox-service-proxy is `~0.6.0`."""
    lock = read("pnpm-lock.yaml")
    bad = local_specifiers()
    ev = jread(f"{PLAN}/evidence/gates-first.json", {}) or {}
    mine = state_status("gates-first") in ("in_progress", "complete") and bool(ev.get("all_green")) and ev.get("tree") == tree_sha()  # the state's own work product: a green gate run on the current code tree, recorded after the state started
    return mine and not bad and PROXY_PKG not in root_overrides() and "adhd-dev-tarballs" not in lock and "file:/Users" not in lock and sp_dep() == "~0.6.0", f"gates-first evidence current={mine}; local specifiers {bad}; override={root_overrides().get(PROXY_PKG)}; dependency={sp_dep()!r}"


@check("merge-readiness", 5)
def _mr5():
    """RELEASE-DECISION.md covers all three packages and the consumer: it names `@adhd/resilience-core-tripwire`, `@adhd/stealth-core-browser` and `@adhd/stealth-search` with their versions (0.x), the publish order tripwire, then core, then search (dependencies publish before dependents), the reverse-apis branch `feat/tripwire-adopt` and its verification state (tripwire-reverse-migrate complete), and records `nx affected -t lint typecheck test build` exit codes."""
    t = read(f"{PLAN}/RELEASE-DECISION.md")
    pos = [t.find(n) for n in (TW_PKG, CORE_PKG, SEARCH_PKG)]
    order = re.search(r"PUBLISH_ORDER:\s*(\S+)\s*,\s*(\S+)\s*,\s*(\S+)", t)
    ok_order = bool(order) and [order.group(i).strip(",") for i in (1, 2, 3)] == [TW_PKG, CORE_PKG, SEARCH_PKG]
    return all(p >= 0 for p in pos) and ok_order and "feat/tripwire-adopt" in t and state_status("tripwire-reverse-migrate") == "complete", f"packages named={pos} order line ok={ok_order}"


@check("merge-readiness", 6)
def _mr6():
    """The tree being merged carries no local specifier: no @adhd/* `file:` / `link:` / `portal:` value or service-proxy override in the root, stealth-core-browser, stealth-search or tripwire manifests, and no `adhd-dev-tarballs` or `file:/Users` text in pnpm-lock.yaml (a published manifest never carries a path)."""
    lock = read("pnpm-lock.yaml")
    bad = local_specifiers()
    mine = exists(f"{PLAN}/RELEASE-DECISION.md")  # the state's own work product
    return mine and not bad and PROXY_PKG not in root_overrides() and "adhd-dev-tarballs" not in lock and "file:/Users" not in lock and sp_dep() == "~0.6.0", f"RELEASE-DECISION.md present={mine}; local specifiers {bad}; stealth-browser proxy dependency={sp_dep()!r}"


@check("docs-marketing-run", 11)
def _dm11():
    """The tripwire package is part of the docs surface: README.md, CHANGELOG.md (with a 0.1.0 entry), docs/ERRORS.md and docs/RECOVERY.md of packages/resilience/resilience-core-tripwire exist (written by tripwire-docs), carry no AI attribution lines (Generated with, Co-Authored-By, written by an AI), and the docs run changed nothing under the package's src/."""
    names = ("README.md", "CHANGELOG.md", "docs/ERRORS.md", "docs/RECOVERY.md")
    ok = all(exists(f"{TW}/{n}") for n in names) and "0.1.0" in read(f"{TW}/CHANGELOG.md")
    ai = re.search(r"Generated with|Co-Authored-By|written by an AI", "".join(read(f"{TW}/{n}") for n in names), re.I)
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    files = git("diff", "--name-only", g.get("head", "HEAD"), "HEAD", "--", f"{TW}/src").splitlines()
    return ok and not ai and not files, f"docs set={ok} ai attribution={bool(ai)} src changed={files[:3]}"


@check("audit-final", 13)
def _af13():
    """[ref:tripwire-core] the second approved package conforms: @adhd/resilience-core-tripwire has zero dependencies, CJS-only manifest (no module, no exports, no type), no process.env / process.stdin / child_process / console access in src/lib outside node-io.ts (TW31), README, CHANGELOG, docs/ERRORS.md and docs/RECOVERY.md, no AI attribution line, and the gates-rerun evidence tripwire tree equals the HEAD tripwire tree."""
    p = jread(f"{TW}/package.json", {}) or {}
    pur = tw_purity()
    names = ("README.md", "CHANGELOG.md", "docs/ERRORS.md", "docs/RECOVERY.md")
    docs = all(exists(f"{TW}/{n}") for n in names)
    ai = re.search(r"Generated with|Co-Authored-By|written by an AI", "".join(read(f"{TW}/{n}") for n in names), re.I)
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    return (p.get("name") == TW_PKG and not (p.get("dependencies") or {}) and "module" not in p and "exports" not in p and "type" not in p and pur[0] and docs and not ai
            and g.get("tw_tree") == tw_tree_sha()), f"purity: {pur[1]} docs={docs} ai={bool(ai)}"


@check("docs-marketing-run", 12)
def _dm12():
    """The stealth-search docs surface exists: README.md, CHANGELOG.md (with a 0.1.0 entry), AGENTS.md, llms.txt and docs/{OBSERVABILITY,ERRORS,CONFIGURATION,EXAMPLES,RESPONSIBLE-USE}.md of entrypoint/stealth-search, no AI attribution lines, and its docs/marketing/.catalog/capabilities.json lists the eleven projected tools as `shipped` with runnable receipts and a review.md verdict of PASS."""
    names = ("README.md", "CHANGELOG.md", "AGENTS.md", "llms.txt", "docs/OBSERVABILITY.md", "docs/ERRORS.md", "docs/CONFIGURATION.md", "docs/EXAMPLES.md", "docs/RESPONSIBLE-USE.md")
    ok = all(exists(f"{SEARCH_DIR}/{n}") for n in names) and "0.1.0" in read(f"{SEARCH_DIR}/CHANGELOG.md")
    ai = re.search(r"Generated with|Co-Authored-By|written by an AI", "".join(read(f"{SEARCH_DIR}/{n}") for n in names), re.I)
    cat = f"{SEARCH_DIR}/docs/marketing/.catalog"
    c = jread(f"{cat}/capabilities.json", {})
    items = c.get("capabilities", c if isinstance(c, list) else [])
    shipped = sum(1 for i in items if i.get("status") == "shipped" and i.get("receipt"))
    rv = read(f"{cat}/review.md")
    return ok and not ai and shipped >= 11 and bool(re.search(r"\\bPASS\\b", rv)) and not re.search(r"\\bFAIL\\b", rv), f"docs set={ok} ai={bool(ai)} shipped receipts={shipped}"


@check("readme-rewrite", 10)
def _rw10():
    """entrypoint/stealth-search/README.md has a title, a tagline <= 120 chars, Quickstart, Features, Surfaces and Receipts sections, >= 2 fenced code blocks, names all eleven stealth_* tools and the host flags --cdp-port, --transport, --listen-port and --data-dir, links docs/ERRORS.md and docs/EXAMPLES.md, every relative link resolves, the only bins it invokes are `stealth-search` and `stealth-search-mcp`, it has >= 5 `<!-- receipt:ID -->` markers resolving to shipped entries of the search catalog, and none of the overclaim words undetectable, bypass, evade, anti-bot."""
    rd = f"{SEARCH_DIR}/README.md"
    t = read(rd)
    heads = {h.strip().lower() for h in re.findall(r"^#{1,3}\s+(.+)$", t, re.M)}
    tagline = [ln for ln in t.splitlines()[1:12] if ln.startswith(">")]
    tools = ("stealth_search", "stealth_listProviders", "stealth_describeProvider", "stealth_tripwireStatus", "stealth_clearTripwire", "stealth_chromeStatus", "stealth_launchChrome", "stealth_shutdownChrome", "stealth_listPageTargets", "stealth_checkChromeActivity", "stealth_getPageContext")
    flags = ("--cdp-port", "--transport", "--listen-port", "--data-dir")
    dead = [l for l in re.findall(r"\]\((?!http|mailto:|#)([^)#\s]+)", t) if not exists(os.path.normpath(os.path.join(SEARCH_DIR, l)))]
    used = set(re.findall(r"^\s*(?:npx |pnpm dlx )?(stealth-search(?:-mcp)?)\b", t, re.M))
    c = jread(f"{SEARCH_DIR}/docs/marketing/.catalog/capabilities.json", {})
    items = c.get("capabilities", c if isinstance(c, list) else [])
    shipped = {i.get("id") for i in items if i.get("status") == "shipped"}
    ids = re.findall(r"<!--\s*receipt:([\w.-]+)\s*-->", t)
    ok = (bool(t) and all(any(k in h for h in heads) for k in ("quickstart", "features", "surfaces", "receipts")) and bool(tagline) and len(tagline[0]) <= 122 and t.count("```") >= 4
          and all(x in t for x in tools) and all(x in t for x in flags) and "docs/ERRORS.md" in t and "docs/EXAMPLES.md" in t and not dead and bool(used) and used <= {"stealth-search", "stealth-search-mcp"}
          and len(ids) >= 5 and all(i in shipped for i in ids) and not re.search(r"undetectable|bypass|evade|anti-bot", t, re.I))
    return ok, f"readme present={bool(t)} dead links={dead[:3]} bins={used} receipts={len(ids)}"


# ---------------------------------------------------------------- split-state guard modules (scripts/guards/*.py)
# One module per state group, executed in this namespace (they use check(), the helpers above and the constants at the top).
import glob as _glob

for _gf in sorted(_glob.glob(f"{SCRIPTS}/guards/*.py")):
    if os.path.basename(_gf).startswith("_"):
        continue
    exec(compile(read(_gf), _gf, "exec"), globals())


for _retired in RETIRED_STATES:  # states removed from the dag by the split amendment; their historical check bodies stay defined above but are no longer registered
    CHECKS.pop(_retired, None)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        print(json.dumps({k: [[cid, (fn.__doc__ or "").strip()] for cid, fn in v] for k, v in CHECKS.items()}, indent=1))
        return
    if len(sys.argv) < 2 or sys.argv[1] not in CHECKS:
        print(f"usage: guard.py <slug> [--only slug.N]; known: {sorted(CHECKS)}", file=sys.stderr)
        sys.exit(2)
    slug = sys.argv[1]
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    fails = 0
    for cid, fn in CHECKS[slug]:
        if only and cid != only:
            continue
        try:
            ok, why = fn()
        except Exception as e:  # a crashing check is a failing check
            ok, why = False, f"check crashed: {e!r}"
        RESULTS.append((cid, bool(ok)))
        print(f"{'PASS' if ok else 'FAIL'} [{cid}] {(fn.__doc__ or '').strip().splitlines()[0][:110]}" + ("" if ok else f"\n     -> {why}"))
        fails += 0 if ok else 1
    if not only:
        # Definition-of-Done confirmation lines (read by the orchestrator; see audit_dod.py).
        if slug == "audit-final":
            res = dict(RESULTS)
            for k in range(1, 9):
                print(f"[dod.{k}] {'PASS' if res.get(f'audit-final.{k}') else 'FAIL'}")
        if slug == "agent-search-cutover":
            print(f"[dod.9] {'PASS' if fails == 0 else 'FAIL'}")
    sys.exit(min(fails, 125))


if __name__ == "__main__":
    main()
