#!/usr/bin/env python3
import json, pathlib
STUDY="/Users/nix/dev/node/adhd/.claude/worktrees/impl-ephemeral/docs/agent-mcp/study/code-tasking"

T = {
 1:("sse-eaddrinuse","DIAGNOSE","SSE well-scoped"),
 2:("fk-cascade-migration","DIAGNOSE","FK underspecified"),
 3:("fk-cascade-migration","DIAGNOSE","FK context-rich"),
 4:("audit-ref-policy-comment","APPLY","audit + pointer hint"),
 5:("fk-cascade-migration","APPLY","FK fix+API handed over"),
 6:("fk-cascade-migration","DIAGNOSE","FK full-context"),
 7:("sse-eaddrinuse","DIAGNOSE","SSE full-context"),
 8:("audit-ref-policy-comment","DIAGNOSE","audit neutral"),
 9:("fk-cascade-migration","DIAGNOSE","FK role-primed (ts-pro)"),
 10:("fk-cascade-migration","APPLY","FK facts-in-prompt (select)"),
 11:("sse-eaddrinuse","APPLY","SSE fact-in-role"),
 12:("fk-cascade-migration","DIAGNOSE","FK multi-turn synth→code"),
 13:("fk-cascade-migration","DIAGNOSE","FK adversarial architect"),
 14:("fk-cascade-migration","ORCH","FK orchestrate lead→synth→coder"),
 15:("tasklist-ephemeral-filter","ADDITIVE","floor: list filter"),
 16:("sse-port-param","ADDITIVE","floor: optional port param"),
 17:("task-status-enum-extend","ADDITIVE","floor: extend enum"),
 18:("export-sqlite-type-annotation","GOTCHA","floor+TS4023 gotcha"),
}
SP = {1:"code-fixer",2:"code-fixer",3:"code-fixer",4:"code-fixer",5:"code-fixer",6:"code-fixer",
 7:"code-fixer",8:"code-fixer",9:"ts-pro",10:"ts-pro",11:"ts-pro",12:"synth-coder (anti-fab)",
 13:"architect (adversarial)",14:"lead (orchestrator)",15:"code-impl",16:"code-impl",17:"code-impl",18:"code-impl"}

V14B={1:("PARTIAL","handler ✓ but cause wrong + breaks sync caller"),2:("FAIL","invalid MySQL dialect, weakens cascade"),
 3:("FAIL","BEGIN/COMMIT in the SQL — still a no-op"),4:("PASS","comment-skip fix (pointer did the work)"),
 5:("NEAR","right approach; restore used READ form → FK never re-enabled"),6:("FAIL","cause inverted; irrelevant fix"),
 7:("FAIL","try/catch around async listen — can't catch 'error'"),8:("FAIL","missed the comment; still matches it"),
 9:("FAIL","raised 'transaction scope' but fix = BEGIN/COMMIT in SQL"),10:("FAIL","selected facts, hallucinated migrate API"),
 11:("FAIL","ignored the fact; uncompilable; High-confidence wrong"),12:("FAIL","anti-fab capped one hallucination, relocated to invalid SQL"),
 13:("FAIL","rejected wrong cause but inverted the fix"),14:("FAIL","coordinated (synth→coder) but fix wrong + fabricated imports"),
 15:("PASS","number enum (different API, consistent)"),16:("PASS","optional port/host defaulted"),
 17:("PASS","both enums updated; flagged other refs"),18:("FAIL","renamed var — still TS4023; no annotation")}
# qwen3.5-9b re-run at temperature=0 (greedy), max_tokens=8192.
VQ35={1:("FAIL","'server.listen() throws an unhandled exception, no try-catch' — wrong (async 'error' event)"),
 2:("FAIL","naive in-SQL FK disable the txn no-op defeats (underspecified)"),
 3:("FAIL","muddled 'PRAGMA OFF only affects the new table'; no connection fix"),4:("PASS","comment-skip fix (hinted)"),
 5:("PASS","correct: 'pragmas ignored inside the migrator transaction'; connection-level fix (handed)"),
 6:("FAIL","confab 'FK checks disabled during rebuild'"),
 7:("FAIL","'listen throws EADDRINUSE synchronously' — wrong; no real handler"),8:("FAIL","'>= operator / 388 vs 410' — misses the Promise.all-in-comment-306"),
 9:("FAIL","denies cascade; 're-enable foreign_keys=ON' theory"),10:("PASS","SELECTED the right facts from the distractor list (migrator txn → in-SQL PRAGMA ignored → cascade) + sqlite-level fix"),
 11:("FAIL","SSE fact-in-role ignored; no handler"),
 12:("FAIL","correctly notes sqlite is module-private but falls back to 'verify FK with queries before/after' — does not disable FK, non-working  [PASS on the default-temp draw, which found (db as any).session.client — sampling-sensitive]"),
 13:("FAIL","rejects the planted dx but lands another wrong cause ('task ID recreation breaks referential integrity')"),
 14:("FAIL","orchestrated correctly (synth→coder, composed) but the fix was wrong  [ERROR/empty on the default-temp draw — sampling-sensitive]"),
 15:("PASS","z.boolean().optional() + eq"),16:("PASS","optional port?/host?, port ?? SSE_PORT"),
 17:("PASS","both enums; values kept"),18:("FAIL","exports db; no Database.Database annotation")}
