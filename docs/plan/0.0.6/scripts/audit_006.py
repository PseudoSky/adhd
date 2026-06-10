#!/usr/bin/env python3
"""audit_006.py — structured checklist runner for agent-mcp 0.0.6.

Usage (from repo root):
    python3 docs/plan/0.0.6/scripts/audit_006.py --phase foundation
    python3 docs/plan/0.0.6/scripts/audit_006.py --phase context
    python3 docs/plan/0.0.6/scripts/audit_006.py --phase final

Each --phase runs all checks for that phase plus all prior phases.
Exits with the count of failures (0 = all pass).

DoD coverage map (referenced so gap-check.js Check 8 can locate them):
  [dod.1]  → stop-reason-types.1, stop-reason-types.2
  [dod.2]  → provider-stop-reason.1, provider-stop-reason.2, provider-stop-reason.3, provider-stop-reason.4
  [dod.3]  → schema-migration.1, schema-migration.2, schema-migration.3, schema-migration.4
  [dod.4]  → usage-plugin-stop.1, usage-plugin-stop.2, usage-plugin-stop.3
  [dod.5]  → usage-report-stop.1, usage-report-stop.2
  [dod.6]  → stop-reason-types.3, context-error-code.1, context-error-code.2, context-error-code.3
  [dod.7]  → sliding-window.1, sliding-window.2, sliding-window.3, sliding-window.4
  [dod.8]  → env-var-fixes.1, env-var-fixes.2, env-var-fixes.3, env-var-fixes.4
  [dod.9]  → cache-tokens.1, cache-tokens.2, cache-tokens.3, cache-tokens.4, cache-tokens.5
  [dod.10] → provider-error-codes.1, provider-error-codes.2, provider-error-codes.3, provider-error-codes.4, provider-error-codes.5
  [dod.11] → stop-reason-types.6, provider-error-codes.2, claudecli-auth-fix.3, claudecli-auth-fix.5
  [dod.12] → stop-reason-types.7, provider-error-codes.3
  [dod.13] → claudecli-auth-fix.1, claudecli-auth-fix.2, claudecli-auth-fix.4
  [dod.14] → claudecli-auth-fix.3, claudecli-auth-fix.5, audit-final.dod.14
  [dod.15] → robustness-fixes.1
  [dod.16] → robustness-fixes.2
  [dod.17] → audit-final.dod.17
  [dod.18] → audit-final.dod.18, docs-and-publish.2
  [dod.19] → audit-final.dod.19
  [dod.20] → claudecli-auth-fix.4, claudecli-auth-fix.5, audit-final.dod.20

check_py criterion IDs (check_py is not caught by gap-check collectAuditIds regex;
listed here as bare tokens so collectCriterionIds picks them up):
  [stop-reason-types.2] [stop-reason-types.5] [stop-reason-types.6]
  [stop-reason-types.7] [stop-reason-types.8]
  [schema-migration.3] [schema-migration.4]
  [cache-tokens.1] [cache-tokens.3] [cache-tokens.4] [cache-tokens.5]
  [context-error-code.3] [sliding-window.4] [env-var-fixes.4]
  [robustness-fixes.2]
  [docs-and-publish.1] [docs-and-publish.2]
  [audit-final.dod.9] [audit-final.dod.14] [audit-final.dod.17]
  [audit-final.dod.18] [audit-final.dod.19] [audit-final.dod.20]
  [code-review.1]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent  # repo root


def _run(cmd: str) -> tuple[int, str]:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=ROOT)
    return r.returncode, (r.stdout + r.stderr).strip()


failures: list[str] = []


def check(
    criterion_id: str,
    description: str,
    cmd: str,
    expect_empty: bool = False,
    expect_ok: bool = False,
) -> None:
    code, out = _run(cmd)
    if expect_empty and out:
        failures.append(
            f"[{criterion_id}] FAIL: expected empty output, got:\n  {out[:200]}\n"
            f"  Fix: {description}"
        )
    elif expect_ok and "OK" not in out:
        failures.append(
            f"[{criterion_id}] FAIL: expected OK, got:\n  {out[:200]}\n"
            f"  Fix: {description}"
        )
    elif not expect_empty and not expect_ok and code != 0:
        failures.append(
            f"[{criterion_id}] FAIL:\n  {out[:200]}\n"
            f"  Fix: {description}"
        )


def check_py(criterion_id: str, description: str, code: str) -> None:
    """Run a Python snippet as a check. AssertionError = failure."""
    globs: dict = {"ROOT": ROOT, "re": re}
    try:
        exec(compile(code.strip(), "<check>", "exec"), globs)
    except AssertionError as e:
        failures.append(f"[{criterion_id}] FAIL: {e or description}\n  Fix: {description}")
    except Exception as e:
        failures.append(f"[{criterion_id}] ERROR: {e}\n  Fix: {description}")


# ─────────────────────────────────────────────────────────────────────────────
# FOUNDATION — Gap #6: stop_reason + max_tokens tracking
# ─────────────────────────────────────────────────────────────────────────────

def phase_foundation() -> None:

    # ── stop-reason-types ────────────────────────────────────────────────────

    check(
        "stop-reason-types.1",
        "stopReason must appear in compiled dist/packages/ai/agent-mcp-types/domain.d.ts",
        "grep -rq 'stopReason' dist/packages/ai/agent-mcp-types/domain.d.ts",
    )

    check_py(
        "stop-reason-types.2",
        "maxTokens must be a field of TokenUsage interface in domain.ts (not only ProviderConfig)",
        """
