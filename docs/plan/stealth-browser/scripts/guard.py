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
P = "entrypoint/stealth-browser"
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
    return (jread(f"{P}/project.json", {}) or {}).get("name", "stealth-browser")


def dag():
    return jread(f"{PLAN}/dag.json", {})


def state():
    return jread(f"{PLAN}/state.json", {})


def tree_sha():
    return git("rev-parse", f"HEAD:{P}") if exists(P) else ""


def ownership():
    return jread(f"{SCRIPTS}/ownership.json", {})


def manifest():
    return jread(f"{SCRIPTS}/port-manifest.json", [])


def criteria_ids():
    doc = jread(f"{SCRIPTS}/criteria.json", {}) or {}
    return {c["id"] for c in doc.get("criteria", [])}


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
def source_untouched():
    base = {}
    for ln in read(f"{PLAN}/evidence/source-baseline.txt").splitlines():
        if " " in ln:
            k, v = ln.split(" ", 1)
            base[k] = v.strip()
    if "tree" not in base:
        return False, "evidence/source-baseline.txt missing (scaffold state records it)"
    tree = git("rev-parse", "HEAD:agent-browser/adhd", cwd=SCRATCH)
    diff = hashlib.sha256(sh(["git", "diff", "--", "agent-browser/adhd"], cwd=SCRATCH)[1].encode()).hexdigest()
    status = git("status", "--porcelain", "--", "agent-browser/adhd", cwd=SCRATCH)
    ok = tree == base.get("tree") and diff == base.get("diff") and status == base.get("status", "")
    return ok, f"scratch agent-browser/adhd tree={tree[:10]} baseline={base.get('tree', '')[:10]} status={status!r}"


def main_nm_untouched():
    stamp = read(f"{PLAN}/evidence/main-node-modules.stamp").strip()
    if not stamp:
        return False, "evidence/main-node-modules.stamp missing"
    try:
        cur = str(int(os.stat(f"{MAIN}/node_modules/.modules.yaml").st_mtime))
    except OSError:
        return False, "main node_modules/.modules.yaml unreadable"
    return cur == stamp, f"main .modules.yaml mtime {cur} vs stamp {stamp}"


def ownership_ok(slug):
    owned = ownership().get(slug)
    if owned is None:
        return False, f"no ownership entry for {slug}"
    st = (state().get("states") or {}).get(slug) or {}
    since = st.get("start_ref") or git("merge-base", "HEAD", "main")
    log = sh(["git", "log", f"{since}..HEAD", "--format=%H%x1f%B%x1e"])[1]
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


def port_check(bucket):
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
        s, d = read(src), read(dst)
        missing = exports_of(s) - exports_of(d)
        if missing:
            bad.append(f"{e['dst']} lost exports {sorted(missing)}")
        for extra in e.get("require_exports", []):
            if extra not in exports_of(d):
                bad.append(f"{e['dst']} must export {extra}")
        ratio = difflib.SequenceMatcher(None, norm_for_diff(s), norm_for_diff(d), autojunk=False).ratio()
        if ratio < e.get("min_similarity", 0.80):
            bad.append(f"{e['dst']} similarity {ratio:.2f} < {e.get('min_similarity', 0.80)} (behavior-preserving port)")
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
        """Every manifest file exists, keeps every export, stays >=80% line-similar to the source, keeps its must-contain tokens."""
        return port_check(bucket)

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
    """entrypoint/stealth-browser/package.json name is exactly @adhd/stealth-browser and project.json exists."""
    return pkg().get("name") == "@adhd/stealth-browser" and exists(f"{P}/project.json"), f"name={pkg().get('name')}"


@check("scaffold", 4)
def _s4():
    """tsconfig.base.json maps the @adhd/stealth-browser path alias (generator UPDATE)."""
    return "@adhd/stealth-browser" in read("tsconfig.base.json"), "tsconfig.base.json alias"


@check("scaffold", 5)
def _s5():
    """Exactly ONE new project.json since main (the one approved package): entrypoint/stealth-browser/project.json."""
    base = git("merge-base", "HEAD", "main")
    added = [f for f in git("diff", "--name-only", "--diff-filter=A", f"{base}..HEAD").splitlines() if f.endswith("project.json")]
    return added == [f"{P}/project.json"], f"new project.json files: {added}"


@check("scaffold", 6)
def _s6():
    """Worktree node_modules is a symlink to the main checkout's and the main .modules.yaml mtime stamp is recorded."""
    link = os.path.islink("node_modules") and os.path.realpath("node_modules") == os.path.realpath(f"{MAIN}/node_modules")
    return link and bool(read(f"{PLAN}/evidence/main-node-modules.stamp").strip()), "symlink + stamp"


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
def sibling_top():
    sets = []
    for s in SIBLINGS:
        files = git("ls-files", "--", s).splitlines()
        sets.append({f[len(s) + 1:] for f in files if "/" not in f[len(s) + 1:]})
    inter = set.intersection(*sets) if sets else set()
    return inter - {"BACKLOG.md", "CONTRIBUTING.md"}


@check("entrypoint-parity", 1)
def _ep1():
    """Top-level tracked file set contains every file common to dispatch-cli, backlog and apigen-cli (eslint/vite/tsconfig.*/vitest.e2e/AGENTS/CHANGELOG/LICENSE...)."""
    need = sibling_top()
    have = {f[len(P) + 1:] for f in git("ls-files", "--", P).splitlines() if "/" not in f[len(P) + 1:]}
    miss = sorted(need - have)
    return not miss and bool(need), f"missing vs siblings: {miss}"


@check("entrypoint-parity", 2)
def _ep2():
    """project.json tags are a superset of the tags common to the three sibling entrypoints."""
    sets = [set((jread(f"{s}/project.json", {}) or {}).get("tags", [])) for s in SIBLINGS]
    inter = set.intersection(*sets)
    mine = set((jread(f"{P}/project.json", {}) or {}).get("tags", []))
    return bool(inter) and inter <= mine, f"need {sorted(inter - mine)}"


@check("entrypoint-parity", 3)
def _ep3():
    """`nx show project` lists every target present in both dispatch-cli and backlog (build, test, lint, typecheck, e2e, verify-dist-load...) and the dispatch-cli-only `build-bin`."""
    def targets(name):
        rc, out = sh([NX, "show", "project", name, "--json"], timeout=300)
        try:
            return set(json.loads(out[out.index("{"):]).get("targets", {}))
        except (ValueError, json.JSONDecodeError):
            return set()
    need = (targets("dispatch-cli") & targets("backlog")) | {"build-bin"}
    mine = targets(proj_name())
    return bool(need) and need <= mine, f"missing targets {sorted(need - mine)}"


@check("entrypoint-parity", 4)
def _ep4():
    """package.json carries the sibling publish metadata: repository.directory == entrypoint/stealth-browser, homepage, bugs, license, files, main/module/types, publishConfig."""
    p = pkg()
    keys = ["homepage", "bugs", "license", "files", "main", "types", "publishConfig", "description", "keywords"]
    ok = all(k in p for k in keys) and (p.get("repository") or {}).get("directory") == P
    return ok, f"missing {[k for k in keys if k not in p]}"