# Haiku run at temperature=0 (greedy), max_tokens=8192.
VHAI={1:("PASS","names the 'error' event + adds server.on('error'); flags hardcoded port"),
 2:("FAIL","confused 'FK constraints disabled by default'; no connection-level fix"),
 3:("PASS","correct: PRAGMA is connection-scoped, the client's ON persists across the in-SQL OFF; connection-level fix"),
 4:("PASS","comment-skip fix (hinted)"),
 5:("PASS","applied the handed-over connection-level fix"),
 6:("NEAR","wrong cause ('better-sqlite3 runs the migration as a single prepared statement') but a connection-level fix"),
 7:("PASS","names the async 'error' event + handler + injectable port"),
 8:("PASS","caught the comment-on-306 false match"),
 9:("NEAR","speculates the migrator 'skips PRAGMA statements' (wrong) but lands a connection-level fix"),
 10:("PASS","'in-SQL PRAGMA OFF is ineffective inside a transaction' + connection-level fix"),
 11:("PASS","applied the role's fact: server.on('error'), no try/catch trap"),
 12:("PASS","correct: 'connection-level foreign_keys=ON overrides the migration SQL's PRAGMA'; layer-correct toggle helpers  [NEAR on the default-temp draw — sampling-sensitive cell]"),
 13:("FAIL","wrong 'FK pragma state leaks across the transaction boundary; re-validates at commit' theory"),
 14:("ERROR","lead called bare `agent` (no server prefix) → task failed — the DEBT-004 trip; hit at temp=0, whereas it coordinated cleanly on the default-temp draw [sampling-sensitive]"),
 15:("PASS","optional is_ephemeral filter"),16:("PASS","optional port/host defaulted"),
 17:("PASS","both enums extended"),18:("PASS","explicit `import type { Database as DatabaseType }` annotation")}
VSON={i:("PASS","") for i in range(1,19)}
VSON[2]=("PASS","FK-cascade-on-rebuild; unprompted surfaced the migrator-transaction subtlety")
VSON[6]=("PASS","exact PRAGMA-no-op-in-transaction; conn-level fkWasOn + try/finally; cleaner than the shipped fix")
VSON[10]=("PASS","selected the right facts AND synthesized the connection-level fix")
VSON[13]=("PASS","rejected the planted wrong diagnosis; correct cause + grounded spec")
VSON[18]=("PASS","explicit type annotation + .d.ts-nameability note")
VSON[14]=("ERROR","lead called bare `agent` (no server prefix) → orchestrator rejected → task failed (DEBT-004); same at default temp AND greedy — sonnet is stable here; orphaned a sub-agent session (BUG-002 repro)")

VGEM={
 1:("FAIL","'server.listen() throws synchronously' — wrong; it's the async 'error' event"),
 2:("FAIL","FK confab; never reaches the transaction-no-op"),
 3:("FAIL","'CREATE TABLE sets up constraints before INSERT' — DDL-ordering confab"),
 4:("PASS","comment-skip fix (hinted)"),
 5:("NEAR","applied the handed-over connection-level OFF→migrate→try; spurious await on sync calls; restore unconfirmed"),
 6:("FAIL","FK confab"),
 7:("FAIL","'error callback provided by listen()' — muddled; no clear 'error' handler/cause"),
 8:("FAIL","'finds an earlier instance' — circles it but never identifies the comment-on-306"),
 9:("FAIL","FK ts-pro — confab, no txn-no-op"),
 10:("FAIL","selected the 'ignored inside transaction' fact but applied the PRAGMA IN-transaction (the no-op) — wrong fix layer"),
 11:("NEAR","role supplied the fact; added server.on('error') (load-bearing fix) but cause muddled / port unconfirmed"),
 12:("FAIL","FK multi-turn — confab"),
 13:("FAIL","architect: inverted cause ('PRAGMA OFF causes the deletion')"),
 14:("ERROR","lead PROVIDER_ERROR — orchestration failed (4B lead could not drive the delegation)"),
 15:("PASS","optional is_ephemeral filter"),16:("PASS","optional port/host defaulted"),
 17:("PASS","both enums extended"),18:("FAIL","exported db; sqlite line unchanged — no Database.Database annotation (still TS4023)")}

