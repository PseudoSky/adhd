#!/usr/bin/env python3
"""Phase 1 inventory: detect runtime-config surface per package across 3 roots.
Emits manifest.jsonl of QUALIFYING packages (>=1 signal) only.
Deterministic; uses ripgrep for speed, falls back to os.walk grep."""
import json, os, re, subprocess, sys
from pathlib import Path

ROOTS = {
    "sox-ecosystem": os.path.expanduser("~/dev/ai/sox-ecosystem"),
    "adhd":          os.path.expanduser("~/dev/node/adhd"),
    "scratch":       os.path.expanduser("~/dev/ai/scratch"),
}
OUT = os.path.expanduser("~/dev/node/adhd/docs/environment/adoption-survey/manifest.jsonl")

JUNK = re.compile(r"(^|/)(node_modules|\.venv|venv|dist|build|target|\.nx|\.git|"
                  r"\.worktrees|__pycache__|\.pytest_cache|coverage|\.next|\.turbo|"
                  r"\.cache|out|\.output|vendor)(/|$)")
MANIFESTS = {"package.json": "node", "pyproject.toml": "python",
             "Cargo.toml": "rust", "go.mod": "go"}
WS_MARKERS = {"nx.json", "pnpm-workspace.yaml", "lerna.json"}

SIG = {
  "env":      re.compile(r"process\.env|import\.meta\.env|os\.environ|std::env::|"
                         r"dotenv|godotenv|os\.Getenv|env::var"),
  "fs_write": re.compile(r"writeFileSync|writeFile\b|createWriteStream|mkdirSync|"
                         r"fs\.mkdir|appendFile|fs::write|fs::create_dir|os\.MkdirAll|"
                         r"\.write_all|open\([^)]*['\"][wa]"),
  "log":      re.compile(r"winston|pino|createLogger|log4js|tracing_subscriber|"
                         r"logging\.getLogger|logrus|\bzap\."),
  "db":       re.compile(r"better-sqlite3|new Database\(|sqlite3|rusqlite|sql\.Open|"
                         r"\bgorm\b|\.sqlite|['\"][^'\"]*\.db['\"]"),
}
CFG_FILE = re.compile(r"(^\.env($|\.)|.*\.config\.[jt]s$|^config\.(ya?ml|json|toml)$|"
                      r".*rc$|^settings\.(json|toml|ya?ml)$|^\.?adhd\.environment\.ya?ml$)")
SRC_EXT = re.compile(r"\.(ts|tsx|js|mjs|cjs|jsx|py|rs|go)$")

def find_manifests(root):
    out = []
    try:
        r = subprocess.run(["rg","--files","--hidden","-g","!**/node_modules/**",
             "-g","!**/.venv/**","-g","!**/target/**","-g","!**/dist/**",
             "-g","!**/.git/**","-g","!**/.worktrees/**",
             "-g","**/package.json","-g","**/pyproject.toml",
             "-g","**/Cargo.toml","-g","**/go.mod", root],
             capture_output=True, text=True, timeout=120)
        out = [l for l in r.stdout.splitlines() if l.strip()]
    except Exception:
        for dp,_,fs in os.walk(root):
            if JUNK.search(dp+"/"): continue
            for f in fs:
                if f in MANIFESTS: out.append(os.path.join(dp,f))
    return out

def is_workspace_root(pkgdir, mf):
    if mf == "package.json":
        try:
            j = json.loads((Path(pkgdir)/mf).read_text())
            if "workspaces" in j: return True
        except Exception: pass
    for m in WS_MARKERS:
        if (Path(pkgdir)/m).exists(): return True
    return False

def scan_pkg(pkgdir):
    """Return (signals dict, flagged_files list, config_files list)."""
    sig = {k: 0 for k in SIG}
    flagged, cfgs = set(), set()
    for dp, dirs, fs in os.walk(pkgdir):
        dirs[:] = [d for d in dirs if not JUNK.search(dp+"/"+d+"/")]
        # don't descend into a nested package root
        if dp != pkgdir and any((Path(dp)/m).exists() for m in MANIFESTS):
            dirs[:] = []; continue
        for f in fs:
            rel = os.path.relpath(os.path.join(dp,f), pkgdir)
            if CFG_FILE.match(f):
                cfgs.add(rel); flagged.add(rel)
            if not SRC_EXT.search(f): continue
            fp = os.path.join(dp,f)
            try: txt = Path(fp).read_text(errors="ignore")
            except Exception: continue
            hit = False
            for k,pat in SIG.items():
                if pat.search(txt): sig[k]+=1; hit=True
            if hit: flagged.add(rel)
    return sig, sorted(flagged)[:15], sorted(cfgs)[:10]

rows = []
for root_name, root_path in ROOTS.items():
    if not os.path.isdir(root_path):
        print(f"  ! root missing: {root_path}", file=sys.stderr); continue
    seen = set()
    for mfpath in find_manifests(root_path):
        pkgdir = os.path.dirname(mfpath); mf = os.path.basename(mfpath)
        if pkgdir in seen: continue
        seen.add(pkgdir)
        if is_workspace_root(pkgdir, mf): continue
        lang = MANIFESTS[mf]
        try: name = json.loads(Path(mfpath).read_text()).get("name") if mf=="package.json" else None
        except Exception: name = None
        name = name or os.path.basename(pkgdir)
        sig, flagged, cfgs = scan_pkg(pkgdir)
        if sum(sig.values())==0 and not cfgs: continue  # filter: no signals
        rows.append({"root":root_name,"name":name,"path":pkgdir,"language":lang,
                     "signals":sig,"config_files":cfgs,"flagged_files":flagged})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT,"w") as fh:
    for r in rows: fh.write(json.dumps(r)+"\n")

# summary
by_root, by_lang = {}, {}
for r in rows:
    by_root[r["root"]] = by_root.get(r["root"],0)+1
    by_lang[r["language"]] = by_lang.get(r["language"],0)+1
print(f"QUALIFYING PACKAGES: {len(rows)}")
print("  by root:", dict(sorted(by_root.items())))
print("  by lang:", dict(sorted(by_lang.items())))
print(f"  -> {OUT}")