@check("entrypoint-parity", 5)
def _ep5():
    """`nx run stealth-browser:lint` exits 0 on the scaffold (tooling wired)."""
    rc, out = sh([NX, "run", f"{proj_name()}:lint"], timeout=900)
    return rc == 0, out[-400:]


@check("entrypoint-parity", 6)
def _ep6():
    """Only owned paths changed by [psm:entrypoint-parity] commits."""
    return ownership_ok("entrypoint-parity")


@check("entrypoint-parity", 7)
def _ep7():
    """package.json declares `engines.node >= 22.5` (the migrated storage layer uses the built-in `node:sqlite`)."""
    m = re.match(r"\s*>=\s*(\d+)(?:\.(\d+))?", (pkg().get("engines") or {}).get("node", ""))
    return bool(m) and (int(m.group(1)), int(m.group(2) or 0)) >= (22, 5), f"engines={pkg().get('engines')}"


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
    """pnpm-lock.yaml has an importers entry for entrypoint/stealth-browser listing all three deps."""
    lock = read("pnpm-lock.yaml")
    m = re.search(r"^  entrypoint/stealth-browser:\n((?:    .*\n|\n)+)", lock, re.M)
    return bool(m) and all(k in m.group(1) for k in WANT_DEPS), "importer block"


@check("deps-install", 4)
def _d4():
    """The lockfile diff removes no existing line (no collateral version bumps): `git diff` of pnpm-lock.yaml has zero '-' lines."""
    base = git("merge-base", "HEAD", "main")
    d = git("diff", "-U0", f"{base}..HEAD", "--", "pnpm-lock.yaml")
    removed = [ln for ln in d.splitlines() if ln.startswith("-") and not ln.startswith("---")]
    return not removed and bool(d), f"{len(removed)} removed lines"


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
    """eslint.config.mjs carries the documented TEMPORARY `@nx/dependency-checks` `ignoredDependencies` entry for node-html-parser, xpath and @xmldom/xmldom (removed again by mig-capture-parsers.6), so the dependency commit passes the pre-commit lint without bypassing hooks."""
    t = read(f"{P}/eslint.config.mjs")
    m = re.search(r"ignoredDependencies\s*:\s*\[([^\]]*)\]", t)
    listed = set(re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))) if m else set()
    return set(WANT_DEPS) <= listed and TEMP_IGNORE_MARK in t, f"ignoredDependencies={sorted(listed)} marker={TEMP_IGNORE_MARK in t}"


# ============================================================ migration buckets
standard_port_checks("mig-foundation", "foundation")


@check("mig-foundation", 4)
def _mf4():
    """session.ts exports getSessionId AND keeps the getSearchSessionId alias (identical function) for the agent-search cutover."""
    t = read(f"{P}/src/lib/session.ts")
    return "getSessionId" in exports_of(t) and "getSearchSessionId" in exports_of(t), "aliases"


standard_port_checks("mig-cdp", "cdp")


@check("mig-cdp", 4)
def _mc4():
    """No compiled .js twins and no nested package.json/tsconfig under src/lib/cdp (the @adhd/cdp-connection sub-package does not travel)."""
    return no_stale_twins("src/lib/cdp")


standard_port_checks("mig-domains-storage", "domains-storage")


@check("mig-domains-storage", 4)
def _mds4():
    """storage/helpers.ts still opens Chrome databases `mode=ro&immutable=1` (no file locking) and still exports openDb via helpers."""
    t = read(f"{P}/src/lib/helpers.ts") + read(f"{P}/src/lib/storage/helpers.ts")
    return "immutable=1" in t and "mode=ro" in t, "immutable read-only open"


standard_port_checks("mig-capture-parsers", "capture-parsers")


@check("mig-capture-parsers", 4)
def _mcp4():
    """capture/dom.ts is carried verbatim but marked @deprecated (Google-SERP walker; removal candidate for the product hold)."""
    return "@deprecated" in read(f"{P}/src/lib/capture/dom.ts"), "deprecation marker"


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
    """Behavior parity: heartbeat file path, three-tier safety shutdown and the ChromeManagerOptions type are preserved (backlog 19dfb641 redesign is OUT of scope)."""
    t = read(f"{P}/src/lib/chrome-manager.ts")
    return "/tmp/stealth-browser-heartbeat" in t and "ChromeManagerOptions" in exports_of(t) and "shutdownIfIdle" in t, "parity tokens"


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
def barrel_names():
    t = read(f"{SRC}/cdp-query-client.ts")
    names = exports_of(t) - {"getLastSearchFromHistory"}
    return names


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
    """Every old cdp-query-client.ts barrel name (minus getLastSearchFromHistory) plus the six verbs resolves from the package root (src/index.ts) OR from the `@adhd/stealth-browser/legacy` subpath (src/legacy.ts), per productization decision D1."""
    have = exports_of(read(f"{P}/src/index.ts")) | exports_of(read(LEGACY_TS))
    miss = sorted((barrel_names() | set(VERBS)) - have)
    return not miss, f"index.ts + legacy.ts missing {miss}"


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
    """The ChromeManager is configured through typed options only (no process.env toggles) and uses port/host options, never a hard-coded 9222 in api.ts defaults without an override."""
    t = read(f"{P}/src/api.ts")
    return "process.env" not in t and "ChromeManager" in t, "typed options"


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
    need = ["@adhd/apigen-core-client", "@adhd/apigen-engine-runtime", "@adhd/apigen-plugin-mcp"]
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
    """`node dist/bin/cli.js chrome-status --json` (or the chromeStatus verb) against an unused port prints running=false with exit 0 - the CLI reaches the real library, not a stub."""
    rc, out = sh(["node", f"{P}/dist/bin/cli.js", "chromeStatus"], timeout=120, env={"STEALTH_BROWSER_CDP_HOST": "127.0.0.1:19999"})
    if rc != 0:
        rc, out = sh(["node", f"{P}/dist/bin/cli.js", "chrome-status"], timeout=120, env={"STEALTH_BROWSER_CDP_HOST": "127.0.0.1:19999"})
    return rc == 0 and "running" in out, out[-300:]


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


SPEC = f"{P}/src/test/unit/tracing/tracing-namespace.spec.ts"


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
    """The spec cites ticket 8468f7b1 and a valid [tracing-plugin.N] criterion id."""
    t = read(SPEC)
    ids = set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t))
    return TICKET in t and bool(ids & criteria_ids()), f"ids={sorted(ids)}"


@check("tracing-namespace-proof", 4)
def _tn4():
    """Mutation teeth: with serviceName flipped to 'apigen' in src/tracing.ts the spec FAILS (restored in a finally block); with the real file it PASSES."""
    path = f"{P}/src/tracing.ts"
    orig = read(path)
    if not orig:
        return False, "tracing.ts missing"
    flt = ["--", "src/test/unit/tracing"]
    rc_ok, _ = sh([NX, "run", f"{proj_name()}:test", *flt], timeout=1500)
    try:
        with open(path, "w", encoding="utf8") as f:
            f.write(re.sub(r"serviceName:\s*['\"]adhd['\"]", "serviceName: 'apigen'", orig))
        rc_bad, _ = sh([NX, "run", f"{proj_name()}:test", *flt], timeout=1500)
    finally:
        with open(path, "w", encoding="utf8") as f:
            f.write(orig)
    return rc_ok == 0 and rc_bad != 0, f"real rc={rc_ok}, mutated rc={rc_bad}"