txt = (ROOT / 'packages/ai/agent-mcp-types/src/domain.ts').read_text()
m = re.search(r'export interface TokenUsage \\{[^}]+\\}', txt, re.DOTALL)
assert m, 'TokenUsage interface not found in domain.ts'
assert 'maxTokens' in m.group(), 'maxTokens not in TokenUsage interface block'
""",
    )

    check(
        "stop-reason-types.3",
        "CONTEXT_WINDOW_EXCEEDED must be in packages/ai/agent-mcp-types/src/errors.ts",
        "grep -q 'CONTEXT_WINDOW_EXCEEDED' packages/ai/agent-mcp-types/src/errors.ts",
    )

    check(
        "stop-reason-types.4",
        "agent-mcp-types must build successfully",
        "npx nx build agent-mcp-types 2>&1 | grep -q 'Successfully ran'",
    )

    check_py(
        "stop-reason-types.5",
        "PROVIDER_TIMEOUT must be in packages/ai/agent-mcp-types/src/errors.ts",
        """
txt = (ROOT / 'packages/ai/agent-mcp-types/src/errors.ts').read_text()
assert 'PROVIDER_TIMEOUT' in txt, 'PROVIDER_TIMEOUT not found in agent-mcp-types/src/errors.ts'
""",
    )

    check_py(
        "stop-reason-types.6",
        "PROVIDER_AUTH_ERROR must be in packages/ai/agent-mcp-types/src/errors.ts",
        """
txt = (ROOT / 'packages/ai/agent-mcp-types/src/errors.ts').read_text()
assert 'PROVIDER_AUTH_ERROR' in txt, 'PROVIDER_AUTH_ERROR not found in agent-mcp-types/src/errors.ts'
""",
    )

    check_py(
        "stop-reason-types.7",
        "PROVIDER_RATE_LIMITED must be in packages/ai/agent-mcp-types/src/errors.ts",
        """
txt = (ROOT / 'packages/ai/agent-mcp-types/src/errors.ts').read_text()
assert 'PROVIDER_RATE_LIMITED' in txt, 'PROVIDER_RATE_LIMITED not found in agent-mcp-types/src/errors.ts'
""",
    )

    check_py(
        "stop-reason-types.8",
        "cacheReadTokens must be in the TokenUsage interface in domain.ts",
        """