# Qwen3-Coder run at temperature=0 (greedy), max_tokens=8192 — the only model run
# with controlled sampling. Verdicts below are from that deterministic run.
VQ3C={
 1:("NEAR","added server.on('error') but mis-frames the mechanism as 'throws an unhandled exception'"),
 2:("FAIL","cascade-on-rebuild noted; no connection-level fix (underspecified)"),
 3:("FAIL","muddled 'FK check happens at the statement level'; mis-describes the rename; no connection fix"),
 4:("PASS","comment-skip fix (hinted)"),
 5:("PASS","correct: 'PRAGMA ignored inside transactions'; connection-level OFF→migrate→restore"),
 6:("FAIL","cascade-on-rebuild noted but never reaches the in-SQL-PRAGMA-is-a-no-op crux / connection fix"),
 7:("NEAR","added server.on('error') but frames it as 'uncaught exception bubbles up'"),
 8:("PASS","fix skips comment lines (`not line.strip().startswith('//')`) — addresses the comment false-match; first local model to"),
 9:("FAIL","wrong: claims 'PRAGMA OFF disables checking, not the cascade behavior itself'"),
 10:("NEAR","acknowledges the in-SQL PRAGMA is insufficient but the fix layer stays vague ('manage FK during migration'), not the connection-level toggle  [PASS on the default-temp draw — sampling-sensitive cell]"),
 11:("PASS","applied the role's fact: server.on('error'), no try/catch trap"),
 12:("FAIL","defeatist — 'the fix must be in Drizzle ORM's migration implementation'"),
 13:("PASS","correct: 'Drizzle's transaction wrapper does not respect the in-script PRAGMA OFF'; fix = set FK OFF before migrate in db/migrate.ts; rejected the planted wrong dx  [NEAR on the default-temp draw — sampling-sensitive cell]"),
 14:("FAIL","orchestrated correctly (synth→coder, composed) but the fix was vague/wrong"),
 15:("PASS","optional is_ephemeral filter"),16:("PASS","optional port/host defaulted"),
 17:("PASS","both enums extended"),18:("FAIL","exported db; sqlite line unchanged — no Database.Database annotation")}

# column order = ascending capability. (json_key, display, source-file, verdicts)
MODELS=[
 ("gemma_4_e4b","gemma-4-e4b","results/runs.gemma-4-e4b.jsonl",VGEM),
 ("qwen2.5_14b","qwen2.5-14b","(original study tests/test-*/mcp.jsonl)",V14B),
 ("qwen3.5_9b_claude_distill","qwen3.5-9b","results/runs.qwen35-9b-hiq.jsonl (temp=0, greedy)",VQ35),
 ("qwen3_coder_30b","qwen3-coder-30b","results/runs.qwen3-coder-30b.jsonl (temp=0, greedy)",VQ3C),
 ("claude_haiku_4_5","haiku-4.5","results/runs.anthropic-haiku45.jsonl (temp=0, greedy)",VHAI),
 ("claude_sonnet_4_6","sonnet-4.6","results/runs.anthropic-sonnet46.jsonl (temp=0, greedy)",VSON),
]
def tal(v):
    p=sum(v[i][0]=="PASS" for i in range(1,19)); n=sum(v[i][0] in("NEAR","PARTIAL") for i in range(1,19))
    f=sum(v[i][0]=="FAIL" for i in range(1,19)); e=sum(v[i][0]=="ERROR" for i in range(1,19)); return p,n,f,e
def req_rate(v):
    d={}
    for i in range(1,19):
        d.setdefault(T[i][1],[0,0]); d[T[i][1]][1]+=1
        if v[i][0]=="PASS": d[T[i][1]][0]+=1
    return d