@check("tracing-namespace-proof", 5)
def _tn5():
    """Only owned paths changed by [psm:tracing-namespace-proof] commits; tracing.ts restored byte-for-byte (git diff clean)."""
    clean = git("status", "--porcelain", "--", f"{P}/src/tracing.ts") == ""
    o = ownership_ok("tracing-namespace-proof")
    return clean and o[0], o[1]


# ============================================================ unit tests
SPAWNERS = ("cdp/browser", "chrome-manager", "cdp/index", "cdp/targets", "cdp/session", "domains/", "capture/network")


def spec_for(e):
    base = os.path.basename(e["dst"])[:-3]
    return f"{P}/src/test/unit/{e['bucket']}/{base}.spec.ts"


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
            if "Application Support" in t or "homedir()" in t and "vi.mock" not in t:
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
    """src/test/unit/surface/api.spec.ts and index.spec.ts exist and assert all six verbs and the index export superset."""
    a, b = read(f"{P}/src/test/unit/surface/api.spec.ts"), read(f"{P}/src/test/unit/surface/index.spec.ts")
    return all(v in a for v in VERBS) and all(k in b for k in ("ChromeManager", "CdpClient", "HistoryClient")), "surface specs"


@check("tests-unit-surface", 2)
def _tus2():
    """Surface specs cite 8468f7b1 and a valid [surface-api.N] id; process/network boundaries are mocked."""
    ids = criteria_ids()
    ok = True
    for f in ("api", "index"):
        t = read(f"{P}/src/test/unit/surface/{f}.spec.ts")
        ok = ok and TICKET in t and bool(set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t)) & ids) and bool(re.search(r"vi\.mock\(|vi\.stubGlobal\(", t))
    return ok, "citations + mocks"


@check("tests-unit-surface", 3)
def _tus3():
    """`nx run stealth-browser:test` exits 0 and only owned paths changed by [psm:tests-unit-surface] commits."""
    rc, out = sh([NX, "run", f"{proj_name()}:test"], timeout=1500)
    o = ownership_ok("tests-unit-surface")
    return rc == 0 and o[0], out[-250:] + o[1]


# ============================================================ e2e
E2E = f"{P}/src/test/e2e"


def e2e_text():
    return "\n".join(read(f) for f in walk(E2E))


@check("tests-e2e", 1)
def _e1():
    """ONE shared scaffold/teardown: exactly one beforeAll and one afterAll across src/test/e2e (harness.ts), shared by every surface."""
    t = e2e_text()
    return len(re.findall(r"\bbeforeAll\(", t)) == 1 and len(re.findall(r"\bafterAll\(", t)) == 1, "single harness"


@check("tests-e2e", 2)
def _e2():
    """All three surfaces are driven in the one run: describe blocks tagged [surface:library], [surface:cli] and [surface:mcp] (MCP via a real JSON-RPC stdio client against the built dist/bin/mcp.js)."""
    t = e2e_text()
    return all(f"[surface:{s}]" in t for s in ("library", "cli", "mcp")) and "dist/bin/mcp" in t, "three surfaces"


@check("tests-e2e", 3)
def _e3():
    """No mocks in e2e (no vi.mock/vi.stubGlobal); real Chrome on a DEDICATED port with a temp profile and fake HOME; never the live 9222; teardown kills only the PID it launched (no lsof/pkill/killall)."""
    t = e2e_text()
    return bool(t) and not re.search(r"vi\.(mock|stubGlobal)\(", t) and "9222" not in t and not re.search(r"lsof|pkill|killall", t) and "tmp/stealth-browser" in t and "HOME" in t, "isolation"


@check("tests-e2e", 4)
def _e4():
    """E2E files cite ticket 8468f7b1 and valid [slug.N] ids."""
    t = e2e_text()
    return TICKET in t and bool(set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t)) & criteria_ids()), "citations"


@check("tests-e2e", 5)
def _e5():
    """`nx run stealth-browser:e2e` exits 0, takes >= 5s wall clock (real Chrome, not a vacuous run) and leaves the pre-existing 9222 listener (if any) untouched."""
    before = sh("lsof -ti tcp:9222 || true")[1].strip()
    t0 = time.time()
    rc, out = sh([NX, "run", f"{proj_name()}:e2e"], timeout=1800)
    dur = time.time() - t0
    after = sh("lsof -ti tcp:9222 || true")[1].strip()
    o = ownership_ok("tests-e2e")
    return rc == 0 and dur >= 5 and before == after and o[0], f"rc={rc} dur={dur:.1f}s 9222 before={before!r} after={after!r} {o[1]}"


# ============================================================ gates
GATE_TARGETS = ["lint", "typecheck", "typecheck-spec", "build", "build-bin", "test", "verify-dist-load", "e2e"]


def run_gates(evidence):
    cur = tree_sha()
    cached = jread(evidence)
    if cached and cached.get("tree") == cur and cached.get("all_green"):
        return cached
    res = {}
    for t in GATE_TARGETS:
        t0 = time.time()
        rc, out = sh([NX, "run", f"{proj_name()}:{t}"], timeout=2400)
        res[t] = {"cmd": f"nx run {proj_name()}:{t}", "exit": rc, "seconds": round(time.time() - t0, 1), "tail": out[-300:]}
    doc = {"tree": cur, "head": git("rev-parse", "HEAD"), "results": res, "all_green": all(v["exit"] == 0 for v in res.values())}
    os.makedirs(os.path.dirname(evidence), exist_ok=True)
    with open(evidence, "w", encoding="utf8") as f:
        json.dump(doc, f, indent=2)
    return doc


