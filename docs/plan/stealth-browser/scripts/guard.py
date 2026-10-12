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
    cut = [x for x in sh(["git", "log", "--format=%H", "--grep=\\[psm:agent-search-cutover\\]", "--reverse"], cwd=SCRATCH)[1].split() if x]
    if cut:
        # the cutover may change agent-browser/adhd: everything BEFORE its first commit must equal the baseline, and only cutover commits may touch it afterwards
        tree = git("rev-parse", f"{cut[0]}^:agent-browser/adhd", cwd=SCRATCH)
        others = [c for c in sh(["git", "log", "--format=%H%x1f%B%x1e", f"{cut[0]}^..HEAD", "--", "agent-browser/adhd"], cwd=SCRATCH)[1].split("\x1e") if c.strip() and "[psm:agent-search-cutover]" not in c]
        return tree == base.get("tree") and not others, f"pre-cutover tree={tree[:10]} baseline={base.get('tree', '')[:10]} non-cutover commits touching adhd={len(others)}"
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


def port_check(bucket, strict=False, final=False):
    """strict=False is the migration-time check (the port still carries the source names); strict=True is the corrected tree after port-fixes (greenfield renames and require_exports enforced)."""
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
        ratio = difflib.SequenceMatcher(None, norm_for_diff(s), norm_for_diff(d), autojunk=False).ratio()
        if ratio < e.get("min_similarity", 0.80) and not e.get("rewritten_by"):  # a file rewritten by capture-upgrade / chrome-lifecycle is held to the feature inventory instead of line similarity (greenfield: no legacy-code guard)
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
        """Every manifest file exists, keeps every export (modulo the manifest's recorded allowed_renames/allowed_drops), stays >=80% line-similar to the scaffold-time source, keeps its must-contain tokens."""
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
    """package.json carries the sibling publish metadata: repository.directory == entrypoint/stealth-browser, homepage, bugs, license, files, main/types, publishConfig."""
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
    """Historical one-shot: the dependency commit carried the documented TEMPORARY `@nx/dependency-checks` `ignoredDependencies` entry (git history shows a [psm:deps-install] commit that introduced the marker); mig-capture-parsers.6 removed it again, so the live eslint config is not asserted."""
    log = git("log", "--format=%B%x1e", "-S" + TEMP_IGNORE_MARK, "--", f"{P}/eslint.config.mjs")
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
    """storage/helpers.ts still opens Chrome databases `mode=ro&immutable=1` (no file locking) and still exports openDb via helpers."""
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
    """Behavior parity of the port at migration time: the three-tier safety shutdown (`shutdownIfIdle`) and the ChromeManagerOptions type are preserved; the cross-process coordination is a FEATURE whose mechanism (heartbeat file, lease registry or service proxy) is rebuilt by chrome-lifecycle (EVALUATIONS.md E2) and is pinned by the feature inventory, not by the heartbeat path."""
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
# Namespaces the capture-upgrade and chrome-lifecycle states add; prod-errors wires them into the package root.
AREAS_EXTRA = {"recording": "lib/recording/index", "lifecycle": "lib/lifecycle/index"}
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
    """The package root (src/index.ts) is the greenfield public API, one root entry (ADR-0003, no subpaths): the five core library areas as namespace exports `cdp`, `storage`, `capture`, `parsers`, `chromeManager` (prod-errors adds `recording` and `lifecycle`) (`export * as <area> from './lib/...'`), `export * from './api.js'` for the six verbs, and `export type * from './lib/types.js'` for the shared types, optionally `export * from './errors.js'` (the typed errors); no default export and no other export statement; every name the agent-search consumer files import (the ~10 deep-imported cdp-connection names included) resolves inside its namespace."""
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
    """The spec cites ticket 8468f7b1 and a valid tracing-plugin.N criterion id."""
    t = read(SPEC)
    ids = set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", t))
    return TICKET in t and bool(ids & criteria_ids()), f"ids={sorted(ids)}"


@check("tracing-namespace-proof", 4)
def _tn4():
    """Mutation teeth, in-process (never touching src/tracing.ts): the spec builds a second plugin with serviceName 'apigen' via makeTracingPlugin and proves the SAME namespace assertion helper rejects its records (expect(...).toThrow), while the configured plugin passes; `nx run stealth-browser:test -- src/test/unit/tracing` exits 0 and src/tracing.ts is byte-identical before and after the run."""
    path = f"{P}/src/tracing.ts"
    t = read(SPEC)
    mut = re.search(r"makeTracingPlugin\(\s*\{[^}]*serviceName:\s*['\"]apigen['\"]", t) is not None and re.search(r"toThrow|rejects\.", t) is not None
    before = hashlib.sha256(read(path).encode()).hexdigest()
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", "src/test/unit/tracing"], timeout=1500)
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
    """src/test/unit/surface/api.spec.ts and index.spec.ts exist and assert all six verbs and the five root namespaces (cdp, storage, capture, parsers, chromeManager)."""
    a, b = read(f"{P}/src/test/unit/surface/api.spec.ts"), read(f"{P}/src/test/unit/surface/index.spec.ts")
    return all(v in a for v in VERBS) and all(k in b for k in AREAS), "surface specs"


@check("tests-unit-surface", 2)
def _tus2():
    """Surface specs cite 8468f7b1 and a valid surface-api.N id; process/network boundaries are mocked."""
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