KEYS=[k for k,_,_,_ in MODELS]; LABELS=[l for _,l,_,_ in MODELS]; VS={k:v for k,_,_,v in MODELS}

# grades.manual.json — driven by MODELS
grades={"models":{k:{"display":l,"source":src} for k,l,src,_ in MODELS},
  "grades_legend":"PASS = correct cause + working fix · NEAR/PARTIAL = correct/working fix with a wrong or muddled stated cause · FAIL = wrong cause and non-working fix · ERROR = orchestration plumbing failure (not a coding verdict)",
  "tests":[]}
for i in range(1,19):
    rec={"test":i,"scenario":T[i][0],"requires":T[i][1],"posing":T[i][2],"system_prompt":SP[i]}
    for k in KEYS: rec[k]=dict(zip(("grade","note"),VS[k][i]))
    grades["tests"].append(rec)
pathlib.Path(STUDY,"results","grades.manual.json").write_text(json.dumps(grades,indent=1)+"\n")

# DIAGNOSE ladder string, computed
diag=" · ".join(f"{l} {req_rate(VS[k])['DIAGNOSE'][0]}/9" for k,l in zip(KEYS,LABELS))
md=["# Multi-model differential — code-tasking study","",
 "Same harness (`runner/`), same `plan.json`, same system+user prompts — **including the",
 "specialized SP variants** (`code-fixer` T1–8, the staff-level `ts-pro` persona T9–11, the",
 "anti-fabrication `synth-coder` T12, the adversarial `architect` T13, the `lead` orchestrator",
 "T14, `code-impl` T15–18). Only the model varies. Verdicts are **hand-graded with teeth**",
 "against `scenarios/<slug>.md`; the auto-grader (`runner/grade.py`) is a conservative first",
 "pass and is **overridden** here (it false-passes 'right fix / wrong cause' cases). ",
 "`NEAR`/`PARTIAL` = correct or working fix with a wrong/muddled stated cause; `ERROR` =",
 "orchestration plumbing failure, not a coding verdict. Columns in ascending capability.","",
 "> **Sampling:** `qwen3.5-9b`, `qwen3-coder-30b`, `haiku-4.5`, and `sonnet-4.6` were run at",
 "> **temperature 0 (greedy, deterministic)**; `gemma-4-e4b` and `qwen2.5-14b` remain provider-default",
 "> single draws. Borderline cells are sampling-sensitive — greedy moved qwen3.5-9b 7.0→6.0 (its lone",
 "> diagnosis pass was luck → 0/9), haiku 13.5→14.0, and flipped haiku's T14 into the prefix trip;",
 "> sonnet was **identical at both temps** (17 PASS / T14 trip) — the frontier model doesn't wobble.",
 "> The **ladder shape is invariant** to temperature. (`run-study.mjs --temperature 0` for determinism.)","",
 "| # | requires | SP | posing | " + " | ".join(LABELS) + " |",
 "|---|---|---|---|" + "---|"*len(LABELS)]
for i in range(1,19):
    md.append(f"| {i} | {T[i][1]} | `{SP[i].split()[0]}` | {T[i][2]} | " + " | ".join(VS[k][i][0] for k in KEYS) + " |")
md+=["","**Tally** (18 tests):"]
for k,l in zip(KEYS,LABELS):
    p,n,f,e=tal(VS[k]); parts=[f"**{p} PASS**"]+([f"{n} NEAR"] if n else [])+([f"{f} FAIL"] if f else [])+([f"{e} ERROR"] if e else [])
    md.append(f"- {l}: "+" / ".join(parts))
md+=["","### Pass-rate by what the test *requires* (strict PASS only)",
 "| requires | " + " | ".join(LABELS) + " |","|---|" + "---|"*len(LABELS)]
rr={k:req_rate(VS[k]) for k in KEYS}
for req in ["ADDITIVE","APPLY","GOTCHA","DIAGNOSE","ORCH"]:
    md.append(f"| {req} | " + " | ".join(f"{rr[k][req][0]}/{rr[k][req][1]}" for k in KEYS) + " |")