txt = (ROOT / 'packages/ai/agent-mcp-types/src/domain.ts').read_text()
m = re.search(r'export interface TokenUsage \\{[^}]+\\}', txt, re.DOTALL)
assert m, 'TokenUsage interface not found in domain.ts'
assert 'cacheReadTokens' in m.group(), 'cacheReadTokens not in TokenUsage interface block'
""",
    )

    # ── provider-stop-reason ─────────────────────────────────────────────────

    check(
        "provider-stop-reason.1",
        "OpenAI provider must access finish_reason from choice",
        "grep -q 'finish_reason' packages/ai/agent-mcp/src/providers/openai.ts",
    )

    check(
        "provider-stop-reason.2",
        "OpenAI provider must include stopReason in usage return",
        "grep -q 'stopReason' packages/ai/agent-mcp/src/providers/openai.ts",
    )

    check(
        "provider-stop-reason.3",
        "Anthropic provider must access stop_reason from response",
        "grep -qE 'response\\.stop_reason|\\.stop_reason' packages/ai/agent-mcp/src/providers/anthropic.ts",
    )

    check(
        "provider-stop-reason.4",
        "Anthropic provider must include stopReason in usage return",
        "grep -q 'stopReason' packages/ai/agent-mcp/src/providers/anthropic.ts",
    )

    # ── schema-migration ─────────────────────────────────────────────────────

    check(
        "schema-migration.1",
        "stop_reason column must be defined in taskUsageTable in schema.ts",
        "grep -q 'stop_reason' packages/ai/agent-mcp/src/db/schema.ts",
    )

    check(
        "schema-migration.2",
        "max_tokens column must be defined in taskUsageTable in schema.ts",
        "grep -q 'max_tokens' packages/ai/agent-mcp/src/db/schema.ts",
    )

    check_py(
        "schema-migration.3",
        "At least 3 drizzle migration .sql files must exist",
        """
sql_files = list((ROOT / 'packages/ai/agent-mcp/drizzle').glob('*.sql'))
assert len(sql_files) >= 3, f'expected >=3 migrations, got {len(sql_files)}: {[f.name for f in sql_files]}'
""",
    )

    check_py(
        "schema-migration.4",
        "At least one new migration file must add stop_reason and max_tokens columns",
        """
drizzle_dir = ROOT / 'packages/ai/agent-mcp/drizzle'
sql_files = sorted(drizzle_dir.glob('*.sql'))
new_files = [f for f in sql_files if '0000_' not in f.name and '0001_' not in f.name]
assert new_files, 'No new migration file found beyond 0001_task_usage.sql'
combined = '\\n'.join(f.read_text() for f in new_files)
assert 'stop_reason' in combined, f'stop_reason not in any of: {[f.name for f in new_files]}'
assert 'max_tokens' in combined, f'max_tokens not in any of: {[f.name for f in new_files]}'
""",
    )

    # ── usage-plugin-stop ────────────────────────────────────────────────────

    check(
        "usage-plugin-stop.1",
        "stopReason or stop_reason must appear in usage-plugin.ts",
        "grep -qE 'stopReason|stop_reason' packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
    )

    check(
        "usage-plugin-stop.2",
        "maxTokens or max_tokens must appear in usage-plugin.ts",
        "grep -qE 'maxTokens|max_tokens' packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
    )

    check(
        "usage-plugin-stop.3",
        "Severity map or most-severe logic must appear in usage-plugin.ts",
        "grep -qE 'SEVERITY|severity|mostSevere|most_severe' packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
    )

    # ── usage-report-stop ────────────────────────────────────────────────────

    check(
        "usage-report-stop.1",
        "stopReason must appear in usageSummarySchema in validation/usage.ts",
        "grep -q 'stopReason' packages/ai/agent-mcp/src/validation/usage.ts",
    )

    check(
        "usage-report-stop.2",
        "stopReason aggregation must appear in summarise() in tools/usage.ts",
        "grep -q 'stopReason' packages/ai/agent-mcp/src/tools/usage.ts",
    )

    # ── env-var-fixes ────────────────────────────────────────────────────────

    check(
        "env-var-fixes.1",
        "AGENT_MCP_MAX_DEPTH must be read in packages/ai/agent-mcp/src/index.ts",
        "grep -q 'AGENT_MCP_MAX_DEPTH' packages/ai/agent-mcp/src/index.ts",
    )

    check(
        "env-var-fixes.2",
        "AGENT_MCP_MAX_TOOL_LOOPS must be read in packages/ai/agent-mcp/src/index.ts",
        "grep -q 'AGENT_MCP_MAX_TOOL_LOOPS' packages/ai/agent-mcp/src/index.ts",
    )

    check(
        "env-var-fixes.3",
        "AGENT_MCP_DEFAULT_MAX_TOKENS must be defined or read in packages/ai/agent-mcp/src/index.ts",
        "grep -q 'AGENT_MCP_DEFAULT_MAX_TOKENS' packages/ai/agent-mcp/src/index.ts",
    )

    check_py(
        "env-var-fixes.4",
        "MAX_TOOL_LOOPS default value in index.ts must be '50' not '10'",
        """