def gate_checks(slug, evidence, pre=None):
    names = [("lint", "`nx run stealth-browser:lint` exits 0 (includes @nx/dependency-checks)"),
             ("typecheck", "`nx run stealth-browser:typecheck` and `:typecheck-spec` exit 0"),
             ("build", "`nx run stealth-browser:build` and `:build-bin` exit 0 (dist/index.js plus dist/bin/*)"),
             ("test", "`nx run stealth-browser:test` exits 0 (unit lane, no subprocess)"),
             ("verify-dist-load", "`nx run stealth-browser:verify-dist-load` exits 0 (the built dist loads the way a consumer loads it)"),
             ("e2e", "`nx run stealth-browser:e2e` exits 0 (all surfaces, one run)")]
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
                bad = [k for k in keys if r.get(k, {}).get("exit") != 0]
                return not bad, f"{bad} {[r[k]['tail'] for k in bad][:1]}"
            fn.__doc__ = text
            return fn
        CHECKS.setdefault(slug, []).append((f"{slug}.{n}", mk()))
    n = len(names) + 1

    def citations():
        files = [f for f in walk(f"{P}/src/test", (".ts",)) if f.endswith((".spec.ts", ".e2e.ts")) or "/e2e/" in f]
        ids = criteria_ids()
        bad = [f for f in files if TICKET not in read(f) or not (set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", read(f))) & ids)]
        return not bad and bool(files), f"uncited tests {bad[:6]}"
    citations.__doc__ = "Every spec/e2e file cites ticket 8468f7b1 and a valid acceptance-criterion id; evidence JSON records every gate command and exit code"
    CHECKS[slug].append((f"{slug}.{n}", citations))


gate_checks("gates-first", f"{PLAN}/evidence/gates-first.json")


def resolution_done():
    r = jread(f"{PLAN}/review/RESOLUTION.json")
    return bool(r), "review/RESOLUTION.json missing (resolve-findings not done)"


gate_checks("gates-rerun", f"{PLAN}/evidence/gates-rerun.json", pre=resolution_done)


# ============================================================ review
REVIEW = f"{PLAN}/review"


@check("review-prep", 1)
def _rp1():
    """review/migration.diff exists, is non-empty and covers entrypoint/stealth-browser + tsconfig.base.json since the scaffold start_ref."""
    d = read(f"{REVIEW}/migration.diff")
    return len(d) > 2000 and f"{P}/src" in d, f"diff bytes={len(d)}"


@check("review-prep", 2)
def _rp2():
    """review/INPUT.sha256 equals sha256(migration.diff) and the diff contains no docs/plan or pnpm-lock paths (reviewer sees the migration only)."""
    d = read(f"{REVIEW}/migration.diff")
    return hashlib.sha256(d.encode()).hexdigest() == read(f"{REVIEW}/INPUT.sha256").strip() and "docs/plan/" not in d and "pnpm-lock" not in d, "sha + scope"


@check("review-prep", 3)
def _rp3():
    """review/BRIEF.txt is exactly the single word `Review` (blind review: no context, rationale or review points)."""
    return read(f"{REVIEW}/BRIEF.txt").strip() == "Review", "brief"


@check("review-prep", 4)
def _rp4():
    """Only owned paths changed by [psm:review-prep] commits; gates-first evidence tree matches the diffed tree."""
    g = jread(f"{PLAN}/evidence/gates-first.json", {})
    o = ownership_ok("review-prep")
    return o[0] and g.get("all_green") is True and g.get("tree") == tree_sha(), f"{o[1]} gates tree match={g.get('tree') == tree_sha()}"


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
    """The package tree is unchanged since review-prep (tree sha in INPUT matches HEAD), so the review judged the code that gated green."""
    g = jread(f"{PLAN}/evidence/gates-first.json", {})
    return g.get("tree") == tree_sha(), "tree unchanged since gates-first"


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
    """No new TODO/FIXME/XXX introduced in entrypoint/stealth-browser/src and only owned paths changed by [psm:resolve-findings] commits."""
    t = "\n".join(read(f) for f in walk(f"{P}/src"))
    o = ownership_ok("resolve-findings")
    return not re.search(r"\b(TODO|FIXME|XXX)\b", t) and o[0], o[1]


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
    """Gate evidence of gates-rerun still matches the package source tree (docs run changed no src/)."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    files = git("diff", "--name-only", g.get("head", "HEAD"), "HEAD", "--", f"{P}/src", f"{P}/bin").splitlines()
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
    """Factual: no unverifiable superlatives (undetectable, unblockable, 100%, bypasses all, guaranteed); every `@adhd/stealth-browser` import specifier in code fences is a real package export."""
    t = read(README)
    if re.search(r"undetectable|unblockable|100%|bypasses? all|guaranteed", t, re.I):
        return False, "unverifiable superlative"
    exp = pkg().get("exports") or {".": "x"}
    for spec in re.findall(r"from\s+['\"](@adhd/stealth-browser[^'\"]*)['\"]", t):
        sub = "." + spec[len("@adhd/stealth-browser"):]
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
    used = set(re.findall(r"^\s*(?:npx |pnpm dlx )?(stealth-browser(?:-mcp)?)\b", t, re.M))
    return used <= bins, f"bins used={used}"


# ============================================================ final audit / merge / cutover
@check("audit-final", 1)
def _af1():
    """[dod.1] structural: exactly one new package exists, entrypoint/stealth-browser, named @adhd/stealth-browser, built by the generator (scaffold evidence) and parity-clean."""
    return _s3()[0] and _s5()[0] and _s2()[0] and _ep1()[0], "package + generator evidence + parity"


@check("audit-final", 2)
def _af2():
    """[dod.2] behavioral: `nx run stealth-browser:verify-dist-load` and the e2e library/CLI/MCP surfaces pass on the final tree (gates-rerun evidence all green, tree == HEAD tree)."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    return g.get("all_green") is True and g.get("tree") == tree_sha(), f"gates tree {str(g.get('tree'))[:8]} vs {tree_sha()[:8]}"


@check("audit-final", 3)
def _af3():
    """[dod.3] structural: tracing namespace is `adhd` - singleton never imported, serviceName configured once, every mount carries the plugin (tracing-plugin checks 1,2,3,5 re-run)."""
    return all(f()[0] for f in (_t1, _t2, _t3, _t5)), "namespace"


@check("audit-final", 4)
def _af4():
    """[dod.4] structural: behavior-preserving port - every manifest bucket still passes port parity (exports superset, >=80% similarity, tokens) and hygiene on the final tree."""
    buckets = sorted({e["bucket"] for e in manifest()})
    bad = [b for b in buckets if not port_check(b)[0]]
    return not bad, f"buckets failing {bad}"


@check("audit-final", 5)
def _af5():
    """[dod.5] structural: the live agent-search source tree is byte-identical to the scaffold-time baseline (cutover is the only state allowed to change it, and it runs after this audit)."""
    return source_untouched()


@check("audit-final", 6)
def _af6():
    """[dod.6] structural: one blind review round, every finding resolved by one implementer, gates re-run green after resolution."""
    return all(f()[0] for f in (_b1, _b2, _r1, _r2, _r3)) and jread(f"{PLAN}/evidence/gates-rerun.json", {}).get("all_green") is True, "review chain"


@check("audit-final", 7)
def _af7():
    """[dod.7] structural: docs marketing run PASS, README rewrite receipts-backed (docs-marketing-run and readme-rewrite checks re-run)."""
    return all(f()[0] for f in (_dm1, _dm2, _rw2, _rw3, _rw4)), "docs chain"


@check("audit-final", 8)
def _af8():
    """[dod.8] structural: the working tree under entrypoint/stealth-browser and docs/plan/stealth-browser is clean (everything committed) and the main checkout node_modules is untouched."""
    st = git("status", "--porcelain", "--", P, PLAN)
    return st == "" and main_nm_untouched()[0], f"dirty: {st[:200]}"


@check("audit-final", 10)
def _af10():
    """Every spec/e2e file cites ticket 8468f7b1 and a valid criterion id (final re-run of the citation rule)."""
    files = [f for f in walk(f"{P}/src/test", (".ts",))]
    ids = criteria_ids()
    bad = [f for f in files if TICKET not in read(f) or not (set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", read(f))) & ids)]
    return not bad and bool(files), f"uncited {bad[:5]}"


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
    """The tree gated by gates-rerun is the tree being merged and the worktree is clean."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    return g.get("tree") == tree_sha() and git("status", "--porcelain", "--", P, PLAN) == "", "clean + gated"


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


@check("agent-search-cutover", 1)
def _ac1():
    """Preconditions: RELEASE-DECISION.md has `DECISION: publish|defer` and a `CONSUME:` line (`@adhd/stealth-browser@<version>` when published, `link:<abs path>` into the MERGED main checkout when deferred) and agent-browser/node_modules resolves @adhd/stealth-browser."""
    t = read(f"{PLAN}/RELEASE-DECISION.md")
    m = re.search(r"^CONSUME:\s*(@adhd/stealth-browser@\S+|link:/\S+)\s*$", t, re.M)
    pj = jread(f"{SRC}/package.json", {}) or {}
    dep = (pj.get("dependencies", {}) or {}).get("@adhd/stealth-browser") or (pj.get("devDependencies", {}) or {}).get("@adhd/stealth-browser")
    ok = bool(re.search(r"^DECISION:\s*(publish|defer)\s*$", t, re.M)) and bool(m) and bool(dep) and exists(f"{SRC}/node_modules/@adhd/stealth-browser/package.json")
    if m and m.group(1).startswith("link:"):
        ok = ok and "/.worktrees/" not in m.group(1)
    return ok, f"consume={m.group(1) if m else None} dep={dep}"


@check("agent-search-cutover", 2)
def _ac2():
    """The chrome-runner implementation is GONE from agent-search: no `class CdpSession`, `class ChromeManager`, `class IdleShutdown` or `class HistoryClient` definition remains under agent-browser (thin consumer/shims only)."""
    rc, out = sh("rg -n --glob '!node_modules' --glob '!dist' -e 'class (CdpSession|ChromeManager|IdleShutdown|HistoryClient)\\b' " + SRC + " || true")
    return out.strip() == "", out.strip()[:200]


@check("agent-search-cutover", 3)
def _ac3():
    """agent-browser still compiles: `pnpm run build` (tsc --noEmit) exits 0 and `pnpm run test:lifecycle` exits 0 against @adhd/stealth-browser."""
    a, _ = sh(["pnpm", "run", "build"], cwd=SRC, timeout=900)
    b, _ = sh(["pnpm", "run", "test:lifecycle"], cwd=SRC, timeout=900)
    return a == 0 and b == 0, f"build={a} lifecycle={b}"


@check("agent-search-cutover", 4)
def _ac4():
    """The live MCP server still works through a REAL MCP stdio client: `node server.mjs` lists the search tools and chrome_status + list_providers return structured results."""
    r = mcp_session(["node", "server.mjs"], SRC, [("chrome_status", {}), ("list_providers", {})])
    tools = r.get("tools", [])
    ok = any(t.endswith("search") for t in tools) and r.get("chrome_status", {}).get("result") and r.get("list_providers", {}).get("result")
    return bool(ok), f"tools={tools[:8]}"


@check("agent-search-cutover", 5)
def _ac5():
    """Scratch repo hygiene: cutover commits are local-only (no push/upstream), staged by explicit path, and touch only agent-browser/adhd/, cdp-query-client.ts, search/queries/, package.json and the cutover docs."""
    allowed = ("agent-browser/adhd/", "agent-browser/cdp-query-client.ts", "agent-browser/search/queries/", "agent-browser/package.json", "agent-browser/pnpm-lock.yaml", "agent-browser/AGENTS.md", "agent-browser/docs/")
    log = sh(["git", "log", "--since=3.days", "--format=%H%x1f%B%x1e"], cwd=SCRATCH)[1]
    bad = []
    for rec in log.split("\x1e"):
        if "[psm:agent-search-cutover]" in rec:
            sha = rec.strip().split("\x1f")[0]
            for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", sha, cwd=SCRATCH).splitlines():
                if not f.startswith(allowed):
                    bad.append(f)
    return not bad, f"out-of-scope files {bad[:5]}"


# ---- reference-pattern conformance (audit_check ids cited from references.json)
def _all(*fns):
    def run():
        bad = [f.__name__ for f in fns if not f()[0]]
        return not bad, f"failing: {bad}"
    return run


def _refcheck(cid, fn, doc):
    fn.__doc__ = doc
    CHECKS.setdefault("audit-final", []).append((cid, fn))


_refcheck("audit-final.ref-backlog-tracing", _all(_t1, _t2, _t3, _t5),
          "[ref:backlog-tracing] tracing.ts / usePlugins / no-singleton conformance with entrypoint/backlog/src/tracing.ts")
_refcheck("audit-final.ref-entrypoint-structure", _all(_ep1, _ep2, _ep4, _s3),
          "[ref:entrypoint-structure] top-level files, tags, package metadata conform to dispatch-cli/backlog/apigen-cli")
_refcheck("audit-final.ref-apigen-host", _all(_sh1, _sh2, _t3),
          "[ref:apigen-host] server.ts / cli.ts / bin hosts mirror entrypoint/backlog's apigen host shape")
_refcheck("audit-final.ref-runner-port", _af4,
          "[ref:runner-port] behavior-preserving port conforms to agent-browser/adhd (exports, similarity, tokens)")


# ============================================================ productization fold (PRODUCT-REVIEW.md)
# Every check below carries the PRODUCT-REVIEW.md task id (PAx.y) it enforces; all are red until the owning state's work is done.
NAMES_RE = re.compile(r"google|search", re.I)
BANNED_RE = re.compile(r"\b(undetectable|bypass(?:es|ed|ing)?|evad(?:e|es|ed|ing)|anti-bot)\b", re.I)
LEGACY_TS = f"{P}/src/legacy.ts"
ERR_CODES = ["CHROME_NOT_FOUND", "PORT_IN_USE", "NODE_TOO_OLD", "CHROME_NOT_RUNNING"]
DEFAULTS = ["9222", "Library/Application Support/Google/Chrome-CDP", "/tmp/stealth-browser-heartbeat"]
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
    return [f for f in walk(f"{P}/src/test/{sub}") if f.endswith((".spec.ts", ".test.ts"))]


def dts_exports(path, seen=None):
    seen = seen if seen is not None else set()
    if path in seen or not exists(path):
        return set()
    seen.add(path)
    t = read(path)
    names = exports_of(t)
    for rel in re.findall(r"export\s+\*\s+from\s+['\"](\.[^'\"]+)['\"]", t):
        base = os.path.normpath(os.path.join(os.path.dirname(path), re.sub(r"\.js$", "", rel)))
        if "legacy" in base:
            continue
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


@check("surface-api", 8)
def _sa8():
    """(product claims, resolved with evidence) evidence/product-claims.json records, with file:line citations that resolve and agree with the source: `launchChromeOptions` (library option names; `verbInputExposesChromePathOrExtraArgs` must be false) and `getPageContextCookieValues` (`returnsValues` boolean; when true `hostRedactionRequired` must be true)."""
    d = jread(f"{PLAN}/evidence/product-claims.json", None)
    if not isinstance(d, dict):
        return False, "evidence/product-claims.json missing or not an object"
    lc, ck = d.get("launchChromeOptions") or {}, d.get("getPageContextCookieValues") or {}
    bad = []

    def cite_ok(c):
        m = re.match(r"^(.+?):(\d+)$", str(c or ""))
        return bool(m) and exists(m.group(1)) and 1 <= int(m.group(2)) <= len(read(m.group(1)).splitlines())
    if not (isinstance(lc.get("libraryOptionNames"), list) and lc["libraryOptionNames"]):
        bad.append("launchChromeOptions.libraryOptionNames")
    if lc.get("verbInputExposesChromePathOrExtraArgs") is not False:
        bad.append("verbInputExposesChromePathOrExtraArgs must be false")
    if not cite_ok(lc.get("evidence")):
        bad.append("launchChromeOptions.evidence not file:line")
    else:
        src = read(re.match(r"^(.+?):\d+$", lc["evidence"]).group(1))
        bad += [f"option {n} not in cited file" for n in lc.get("libraryOptionNames", []) if n not in src]
    if not isinstance(ck.get("returnsValues"), bool):
        bad.append("getPageContextCookieValues.returnsValues must be boolean")
    elif ck["returnsValues"] and ck.get("hostRedactionRequired") is not True:
        bad.append("returnsValues=true requires hostRedactionRequired=true")
    if not cite_ok(ck.get("evidence")):
        bad.append("getPageContextCookieValues.evidence not file:line")
    return not bad, "; ".join(bad) or "ok"


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


# ---------------------------------------------------------------- prod-public-api (P3)
@check("prod-public-api", 1)
def _pp1():
    """(PA3.1) A public-API export snapshot spec under src/test/unit/public-api/ lists every root export of src/index.ts (and the six verbs) and fails on drift (toEqual / snapshot of the sorted export names)."""
    names = exports_of(read(f"{P}/src/index.ts")) | set(VERBS)
    specs = spec_files("unit/public-api")
    t = "\n".join(read(f) for f in specs)
    miss = sorted(n for n in names if n not in t)
    return bool(specs) and not miss and re.search(r"toEqual|toMatchInlineSnapshot|toMatchSnapshot", t) is not None, f"specs={len(specs)} unlisted={miss}"


@check("prod-public-api", 2)
def _pp2():
    """(PA3.2) src/index.ts exports no Google- or Search-named symbol and does not re-export ./legacy; src/legacy.ts exports every such old-barrel name (the union of both files still covers the old barrel)."""
    idx, leg = read(f"{P}/src/index.ts"), read(LEGACY_TS)
    if not idx or not leg:
        return False, "index.ts or legacy.ts missing"
    root_bad = sorted(n for n in exports_of(idx) if NAMES_RE.search(n))
    star = re.findall(r"export\s+\*\s+from\s+['\"]([^'\"]+)", idx)
    star_bad = [s for s in star if NAMES_RE.search(s) or "legacy" in s]
    need = {n for n in barrel_names() if NAMES_RE.search(n)}
    miss = sorted(need - exports_of(leg))
    return not root_bad and not star_bad and not miss, f"root={root_bad} star={star_bad} legacy missing={miss}"


@check("prod-public-api", 3)
def _pp3():
    """(PA3.3, source level) src/legacy.ts exports SearchResultSource and src/index.ts exports the neutral alias PageSource; capture/dom.ts stays present (dod.4)."""
    return "SearchResultSource" in exports_of(read(LEGACY_TS)) and "PageSource" in exports_of(read(f"{P}/src/index.ts")) and exists(f"{P}/src/lib/capture/dom.ts"), "legacy/alias"


@check("prod-public-api", 4)
def _pp4():
    """(PA3.5) Tier tags: every export statement in src/legacy.ts carries @deprecated and every export in src/index.ts other than the `./api.js` verbs carries @experimental in its TSDoc."""
    lt, lbad = tagged_exports(read(LEGACY_TS), "@deprecated")
    it, ibad = tagged_exports(read(f"{P}/src/index.ts"), "@experimental", skip=lambda ln: "./api.js" in ln)
    return lt > 0 and not lbad and not ibad, f"legacy untagged={lbad[:3]} index untagged={ibad[:3]}"


@check("prod-public-api", 5)
def _pp5():
    """Specs cite ticket 8468f7b1, a valid criterion id of this state and the PA ids they cover (PA3.1, PA3.5); only owned paths changed by [psm:prod-public-api] commits."""
    t = "\n".join(read(f) for f in spec_files("unit/public-api"))
    ids = set(re.findall(r"\[(prod-public-api\.\d+)\]", t))
    o = ownership_ok("prod-public-api")
    return TICKET in t and bool(ids & criteria_ids()) and "PA3.1" in t and "PA3.5" in t and o[0], o[1]


# ---------------------------------------------------------------- prod-errors (P5)
@check("prod-errors", 1)
def _pe1():
    """(PA5.1) src/errors.ts defines an Error subclass with a stable `code` field covering CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD and CHROME_NOT_RUNNING, each with a remediation message naming the fix."""
    t = read(f"{P}/src/errors.ts")
    miss = [c for c in ERR_CODES if c not in t]
    cls = re.search(r"class\s+\w+\s+extends\s+Error", t) is not None and re.search(r"\bcode\b", t) is not None
    fix = len(re.findall(r"""['"`][^'"`\n]*\b(install|set|use|run|upgrade|start|free|choose|launch|update)\b[^'"`\n]*['"`]""", t, re.I))
    return cls and not miss and fix >= len(ERR_CODES), f"class={cls} missing={miss} remediation strings={fix}"


@check("prod-errors", 2)
def _pe2():
    """(PA5.4) src/test/unit/errors/ has a unit test per code: each of the four codes is asserted (code and a remediation message), citing ticket 8468f7b1, a valid criterion id of this state and PA5.1 / PA5.4."""
    specs = spec_files("unit/errors")
    t = "\n".join(read(f) for f in specs)
    miss = [c for c in ERR_CODES if t.count(c) < 1]
    ids = set(re.findall(r"\[(prod-errors\.\d+)\]", t))
    return bool(specs) and not miss and t.count("message") >= len(ERR_CODES) and TICKET in t and bool(ids & criteria_ids()) and "PA5.1" in t and "PA5.4" in t, f"specs={len(specs)} missing={miss}"


@check("prod-errors", 3)
def _pe3():
    """Only owned paths changed by [psm:prod-errors] commits; errors.ts reads no process.env."""
    o = ownership_ok("prod-errors")
    return o[0] and "process.env" not in read(f"{P}/src/errors.ts") and exists(f"{P}/src/errors.ts"), o[1]


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
    """(PA3.2, PA3.3, PA3.4) package.json exports a ./legacy subpath into dist; the built root index.d.ts exports no Google- or Search-named symbol; `@adhd/stealth-browser/legacy` resolves from the built package; `nx run stealth-browser:verify-dist-load` exits 0."""
    if not ensure_bin():
        return False, "build-bin failed"
    ex = (pkg().get("exports") or {})
    leg = ex.get("./legacy")
    root_types = pkg().get("types") or pkg().get("typings") or "./dist/index.d.ts"
    bad = sorted(n for n in dts_exports(os.path.normpath(f"{P}/{root_types}")) if NAMES_RE.search(n))
    rc_r, _, err = run2(["node", "--input-type=module", "-e", "await import('@adhd/stealth-browser/legacy')"], 60, cwd=P)
    rc_v, out = sh([NX, "run", f"{proj_name()}:verify-dist-load"], timeout=1200)
    return bool(leg) and not bad and rc_r == 0 and rc_v == 0, f"legacy={leg} rootSearchNames={bad} resolve rc={rc_r} {err[-120:]} verify rc={rc_v}"


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


@check("surface-hosts", 12)
def _sh12():
    """(PA5.2, PA5.3, PA5.5) bin/cli.ts and bin/mcp.ts preflight Node >= 22.5 with a one-line message; against a dead port the CLI exits non-zero with CHROME_NOT_RUNNING on stderr and no stack trace, and the MCP returns isError: true with the code in the content."""
    pre = all(re.search(r"22[.,\s]+5", read(f"{P}/bin/{f}")) for f in ("cli.ts", "mcp.ts"))
    if not ensure_bin():
        return False, "build-bin failed"
    rc, o, e = cli_verb("listPageTargets", ["--port", HOST_PORT_DEAD])
    cli_ok = rc != 0 and "CHROME_NOT_RUNNING" in (o + e) and not re.search(r"\n\s+at\s+\S+.*[:(]\d+", e)
    r = mcp_full([], [("listPageTargets", {"port": int(HOST_PORT_DEAD)})])
    res = ((r["calls"] or [{}])[0].get("result") or {})
    mcp_ok = res.get("isError") is True and "CHROME_NOT_RUNNING" in json.dumps(res.get("content"))
    return pre and cli_ok and mcp_ok, f"preflight={pre} cli(rc={rc})={cli_ok} mcp={mcp_ok}"


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


@check("prod-examples", 1)
def _pex1():
    """(PA7.1) examples/library.ts, examples/cli.md and examples/mcp-config.json exist and are non-empty."""
    miss = [f for f in ("library.ts", "cli.md", "mcp-config.json") if not read(f"{EX}/{f}").strip()]
    return not miss, f"missing/empty {miss}"


@check("prod-examples", 2)
def _pex2():
    """(PA7.2) tsconfig.spec.json includes examples/ and `nx run stealth-browser:typecheck-spec` exits 0 with examples/library.ts importing the package."""
    inc = "examples" in read(f"{P}/tsconfig.spec.json")
    imp = re.search(r"from\s+['\"](@adhd/stealth-browser|\.\./src/index\.js)['\"]", read(f"{EX}/library.ts")) is not None
    rc, out = sh([NX, "run", f"{proj_name()}:typecheck-spec"], timeout=1200) if inc and imp else (1, "")
    return inc and imp and rc == 0, f"included={inc} imports={imp} rc={rc} {out[-150:]}"


@check("prod-examples", 3)
def _pex3():
    """(PA7.3) examples/mcp-config.json parses as JSON with an mcpServers entry whose command/args name the `stealth-browser-mcp` bin declared in package.json."""
    d = jread(f"{EX}/mcp-config.json", None)
    bins = set((pkg().get("bin") or {}))
    servers = (d or {}).get("mcpServers") or {}
    named = any("stealth-browser-mcp" in json.dumps(v) for v in servers.values())
    return bool(servers) and "stealth-browser-mcp" in bins and named, f"servers={list(servers)} bins={sorted(bins)}"


@check("prod-examples", 4)
def _pex4():
    """(PA7.4) The three examples use an explicit non-9222 port and never the default 9222."""
    bad = []
    for f in ("library.ts", "cli.md", "mcp-config.json"):
        t = read(f"{EX}/{f}")
        ports = re.findall(r"port\W{0,6}(\d{4,5})", t, re.I)
        if not ports or any(p == "9222" for p in ports) or re.search(r"(?<!\d)9222(?!\d)", t):
            bad.append(f)
    return not bad, f"examples without an explicit non-9222 port: {bad}"


@check("prod-examples", 5)
def _pex5():
    """A spec under src/test/unit/examples/ asserts the examples (config JSON parses, bin name matches, port is non-9222), citing ticket 8468f7b1, a valid criterion id of this state and PA7.3 / PA7.4; only owned paths changed by [psm:prod-examples] commits."""
    specs = spec_files("unit/examples")
    t = "\n".join(read(f) for f in specs)
    ids = set(re.findall(r"\[(prod-examples\.\d+)\]", t))
    o = ownership_ok("prod-examples")
    return bool(specs) and TICKET in t and bool(ids & criteria_ids()) and all(k in t for k in ("PA7.3", "PA7.4")) and o[0], o[1]


# ---------------------------------------------------------------- tests (P1, P2, P9 coverage)
@check("tests-unit-surface", 4)
def _tus4():
    """(PA1.2, PA1.3, PA2.2) An in-process host spec under src/test/unit/surface/ (child_process / ChromeManager mocked, no subprocess) asserts: the launchChrome tools/list schema has no chromePath or extraArgs, a tools/call with extraArgs is rejected and spawns nothing, and the fixture cookie value SECRET123 is absent from the MCP JSON and the CLI stdout; it cites the PA ids and ticket 8468f7b1."""
    t = "\n".join(read(f) for f in spec_files("unit/surface") if "host" in os.path.basename(f))
    need = ("SECRET123", "chromePath", "extraArgs", "PA1.2", "PA1.3", "PA2.2", TICKET, "vi.mock")
    miss = [k for k in need if k not in t]
    return not miss and re.search(r"not\.toContain\(['\"]?SECRET123|not\.toMatch\(.*SECRET123", t) is not None, f"host spec missing {miss}"


@check("tests-e2e", 6)
def _te6():
    """(PA2.1) The e2e seeds a cookie with a unique value on the real Chrome (Network.setCookie) and asserts getPageContext over BOTH the built MCP bin and the CLI returns the cookie name and count but never the value string."""
    t = "\n".join(read(f) for f in walk(f"{P}/src/test/e2e"))
    need = ("PA2.1", "setCookie", "getPageContext")
    return all(k in t for k in need) and re.search(r"not\.toContain\(", t) is not None, f"missing {[k for k in need if k not in t]}"


@check("tests-e2e", 7)
def _te7():
    """(PA9.2, PA5.3) The e2e runs the real MCP bin with --verbose and asserts every stdout line parses as JSON-RPC while diagnostics appear only on stderr."""
    t = "\n".join(read(f) for f in walk(f"{P}/src/test/e2e"))
    need = ("PA9.2", "--verbose", "jsonrpc", "JSON.parse", "stderr")
    return all(k in t for k in need), f"missing {[k for k in need if k not in t]}"


# ---------------------------------------------------------------- docs (P6, P8, P9)
@check("docs-marketing-run", 6)
def _dm6():
    """(PA6.2, PA6.3) docs/CONFIGURATION.md lists every default verbatim (port 9222, the Library/Application Support/Google/Chrome-CDP profile, /tmp/stealth-browser-heartbeat) and states macOS-first support with what is untested elsewhere."""
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
    """(PA9.1) docs/OBSERVABILITY.md documents adhd.<op>.start|finish|error records, how to enable the sink, the --verbose stderr diagnostics, and that the MCP bin writes only JSON-RPC to stdout."""
    t = read(f"{P}/docs/OBSERVABILITY.md")
    need = ("adhd.", ".start", ".finish", ".error", "sink", "--verbose", "stderr", "JSON-RPC", "stdout")
    miss = [k for k in need if k not in t]
    return not miss, f"missing {miss}"


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
    """(PA10.2) README states the stability policy: the package is 0.x, only the six verbs and their types are stable, everything else is experimental."""
    t = read(f"{P}/README.md")
    return "0.x" in t and re.search(r"stability|stable", t, re.I) is not None and "experimental" in t.lower(), "stability policy"


# ---------------------------------------------------------------- prod-publish-readiness (P10)
@check("prod-publish-readiness", 1)
def _pr1():
    """(PA10.1) package.json has description, keywords, license, publishConfig.access = public (matching dispatch-cli and backlog), files, and engines.node >= 22.5."""
    p = pkg()
    eng = (p.get("engines") or {}).get("node", "")
    return all(p.get(k) for k in ("description", "keywords", "license", "files")) and (p.get("publishConfig") or {}).get("access") == "public" and "22.5" in eng, f"engines={eng}"


@check("prod-publish-readiness", 2)
def _pr2():
    """(PA10.2) The initial version is 0.x (the README's stability policy is guarded by readme-rewrite.8, which runs after the docs states)."""
    return str(pkg().get("version", "")).startswith("0."), f"version={pkg().get('version')}"


def tarball_missing():
    """`npm pack --dry-run --json` in dist/: returns (rc, missing members) against README.md, CHANGELOG.md, both bins and every exports target of the dist manifest."""
    rc, o, e = run2(["npm", "pack", "--dry-run", "--json"], 300, cwd=f"{P}/dist")
    try:
        files = {f["path"] for f in json.loads(o)[0]["files"]}
    except (ValueError, KeyError, IndexError):
        return rc, [f"npm pack --dry-run unreadable rc={rc} {e[-150:]}"]
    need = {"README.md", "CHANGELOG.md", "bin/cli.js", "bin/mcp.js"}
    dm = jread(f"{P}/dist/package.json", {}) or {}
    tg = set()

    def collect(x):
        if isinstance(x, str):
            tg.add(os.path.normpath(x))
        elif isinstance(x, dict):
            for v in x.values():
                collect(v)
    collect(dm.get("exports") or {})
    return rc, sorted(need - files) + sorted(t for t in tg if t not in files)


@check("prod-publish-readiness", 3)
def _pr3():
    """(PA10.3) `npm pack --dry-run` against the built dist output lists README.md, CHANGELOG.md, bin/cli.js, bin/mcp.js and every exports target; the output is recorded in evidence/publish-dry-run.txt."""
    rc, miss = tarball_missing()
    rec = read(f"{PLAN}/evidence/publish-dry-run.txt")
    return rc == 0 and not miss and bool(rec.strip()), f"missing from tarball: {miss}; evidence recorded={bool(rec.strip())}"


@check("audit-final", 9)
def _af9():
    """(PA10.3, re-checked after the docs states) `npm pack --dry-run` against the final dist output still lists README.md, CHANGELOG.md, bin/cli.js, bin/mcp.js and every exports target, and the packed README is the rewritten one (it links docs/RESPONSIBLE-USE.md)."""
    rc, miss = tarball_missing()
    return rc == 0 and not miss and "docs/RESPONSIBLE-USE.md" in read(f"{P}/dist/README.md"), f"missing from tarball: {miss}"


@check("prod-publish-readiness", 4)
def _pr4():
    """(PA10.4) dist/bin/cli.js and dist/bin/mcp.js start with a shebang and are executable."""
    bad = []
    for f in ("cli.js", "mcp.js"):
        p = f"{P}/dist/bin/{f}"
        if not (exists(p) and read(p).startswith("#!") and os.access(p, os.X_OK)):
            bad.append(f)
    return not bad, f"not shebang+executable: {bad}"


@check("prod-publish-readiness", 5)
def _pr5():
    """(PA10.5) Every @adhd/* dependency is either a public workspace package (not private) or recorded as published in published-state.json."""
    names = {}
    for f in git("ls-files", "*package.json").splitlines():
        d = jread(f, None)
        if isinstance(d, dict) and d.get("name"):
            names[d["name"]] = d
    pub = jread("published-state.json", {}) or {}
    p = pkg()
    deps = {**(p.get("dependencies") or {}), **(p.get("peerDependencies") or {})}
    bad = [n for n in deps if n.startswith("@adhd/") and not ((n in names and not names[n].get("private")) or n in pub or n in (pub.get("packages") or {}))]
    return bool(deps) and not bad, f"unpublished/private deps: {bad}"


@check("prod-publish-readiness", 6)
def _pr6():
    """Only owned paths changed by [psm:prod-publish-readiness] commits."""
    return ownership_ok("prod-publish-readiness")


# ---------------------------------------------------------------- release (D1, D3)
def consume_link():
    m = re.search(r"^CONSUME:\s*link:(/\S+)\s*$", read(f"{PLAN}/RELEASE-DECISION.md"), re.M)
    return m.group(1) if m else None


@check("merge-readiness", 4)
def _mr4():
    """(D3) When CONSUME is a link: into the merged main checkout, RELEASE-DECISION.md records `MAIN_BUILD: nx run stealth-browser:build-bin exit=0` (dist/ built in the merged main checkout by the dispatcher before the link is consumed) and that dist exists there; a published CONSUME needs no main build."""
    t = read(f"{PLAN}/RELEASE-DECISION.md")
    link = consume_link()
    if not t:
        return False, "RELEASE-DECISION.md missing"
    if link is None:
        return bool(re.search(r"^CONSUME:\s*@adhd/stealth-browser@\S+\s*$", t, re.M)), "published consume"
    return bool(re.search(r"^MAIN_BUILD:\s*nx run stealth-browser:build-bin exit=0\s*$", t, re.M)) and exists(f"{link}/dist/bin/cli.js") and exists(f"{link}/dist/bin/mcp.js"), f"link={link}"


@check("agent-search-cutover", 6)
def _ac6():
    """(D3) Before consumption: a link: CONSUME target has a built dist (dist/index.js, dist/bin/cli.js, dist/bin/mcp.js) and `node dist/bin/cli.js --help` exits 0 there; agent-browser's node_modules/@adhd/stealth-browser/package.json exists."""
    link = consume_link()
    if link is None:
        return exists(f"{SRC}/node_modules/@adhd/stealth-browser/package.json"), "published consume resolves"
    rc, _, _ = run2(["node", f"{link}/dist/bin/cli.js", "--help"], 60) if exists(f"{link}/dist/bin/cli.js") else (1, "", "")
    return all(exists(f"{link}/dist/{f}") for f in ("index.js", "bin/cli.js", "bin/mcp.js")) and rc == 0 and exists(f"{SRC}/node_modules/@adhd/stealth-browser/package.json"), f"link={link} cli rc={rc}"


@check("agent-search-cutover", 7)
def _ac7():
    """(D1) agent-browser imports the old search/Google-named barrel names from `@adhd/stealth-browser/legacy`, and no import from the bare root `@adhd/stealth-browser` names a Google- or Search-named symbol."""
    bad, via_legacy = [], False
    for f in walk(SRC):
        t = read(f)
        if "@adhd/stealth-browser/legacy" in t:
            via_legacy = True
        for names, spec in re.findall(r"(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"](@adhd/stealth-browser)['\"]", t):
            bad += [f"{os.path.relpath(f, SRC)}:{n.strip()}" for n in names.split(",") if NAMES_RE.search(n)]
    return via_legacy and not bad, f"legacy import={via_legacy} root imports of legacy names={bad[:5]}"



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