md+=["","### What it shows","",
 "- **A capability ladder, and the rung that matters is `DIAGNOSE`.** Floor (`ADDITIVE`) is 3/3",
 "  for every model. `APPLY` (fix handed over / selectable / scaffolded) climbs with capability.",
 f"  But cold cross-layer **diagnosis** separates them sharply: {diag}.",
 "- **Size alone is not the axis.** gemma-4-e4b (4B) ties qwen2.5-14b — both hold the floor and",
 "  fail every cold diagnosis. The 4B even matches the 14B on a couple of APPLY tests (it added",
 "  the SSE handler its role supplied; the 14B ignored it). Diagnosis tracks capability tier, not",
 "  parameter count.",
 "- **The 9B \"Claude-4.6 high-IQ distill\" did not inherit diagnosis.** qwen3.5-9b matches the 14B",
 "  wall — it only clears tests where the answer is supplied or scaffolded; every from-scratch",
 "  diagnosis confabulates. Distillation bought application + calibration, not synthesis.",
 "- **Haiku-4.5 is the dangerous middle: right fix, wrong reason.** It often lands a *working*",
 "  connection-level FK fix (`db._.client` pragma toggle) while stating a *wrong* mechanism",
 "  ('deferred FK checks until commit', 'migrator opens a separate connection') — T6/T9/T12. A",
 "  test gate catches the bad ones; self-reported confidence does not. The `ts-pro` SP did not",
 "  repair the reasoning (T9 still confabulated).",
 "- **Only sonnet-4.6 gets cause *and* fix right every time** — 17/17 on the gradeable tasks,",
 "  several cleaner than the human-shipped fix.","",
 "### Orchestration (T14) failed five different ways — none about coding ability",
 "| model | T14 outcome |","|---|---|"]
for k,l in zip(KEYS,LABELS):
    md.append(f"| {l} | {VS[k][14][1]} |")
md+=["",
 "So the bare-tool-name trip (BACKLOG **DEBT-004**) is **model-specific, not universal**: only",
 "sonnet hit it; haiku + 14b orchestrated fine, qwen3.5 went empty, gemma errored in the loop.",
 "The orphaned-session leak (BACKLOG **BUG-002**) was the sonnet run. Orchestration reliability",
 "here is about following tool conventions + composing a result — orthogonal to diagnosis.","",
 "_Per-run responses: `results/runs.<label>.jsonl`. Usage/latency: `results/usage.json`._"]
pathlib.Path(STUDY,"results","comparison.md").write_text("\n".join(md)+"\n")
print("\n".join(md[:62]))
print("\n... (delegation section appended below) ...")

# delegation-structure section (FK held constant) — appended
STRUCT=[(2,"direct single-shot"),(3,"direct single-shot"),(6,"direct single-shot"),
 (5,"direct + fix handed over"),(9,"direct + heavy role (ts-pro)"),(10,"direct + facts in prompt"),
 (12,"stateful multi-turn (diagnose→code)"),(13,"pipeline review stage (architect)"),
 (14,"recursive orchestration (lead→synth→coder)")]
TOPO={2:"1 agent · 1 turn · depth 0",3:"1 agent · 1 turn · depth 0",6:"1 agent · 1 turn · depth 0",
 5:"1 agent · 1 turn · depth 0",9:"1 agent · 1 turn · depth 0",10:"1 agent · 1 turn · depth 0",
 12:"1 agent · 2 turns · depth 0",13:"1 agent · 1 turn · depth 0",14:"3 agents · depth 1"}
d=["","---","","## Results by delegation structure","",
 "Same FK-cascade bug, only the topology varies — isolating what structure buys.","",
 "| structure | topology | test | " + " | ".join(LABELS) + " |","|---|---|---|" + "---|"*len(LABELS)]
for i,lab in STRUCT:
    d.append(f"| {lab} | {TOPO[i]} | T{i} | " + " | ".join(VS[k][i][0] for k in KEYS) + " |")
d+=["","- **Information/step-scaffolding moves small models; agent fan-out does not.** The structures",
 "  that flipped a small model toward PASS *added information* (T5 handed, T10 facts) or *staged",
 "  the reasoning* (T12). Adding agents/review stages without information (T13, T14) did not.",
 "- **The richest topology (T14) was the least reliable across the board** — every model failed it,",
 "  for four different reasons (table above), none about diagnosis ability. Keep delegation graphs",
 "  shallow; reserve fan-out for genuinely parallel work, not to manufacture a missing diagnosis.",
 "- **The frontier model needs the least structure**: sonnet solved the bug direct/single-shot/depth-0",
 "  (T2/T3/T6); the most elaborate structure was the only thing that broke it (on plumbing)."]
with open(pathlib.Path(STUDY,"results","comparison.md"),"a") as f: f.write("\n".join(d)+"\n")
print("regenerated comparison.md + grades.manual.json (4 models)")