# ============================================================ gates
GATE_TARGETS = ["lint", "typecheck", "typecheck-spec", "build", "build-bin", "test", "verify-dist-load"]


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
             ("test", "`nx run stealth-browser:test` exits 0 (unit lane incl. the use-case suites; every spawner and third-party network call is mocked, no live Chrome)"),
             ("verify-dist-load", "`nx run stealth-browser:verify-dist-load` exits 0 (the built dist loads the way a consumer loads it)")]
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
        files = [f for f in walk(f"{P}/src/test", (".ts",)) if f.endswith(".spec.ts")]
        ids = criteria_ids()
        bad = [f for f in files if TICKET not in read(f) or not (set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", read(f))) & ids)]
        return not bad and bool(files), f"uncited tests {bad[:6]}"
    citations.__doc__ = "Every spec file cites ticket 8468f7b1 and a valid acceptance-criterion id; evidence JSON records every gate command and exit code"
    CHECKS[slug].append((f"{slug}.{n}", citations))


gate_checks("gates-first", f"{PLAN}/evidence/gates-first.json")


@check("gates-first", 7)
def _gf7():
    """(PA10.1, PA10.2, PA10.4, PA10.5; folded from the retired publish-readiness state) package.json has description, keywords, license, files, publishConfig.access = public and engines.node >= 22.5, the version is 0.x, the built dist/bin/cli.js and mcp.js start with a shebang and are executable, and every @adhd/* dependency is a public workspace package or recorded in published-state.json."""
    p = pkg()
    eng = (p.get("engines") or {}).get("node", "")
    meta = all(p.get(k) for k in ("description", "keywords", "license", "files")) and (p.get("publishConfig") or {}).get("access") == "public" and "22.5" in eng
    bad_bin = [f for f in ("cli.js", "mcp.js") if not (exists(f"{P}/dist/bin/{f}") and read(f"{P}/dist/bin/{f}").startswith("#!") and os.access(f"{P}/dist/bin/{f}", os.X_OK))]
    names = {}
    for f in git("ls-files", "*package.json").splitlines():
        d = jread(f, None)
        if isinstance(d, dict) and d.get("name"):
            names[d["name"]] = d
    pub = jread("published-state.json", {}) or {}
    deps = {**(p.get("dependencies") or {}), **(p.get("peerDependencies") or {})}
    bad_dep = [n for n in deps if n.startswith("@adhd/") and not ((n in names and not names[n].get("private")) or n in pub or n in (pub.get("packages") or {}))]
    return meta and str(p.get("version", "")).startswith("0.") and not bad_bin and bool(deps) and not bad_dep, f"meta={meta} version={p.get('version')} bins={bad_bin} unpublished deps={bad_dep}"


@check("gates-first", 8)
def _gf8():
    """(PA10.3) `npm pack --dry-run` against the built dist output lists README.md, CHANGELOG.md, bin/cli.js, bin/mcp.js, index.js and index.d.ts (the main/types/bin targets); the output is recorded in evidence/publish-dry-run.txt."""
    rc, miss = tarball_missing()
    rec = read(f"{PLAN}/evidence/publish-dry-run.txt")
    return rc == 0 and not miss and bool(rec.strip()), f"missing from tarball: {miss}; evidence recorded={bool(rec.strip())}"


@check("gates-first", 9)
def _gf9():
    """Only owned paths changed by [psm:gates-first] commits."""
    return ownership_ok("gates-first")

@check("gates-first", 10)
def _gf10():
    """After a full build, neither owned package is inlined into dist (module-format proof for ADR-0003): no dist/**/*.js file defines `createStoreAdapter`, `ensureBackend`, `serveBackend` or `dialBackend`, dist references `@adhd/sox-service-proxy` as an external require, and no dist file `require`s `@adhd/sox-store-adapter` (it is reached only through a dynamic `import()`)."""
    rc, out = sh([NX, "run", f"{proj_name()}:build"], timeout=1800)
    files = walk(f"{P}/dist", (".js", ".cjs", ".mjs"))
    txt = {f: read(f) for f in files}
    inlined = [os.path.relpath(f, P) for f, t in txt.items() if re.search(r"function\s+(createStoreAdapter|ensureBackend|serveBackend|dialBackend)\b", t)]
    req_store = [os.path.relpath(f, P) for f, t in txt.items() if re.search(r"require\(\s*['\"]@adhd/sox-store-adapter['\"]", t)]
    proxy_ext = any("@adhd/sox-service-proxy" in t for t in txt.values())
    return rc == 0 and bool(files) and not inlined and not req_store and proxy_ext, f"build rc={rc} files={len(files)} inlined={inlined} store require={req_store} proxy external={proxy_ext}"



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
    """[dod.2] behavioral: `nx run stealth-browser:verify-dist-load` and the use-case unit suites (library, CLI and MCP scenarios against the in-process fake CDP server) pass on the final tree, and the agent-search cutover proof holds (gates-rerun evidence all green, tree == HEAD tree)."""
    g = jread(f"{PLAN}/evidence/gates-rerun.json", {})
    return g.get("all_green") is True and g.get("tree") == tree_sha(), f"gates tree {str(g.get('tree'))[:8]} vs {tree_sha()[:8]}"


@check("audit-final", 3)
def _af3():
    """[dod.3] structural: tracing namespace is `adhd` - singleton never imported, serviceName configured once, every mount carries the plugin (tracing-plugin checks 1,2,3,5 re-run)."""
    return all(f()[0] for f in (_t1, _t2, _t3, _t5)), "namespace"


@check("audit-final", 4)
def _af4():
    """[ref:runner-port] feature parity: every failsafe-inventory row (features and failsafes of the source runner, not code or exports) is pinned by a feature-level unit test that cites its row id."""
    rows = inventory_rows()
    bad = [r["id"] for r in rows if not row_pinned(r)]
    return len(rows) >= 40 and not bad, f"{len(rows)} rows, unpinned {bad[:10]}"


@check("audit-final", 5)
def _af5():
    """[dod.5] structural: the agent-search source tree was byte-identical to the scaffold-time baseline up to the first cutover commit, and only [psm:agent-search-cutover] commits touched agent-browser/adhd afterwards."""
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
    """Every spec file cites ticket 8468f7b1 and a valid criterion id (final re-run of the citation rule)."""
    files = [f for f in walk(f"{P}/src/test", (".ts",))]
    ids = criteria_ids()
    bad = [f for f in files if TICKET not in read(f) or not (set(re.findall(r"\[([a-z0-9-]+\.\d+)\]", read(f))) & ids)]
    return not bad and bool(files), f"uncited {bad[:5]}"



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
ERR_CODES_HOST = ["CHROME_NOT_FOUND", "PORT_IN_USE", "NODE_TOO_OLD", "CHROME_NOT_RUNNING"]
# failure modes enumerated from the library's throw sites (cdp/browser, cdp/targets, cdp/session, cdp/settle, capture/dom, domains/transport)
ERR_CODE_LIB = ["CHROME_START_TIMEOUT", "CDP_UNREACHABLE", "CDP_BAD_RESPONSE", "TARGET_NOT_FOUND", "CDP_CONNECT_FAILED", "CDP_NOT_CONNECTED",
                "CDP_TIMEOUT", "CDP_REMOTE_ERROR", "CDP_SESSION_CLOSED", "CDP_SEND_FAILED", "NAVIGATION_FAILED", "PAGE_SETTLE_FAILED",
                "OPERATION_ABORTED", "SELECTOR_TIMEOUT"]
# CaptureError (capture-upgrade, spec 5.5) and LifecycleError (chrome-lifecycle, spec 6.4) codes join the same registry (amendment A4)
# final registries fixed by EVAL-store-adapter.md (CU10) and EVAL-service-proxy.md (CL20)
CAPTURE_CODES = ["CAPTURE_CONNECT_FAILED", "CAPTURE_NAVIGATE_FAILED", "CAPTURE_TIMEOUT", "CAPTURE_NO_MATCH", "CAPTURE_BAN_DETECTED", "CAPTURE_SESSION_CLOSED", "CAPTURE_SINK_FAILED", "CAPTURE_SINK_UNAVAILABLE"]
LIFECYCLE_CODES = ["LAUNCH_FAILED", "LAUNCH_LOCK_TIMEOUT", "CHROME_UNREACHABLE_AFTER_LAUNCH", "LAUNCH_CIRCUIT_OPEN", "PRESENCE_DIR_INSECURE", "REAPER_UNAVAILABLE", "ISOLATED_CONTEXT_FAILED"]
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
    return [f for f in walk(f"{P}/src/test/{sub}") if f.endswith((".spec.ts", ".test.ts"))]


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
    """(PA3.3, PA3.4, ADR-0003) package.json has NO `exports` map and NO `module` field, `main` is ./dist/index.js and `types` ./dist/index.d.ts; the built root index.d.ts (namespaces included) exports no Google- or Search-named symbol; `require()` of the built dist/index.js exposes the five namespaces and the six verbs; `nx run stealth-browser:verify-dist-load` exits 0."""
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
    return shape and not bad and rc_r == 0 and (set(AREAS) | set(VERBS)) <= keys and rc_v == 0, f"shape={shape} searchNames={bad} require rc={rc_r} keys={sorted(keys)} {e_r[-100:]} verify rc={rc_v}"


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
@check("tests-unit-surface", 4)
def _tus4():
    """(PA1.2, PA1.3, PA2.2) An in-process host spec under src/test/unit/surface/ (child_process / ChromeManager mocked, no subprocess) asserts: the launchChrome tools/list schema has no chromePath or extraArgs, a tools/call with extraArgs is rejected and spawns nothing, and the fixture cookie value SECRET123 is absent from the MCP JSON and the CLI stdout; it cites the PA ids and ticket 8468f7b1."""
    t = "\n".join(read(f) for f in spec_files("unit/surface") if "host" in os.path.basename(f))
    need = ("SECRET123", "chromePath", "extraArgs", "PA1.2", "PA1.3", "PA2.2", TICKET, "vi.mock")
    miss = [k for k in need if k not in t]
    return not miss and re.search(r"not\.toContain\(['\"]?SECRET123|not\.toMatch\(.*SECRET123", t) is not None, f"host spec missing {miss}"



@check("tests-unit-surface", 5)
def _tus5():
    """(PA3.1, greenfield) A public-API export snapshot spec under src/test/unit/surface/ lists every root export name of src/index.ts (the five namespaces and the six verbs) and the member names of each namespace, and fails on drift (toEqual / inline snapshot of the sorted names); it cites ticket 8468f7b1, a valid tests-unit-surface.N id and PA3.1."""
    specs = [f for f in spec_files("unit/surface") if "public-api" in os.path.basename(f)]
    t = "\n".join(read(f) for f in specs)
    names = set(AREAS) | set(VERBS)
    miss = sorted(n for n in names if n not in t)
    ids = set(re.findall(r"\[(tests-unit-surface\.\d+)\]", t))
    return bool(specs) and not miss and re.search(r"toEqual|toMatchInlineSnapshot|toMatchSnapshot", t) is not None and TICKET in t and bool(ids & criteria_ids()) and "PA3.1" in t, f"specs={len(specs)} unlisted={miss}"

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
    """(PA9.1) docs/OBSERVABILITY.md documents adhd.<op>.start|finish|error records, how to enable the sink, the --verbose stderr diagnostics, and that the MCP bin writes only JSON-RPC to stdout."""
    t = read(f"{P}/docs/OBSERVABILITY.md")
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
def tarball_missing():
    """`npm pack --dry-run --json` in dist/: returns (rc, missing members) against README.md, CHANGELOG.md, both bins and the main/types/bin targets of the dist manifest (no exports map, ADR-0003)."""
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
    collect([dm.get("main"), dm.get("types") or dm.get("typings")])
    collect(dm.get("bin") or {})
    return rc, sorted(need - files) + sorted(t for t in tg if t not in files)


@check("audit-final", 9)
def _af9():
    """(PA10.3, re-checked after the docs states) `npm pack --dry-run` against the final dist output still lists README.md, CHANGELOG.md, bin/cli.js, bin/mcp.js, index.js and index.d.ts, and the packed README is the rewritten one (it links docs/RESPONSIBLE-USE.md)."""
    rc, miss = tarball_missing()
    return rc == 0 and not miss and "docs/RESPONSIBLE-USE.md" in read(f"{P}/dist/README.md"), f"missing from tarball: {miss}"


# ---------------------------------------------------------------- release (D1, D3)
CONSUMERS = ["cdp-query-client.ts", "cdp-search.ts", "chrome-lifecycle-test.ts", "network-capture.ts", "search-challenge.ts", "search-dom.ts", "search-fetch.ts",
             "search-guard-test.ts", "search-mcp-source.ts", "search-network.ts", "search-tripwire.ts", "search/queries/activity.ts", "search/queries/context.ts", "search/queries/last-search.ts"]
CUTOVER_OWNED = ["adhd/", *CONSUMERS, "package.json", "pnpm-lock.yaml", "AGENTS.md", "SEARCH.md", "FEATURES.md", "FETCH.md", "docs/"]


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
    specs = "\n".join(read(f) for f in walk(f"{P}/src/test/unit/domains-storage"))
    return "readBigInts" in h and "immutable=1" in h and "it.fails" not in "\n".join(read(f) for f in walk(f"{P}/src/test")) and "getRedirectChain" in specs and re.search(r"typeof[^\n]*['\"]number['\"]|toBeTypeOf\(['\"]number['\"]\)", specs) is not None, "bigint defect pinned green"


@check("port-fixes", 3)
def _pf3():
    """Defect 2 (cookie expiry): a unit test in domains-storage/cookies.spec.ts proves CookieClient.getCookies maps `expires_utc = 0` (a session cookie) to a null expiry instead of 1601-01-01."""
    t = read(f"{P}/src/test/unit/domains-storage/cookies.spec.ts")
    return "expires_utc" in t and re.search(r"expires_utc[^\n]*\b0\b", t) is not None and "toBeNull" in t and "1601" in t and "[port-fixes." in t, "session-cookie expiry regression test"


@check("port-fixes", 4)
def _pf4():
    """Defect 3 (cdpCall before open): domains/transport.ts waits for the socket to open before `send`, and a unit test in domains-storage/transport.spec.ts drives a WebSocket stub that opens asynchronously and proves cdpCall resolves with the reply (not null) and never sends before open."""
    code = read(f"{P}/src/lib/domains/transport.ts")
    t = read(f"{P}/src/test/unit/domains-storage/transport.spec.ts")
    waits = re.search(r"readyState|addEventListener\(['\"]open|\.on\(['\"]open|once\(['\"]open|onopen", code) is not None
    return waits and "cdpCall" in t and re.search(r"open", t) is not None and "not.toBeNull" in t and "[port-fixes." in t, f"waits={waits}"


@check("port-fixes", 5)
def _pf5():
    """The scratch chrome-lifecycle-test.ts is ported as a unit/lifecycle spec: src/test/unit/chrome-manager/chrome-lifecycle.spec.ts covers all five scenarios (deferral does not stamp the deferrer's heartbeat, genuine activity stamps, stale sibling lets shutdown proceed, absent sibling proceeds, dead sibling PID is ignored), uses a temp heartbeat path and a dead CDP port (never the live /tmp/stealth-browser-heartbeat), cites ticket 8468f7b1 and a valid port-fixes.N id; chrome-lifecycle later replaces the heartbeat mechanism with per-process presence records that keep the same behaviors."""
    t = read(f"{P}/src/test/unit/chrome-manager/chrome-lifecycle.spec.ts")
    need = ("shutdownIfIdle", "heartbeatPath", "mkdtemp", "bump", "livelock")
    live = re.search(r"['\"`]/tmp/stealth-browser-heartbeat['\"`]", t) is not None
    ids = set(re.findall(r"\[(port-fixes\.\d+)\]", t))
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
    """review/PRE-REVIEW.json exists and records `auditor`, `blind: false`, `static: true`, the audited `head` and `tree` (git rev-parse HEAD:entrypoint/stealth-browser), the `audit_dod` command, its integer `audit_dod_exit` and the verbatim `[dod.N]` lines it printed; PRE-REVIEW.md is the human-readable rendering."""
    f = pre_findings()
    ok = bool(f.get("auditor")) and f.get("blind") is False and f.get("static") is True and bool(f.get("head")) and bool(f.get("tree")) and isinstance(f.get("audit_dod_exit"), int) and "audit_dod.py --phase pre-review" in str(f.get("audit_dod", "")) and bool(f.get("audit_dod_lines"))
    return ok and len(read(f"{PLAN}/review/PRE-REVIEW.md").strip()) > 100, "pre-review record"


@check("audit-pre-review", 2)
def _apr2():
    """The audit judged the current code: `tree` in PRE-REVIEW.json equals the current entrypoint/stealth-browser tree sha, and `audit_dod_exit` equals the exit status of re-running `audit_dod.py --phase pre-review` now."""
    f = pre_findings()
    rc, _ = sh([sys.executable, f"{SCRIPTS}/audit_dod.py", "--phase", "pre-review"], timeout=2400)
    return f.get("tree") == tree_sha() and f.get("audit_dod_exit") == rc, f"tree match={f.get('tree') == tree_sha()} recorded exit={f.get('audit_dod_exit')} rerun={rc}"


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
        same = git("rev-parse", f"{since}:{P}") == tree_sha()
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
            body = git("log", "-1", "--format=%B", r.get("commit", "HEAD_MISSING"))
            files = git("diff-tree", "--no-commit-id", "--name-only", "-r", r.get("commit", "HEAD_MISSING")).splitlines()
            if "[psm:audit-fixes]" not in body or fmap.get(r["id"], {}).get("file") not in files:
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
    """No new TODO/FIXME/XXX in entrypoint/stealth-browser/src and only owned paths changed by [psm:audit-fixes] commits."""
    t = "\n".join(read(f) for f in walk(f"{P}/src"))
    o = ownership_ok("audit-fixes")
    return not re.search(r"\b(TODO|FIXME|XXX)\b", t) and o[0], o[1]


@check("audit-fixes", 5)
def _afx5():
    """After the corrections lint, typecheck, typecheck-spec and the unit lane exit 0 (`nx run stealth-browser:lint typecheck typecheck-spec test`); the full gate run follows in gates-first."""
    bad = []
    for t in ("lint", "typecheck", "typecheck-spec", "test"):
        rc, out = sh([NX, "run", f"{proj_name()}:{t}"], timeout=2400)
        if rc != 0:
            bad.append(f"{t}={rc}")
    return not bad, f"failing {bad}"


@check("audit-fixes", 6)
def _afx6():
    """`audit_dod.py --phase pre-review` exits 0 on the corrected tree (every dod clause that was available before the gates now passes)."""
    rc, out = sh([sys.executable, f"{SCRIPTS}/audit_dod.py", "--phase", "pre-review"], timeout=2400)
    return rc == 0, out[-300:]



# ---------------------------------------------------------------- prod-errors (100% typed errors)
def untyped_throws():
    """Every non-test source line under src/ and bin/ that constructs or throws an untyped error."""
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
    """(PA5.1, widened to 100%) src/errors.ts defines one `StealthBrowserError extends Error` with a readonly stable `code`, an exported `ERROR_CODES` const naming EVERY failure mode of the library, an `exitCodeFor(code)` mapping and a remediation message per code; the codes are exactly the 33 enumerated from the code and the two specs (4 host codes CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD, CHROME_NOT_RUNNING; 14 library codes CHROME_START_TIMEOUT, CDP_UNREACHABLE, CDP_BAD_RESPONSE, TARGET_NOT_FOUND, CDP_CONNECT_FAILED, CDP_NOT_CONNECTED, CDP_TIMEOUT, CDP_REMOTE_ERROR, CDP_SESSION_CLOSED, CDP_SEND_FAILED, NAVIGATION_FAILED, PAGE_SETTLE_FAILED, OPERATION_ABORTED, SELECTOR_TIMEOUT; the 8 CaptureError codes CAPTURE_CONNECT_FAILED, CAPTURE_NAVIGATE_FAILED, CAPTURE_TIMEOUT, CAPTURE_NO_MATCH, CAPTURE_BAN_DETECTED, CAPTURE_SESSION_CLOSED, CAPTURE_SINK_FAILED, CAPTURE_SINK_UNAVAILABLE; the 7 LifecycleError codes LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, PRESENCE_DIR_INSECURE, REAPER_UNAVAILABLE, ISOLATED_CONTEXT_FAILED), and every code's message names a concrete next step."""
    t = read(f"{P}/src/errors.ts")
    miss = [c for c in all_codes() if c not in t]
    cls = re.search(r"class\s+StealthBrowserError\s+extends\s+Error", t) is not None and re.search(r"readonly\s+code", t) is not None
    api = {"ERROR_CODES", "exitCodeFor", "StealthBrowserError"} <= exports_of(t)
    fix = len(re.findall(r"""['"`][^'"`\n]*\b(install|set|use|run|upgrade|start|free|choose|launch|update|retry|check|increase|pass)\b[^'"`\n]*['"`]""", t, re.I))
    return cls and api and not miss and fix >= len(all_codes()), f"class={cls} api={api} missing={miss} remediation strings={fix}"


@check("prod-errors", 2)
def _pe2():
    """(PA5.4, widened) src/test/unit/errors/ has a unit test PER CODE: each code of the registry (all 33 codes) is asserted (`code` and a remediation message; CaptureError and LifecycleError instances are `instanceof StealthBrowserError`) and each of the 14 library codes is reached through the real library path (`rejects.toMatchObject({ code: '<CODE>' })` or `.code).toBe('<CODE>')` against the in-process fake server/stubs), citing ticket 8468f7b1, a valid prod-errors.N id and PA5.1 / PA5.4."""
    specs = spec_files("unit/errors")
    t = "\n".join(read(f) for f in specs)
    miss = [c for c in all_codes() if t.count(c) < 1]
    reach = [c for c in ERR_CODE_LIB if not re.search(rf"toMatchObject\(\s*\{{[^}}]*code:\s*['\"]{c}['\"]|\.code\)\.toBe\(\s*['\"]{c}['\"]", t)]
    ids = set(re.findall(r"\[(prod-errors\.\d+)\]", t))
    return bool(specs) and not miss and not reach and t.count("message") >= len(all_codes()) and TICKET in t and bool(ids & criteria_ids()) and "PA5.1" in t and "PA5.4" in t, f"specs={len(specs)} missing={miss} not reached through the library={reach}"


@check("prod-errors", 3)
def _pe3():
    """Only owned paths changed by [psm:prod-errors] commits (errors.ts, src/index.ts, the lib files whose throw sites it types, the host wiring files and the error specs); errors.ts reads no process.env; the existing unit lane still passes (`nx run stealth-browser:test` exits 0, messages preserved)."""
    o = ownership_ok("prod-errors")
    rc, out = sh([NX, "run", f"{proj_name()}:test"], timeout=2400)
    return o[0] and rc == 0 and "process.env" not in read(f"{P}/src/errors.ts") and exists(f"{P}/src/errors.ts"), f"{o[1]} test rc={rc} {out[-120:]}"


@check("prod-errors", 4)
def _pe4():
    """(PA5.2, PA5.3, PA5.5, widened) the CLI and the MCP host map EVERY code consistently: bin/cli.ts and bin/mcp.ts preflight Node >= 22.5 (NODE_TOO_OLD, one-line message); src/cli.ts exits through `exitCodeFor(error.code)` printing `<CODE>: <message>` on stderr with no stack trace; src/server.ts returns `isError: true` with the code and message in the content for any StealthBrowserError; against a dead port the built CLI exits non-zero (the CHROME_NOT_RUNNING exit code) and the built MCP returns isError with CHROME_NOT_RUNNING."""
    pre = all(re.search(r"22[.,\s]+5", read(f"{P}/bin/{f}")) for f in ("cli.ts", "mcp.ts"))
    wired = "exitCodeFor" in read(f"{P}/src/cli.ts") and "StealthBrowserError" in read(f"{P}/src/server.ts") and re.search(r"isError", read(f"{P}/src/server.ts")) is not None
    if not ensure_bin():
        return False, "build-bin failed"
    rc, o, e = cli_verb("listPageTargets", ["--port", HOST_PORT_DEAD])
    cli_ok = rc not in (0, None) and "CHROME_NOT_RUNNING" in (o + e) and not re.search(r"\n\s+at\s+\S+.*[:(]\d+", e)
    r = mcp_full([], [("listPageTargets", {"port": int(HOST_PORT_DEAD)})])
    res = ((r["calls"] or [{}])[0].get("result") or {})
    mcp_ok = res.get("isError") is True and "CHROME_NOT_RUNNING" in json.dumps(res.get("content"))
    return pre and wired and cli_ok and mcp_ok, f"preflight={pre} wired={wired} cli(rc={rc})={cli_ok} mcp={mcp_ok}"


@check("prod-errors", 5)
def _pe5():
    """(audit criterion) No untyped error escapes: no `new Error(`, `new TypeError(`, `Promise.reject('...')` or `throw '...'` exists in non-test src/ or bin/ outside src/errors.ts (every throw site raises a StealthBrowserError code)."""
    hits = untyped_throws()
    return not hits, f"untyped error sites: {hits[:8]}"


@check("prod-errors", 6)
def _pe6():
    """docs/ERRORS.md lists every code with its CLI exit code, its MCP isError code and its remediation, in the order of `ERROR_CODES`, and the root of the package exports StealthBrowserError, ERROR_CODES and exitCodeFor (src/index.ts re-exports ./errors.js)."""
    d = read(f"{P}/docs/ERRORS.md")
    miss = [c for c in ERR_CODES if c not in d]
    idx = read(f"{P}/src/index.ts")
    return exists(f"{P}/docs/ERRORS.md") and not miss and re.search(r"export\s+\*\s+from\s+['\"]\./errors\.js['\"]", idx) is not None, f"undocumented={miss}"



@check("prod-errors", 7)
def _pe7():
    """(amendment A3, greenfield root) src/index.ts exports the `recording` and `lifecycle` namespaces (`export * as recording from './lib/recording/index.js'`, `export * as lifecycle from './lib/lifecycle/index.js'`); `recording` exposes NetworkRecorder, CaptureError, MemoryRecordingSink, StoreRecordingSink, openStoreRecordingSink and redactHeaders, `capture` exposes captureAllNetworkResponses, `lifecycle` exposes LifecycleError, openIsolatedPage, withIsolatedPage, installProcessExitHooks, FilePresenceStore, ServiceProxyReaperLauncher and runChromeReaper (the detached reaper loads it through the package entry)."""
    ns = dict(NS_RE.findall(read(f"{P}/src/index.ts")))
    wired = all(ns.get(a) and re.sub(r"\.js$", "", ns[a]) == "./" + AREAS_EXTRA[a] for a in AREAS_EXTRA)
    want = {"recording": {"NetworkRecorder", "CaptureError", "MemoryRecordingSink", "StoreRecordingSink", "openStoreRecordingSink", "redactHeaders"}, "capture": {"captureAllNetworkResponses"}, "lifecycle": {"LifecycleError", "openIsolatedPage", "withIsolatedPage", "installProcessExitHooks", "FilePresenceStore", "ServiceProxyReaperLauncher", "runChromeReaper"}}
    miss = {a: sorted(w - barrel_names_of(f"{P}/src/{AREAS_ALL[a]}.ts") - barrel_names_of(f"{P}/src/{AREAS_ALL[a]}/index.ts")) for a, w in want.items()}
    miss = {a: m for a, m in miss.items() if m}
    return wired and not miss, f"wired={wired} missing members {miss}"


@check("prod-errors", 8)
def _pe8():
    """(amendment A4) CaptureError (src/lib/recording/errors.ts) and LifecycleError (src/lib/lifecycle/errors.ts) extend StealthBrowserError, so one `instanceof` covers every package error; `exitCodeFor` and docs/ERRORS.md cover every code; a classifier maps a launch failure whose cause is ENOENT to CHROME_NOT_FOUND and EADDRINUSE to PORT_IN_USE (unit-tested)."""
    cap, life = read(f"{P}/src/lib/recording/errors.ts"), read(f"{P}/src/lib/lifecycle/errors.ts")
    ext = re.search(r"class\s+CaptureError\s+extends\s+StealthBrowserError", cap) is not None and re.search(r"class\s+LifecycleError\s+extends\s+StealthBrowserError", life) is not None
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
    """(PA7.1, widened) examples/ holds one runnable TypeScript example per public verb (examples/verbs/<verb>.ts for the six verbs) and per root namespace (examples/namespaces/<namespace>.ts for cdp, storage, capture, parsers, chromeManager, recording, lifecycle), plus examples/cli.md and examples/mcp-config.json, all non-empty; each .ts example opens with a `Scenario:` header naming the real user task it solves and exports `run(options)`."""
    miss = [f for f in EX_VERB_FILES + EX_NS_FILES + ["cli.md", "mcp-config.json"] if not read(f"{EX}/{f}").strip()]
    headless = [f for f in EX_VERB_FILES + EX_NS_FILES if exists(f"{EX}/{f}") and not (re.search(r"Scenario:\s*\S{12,}", read(f"{EX}/{f}")) and re.search(r"export\s+(?:async\s+)?function\s+run\b|export\s+const\s+run\b", read(f"{EX}/{f}")))]
    return not miss and not headless, f"missing/empty {miss}; without Scenario header or run(): {headless}"


@check("prod-examples", 2)
def _pex2():
    """(PA7.2) tsconfig.spec.json includes examples/, every .ts example imports the package ROOT only (`@adhd/stealth-browser` or `../../src/index.js`, never a subpath or a src/lib path), and `nx run stealth-browser:typecheck-spec` exits 0."""
    inc = "examples" in read(f"{P}/tsconfig.spec.json")
    bad = []
    for f in EX_VERB_FILES + EX_NS_FILES:
        t = read(f"{EX}/{f}")
        mods = re.findall(r"from\s+['\"]([^'\"]+)['\"]", t)
        if not mods or any(m not in ("@adhd/stealth-browser", "../../src/index.js") and not m.startswith("node:") for m in mods):
            bad.append(f)
    rc, out = sh([NX, "run", f"{proj_name()}:typecheck-spec"], timeout=1500) if inc and not bad else (1, "")
    return inc and not bad and rc == 0, f"included={inc} bad imports={bad} rc={rc} {out[-150:]}"


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
    """(PA7.4) Every example (all .ts, cli.md, mcp-config.json) uses an explicit non-9222 port and never the default 9222."""
    bad = []
    for f in EX_VERB_FILES + EX_NS_FILES + ["cli.md", "mcp-config.json"]:
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
    """The examples are exercised, not just typechecked: a spec under src/test/unit/examples/ imports every examples/verbs and examples/namespaces file and runs its `run()` against the in-process fake CDP server (no live Chrome), citing ticket 8468f7b1, a valid prod-examples.N id and PA7.3 / PA7.4."""
    specs = spec_files("unit/examples")
    t = "\n".join(read(f) for f in specs)
    unused = [f for f in EX_VERB_FILES + EX_NS_FILES if os.path.splitext(f)[0] not in t]
    ids = set(re.findall(r"\[(prod-examples\.\d+)\]", t))
    return bool(specs) and not unused and "run(" in t and TICKET in t and bool(ids & criteria_ids()) and all(k in t for k in ("PA7.3", "PA7.4")), f"specs={len(specs)} examples not exercised={unused}"


# ============================================================ tests-use-cases (replaces the e2e lane)
UC = f"{P}/src/test/use-cases"
SUP = f"{P}/src/test/support"
UC_SPEC = f"{P}/src/test/use-cases"


def uc_specs():
    return [f for f in walk(UC, (".ts",)) if f.endswith(".spec.ts")]


@check("tests-use-cases", 1)
def _uc1():
    """The scenario fixtures exist under src/test/support/: real-shape profile databases (profile-fixtures.ts builds History, Cookies and Bookmarks SQLite files through a builder, no hand-written rows in the specs) and realistic HTML plus network-trace fixtures (page-fixtures.ts); the suites reuse the cdp-test-harness (FakeCdpServer, loadFixture, FakeProc) and add no loopback socket (no node:net, node:http or ws)."""
    need = ("profile-fixtures.ts", "page-fixtures.ts")
    miss = [f for f in need if len(read(f"{SUP}/{f}").strip()) < 200]
    t = "\n".join(read(f) for f in uc_specs())
    reuse = all(k in t for k in ("FakeCdpServer", "loadFixture")) and "fake-proc" in t
    net = re.search(r"node:net|node:http|from ['\"]ws['\"]", t + read(f"{SUP}/profile-fixtures.ts") + read(f"{SUP}/page-fixtures.ts"))
    return not miss and reuse and not net, f"missing/short {miss} reuses harness={reuse} loopback={bool(net)}"


@check("tests-use-cases", 2)
def _uc2():
    """At least 12 use-case specs under src/test/use-cases/, named after user scenarios (not modules: e.g. `recover-a-crashed-chrome.spec.ts`), each `describe` opening with `Scenario:` plus the user goal; together they cover all six verbs, all seven root namespaces and both hosts (the CLI and the MCP stdio server driven in-process), each citing ticket 8468f7b1, a valid tests-use-cases.N id and the AC ids they exercise."""
    specs = uc_specs()
    t = "\n".join(read(f) for f in specs)
    modlike = [os.path.basename(f) for f in specs if re.fullmatch(r"(cdp|storage|capture|parsers|chrome-manager|api|index|session|helpers|types)\.spec\.ts", os.path.basename(f))]
    nodesc = [os.path.basename(f) for f in specs if not re.search(r"describe\(\s*['\"`]Scenario:", read(f))]
    verbs = [v for v in VERBS if v not in t]
    areas = [a for a in AREAS_ALL if not re.search(rf"\b{a}\.", t)]
    hosts = [h for h in ("server", "cli") if not re.search(rf"\b{h}\b", t)]
    uncited = [os.path.basename(f) for f in specs if TICKET not in read(f) or not (set(re.findall(r"\[(tests-use-cases\.\d+)\]", read(f))) & criteria_ids())]
    return len(specs) >= 12 and not modlike and not nodesc and not verbs and not areas and not hosts and not uncited, f"specs={len(specs)} module-named={modlike} no Scenario describe={nodesc} verbs={verbs} namespaces={areas} hosts={hosts} uncited={uncited}"


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
    """The examples are consumed: the suites import and `run()` every examples/verbs and examples/namespaces file (prod-examples), and the typed errors are reached through user scenarios (>= 6 distinct StealthBrowserError codes asserted across the suites)."""
    t = "\n".join(read(f) for f in uc_specs())
    unused = [f for f in EX_VERB_FILES + EX_NS_FILES if os.path.splitext(f)[0] not in t]
    codes = [c for c in all_codes() if re.search(rf"['\"]{c}['\"]", t)]
    return not unused and len(codes) >= 6, f"examples not run={unused} codes asserted={len(codes)}"


@check("tests-use-cases", 5)
def _uc5():
    """`nx run stealth-browser:test -- src/test/use-cases` exits 0 in under 120 seconds wall clock and leaves no listener behind on the ports it used."""
    t0 = time.time()
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", "src/test/use-cases"], timeout=1800)
    return rc == 0 and time.time() - t0 < 120 + 60, f"rc={rc} {time.time() - t0:.0f}s {out[-150:]}"


@check("tests-use-cases", 6)
def _uc6():
    """Only owned paths changed by [psm:tests-use-cases] commits (src/test/use-cases/**, src/test/support/**); no production file is edited to make a simulation pass."""
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
    """evidence/cutover-live-vs-recorded.md states precisely what is LIVE and what is only RECORDED: lines `LIVE:` (node_modules content = the tarball, with its sha256), `RECORDED:` (the committed agent-browser/package.json dependency range, which resolves only once released) and `NOT-CHANGED:` naming pnpm-lock.yaml in agent-browser and the adhd main checkout's pnpm-lock.yaml; agent-browser/package.json carries no `link:`/`file:` value and no .worktrees path, and the adhd main checkout lockfile is unmodified."""
    t = read(CUT_LIVE)
    pj = json.dumps(jread(f"{SRC}/package.json", {}) or {})
    dep = ((jread(f"{SRC}/package.json", {}) or {}).get("dependencies") or {}).get("@adhd/stealth-browser", "")
    stated = all(re.search(rf"^{k}:\s*\S", t, re.M) for k in ("LIVE", "RECORDED", "NOT-CHANGED")) and "pnpm-lock.yaml" in t
    tg_sha = jread(CUT_EVID, {}).get("sha256", "x")
    clean = not re.search(r"link:|file:|\.worktrees", dep) and bool(dep) and ".worktrees" not in pj
    main_lock = git("status", "--porcelain", "--", "pnpm-lock.yaml", cwd=MAIN) == ""
    return stated and tg_sha in t and clean and main_lock, f"stated={stated} sha cited={tg_sha in t} dep={dep!r} main lock clean={main_lock}"


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


# ============================================================ cdp-test-harness (spec 4) / capture-upgrade (spec 5) / chrome-lifecycle (spec 6)
FIXTURE_NAMES = ["doc-200", "search-404", "rate-limit-429", "redirect-301-200", "extrainfo-before-main", "extrainfo-after-main", "cached-304", "cors-failure",
                 "post-json-api", "binary-base64", "no-body-204", "two-tabs-parallel", "isolated-context-ok", "isolated-context-target-missing"]
BAN_WORDS = r"node:net|node:http|child_process|from ['\"]ws['\"]"


def ac_spec(sub, fname, cid, must=(), anywhere=False):
    """(ok, why) for one acceptance spec: the file exists, cites ticket 8468f7b1 and its [state.N] id (the CU/CL/HC number is in the text) and contains every `must` token."""
    p = f"{P}/src/test/{sub}/{fname}"
    t = read(p)
    miss = [m for m in must if m not in t]
    return bool(t.strip()) and TICKET in t and f"[{cid}]" in t and not miss, f"{sub}/{fname}: exists={bool(t.strip())} cites ticket={TICKET in t} id={f'[{cid}]' in t} missing tokens={miss}"


def lib_text(sub):
    return "\n".join(read(f) for f in walk(f"{P}/src/lib/{sub}", (".ts",)))


def run_unit(sub):
    rc, out = sh([NX, "run", f"{proj_name()}:test", "--", f"src/test/unit/{sub}"], timeout=1800)
    return rc == 0, f"unit/{sub} rc={rc} {out[-150:]}"


@check("cdp-test-harness", 1)
def _h1():
    """The in-memory CDP harness exists: src/test/support/fake-cdp.ts exports FakeCdpServer (install, received, unexpected, emitNow, closeFromServer, openCount), loadFixture and the CdpFixture / CdpFixtureStep types, and src/test/fixtures/cdp/ holds the 14 `<name>.cdp.json` fixtures (doc-200, search-404, rate-limit-429, redirect-301-200, extrainfo-before-main, extrainfo-after-main, cached-304, cors-failure, post-json-api, binary-base64, no-body-204, two-tabs-parallel, isolated-context-ok, isolated-context-target-missing), each valid JSON with `meta.name`, `meta.origin` (`recorded` or `synthetic-protocol-conformant`) and a `steps` array."""
    t = read(f"{P}/src/test/support/fake-cdp.ts")
    ex = exports_of(t)
    api = {"FakeCdpServer", "loadFixture"} <= ex and {"CdpFixture", "CdpFixtureStep"} <= ex and all(m in t for m in ("install", "received", "unexpected", "emitNow", "closeFromServer", "openCount"))
    bad = []
    for n in FIXTURE_NAMES:
        d = jread(f"{P}/src/test/fixtures/cdp/{n}.cdp.json", None)
        if not (isinstance(d, dict) and (d.get("meta") or {}).get("name") == n and (d.get("meta") or {}).get("origin") in ("recorded", "synthetic-protocol-conformant") and isinstance(d.get("steps"), list) and d["steps"]):
            bad.append(n)
    return api and not bad, f"api={api} bad fixtures={bad}"


@check("cdp-test-harness", 2)
def _h2():
    """The harness is pure (unit purity): no `node:net`, `node:http`, `child_process` or `ws` import anywhere under src/test/support (the loopback-socket variant belongs to a later e2e follow-up, not this lane)."""
    hits = [os.path.relpath(f, P) for f in walk(f"{P}/src/test/support", (".ts",)) if re.search(BAN_WORDS, read(f))]
    return not hits and exists(f"{P}/src/test/support/fake-cdp.ts"), f"impure support files {hits}"


@check("cdp-test-harness", 3)
def _h3():
    """src/test/unit/support/fake-cdp.spec.ts covers HC1 id correlation, HC2 strict unknown command (CDP error -32601, listed in `.unexpected`), HC3 fake-timer ordering of `delayMs` events, HC4 the Network-domain field-name allow-list over every fixture, HC5 `closeFromServer` firing `close`; it cites ticket 8468f7b1 and a valid cdp-test-harness.N id, and `nx run stealth-browser:test` exits 0."""
    ok, why = ac_spec("unit/support", "fake-cdp.spec.ts", "cdp-test-harness.3", ("HC1", "HC2", "HC3", "HC4", "HC5", "-32601"))
    rc, out = sh([NX, "run", f"{proj_name()}:test"], timeout=2400)
    return ok and rc == 0, f"{why} test rc={rc}"


@check("cdp-test-harness", 4)
def _h4():
    """Only owned paths changed by [psm:cdp-test-harness] commits (src/test/support/, src/test/fixtures/cdp/, src/test/unit/support/)."""
    return ownership_ok("cdp-test-harness")


@check("cdp-test-harness", 5)
def _h5():
    """src/test/support/mem-fs.ts exports an in-memory FsLike (MemFs) with exclusive create (`wx` fails on an existing file), atomic rename, readdir, mode and uid; src/test/unit/support/mem-fs.spec.ts proves exclusive-create failure and rename atomicity and cites 8468f7b1 and [cdp-test-harness.5]."""
    t = read(f"{P}/src/test/support/mem-fs.ts")
    ok = "MemFs" in exports_of(t) and all(k in t for k in ("rename", "readdir", "mode", "uid")) and re.search(r"wx|exclusive|EEXIST", t) is not None
    s_ok, why = ac_spec("unit/support", "mem-fs.spec.ts", "cdp-test-harness.5", ("rename",))
    return ok and s_ok and re.search(r"EEXIST|exclusive", read(f"{P}/src/test/unit/support/mem-fs.spec.ts")) is not None, f"mem-fs={ok} {why}"


@check("cdp-test-harness", 6)
def _h6():
    """src/test/support/fake-proc.ts exports FakeProc with `pidAlive`, `procStart`, `kill(pid|-pgid, signal)` (logged) and a recording `spawn`; src/test/unit/support/fake-proc.spec.ts covers each and cites 8468f7b1 and [cdp-test-harness.6]."""
    t = read(f"{P}/src/test/support/fake-proc.ts")
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
    """CU13 hygiene: only owned paths changed by [psm:capture-upgrade] commits (src/lib/recording/, capture/network.ts, capture/index.ts, src/test/unit/capture/, capture-parsers/network.spec.ts), `node:sqlite` and `process.env` never appear in src/lib/recording, the only top-level reference to @adhd/sox-store-adapter in src/lib/recording is `import type` (no value import and no require), and `nx run stealth-browser:test -- src/test/unit/capture` exits 0."""
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
    """CU27 module-format guard (ADR-0003): src/test/unit/capture/build-format.spec.ts asserts on the source text that src/lib/recording references @adhd/sox-store-adapter at top level only through `import type` and has exactly one dynamic `import('@adhd/sox-store-adapter')` call site (inside the `loadAdapter` default); the guard re-checks both facts on src/lib/recording, requires `@adhd/sox-store-adapter` in package.json `dependencies` and `externalizeRealDeps(__dirname)` in vite.config.ts (owned by port-fixes), and when dist/index.js exists it contains no `require('@adhd/sox-store-adapter')`."""
    r = lib_text("recording")
    dyn = re.findall(r"import\(\s*['\"]@adhd/sox-store-adapter['\"]\s*\)", r)
    top = [m for m in re.findall(r"^\s*import\s+[^;]*from\s*['\"]@adhd/sox-store-adapter['\"]", r, re.M) if not re.match(r"\s*import\s+type\b", m)]
    pkg = jread(f"{P}/package.json", {}) or {}
    dist = read(f"{P}/dist/index.js")
    dist_ok = "require('@adhd/sox-store-adapter')" not in dist and 'require("@adhd/sox-store-adapter")' not in dist
    ok, why = ac_spec("unit/capture", "build-format.spec.ts", "capture-upgrade.27", ("import type", "import("))
    return len(dyn) == 1 and not top and SINK_PKG in (pkg.get("dependencies") or {}) and "externalizeRealDeps(__dirname)" in read(f"{P}/vite.config.ts") and dist_ok and ok, f"dynamic sites={len(dyn)} value imports={top} {why}"


# ---------------------------------------------------------------- chrome-lifecycle (EVAL-service-proxy.md, option C with the proxy launcher)
PROXY_PKG = "@adhd/sox-service-proxy"


def _cl_spec(num, fname, doc, must, sub="unit/lifecycle"):
    def fn():
        return ac_spec(sub, fname, f"chrome-lifecycle.{num}", must)
    fn.__doc__ = doc
    check("chrome-lifecycle", num)(fn)


_cl_spec(1, "concurrent-launch.spec.ts", "CL1 (F1 F2 F4) race-free launch: concurrent-launch.spec.ts runs 8 managers over one MemFs and proves exactly one spawn, the default host 127.0.0.1:9222, a CDP that never becomes ready within 10 s giving CHROME_UNREACHABLE_AFTER_LAUNCH, a loser waiting bounded for the winner, and a launch lock older than 15 s being reclaimed.", ("toHaveBeenCalledTimes(1)", "CHROME_UNREACHABLE_AFTER_LAUNCH", "9222"))
_cl_spec(2, "relaunch.spec.ts", "CL2 (F3 F17) self-heal and reset: relaunch.spec.ts proves that after another process kills the shared Chrome the next `ready()` relaunches, and that after a real shutdown a later `ready()` relaunches and a fresh idle timer fires again.", ("ready()", "shutdown"))
_cl_spec(3, "hide-windows.spec.ts", "CL3 (F5) a fresh launch hides windows and the fast path does not re-hide (a window revealed for a human stays visible); hide-windows.spec.ts proves both.", ("hideAllWindows",))
_cl_spec(4, "idle-timer.spec.ts", "CL4 (F6 F7) activity-bumped idle timer: idle-timer.spec.ts proves `bump()` re-arms (no fire at 299 ms, fire at 300 ms), the timer re-arms after it fired, `withBrowser` bumps when `fn` throws, and timers are unref'd.", ("299", "300", "unref", "withBrowser"))
_cl_spec(5, "cross-process.spec.ts", "CL5 (F8) cross-process coordination: cross-process.spec.ts proves process A defers when process B bumped within the idle window, reaps when B stayed silent past it, and ignores B when B is dead or its pid was reused (start-time token mismatch).", ("procStart", "bump"))
_cl_spec(6, "no-livelock.spec.ts", "CL6 (F9) livelock protection: no-livelock.spec.ts proves two idle managers with zero http pages and history off never write presence while deferring (`bump()` is the only writer of `lastActivityAt`) and Chrome is reaped within idle plus grace.", ("lastActivityAt", "bump"))
_cl_spec(7, "page-tier.spec.ts", "CL7 (F10 F11 F12) page tier: page-tier.spec.ts proves an open http and an open https page pin Chrome, `chrome://newtab/`, `about:blank`, `devtools://` and `chrome-untrusted://` targets do not, and an unreachable CDP during the check proceeds.", ("chrome://newtab/", "about:blank", "devtools://", "chrome-untrusted://"))
_cl_spec(8, "history-tier.spec.ts", "CL8 (F13) history-recency tier: history-tier.spec.ts proves a visit within 2 minutes pins Chrome, `checkHistory: false` ignores history, a history database error proceeds, the default is on, and the tier is on when ANY live process enables it.", ("checkHistory",))
_cl_spec(9, "shutdown-modes.spec.ts", "CL9 (F14 F15) shutdown modes: shutdown-modes.spec.ts proves `shutdown()` ignores every tier and `shutdownIfIdle()` defers to a sibling, to a page and to history.", ("shutdownIfIdle", "shutdown("))
_cl_spec(10, "ordered-shutdown.spec.ts", "CL10 (F16) ordered shutdown: ordered-shutdown.spec.ts proves all page targets are closed (allSettled) before Chrome is killed and that a failing close or kill is logged and the rest still runs.", ("logger",))
_cl_spec(11, "group-kill.spec.ts", "CL11 (F18) group kill: group-kill.spec.ts proves SIGTERM to the process group, a bounded wait, then SIGKILL to the group, with a fallback to the single pid when the group signal fails (FakeProc log).", ("SIGTERM", "SIGKILL"))
_cl_spec(12, "reaper-scope.spec.ts", "CL12 (F19) reaper scope: reaper-scope.spec.ts proves scope `port-occupant` (default) signals the port occupant (lsof, then fuser, with its pgid) when no owner is recorded and only the matching pid and start-time when an owner record exists, and scope `launched-only` never signals an unrecorded process.", ("port-occupant", "launched-only", "lsof", "fuser", "procStart"))


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
    """CL14 (F23, gap G2) exit hooks: src/lib/lifecycle/exit-hooks.ts exports `installProcessExitHooks(manager, { forceExitMs = 5000, stdinEof, exit })` returning an uninstall function; exit-hooks.spec.ts proves each of exit, SIGINT, SIGTERM, uncaughtException, unhandledRejection and (opt-in) stdin end runs `release()` then the soft shutdown once, force-exits after 5000 ms, uses codes 130, 143 and 1, and uninstall removes the listeners (wiring into the hosts is surface-hosts.14)."""
    e = read(f"{P}/src/lib/lifecycle/exit-hooks.ts")
    ok, why = ac_spec("unit/lifecycle", "exit-hooks.spec.ts", "chrome-lifecycle.14", ("SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection", "stdin", "130", "143", "5000"))
    return "installProcessExitHooks" in exports_of(e) and ok, why


@check("chrome-lifecycle", 15)
def _cl15():
    """CL15 (F24 N1 N5, gap G4) out-of-process reaper through the proxy launcher: src/lib/lifecycle/proxy-launcher.ts exports ServiceProxyReaperLauncher implementing `ReaperLauncher` (`ensure(cfg)` giving 'started' | 'already-running' | 'unavailable') over `ensureBackend` from @adhd/sox-service-proxy (imported statically, no dynamic import); reaper.spec.ts, with `vi.mock('@adhd/sox-service-proxy')`, proves the dispositions spawned, already-live and adopted-after-wait map to started or already-running and `failed` (including E_UDS_DIR_UNSAFE) maps to unavailable, a launcher giving unavailable leaves `ready()` successful with `status().reaper === false` and the in-process timers still apply, a reaper tick with all clients gone (kill -9: never released) reaps within TTL plus grace signalling only the recorded pid and start-time (none when the record is missing or mismatched), and the bound 'the next ready() of any process adopts or reaps' is tested as a rule; the child entry is `runChromeReaper(cfg)` in src/lib/lifecycle/reaper-entry.ts (it calls `serveBackend` with a ping handler, then `runReaper` from reaper.ts, which uses the same `decideReap` as the in-process path: one policy)."""
    p = read(f"{P}/src/lib/lifecycle/proxy-launcher.ts")
    r = read(f"{P}/src/lib/lifecycle/reaper.ts")
    re_ = read(f"{P}/src/lib/lifecycle/reaper-entry.ts")
    ok, why = ac_spec("unit/lifecycle", "reaper.spec.ts", "chrome-lifecycle.15", ("vi.mock('@adhd/sox-service-proxy'", "ensureBackend", "spawned", "already-live", "adopted-after-wait", "E_UDS_DIR_UNSAFE", "REAPER_UNAVAILABLE"))
    return ("ServiceProxyReaperLauncher" in exports_of(p) and "ensureBackend" in p and re.search(r"from\s*['\"]@adhd/sox-service-proxy['\"]", p) is not None
            and "runChromeReaper" in exports_of(re_) and "serveBackend" in re_ and "runReaper" in exports_of(r) and "decideReap" in r and ok), why


@check("chrome-lifecycle", 16)
def _cl16():
    """CL16 (N3, gap G4) presence: src/lib/lifecycle/presence.ts exports the `PresenceStore` / `PresenceHandle` interfaces and `FilePresenceStore` (one record file per process, atomic write, directory mode 0700 and own uid else PRESENCE_DIR_INSECURE, no file shared between processes, an unparsable file counts as dead); presence-eviction.spec.ts proves `list()` evicts dead, pid-reused (start-time mismatch) and TTL-expired records, `sweep()` returns the evicted, and a beating process survives."""
    p = read(f"{P}/src/lib/lifecycle/presence.ts")
    ok, why = ac_spec("unit/lifecycle", "presence-eviction.spec.ts", "chrome-lifecycle.16", ("procStart", "sweep", "PRESENCE_DIR_INSECURE"))
    return {"FilePresenceStore"} <= exports_of(p) and "PresenceStore" in p and ok, why


@check("chrome-lifecycle", 17)
def _cl17():
    """CL17 (N4) launch circuit breaker: src/lib/lifecycle/launch-breaker.ts exports LaunchBreaker (file-backed, atomic rename; opens after 3 failures in 60 s and stays open 30 s); launch-breaker.spec.ts proves the 4th `ready()` throws LAUNCH_CIRCUIT_OPEN with `retryAfterMs` and no spawn, the breaker closes after the cool-off, success resets it and the state is shared across managers."""
    b = read(f"{P}/src/lib/lifecycle/launch-breaker.ts")
    ok, why = ac_spec("unit/lifecycle", "launch-breaker.spec.ts", "chrome-lifecycle.17", ("LAUNCH_CIRCUIT_OPEN", "retryAfterMs"))
    return "LaunchBreaker" in exports_of(b) and ok, why


_cl_spec(18, "sibling-warning.spec.ts", "CL18 (F25) sibling diagnostic: sibling-warning.spec.ts proves `status().siblingWarning` is true at the threshold of live sibling records and that the diagnostic never kills anything.", ("siblingWarning", "status"))
_cl_spec(19, "grace-exit.spec.ts", "CL19 (N2 N6) shared Chrome and grace: grace-exit.spec.ts proves N managers share one Chrome and that after the last `release()` Chrome exits within `shutdownGraceMs` (fake clock).", ("release", "shutdownGraceMs"))


@check("chrome-lifecycle", 20)
def _cl20():
    """CL20 typed lifecycle errors: src/lib/lifecycle/errors.ts exports LifecycleError with exactly the seven codes LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, PRESENCE_DIR_INSECURE, REAPER_UNAVAILABLE and ISOLATED_CONTEXT_FAILED; errors.spec.ts reaches each with `cause` or `detail` (`retryAfterMs`, `port`, `path`) and a one-line message naming the fix."""
    e = read(f"{P}/src/lib/lifecycle/errors.ts")
    ok, why = ac_spec("unit/lifecycle", "errors.spec.ts", "chrome-lifecycle.20", tuple(LIFECYCLE_CODES))
    return "LifecycleError" in exports_of(e) and all(c in e for c in LIFECYCLE_CODES) and ok, why


_cl_spec(21, "best-effort.spec.ts", "CL21 (F26) best-effort I/O: best-effort.spec.ts proves presence and ownership write failures never fail a call.", ("release",))


@check("chrome-lifecycle", 22)
def _cl22():
    """CL22 seam contract: src/test/unit/lifecycle/presence-contract.ts exports a contract suite that presence-contract.spec.ts runs against `FilePresenceStore`; `PresenceStore` and `ReaperLauncher` are the only two seams, and only `proxy-launcher.ts` and `reaper-entry.ts` (the detached child's entry) import `@adhd/sox-service-proxy` (decideReap, the tiers, the breaker, the isolated pages, the exit hooks and the manager never import the proxy package or a concrete store), so a proxy-backed presence store later passes the same suite and needs no change to the policy engine; a fake `ReaperLauncher` is substitutable in the manager tests."""
    c = read(f"{P}/src/test/unit/lifecycle/presence-contract.ts")
    ok, why = ac_spec("unit/lifecycle", "presence-contract.spec.ts", "chrome-lifecycle.22", ("FilePresenceStore", "presence-contract"))
    allowed = {"proxy-launcher.ts", "reaper-entry.ts"}
    leak = [os.path.basename(f) for f in walk(f"{P}/src/lib/lifecycle", (".ts",)) if os.path.basename(f) not in allowed and PROXY_PKG in read(f)] + [os.path.relpath(f, f"{P}/src/lib") for f in walk(f"{P}/src/lib", (".ts",)) if "/lifecycle/" not in f and PROXY_PKG in read(f)]
    return bool(c.strip()) and ok and not leak and PROXY_PKG in read(f"{P}/src/lib/lifecycle/proxy-launcher.ts"), f"{why} proxy imported outside the launcher and the reaper entry: {leak}"


@check("chrome-lifecycle", 23)
def _cl23():
    """CL23 hygiene: `process.env` never appears in src/lib/lifecycle (no env toggles, ADR-0013), no spec under src/test/unit/lifecycle opens a socket or spawns a process (no unmocked node:net, node:http or child_process), only owned paths changed by [psm:chrome-lifecycle] commits, and `nx run stealth-browser:test -- src/test/unit/lifecycle` exits 0 without touching a real port 9222."""
    o = ownership_ok("chrome-lifecycle")
    specs = [f for f in walk(f"{P}/src/test/unit/lifecycle", (".ts",)) if re.search(r"from ['\"]node:(net|http)['\"]", read(f))]
    ok, why = run_unit("lifecycle")
    return o[0] and "process.env" not in lib_text("lifecycle") and not specs and ok, f"{o[1]} socket specs={specs} {why}"


@check("chrome-lifecycle", 24)
def _cl24():
    """CL24 transitional safety (removable at cutover): src/lib/lifecycle/legacy-heartbeat.ts is a READ-ONLY reader (no write call) of the old agent-browser heartbeat file, enabled only by the explicit `legacyHeartbeatPath` constructor option, feeding live old servers into the same `others` input of `decideReap`; legacy-heartbeat.spec.ts proves an old server with a fresh `pid:ts` entry defers a reap, a stale or dead one does not, and with the option unset nothing is read."""
    t = read(f"{P}/src/lib/lifecycle/legacy-heartbeat.ts")
    ok, why = ac_spec("unit/lifecycle", "legacy-heartbeat.spec.ts", "chrome-lifecycle.24", ("legacyHeartbeatPath",))
    return bool(t.strip()) and not re.search(r"writeFile|appendFile|rename\(|\.write\(", t) and ok, why


@check("chrome-lifecycle", 25)
def _cl25():
    """CL25 (gap G3) docs/plan/stealth-browser/evidence/lifecycle-definitions.md states that backlog items B-036..B-039 have no definition in the source tree (commit cffee3c carries only a title), then defines each of B-036, B-037, B-038 and B-039 as a lifecycle requirement derived from the features F1-F26 and requirements N1-N7 of EVAL-service-proxy.md, naming for each the chrome-lifecycle criterion id that pins it."""
    d = read(f"{PLAN}/evidence/lifecycle-definitions.md")
    return all(re.search(rf"B-0{n}\b", d) for n in (36, 37, 38, 39)) and "cffee3c" in d and len(re.findall(r"chrome-lifecycle\.\d+", d)) >= 4, f"{len(d)} bytes"


@check("chrome-lifecycle", 26)
def _cl26():
    """CL26 public shape of the manager: `ChromeManagerOptions` has `cdpHost`, `idleTimeoutMs` (default 120000), `checkHistory` (default true), `shutdownGraceMs` (default 30000), `leaseDir`, `leaseTtlMs` (default 30000), `reaperScope` ('launched-only' | 'port-occupant', default 'port-occupant'), `reaper` ('detached' | 'in-process-only', default 'detached'), `presence`, `launcher`, `legacyHeartbeatPath` and `logger`; the methods `ready`, `bump`, `shutdown`, `shutdownIfIdle`, `withBrowser`, `isReady` stay and `release()` and `status()` (`ChromeStatus`: ready, owned, processes, activeProcesses, httpPages, reaper, breaker, siblingWarning) are new; no heartbeat file is written by the manager."""
    c = read(f"{P}/src/lib/chrome-manager.ts")
    need = ["cdpHost", "idleTimeoutMs", "checkHistory", "shutdownGraceMs", "leaseDir", "leaseTtlMs", "reaperScope", "reaper", "presence", "launcher", "legacyHeartbeatPath", "release", "status", "siblingWarning"]
    miss = [n for n in need if n not in c]
    return not miss and "port-occupant" in c and "launched-only" in c and "in-process-only" in c, f"missing {miss}"



# ============================================================ failsafe inventory ([inv:no-features-removed])
INV = f"{PLAN}/evidence/failsafe-inventory.json"
INV_OWNERS = ["port-fixes", "tests-unit-core", "tests-unit-data", "tests-unit-extract", "tests-unit-surface", "capture-upgrade", "chrome-lifecycle"]
INV_TAGS = ["safety-tier", "launch-lock-oexcl", "group-kill", "newtab-fix", "cross-process", "livelock", "history-recency", "idle-shutdown", "isolated-page-cleanup", "reaper", "ban-detection",
            "readonly-sqlite", "stealth-flags", "settle", "session", "targets", "capture", "storage", "parsers", "verb"]


def inventory_rows():
    return (jread(INV, {}) or {}).get("rows", [])


def row_pinned(r):
    pin = r.get("pin") or {}
    p = f"{P}/{pin.get('file', '')}"
    txt = read(p)
    return bool(pin.get("file")) and bool(txt.strip()) and f"[{r['id']}]" in txt and bool(pin.get("test")) and pin["test"] in txt


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
    """Every row names an `owner_state` from the closed set (port-fixes, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, capture-upgrade, chrome-lifecycle) and a planned `pin` ({file under entrypoint/stealth-browser/src/test/ inside that owner's owned test directory, test: an it()/test() name substring}); rows tagged reaper, cross-process, livelock, launch-lock-oexcl, group-kill or newtab-fix are owned by chrome-lifecycle or tests-unit-core, rows tagged capture by capture-upgrade or tests-unit-extract."""
    own = ownership()
    bad = []
    for r in inventory_rows():
        o, pin = r.get("owner_state"), r.get("pin") or {}
        pf = f"{P}/{pin.get('file', '')}"
        owned = own.get(o, [])
        inside = any(pf.startswith(x) for x in owned if x.endswith("/") and "/src/test/" in x) or any(pf == x for x in owned)
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
            bad = [r["id"] for r in tagged if not row_pinned(r)]
            lib = "\n".join(read(x) for x in walk(f"{P}/src/lib", (".ts",)))
            return ok and len(tagged) >= 8 and not bad and "checkHistory" in lib, f"{why}; lifecycle-tagged rows={len(tagged)} unpinned={bad} checkHistory={'checkHistory' in lib}"
        fn.__doc__ = (f"[inv:no-features-removed] every failsafe-inventory row owned by {owner} is pinned: its pin file exists under src/test, cites the row id `[fs-NNN]` and contains the named test; "
                      "the feature is kept (no row may be removed or narrowed)."
                      + (" Every row tagged reaper, cross-process, history-recency, idle-shutdown, safety-tier, livelock, launch-lock-oexcl, group-kill or newtab-fix (at least 8) is pinned, and the history-recency tier with its `checkHistory` option remains." if owner == "chrome-lifecycle" else ""))
        return fn
    check(_slug, _n)(_mk(_owner))


@check("surface-api", 11)
def _sa11():
    """[inv:no-features-removed] the six chrome verbs exist as features (chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext) and every inventory row tagged `verb` names tests-unit-surface as its owner; export-name parity with the source is not required (greenfield)."""
    verbs = [r for r in inventory_rows() if "verb" in r.get("tags", [])]
    api = exports_of(read(f"{P}/src/api.ts"))
    return {"chromeStatus", "launchChrome", "shutdownChrome", "listPageTargets", "checkChromeActivity", "getPageContext"} <= api and bool(verbs) and all(r.get("owner_state") == "tests-unit-surface" for r in verbs), f"verb rows={len(verbs)}"


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
    return len(rows) >= 40 and not bad, f"{len(rows)} rows, unpinned {bad[:10]}"


@check("audit-pre-review", 5)
def _apr5():
    """The pre-review audit checks the inventory: every failsafe-inventory row is pinned now and PRE-REVIEW.json records `inventory_rows` (the row count) and `inventory_unpinned: 0`."""
    f = jread(f"{PLAN}/review/PRE-REVIEW.json", {}) or {}
    rows = inventory_rows()
    bad = [r["id"] for r in rows if not row_pinned(r)]
    return len(rows) >= 40 and not bad and f.get("inventory_rows") == len(rows) and f.get("inventory_unpinned") == 0, f"unpinned {bad[:10]} recorded={f.get('inventory_rows')}/{f.get('inventory_unpinned')}"


@check("audit-final", 12)
def _af12():
    """[inv:no-features-removed] final re-check: every failsafe-inventory row is still pinned on the final tree and the inventory file is unchanged since failsafe-inventory (rows were never deleted: row count >= the count recorded at inventory time in evidence/failsafe-inventory.json `row_count`)."""
    d = jread(INV, {}) or {}
    rows = d.get("rows", [])
    bad = [r["id"] for r in rows if not row_pinned(r)]
    return len(rows) >= max(40, int(d.get("row_count") or 0)) and not bad, f"{len(rows)} rows, unpinned {bad[:10]}"


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
    """Dependencies for the capture sink and the lifecycle reaper (no approval gate, both are owned packages): package.json `dependencies` lists @adhd/sox-store-adapter at ^0.13.3 and @adhd/sox-service-proxy (^0.5.0), vite.config.ts builds with `externalizeRealDeps(__dirname)` (imported from tools/vite-plugins/externalize.mjs) so neither package is inlined into dist, pnpm-lock.yaml resolves both, and `nx run stealth-browser:build` exits 0 with dist/index.js containing no inlined copy of either package (a `require` or dynamic `import()` of the name only)."""
    pkg = jread(f"{P}/package.json", {}) or {}
    deps = pkg.get("dependencies") or {}
    lock = read("pnpm-lock.yaml")
    v = read(f"{P}/vite.config.ts")
    static_ok = (deps.get("@adhd/sox-store-adapter", "").lstrip("^~").startswith("0.13") and "@adhd/sox-service-proxy" in deps and "externalizeRealDeps(__dirname)" in v
                 and "sox-store-adapter" in lock and "sox-service-proxy" in lock)
    if not static_ok:
        return False, "dependencies, externalizeRealDeps or lockfile entries missing"
    rc, out = sh([NX, "run", f"{proj_name()}:build"], timeout=1800)
    dist = read(f"{P}/dist/index.js")
    inlined = ("function createStoreAdapter" in dist) or ("function ensureBackend" in dist)
    return (deps.get("@adhd/sox-store-adapter", "").lstrip("^~") .startswith("0.13") and "@adhd/sox-service-proxy" in deps and "externalizeRealDeps(__dirname)" in v
            and "sox-store-adapter" in lock and "sox-service-proxy" in lock and rc == 0 and not inlined), f"deps={ {k: deps.get(k) for k in ('@adhd/sox-store-adapter','@adhd/sox-service-proxy')} } build rc={rc} inlined={inlined}"


@check("surface-hosts", 14)
def _sh14():
    """(gap G2, F23 F24) the hosts wire the lifecycle: src/server.ts and src/cli.ts call `installProcessExitHooks` (from the lifecycle namespace) with the shared ChromeManager, the CLI accepts `--idle-shutdown <ms>` (default 120000) and `--keep-alive` mapped onto the ChromeManager options (`--keep-alive` disables the idle reaper, `reaper` detached by default), the MCP host installs the hooks with `stdinEof: true` (orphan detection), and both bins print the two flags and the defaults in --help."""
    sv, cl = read(f"{P}/src/server.ts"), read(f"{P}/src/cli.ts")
    if not ("installProcessExitHooks" in sv and "installProcessExitHooks" in cl and "stdinEof" in sv):
        return False, "exit hooks not wired in src/server.ts and src/cli.ts"
    if not ensure_bin():
        return False, "build-bin failed"
    h = []
    for b in ("cli", "mcp"):
        rc, o, e = run2(["node", f"{P}/dist/bin/{b}.js", "--help"], 30)
        t = o + e
        h.append(rc == 0 and "--idle-shutdown" in t and "--keep-alive" in t and "120000" in t)
    return "installProcessExitHooks" in sv and "installProcessExitHooks" in cl and "stdinEof" in sv and all(h), f"help flags ok={h}"


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