txt = (ROOT / 'packages/ai/agent-mcp/src/index.ts').read_text()
m = re.search(r'AGENT_MCP_MAX_TOOL_LOOPS[^)]+\\?\\?\\s*["\\'](\\d+)["\\']]', txt)
if not m:
    m = re.search(r'AGENT_MCP_MAX_TOOL_LOOPS.*?["\\'](\\d+)["\\']]', txt)
# Simpler: just check that '50' appears near AGENT_MCP_MAX_TOOL_LOOPS
idx = txt.find('AGENT_MCP_MAX_TOOL_LOOPS')
assert idx != -1, 'AGENT_MCP_MAX_TOOL_LOOPS not found in index.ts'
window = txt[idx:idx+200]
assert '"50"' in window or "'50'" in window, (
    f'Default for AGENT_MCP_MAX_TOOL_LOOPS is not "50" in index.ts. Window: {window[:100]}'
)
""",
    )

    # ── cache-tokens ─────────────────────────────────────────────────────────

    check_py(
        "cache-tokens.1",
        "cacheReadTokens must be in the TokenUsage interface in agent-mcp-types/src/domain.ts",
        """
txt = (ROOT / 'packages/ai/agent-mcp-types/src/domain.ts').read_text()
m = re.search(r'export interface TokenUsage \\{[^}]+\\}', txt, re.DOTALL)
assert m, 'TokenUsage interface not found in domain.ts'
assert 'cacheReadTokens' in m.group(), 'cacheReadTokens not in TokenUsage interface block'
""",
    )

    check(
        "cache-tokens.2",
        "cache_read_input_tokens must be forwarded in anthropic.ts",
        "grep -q 'cache_read_input_tokens' packages/ai/agent-mcp/src/providers/anthropic.ts",
    )

    check_py(
        "cache-tokens.3",
        "cache_read_input_tokens column must be defined in schema.ts",
        """
txt = (ROOT / 'packages/ai/agent-mcp/src/db/schema.ts').read_text()
assert 'cache_read_input_tokens' in txt, 'cache_read_input_tokens column not found in schema.ts'
""",
    )

    check_py(
        "cache-tokens.4",
        "A drizzle migration must add cache token columns",
        """
drizzle_dir = ROOT / 'packages/ai/agent-mcp/drizzle'
sql_files = sorted(drizzle_dir.glob('*.sql'))
new_files = [f for f in sql_files if '0000_' not in f.name and '0001_' not in f.name]
assert new_files, 'No new migration file found beyond 0001_task_usage.sql'
# At least one new migration must have cache columns (may be same file as stop_reason)
combined = '\\n'.join(f.read_text() for f in new_files)
assert 'cache_read_input_tokens' in combined, 'cache_read_input_tokens not in any new migration file'
""",
    )

    check_py(
        "cache-tokens.5",
        "AGENT_MCP_DEFAULT_MAX_TOKENS must be used as max_tokens fallback in anthropic.ts (hard-coded 4096 removed)",
        """
txt = (ROOT / 'packages/ai/agent-mcp/src/providers/anthropic.ts').read_text()
assert 'AGENT_MCP_DEFAULT_MAX_TOKENS' in txt, (
    'AGENT_MCP_DEFAULT_MAX_TOKENS not used in anthropic.ts — old hard-coded 4096 fallback must be replaced'
)
""",
    )

    # ── provider-error-codes ─────────────────────────────────────────────────

    check(
        "provider-error-codes.1",
        "PROVIDER_TIMEOUT must be in errorCodeSchema in packages/ai/agent-mcp/src/validation/errors.ts",
        "grep -q 'PROVIDER_TIMEOUT' packages/ai/agent-mcp/src/validation/errors.ts",
    )

    check(
        "provider-error-codes.2",
        "PROVIDER_AUTH_ERROR must be in errorCodeSchema in packages/ai/agent-mcp/src/validation/errors.ts",
        "grep -q 'PROVIDER_AUTH_ERROR' packages/ai/agent-mcp/src/validation/errors.ts",
    )

    check(
        "provider-error-codes.3",
        "PROVIDER_RATE_LIMITED must be in errorCodeSchema in packages/ai/agent-mcp/src/validation/errors.ts",
        "grep -q 'PROVIDER_RATE_LIMITED' packages/ai/agent-mcp/src/validation/errors.ts",
    )

    check(
        "provider-error-codes.4",
        "PROVIDER_TIMEOUT must be thrown in orchestrator.ts (replaces PROVIDER_ERROR for timeout path)",
        "grep -q 'PROVIDER_TIMEOUT' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    check(
        "provider-error-codes.5",
        "PROVIDER_AUTH_ERROR must be referenced in packages/ai/agent-mcp/src/providers/anthropic.ts",
        "grep -q 'PROVIDER_AUTH_ERROR' packages/ai/agent-mcp/src/providers/anthropic.ts",
    )

    # ── claudecli-auth-fix ───────────────────────────────────────────────────

    check(
        "claudecli-auth-fix.1",
        "buildSubprocessEnv catch block in claudecli.ts must log warn and capture keychain error (no longer empty)",
        "grep -qE 'warn|keychainError' packages/ai/agent-mcp/src/providers/claudecli.ts",
    )

    check(
        "claudecli-auth-fix.2",
        "PROVIDER_AUTH_ERROR must be thrown in claudecli.ts when finalResult is empty",
        "grep -q 'PROVIDER_AUTH_ERROR' packages/ai/agent-mcp/src/providers/claudecli.ts",
    )

    check(
        "claudecli-auth-fix.3",
        "PROVIDER_AUTH_ERROR must be thrown in anthropic.ts when keychain fails and no env var fallback exists",
        "grep -q 'PROVIDER_AUTH_ERROR' packages/ai/agent-mcp/src/providers/anthropic.ts",
    )

    check(
        "claudecli-auth-fix.4",
        "Recovery instruction must appear in claudecli.ts (contains setup-token or authTokenEnv)",
        "grep -qE 'setup-token|authTokenEnv' packages/ai/agent-mcp/src/providers/claudecli.ts",
    )

    check(
        "claudecli-auth-fix.5",
        "Recovery instruction must appear in anthropic.ts (contains setup-token or authTokenEnv)",
        "grep -qE 'setup-token|authTokenEnv' packages/ai/agent-mcp/src/providers/anthropic.ts",
    )

    # ── robustness-fixes ─────────────────────────────────────────────────────

    check(
        "robustness-fixes.1",
        "Empty tool-call guard must be present in orchestrator.ts (checks toolCalls.length === 0 when stopReason === tool_calls)",
        "grep -qE 'toolCalls.*length|length.*toolCalls' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    check_py(
        "robustness-fixes.2",
        "Cancellation detection in orchestrator.ts must NOT use message.includes('cancelled') to detect cancellation",
        """
txt = (ROOT / 'packages/ai/agent-mcp/src/engine/orchestrator.ts').read_text()
# Look for the old fragile isCancelled detection: message.includes("cancelled") as a cancellation signal.
# New correct form is: signal.aborted — throw sites may still say "cancelled" in their message text.
old_pattern = re.search(r'message\\.includes\\(.*cancelled', txt)
assert not old_pattern, (
    'Old fragile cancellation detection found: message.includes("cancelled"). '
    'Replace with signal.aborted check.'
)
""",
    )

    # ── reference conformance ────────────────────────────────────────────────

    check(
        "audit-foundation.ref-provider-usage-extraction",
        "Providers must bind sdkUsage before mapping (not inline response.usage access in return)",
        "grep -q 'sdkUsage' packages/ai/agent-mcp/src/providers/openai.ts",
    )

    check(
        "audit-foundation.ref-drizzle-upsert-increment",
        "UsagePlugin UPSERT must still use sql template literal for token accumulation",
        "grep -q 'sql' packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
    )


# ─────────────────────────────────────────────────────────────────────────────
# CONTEXT — Gap #7: CONTEXT_WINDOW_EXCEEDED + sliding-window truncation
# ─────────────────────────────────────────────────────────────────────────────

def phase_context() -> None:
    phase_foundation()

    # ── context-error-code ───────────────────────────────────────────────────

    check(
        "context-error-code.1",
        "CONTEXT_WINDOW_EXCEEDED must be in errorCodeSchema in validation/errors.ts",
        "grep -q 'CONTEXT_WINDOW_EXCEEDED' packages/ai/agent-mcp/src/validation/errors.ts",
    )

    check(
        "context-error-code.2",
        "CONTEXT_WINDOW_EXCEEDED must be thrown in orchestrator.ts",
        "grep -q 'CONTEXT_WINDOW_EXCEEDED' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    check_py(
        "context-error-code.3",
        "Context-length error patterns must map to CONTEXT_WINDOW_EXCEEDED, not PROVIDER_ERROR",
        """
txt = (ROOT / 'packages/ai/agent-mcp/src/engine/orchestrator.ts').read_text()
patterns = list(re.finditer(r'context_length_exceeded|prompt is too long', txt))
for m in patterns:
    window = txt[max(0, m.start() - 400) : m.end() + 400]
    assert 'CONTEXT_WINDOW_EXCEEDED' in window, (
        f'Pattern "{m.group()}" at char {m.start()} is not inside a CONTEXT_WINDOW_EXCEEDED throw'
    )
""",
    )

    # ── sliding-window ───────────────────────────────────────────────────────

    check(
        "sliding-window.1",
        "AGENT_MCP_CONTEXT_LIMIT must be read in orchestrator.ts",
        "grep -q 'AGENT_MCP_CONTEXT_LIMIT' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    check(
        "sliding-window.2",
        "windowMessages or estimateTokens function must exist in session-store.ts",
        "grep -qE 'windowMessages|estimateTokens' packages/ai/agent-mcp/src/store/session-store.ts",
    )

    check(
        "sliding-window.3",
        "AGENT_MCP_CONTEXT_LIMIT must be documented in packages/ai/agent-mcp/CLAUDE.md",
        "grep -q 'AGENT_MCP_CONTEXT_LIMIT' packages/ai/agent-mcp/CLAUDE.md",
    )

    check_py(
        "sliding-window.4",
        "windowMessages must reference 'system' role to preserve system messages",
        """
txt = (ROOT / 'packages/ai/agent-mcp/src/store/session-store.ts').read_text()
assert 'windowMessages' in txt, 'windowMessages function not found in session-store.ts'
assert 'system' in txt, 'system role not referenced in session-store.ts'
""",
    )


# ─────────────────────────────────────────────────────────────────────────────
# FINAL — full convergence: build, tests, version, docs
# ─────────────────────────────────────────────────────────────────────────────

def phase_final() -> None:
    phase_context()

    # ── dod.17: tests pass (live data: in-memory SQLite via drizzle) ─────────
    check(
        "audit-final.dod.17",
        "All agent-mcp unit tests must pass — npx nx test agent-mcp exits 0",
        "npx nx test agent-mcp",
    )

    # ── dod.18: version bumped ────────────────────────────────────────────────
    check_py(
        "audit-final.dod.18",
        "agent-mcp package.json must be at version 0.0.6",
        """
import json
p = json.loads((ROOT / 'packages/ai/agent-mcp/package.json').read_text())
assert p['version'] == '0.0.6', f"expected 0.0.6, got {p['version']}"
""",
    )

    # ── dod.19: new env vars and error codes documented ──────────────────────
    check_py(
        "audit-final.dod.19",
        "All new env vars and error codes must be documented in CLAUDE.md",
        """
txt = (ROOT / 'packages/ai/agent-mcp/CLAUDE.md').read_text()
for item in [
    'AGENT_MCP_CONTEXT_LIMIT',
    'AGENT_MCP_DEFAULT_MAX_TOKENS',
    'CONTEXT_WINDOW_EXCEEDED',
    'PROVIDER_TIMEOUT',
    'PROVIDER_AUTH_ERROR',
    'PROVIDER_RATE_LIMITED',
]:
    assert item in txt, f'{item} not found in CLAUDE.md'
""",
    )

    # ── dod.14: CLAUDE.md documents OAuth/claudecli keychain trust requirement
    check_py(
        "audit-final.dod.14",
        "CLAUDE.md must document useClaudeOauth keychain trust requirement or fallback",
        """
txt = (ROOT / 'packages/ai/agent-mcp/CLAUDE.md').read_text()
assert 'useClaudeOauth' in txt or 'keychain' in txt, (
    'CLAUDE.md does not mention useClaudeOauth or keychain trust context requirement'
)
""",
    )

    # ── dod.20: recovery instruction documented in CLAUDE.md ────────────────
    check_py(
        "audit-final.dod.20",
        "CLAUDE.md must document the manual ANTHROPIC_AUTH_TOKEN injection workflow",
        """
txt = (ROOT / 'packages/ai/agent-mcp/CLAUDE.md').read_text()
assert 'ANTHROPIC_AUTH_TOKEN' in txt, (
    'CLAUDE.md does not document ANTHROPIC_AUTH_TOKEN injection workflow'
)
""",
    )

    # ── code-review sentinel ──────────────────────────────────────────────────
    check_py(
        "code-review.1",
        "Code review sentinel file must exist: docs/plan/0.0.6/.code-review-complete",
        """
sentinel = ROOT / 'docs/plan/0.0.6/.code-review-complete'
assert sentinel.exists(), (
    'Code review has not been completed. Create the sentinel file when satisfied: '
    'touch docs/plan/0.0.6/.code-review-complete'
)
""",
    )

    # ── reference conformance ─────────────────────────────────────────────────
    check(
        "audit-final.ref-tool-error-throw",
        "CONTEXT_WINDOW_EXCEEDED must be thrown via new ToolError() pattern",
        "grep -qE 'new ToolError.*CONTEXT_WINDOW_EXCEEDED|CONTEXT_WINDOW_EXCEEDED.*ToolError' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # ── positive: full build succeeds ────────────────────────────────────────
    check(
        "audit-final.build",
        "Full agent-mcp build must succeed — npx nx build agent-mcp exits 0",
        "npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'",
    )

    # ── CONTEXT_WINDOW_EXCEEDED documented ───────────────────────────────────
    check(
        "audit-final.dod.8",
        "CONTEXT_WINDOW_EXCEEDED must appear in packages/ai/agent-mcp/CLAUDE.md (error codes table)",
        "grep -q 'CONTEXT_WINDOW_EXCEEDED' packages/ai/agent-mcp/CLAUDE.md",
    )

    # ── docs-and-publish readiness ────────────────────────────────────────────
    # [docs-and-publish.1] same version check as dod.18 — explicit ID for criterion match
    check_py(
        "docs-and-publish.1",
        "agent-mcp/package.json must be at version 0.0.6",
        """
import json
p = json.loads((ROOT / 'packages/ai/agent-mcp/package.json').read_text())
assert p['version'] == '0.0.6', f"expected 0.0.6, got {p['version']}"
""",
    )

    # [docs-and-publish.2] live npm registry check — run only when npm is available
    check(
        "docs-and-publish.2",
        "npm info @adhd/agent-mcp version must return 0.0.6 (run after publish)",
        "npm info @adhd/agent-mcp version 2>/dev/null | grep -q '0.0.6'",
    )


# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--phase",
        choices=["foundation", "context", "final"],
        required=True,
    )
    args = parser.parse_args()

    {"foundation": phase_foundation, "context": phase_context, "final": phase_final}[
        args.phase
    ]()

    if failures:
        print(f"\n{args.phase.upper()} AUDIT FAILED: {len(failures)} failure(s):\n")
        for f in failures:
            print(f)
        sys.exit(len(failures))
    else:
        print(f"\n{args.phase.upper()} AUDIT PASSED: all criteria verified.")
        sys.exit(0)


if __name__ == "__main__":
    main()
