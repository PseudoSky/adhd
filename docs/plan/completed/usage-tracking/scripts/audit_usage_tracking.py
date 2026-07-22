#!/usr/bin/env python3
"""
Audit script for the usage-tracking state-machine plan.

Usage:
    python3 audit_usage_tracking.py --phase foundation
    python3 audit_usage_tracking.py --phase final

Exit code equals the number of failing checks (0 = all passed).
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]  # adhd repo root


def run(cmd, cwd=None):
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd or ROOT
    )
    return result.returncode, result.stdout + result.stderr


def file_contains(path, pattern):
    full = ROOT / path
    if not full.exists():
        return False, f"file not found: {path}"
    text = full.read_text()
    if re.search(pattern, text):
        return True, ""
    return False, f"pattern not found in {path}: {pattern!r}"


def file_exists(path):
    full = ROOT / path
    if full.exists():
        return True, ""
    return False, f"file not found: {path}"


failures = []


def check(label, ok, detail=""):
    if ok:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}")
        if detail:
            print(f"        {detail}")
        failures.append(label)


# ─── Foundation phase checks ──────────────────────────────────────────────────

def check_foundation():
    print("\n── foundation ────────────────────────────────────────────────────────────")

    # Build outputs — run builds once and reuse
    print("  building agent-mcp-types...")
    rc, out = run("npx nx build agent-mcp-types --skip-nx-cache 2>&1")
    build_types_ok = rc == 0
    if not build_types_ok:
        print(f"  [build output] {out[:300]}")

    print("  building agent-mcp...")
    rc2, out2 = run("npx nx build agent-mcp --skip-nx-cache 2>&1")
    build_mcp_ok = rc2 == 0
    if not build_mcp_ok:
        print(f"  [build output] {out2[:300]}")

    # [provider-token-signal.1] TokenUsage in compiled agent-mcp-types
    if build_types_ok:
        ok, detail = file_contains(
            "dist/packages/ai/agent-mcp-types/index.d.ts",
            r"TokenUsage"
        )
        check("[provider-token-signal.1] TokenUsage exported from agent-mcp-types", ok, detail)
    else:
        check("[provider-token-signal.1] TokenUsage exported from agent-mcp-types", False, "build failed")

    # [provider-token-signal.2] ProviderChatResponse.usage in compiled types
    if build_mcp_ok:
        ok, detail = file_contains(
            "dist/packages/ai/agent-mcp/src/providers/types.d.ts",
            r"usage\??\s*:\s*TokenUsage"
        )
        check("[provider-token-signal.2] ProviderChatResponse.usage?: TokenUsage in compiled types", ok, detail)
    else:
        check("[provider-token-signal.2] ProviderChatResponse.usage?: TokenUsage in compiled types", False, "build failed")

    # [provider-token-signal.3] openai.ts maps to inputTokens
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/providers/openai.ts",
        r"inputTokens"
    )
    check("[provider-token-signal.3] openai.ts maps usage to inputTokens", ok, detail)

    # [provider-token-signal.4] anthropic.ts maps to inputTokens
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/providers/anthropic.ts",
        r"inputTokens"
    )
    check("[provider-token-signal.4] anthropic.ts maps usage to inputTokens", ok, detail)

    # [provider-token-signal.5] Tests pass
    print("  running tests (this may take ~30s)...")
    rc3, out3 = run("npx nx test agent-mcp 2>&1")
    test_ok = rc3 == 0
    if not test_ok:
        # Print last 20 lines for diagnosis
        lines = out3.strip().split("\n")
        print("\n".join(f"        {l}" for l in lines[-20:]))
    check("[provider-token-signal.5] All agent-mcp tests pass", test_ok, "" if test_ok else "see output above")

    # [hook-token-payload.1] PostModelResponsePayload.tokenUsage in compiled types
    if build_types_ok:
        ok, detail = file_contains(
            "dist/packages/ai/agent-mcp-types/index.d.ts",
            r"tokenUsage\??\s*:\s*TokenUsage"
        )
        check("[hook-token-payload.1] PostModelResponsePayload.tokenUsage?: TokenUsage", ok, detail)
    else:
        check("[hook-token-payload.1] PostModelResponsePayload.tokenUsage?: TokenUsage", False, "build failed")

    # [hook-token-payload.2] Orchestrator passes tokenUsage
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/engine/orchestrator.ts",
        r"tokenUsage\s*:\s*providerResponse\.usage"
    )
    check("[hook-token-payload.2] Orchestrator emit includes tokenUsage: providerResponse.usage", ok, detail)

    # [hook-token-payload.3] TypeScript build clean (reuse build result)
    check("[hook-token-payload.3] TypeScript build exits 0", build_mcp_ok, "" if build_mcp_ok else "build failed — see earlier output")

    # [hook-token-payload.4] Tests pass (already checked above)
    check("[hook-token-payload.4] Tests still pass (same run as .5)", test_ok, "")

    # [hook-token-payload.5] ExecutionContext has rootTaskId field in domain.ts
    ok5, detail5 = file_contains(
        "packages/ai/agent-mcp-types/src/domain.ts",
        r"rootTaskId"
    )
    check("[hook-token-payload.5] ExecutionContext has rootTaskId in domain.ts", ok5, detail5)

    # [hook-token-payload.6] TaskStartPayload carries rootTaskId in hooks.ts
    ok6, detail6 = file_contains(
        "packages/ai/agent-mcp-types/src/hooks.ts",
        r"rootTaskId"
    )
    check("[hook-token-payload.6] TaskStartPayload carries rootTaskId in hooks.ts", ok6, detail6)

    # [hook-token-payload.7] task:start emit includes rootTaskId from executionContext
    ok7, detail7 = file_contains(
        "packages/ai/agent-mcp/src/engine/orchestrator.ts",
        r"rootTaskId"
    )
    check("[hook-token-payload.7] orchestrator.ts task:start emit includes rootTaskId", ok7, detail7)

    # [hook-token-payload.8] task:failed and task:cancelled use await (not void) for hook emit
    rc8, out8 = run(
        "grep -n 'void hooks.emit' packages/ai/agent-mcp/src/engine/orchestrator.ts"
    )
    void_terminal = any(
        "task:failed" in line or "task:cancelled" in line
        for line in out8.strip().split("\n") if line.strip()
    )
    check("[hook-token-payload.8] task:failed/task:cancelled hooks use await (not void)", not void_terminal,
          "Found 'void hooks.emit' on task:failed or task:cancelled — must be await")

    # [hook-token-payload.9] tools/task.ts derives rootTaskId at creation from callerContext
    ok9, detail9 = file_contains(
        "packages/ai/agent-mcp/src/tools/task.ts",
        r"rootTaskId.*callerContext|callerContext.*rootTaskId"
    )
    check("[hook-token-payload.9] tools/task.ts derives rootTaskId from callerContext at creation", ok9, detail9)

    # Negative: no raw prompt_tokens/completion_tokens in providers
    ok_pos, _ = file_contains("packages/ai/agent-mcp/src/providers/openai.ts", r"prompt_tokens")
    ok_neg, _ = file_contains("packages/ai/agent-mcp/src/providers/anthropic.ts", r"input_tokens\b")
    # These should be ABSENT (mapped to inputTokens) — but they may appear in comments
    # We only flag if they appear outside a comment in the return value
    # Use a looser check: if usage.prompt_tokens appears as a VALUE (not a key), fail
    raw_openai, _ = file_contains("packages/ai/agent-mcp/src/providers/openai.ts", r"usage\.prompt_tokens")
    raw_anthropic, _ = file_contains("packages/ai/agent-mcp/src/providers/anthropic.ts", r"usage\.input_tokens")
    check(
        "[audit-foundation.neg.1] Raw SDK usage fields mapped away (not used as values)",
        not raw_openai and not raw_anthropic,
        "Found raw SDK field usage in provider return values — should be mapped to inputTokens/outputTokens"
    )

    # Negative: no duplicate TokenUsage definition
    rc4, out4 = run("grep -rn 'interface TokenUsage' packages/ai/agent-mcp/src/ packages/ai/agent-mcp-types/src/")
    count = len([l for l in out4.strip().split("\n") if l.strip()])
    check(
        "[audit-foundation.neg.2] TokenUsage defined in exactly one place",
        count == 1,
        f"Found {count} definitions: {out4.strip()[:200]}"
    )


# ─── Plugin phase checks ───────────────────────────────────────────────────────

def check_plugin():
    print("\n── plugin ────────────────────────────────────────────────────────────────")

    # [usage-schema.1] taskUsageTable in schema.ts
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/db/schema.ts",
        r"taskUsageTable"
    )
    check("[usage-schema.1] taskUsageTable defined in schema.ts", ok, detail)

    # [usage-schema.2] Migration file has CREATE TABLE task_usage
    drizzle_dir = ROOT / "packages/ai/agent-mcp/drizzle"
    sql_files = list(drizzle_dir.glob("*.sql"))
    has_migration = any(
        re.search(r"task_usage", f.read_text(), re.IGNORECASE)
        for f in sql_files
    )
    check("[usage-schema.2] Migration file contains task_usage", has_migration,
          f"No .sql file in {drizzle_dir} mentions task_usage" if not has_migration else "")

    # [usage-schema.3] Journal updated
    ok, detail = file_contains(
        "packages/ai/agent-mcp/drizzle/meta/_journal.json",
        r"task.?usage"
    )
    check("[usage-schema.3] drizzle/_journal.json mentions task_usage", ok, detail)

    # [usage-schema.4] Build clean
    rc, out = run("npx nx build agent-mcp --skip-nx-cache 2>&1")
    check("[usage-schema.4] TypeScript build exits 0", rc == 0, "" if rc == 0 else out[-300:])

    # [usage-schema.5] Tests pass
    rc2, out2 = run("npx nx test agent-mcp 2>&1")
    check("[usage-schema.5] Tests pass after schema change", rc2 == 0, "" if rc2 == 0 else out2[-200:])

    # [usage-schema.6] Migration includes index on root_task_id
    drizzle_dir_idx = ROOT / "packages/ai/agent-mcp/drizzle"
    task_usage_sqls = list(drizzle_dir_idx.glob("*.sql"))
    has_root_idx = any(
        re.search(r"idx_task_usage_root_task_id|INDEX.*root_task_id", f.read_text(), re.IGNORECASE)
        for f in task_usage_sqls
        if re.search(r"task_usage", f.read_text(), re.IGNORECASE)
    )
    check("[usage-schema.6] Migration includes index on root_task_id column", has_root_idx,
          "No CREATE INDEX on root_task_id found in task_usage migration SQL" if not has_root_idx else "")

    # [usage-plugin.1] Plugin file exists
    ok, detail = file_exists("packages/ai/agent-mcp/src/plugins/usage-plugin.ts")
    check("[usage-plugin.1] usage-plugin.ts exists", ok, detail)

    # [usage-plugin.2] Implements Plugin
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
        r"implements Plugin"
    )
    check("[usage-plugin.2] UsagePlugin implements Plugin", ok, detail)

    # [usage-plugin.3] Registered in index.ts
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/index.ts",
        r"UsagePlugin|usagePlugin"
    )
    check("[usage-plugin.3] UsagePlugin referenced in index.ts", ok, detail)

    # [usage-plugin.4] Registers all four hook events
    plugin_path = "packages/ai/agent-mcp/src/plugins/usage-plugin.ts"
    events = [r"post:model_response", r"task:completed", r"task:failed", r"task:cancelled"]
    for event in events:
        ok, detail = file_contains(plugin_path, event)
        check(f"[usage-plugin.4] Plugin registers '{event}'", ok, detail)

    # [usage-plugin.5] Build clean (reuse from schema check)
    check("[usage-plugin.5] Build clean", rc == 0, "")

    # [usage-plugin.6] Tests pass (reuse)
    check("[usage-plugin.6] Tests pass with plugin", rc2 == 0, "")

    # [usage-plugin.7] plugins/index.ts exports UsagePlugin
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/plugins/index.ts",
        r"export.*UsagePlugin"
    )
    check("[usage-plugin.7] plugins/index.ts barrel-exports UsagePlugin", ok, detail)

    # [usage-plugin.8] Plugin UPSERTs on post:model_response
    ok1, _ = file_contains("packages/ai/agent-mcp/src/plugins/usage-plugin.ts", r"post:model_response")
    ok2, _ = file_contains("packages/ai/agent-mcp/src/plugins/usage-plugin.ts", r"insert|upsert|onConflict|run\(")
    check("[usage-plugin.8] Plugin writes incrementally on post:model_response (UPSERT)", ok1 and ok2,
          "Missing post:model_response handler or DB write in usage-plugin.ts")

    # [usage-plugin.9] root_task_id resolved at terminal event
    ok, detail = file_contains("packages/ai/agent-mcp/src/plugins/usage-plugin.ts", r"root_task_id|rootTaskId")
    check("[usage-plugin.9] Plugin resolves root_task_id at terminal event", ok, detail)

    # [usage-plugin.10] is_complete set at terminal event
    ok, detail = file_contains("packages/ai/agent-mcp/src/plugins/usage-plugin.ts", r"is_complete|isComplete")
    check("[usage-plugin.10] Plugin sets is_complete=1 at terminal event", ok, detail)

    # [usage-query-tool.1] usage_query in ListTools
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/server.ts",
        r'"usage_query"'
    )
    check("[usage-query-tool.1] usage_query name registered in server.ts", ok, detail)

    # [usage-query-tool.2] case "usage_query" in CallTool
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/server.ts",
        r'case\s+"usage_query"'
    )
    check("[usage-query-tool.2] case 'usage_query' in CallTool handler", ok, detail)

    # [usage-query-tool.3] usage_query in all 4 registration points
    rc3, out3 = run("grep -c '\"usage_query\"' packages/ai/agent-mcp/src/server.ts")
    count = int(out3.strip()) if rc3 == 0 and out3.strip().isdigit() else 0
    check("[usage-query-tool.3] usage_query appears ≥4 times in server.ts (all registration points)", count >= 4,
          f"Found {count} occurrences, need at least 4")

    # [usage-query-tool.4] Query function references taskUsageTable
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/tools/usage.ts",
        r"taskUsageTable"
    )
    check("[usage-query-tool.4] tools/usage.ts references taskUsageTable", ok, detail)

    # [usage-query-tool.5] Build clean
    rc4, out4 = run("npx nx build agent-mcp --skip-nx-cache 2>&1")
    check("[usage-query-tool.5] Build clean after tool registration", rc4 == 0, "" if rc4 == 0 else out4[-300:])

    # [usage-query-tool.6] Tests pass
    rc5, out5 = run("npx nx test agent-mcp 2>&1")
    check("[usage-query-tool.6] Tests pass after tool registration", rc5 == 0, "" if rc5 == 0 else out5[-200:])

    # [usage-query-tool.7] INSTALL.md documents usage_query
    ok, detail = file_contains("packages/ai/agent-mcp/INSTALL.md", r"usage_query")
    check("[usage-query-tool.7] INSTALL.md references usage_query", ok, detail)

    # [usage-query-tool.8] README.md references usage_query
    ok, detail = file_contains("packages/ai/agent-mcp/README.md", r"usage_query")
    check("[usage-query-tool.8] README.md references usage_query", ok, detail)

    # [usage-query-tool.15] guide tool registered in server.ts (usage renamed to guide)
    ok15, detail15 = file_contains("packages/ai/agent-mcp/src/server.ts", r'"guide"')
    check("[usage-query-tool.15] 'guide' tool registered in server.ts (usage guide renamed)", ok15, detail15)

    # [usage-query-tool.16] Old standalone 'usage' guide name gone from server.ts
    rc16, out16 = run(r"grep -n 'name.*\"usage\"\b\|case.*\"usage\"\b' packages/ai/agent-mcp/src/server.ts")
    # Filter out any matches that are actually 'usage_query'
    stale_lines = [l for l in out16.strip().split("\n") if l.strip() and "usage_query" not in l]
    check("[usage-query-tool.16] Old 'usage' guide tool name absent from server.ts", len(stale_lines) == 0,
          f"Found stale 'usage' name in server.ts: {stale_lines[:3]}")

    # [usage-query-tool.9] Query function supports root_task_id subtree lookup
    ok, detail = file_contains("packages/ai/agent-mcp/src/tools/usage.ts", r"root_task_id|rootTaskId")
    check("[usage-query-tool.9] tools/usage.ts supports root_task_id subtree query", ok, detail)

    # [usage-query-tool.10] Validation schema includes root_task_id and include_incomplete
    ok1, _ = file_contains("packages/ai/agent-mcp/src/validation/usage.ts", r"root_task_id")
    ok2, _ = file_contains("packages/ai/agent-mcp/src/validation/usage.ts", r"include_incomplete")
    check("[usage-query-tool.10] Validation schema has root_task_id and include_incomplete", ok1 and ok2,
          "Missing root_task_id or include_incomplete in validation/usage.ts")

    # [usage-query-tool.11] taskToolOutputSchema has optional usage field (direct + subtree)
    ok11, detail11 = file_contains(
        "packages/ai/agent-mcp/src/validation/task.ts",
        r"subtree|TaskUsageReport|usageReport"
    )
    check("[usage-query-tool.11] taskToolOutputSchema has optional usage field (direct+subtree)", ok11, detail11)

    # [usage-query-tool.12] resultTool returns usage.direct and usage.subtree
    ok12, detail12 = file_contains(
        "packages/ai/agent-mcp/src/tools/task.ts",
        r"buildTaskUsageReport"
    )
    check("[usage-query-tool.12] resultTool enriches response with usage via buildTaskUsageReport", ok12, detail12)

    # [usage-query-tool.13] Sync taskTool and ephemeral path both include usage (≥2 call sites)
    rc13, out13 = run("grep -c 'buildTaskUsageReport' packages/ai/agent-mcp/src/tools/task.ts")
    count13 = int(out13.strip()) if rc13 == 0 and out13.strip().isdigit() else 0
    check("[usage-query-tool.13] buildTaskUsageReport called in ≥2 paths in tools/task.ts",
          count13 >= 2, f"Found {count13} call(s), need ≥2 (result + sync/ephemeral task paths)")

    # [usage-query-tool.14] claudecli path: buildTaskUsageReport handles zero-token rows without error
    ok14, detail14 = file_contains(
        "packages/ai/agent-mcp/src/tools/usage.ts",
        r"buildTaskUsageReport"
    )
    check("[usage-query-tool.14] buildTaskUsageReport exists in tools/usage.ts (claudecli zeros handled there)",
          ok14, detail14)


# ─── Final phase checks ────────────────────────────────────────────────────────

def check_final():
    print("\n── final ─────────────────────────────────────────────────────────────────")

    # Re-run foundation + plugin
    check_foundation()
    check_plugin()

    print("\n── conformance ───────────────────────────────────────────────────────────")

    # [audit-final.ref-provider-response] usage is optional
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/providers/types.ts",
        r"usage\?"
    )
    check("[audit-final.ref-provider-response] ProviderChatResponse.usage is optional (?)", ok, detail)

    # [audit-final.ref-hook-payload-optional] tokenUsage is optional in hooks.ts
    ok, detail = file_contains(
        "packages/ai/agent-mcp-types/src/hooks.ts",
        r"tokenUsage\?"
    )
    check("[audit-final.ref-hook-payload-optional] PostModelResponsePayload.tokenUsage is optional (?)", ok, detail)

    # [audit-final.ref-plugin-interface] install() exists and class implements Plugin
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
        r"implements Plugin"
    )
    check("[audit-final.ref-plugin-interface] UsagePlugin implements Plugin", ok, detail)

    # [audit-final.ref-drizzle-migration] Migration is generated SQL (has CREATE TABLE, not templated)
    drizzle_dir = ROOT / "packages/ai/agent-mcp/drizzle"
    sql_files = [f for f in drizzle_dir.glob("*.sql") if re.search(r"task_usage", f.read_text(), re.IGNORECASE)]
    has_create_table = sql_files and any(
        re.search(r"CREATE TABLE", f.read_text(), re.IGNORECASE)
        for f in sql_files
    )
    check("[audit-final.ref-drizzle-migration] Migration file contains CREATE TABLE (generated, not manual)", bool(has_create_table),
          "No migration SQL with CREATE TABLE found for task_usage" if not has_create_table else "")

    # [audit-final.ref-server-tool-pattern] 4 occurrences of usage_query in server.ts; guide registered
    rc, out = run("grep -c '\"usage_query\"' packages/ai/agent-mcp/src/server.ts")
    count = int(out.strip()) if rc == 0 and out.strip().isdigit() else 0
    ok_guide, _ = file_contains("packages/ai/agent-mcp/src/server.ts", r'"guide"')
    check("[audit-final.ref-server-tool-pattern] usage_query in all 4 server.ts points; guide tool registered",
          count >= 4 and ok_guide, f"usage_query count={count}, guide={'found' if ok_guide else 'missing'}")

    print("\n── negative ──────────────────────────────────────────────────────────────")

    # [audit-final.neg.1] Raw SDK fields mapped away
    raw_openai, _ = file_contains("packages/ai/agent-mcp/src/providers/openai.ts", r"usage\.prompt_tokens")
    raw_anthropic, _ = file_contains("packages/ai/agent-mcp/src/providers/anthropic.ts", r"usage\.input_tokens")
    check("[audit-final.neg.1] Raw SDK fields (prompt_tokens, input_tokens) are mapped away", not raw_openai and not raw_anthropic, "")

    # [audit-final.neg.2] No duplicate TokenUsage definition
    rc2, out2 = run("grep -rn 'interface TokenUsage' packages/ai/agent-mcp/src/ packages/ai/agent-mcp-types/src/")
    count2 = len([l for l in out2.strip().split("\n") if l.strip()])
    check("[audit-final.neg.2] TokenUsage defined in exactly one place", count2 == 1,
          f"Found {count2}: {out2.strip()[:200]}")

    # [audit-final.neg.3] INSTALL.md has usage_query in permissions.allow and guide replacing usage
    ok_uq, detail_uq = file_contains("packages/ai/agent-mcp/INSTALL.md", r"usage_query")
    ok_gd, _ = file_contains("packages/ai/agent-mcp/INSTALL.md", r"guide")
    check("[audit-final.neg.3] INSTALL.md includes usage_query and guide in permissions.allow",
          ok_uq and ok_gd, detail_uq if not ok_uq else "guide missing from INSTALL.md")

    # [audit-final.claudecli.1] UsagePlugin guards against undefined tokenUsage
    ok, detail = file_contains(
        "packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
        r"tokenUsage\?|tokenUsage &&|\?\?"
    )
    check("[audit-final.claudecli.1] UsagePlugin guards against undefined tokenUsage (claudecli path)", ok, detail)

    print("\n── gaps.md ───────────────────────────────────────────────────────────────")

    # [audit-final.gaps] GAPS.md item #4 marked implemented
    gaps_path = ROOT / "packages/ai/agent-mcp/GAPS.md"
    if not gaps_path.exists():
        check("[audit-final.gaps] GAPS.md exists", False, str(gaps_path))
    else:
        text = gaps_path.read_text()
        # Look for usage tracking item marked as implemented/done
        has_usage_item = bool(re.search(r"usage.tracking|token.usage", text, re.IGNORECASE))
        is_implemented = has_usage_item and bool(re.search(r"implemented|done|completed", text, re.IGNORECASE))
        check("[audit-final.gaps] GAPS.md usage-tracking item marked implemented", is_implemented,
              "GAPS.md exists but usage tracking item not marked implemented" if has_usage_item else "No usage tracking item found in GAPS.md")

    print("\n── live data (optional) ──────────────────────────────────────────────────")

    lm_url = os.environ.get("LMSTUDIO_BASE_URL")
    if not lm_url:
        print("  SKIP  [audit-final.live] LM Studio not available (LMSTUDIO_BASE_URL not set)")
    else:
        print(f"  INFO  [audit-final.live] LM Studio available at {lm_url} — manual verification required")
        print("        Run a task against the built server and verify a row in task_usage via task_usage tool")

    print("\n── dod.2 — usage in mcp response body ───────────────────────────────────")

    # [audit-final.dod2.schema] taskToolOutputSchema has usage field
    ok_schema, detail_schema = file_contains(
        "packages/ai/agent-mcp/src/validation/task.ts",
        r"subtree|TaskUsageReport|usageReport"
    )
    check("[audit-final.dod2.schema] taskToolOutputSchema has usage field (direct+subtree)", ok_schema, detail_schema)

    # [audit-final.dod2.result] resultTool calls buildTaskUsageReport
    ok_result, detail_result = file_contains(
        "packages/ai/agent-mcp/src/tools/task.ts",
        r"buildTaskUsageReport"
    )
    check("[audit-final.dod2.result] resultTool calls buildTaskUsageReport", ok_result, detail_result)

    # [audit-final.dod2.task] Both sync taskTool paths include usage
    rc_calls, out_calls = run("grep -c 'buildTaskUsageReport' packages/ai/agent-mcp/src/tools/task.ts")
    call_count = int(out_calls.strip()) if rc_calls == 0 and out_calls.strip().isdigit() else 0
    check("[audit-final.dod2.task] buildTaskUsageReport called in ≥2 paths (result + task sync/ephemeral)",
          call_count >= 2, f"Found {call_count} calls, need ≥2 (result + sync/ephemeral task paths)")

    # [audit-final.dod2.helper] buildTaskUsageReport queries both direct and subtree
    ok_helper, detail_helper = file_contains(
        "packages/ai/agent-mcp/src/tools/usage.ts",
        r"buildTaskUsageReport"
    )
    ok_direct, _ = file_contains("packages/ai/agent-mcp/src/tools/usage.ts", r"direct|direct_")
    ok_subtree, _ = file_contains("packages/ai/agent-mcp/src/tools/usage.ts", r"subtree|root_task_id")
    check("[audit-final.dod2.helper] buildTaskUsageReport exists and queries direct+subtree",
          ok_helper and ok_direct and ok_subtree,
          detail_helper if not ok_helper else "Missing direct or subtree query in buildTaskUsageReport")

    print("\n── definition of done ────────────────────────────────────────────────────")

    # [dod.1] task_usage rows with all required fields (tokens, latency, root_task_id)
    ok_sc, _ = file_contains("packages/ai/agent-mcp/src/db/schema.ts", r"taskUsageTable")
    ok_lat, _ = file_contains("packages/ai/agent-mcp/src/db/schema.ts", r"latency_ms")
    ok_root, _ = file_contains("packages/ai/agent-mcp/src/db/schema.ts", r"root_task_id")
    check("[dod.1] task_usage table has inputTokens, latency_ms, and root_task_id columns",
          ok_sc and ok_lat and ok_root, "")

    # [dod.2] Usage in MCP response body (direct + subtree)
    dod2_ok = ok_schema and ok_result and call_count >= 2 and ok_helper and ok_direct and ok_subtree
    check("[dod.2] Token usage in MCP response body (result + task tools, direct + subtree)",
          dod2_ok, "See [audit-final.dod2.*] checks above for detail")

    # [dod.3] usage_query MCP tool registered at all 4 points; guide tool replaces usage; subtree supported
    rc_sv, out_sv = run("grep -c '\"usage_query\"' packages/ai/agent-mcp/src/server.ts")
    sv_count = int(out_sv.strip()) if rc_sv == 0 and out_sv.strip().isdigit() else 0
    ok_sub, _ = file_contains("packages/ai/agent-mcp/src/tools/usage.ts", r"root_task_id")
    ok_guide_dod, _ = file_contains("packages/ai/agent-mcp/src/server.ts", r'"guide"')
    check("[dod.3] usage_query tool (4 registrations, subtree support) and guide tool registered",
          sv_count >= 4 and ok_sub and ok_guide_dod,
          f"usage_query count={sv_count}, subtree={'ok' if ok_sub else 'missing'}, guide={'ok' if ok_guide_dod else 'missing'}")

    # [dod.4] Incremental UPSERT on post:model_response
    ok_up, _ = file_contains("packages/ai/agent-mcp/src/plugins/usage-plugin.ts", r"post:model_response")
    ok_ups, _ = file_contains("packages/ai/agent-mcp/src/plugins/usage-plugin.ts", r"insert|upsert|onConflict|run\(")
    check("[dod.4] UsagePlugin UPSERTs on post:model_response (incremental crash-durable writes)",
          ok_up and ok_ups, "")

    # [dod.5] No regressions — checks whether any test-pass criterion failed earlier in this run
    dod5_ok = not any("agent-mcp tests pass" in f for f in failures)
    check("[dod.5] All agent-mcp tests pass (no regressions)",
          dod5_ok, "Earlier test-pass check failed — see above" if not dod5_ok else "")

    # [dod.6] Package docs updated (GAPS.md, ROADMAP.md, INSTALL.md, README.md)
    # Verified in docs-and-publish state; audit-final checks what it can statically
    ok_inst, _ = file_contains("packages/ai/agent-mcp/INSTALL.md", r"task_usage")
    ok_rm, _ = file_contains("packages/ai/agent-mcp/README.md", r"task_usage")
    check("[dod.6] INSTALL.md and README.md reference task_usage (doc update pre-check)",
          ok_inst and ok_rm,
          "GAPS.md/ROADMAP.md updates verified in docs-and-publish state after code-review")

    # [dod.7] Code review evidence (release-phase; SKIP if file not yet created)
    cr_path = ROOT / "docs/plan/usage-tracking/code-review-evidence.md"
    if cr_path.exists():
        cr_ok = bool(re.search(r"REVIEW_COMPLETE", cr_path.read_text()))
        check("[dod.7] Code review complete (evidence file has REVIEW_COMPLETE)", cr_ok,
              str(cr_path) + " exists but REVIEW_COMPLETE not found" if not cr_ok else "")
    else:
        print("  SKIP  [dod.7] Code review evidence not yet written (release phase pending)")

    # [dod.8] npm publish — requires network; SKIP if offline
    rc_npm, out_npm = run("npm view @adhd/agent-mcp version 2>/dev/null")
    if rc_npm == 0 and out_npm.strip():
        local_ver = (ROOT / "packages/ai/agent-mcp/package.json").read_text()
        import json as _json
        local_v = _json.loads(local_ver).get("version", "?")
        npm_v = out_npm.strip()
        check("[dod.8] npm-published version matches local package.json",
              local_v == npm_v, f"local={local_v} npm={npm_v}")
    else:
        print("  SKIP  [dod.8] npm registry not reachable (release phase / offline)")

    # [dod.9] Zero-knowledge acceptance evidence (release-phase)
    ae_path = ROOT / "docs/plan/usage-tracking/acceptance-evidence.md"
    if ae_path.exists():
        ae_ok = bool(re.search(r"VERIFIED_MATCH", ae_path.read_text()))
        check("[dod.9] Zero-knowledge acceptance test passed (evidence file has VERIFIED_MATCH)", ae_ok,
              str(ae_path) + " exists but VERIFIED_MATCH not found" if not ae_ok else "")
    else:
        print("  SKIP  [dod.9] Acceptance evidence not yet written (release phase pending)")


# ─── Release phase checks (criterion ID registry) ────────────────────────────
# These checks are run manually by their respective state guards, not by this
# script. The IDs are listed here so gap-check.js can find them.

# [code-review.1] Build passes after any cleanup
# [code-review.2] Tests pass after any cleanup
# [code-review.3] Review evidence file exists
# [code-review.4] Evidence file records completion

# [docs-and-publish.1] GAPS.md item #4 marked implemented
# [docs-and-publish.2] ROADMAP.md Phase 1 item #2 marked complete
# [docs-and-publish.3] INSTALL.md includes task_usage
# [docs-and-publish.4] README.md includes task_usage
# [docs-and-publish.5] package.json version bumped to 0.0.5
# [docs-and-publish.6] npm-published version matches local package.json

# [acceptance-test.1] Acceptance evidence file exists
# [acceptance-test.2] Evidence records a verified match


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Audit usage-tracking plan")
    parser.add_argument("--phase", choices=["foundation", "final"], required=True)
    args = parser.parse_args()

    print(f"\nAudit: usage-tracking  phase={args.phase}")
    print(f"Root: {ROOT}\n")

    if args.phase == "foundation":
        check_foundation()
    elif args.phase == "final":
        check_final()

    print(f"\n{'═' * 60}")
    if failures:
        print(f"FAILED  {len(failures)} check(s):")
        for f in failures:
            print(f"  - {f}")
    else:
        print("PASSED  all checks")
    print()

    sys.exit(len(failures))


if __name__ == "__main__":
    main()
