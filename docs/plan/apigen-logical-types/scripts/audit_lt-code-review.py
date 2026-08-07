#!/usr/bin/env python3
"""
audit_lt-code-review.py — Deterministic gate for the lt-code-review state.

Reads docs/plan/apigen-logical-types/references/code-review.md and exits 0
iff the verdict line matches ^VERDICT:\\s*APPROVED (case-insensitive).
Exits non-zero otherwise.

Usage (from workspace root):
    python3 docs/plan/apigen-logical-types/scripts/audit_lt-code-review.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REVIEW_FILE = Path(__file__).resolve().parents[1] / "references" / "code-review.md"
VERDICT_PATTERN = re.compile(r"^#{0,6}\s*VERDICT:\s*APPROVED\b", re.IGNORECASE | re.MULTILINE)
CHANGES_PATTERN = re.compile(r"^#{0,6}\s*VERDICT:\s*CHANGES_REQUESTED\b", re.IGNORECASE | re.MULTILINE)


def main() -> int:
    """Return 0 on APPROVED verdict, non-zero otherwise."""
    if not REVIEW_FILE.exists():
        print(f"ERROR: Review artifact not found at {REVIEW_FILE}", file=sys.stderr)
        print("VERDICT: MISSING")
        print("SUMMARY: lt-code-review audit artifact does not exist — gate RED")
        return 2

    content = REVIEW_FILE.read_text(encoding="utf-8")

    # Check for CHANGES_REQUESTED first (explicit rejection).
    if CHANGES_PATTERN.search(content):
        # Extract the last VERDICT line for display.
        lines = content.splitlines()
        verdict_lines = [l for l in lines if re.match(r"#{0,6}\s*VERDICT:", l, re.IGNORECASE)]
        last = verdict_lines[-1].lstrip("#").strip() if verdict_lines else "VERDICT: CHANGES_REQUESTED"
        print(f"{last}")
        print("SUMMARY: Code review gate RED — changes were requested before advancing.")
        return 1

    # Check for APPROVED.
    if VERDICT_PATTERN.search(content):
        # Extract the VERDICT line for display.
        lines = content.splitlines()
        verdict_lines = [l for l in lines if re.match(r"VERDICT:", l, re.IGNORECASE)]
        last = verdict_lines[-1] if verdict_lines else "VERDICT: APPROVED"
        print(f"{last}")
        print(
            "SUMMARY: Code review gate GREEN — implementation approved; "
            "non-blocking findings logged for backlog."
        )
        return 0

    # No recognizable verdict found.
    print("VERDICT: MISSING (no ^VERDICT: line found in review artifact)")
    print(
        f"SUMMARY: Could not parse a verdict from {REVIEW_FILE}. "
        "The file must contain a line matching ^VERDICT: APPROVED or "
        "^VERDICT: CHANGES_REQUESTED."
    )
    return 3


if __name__ == "__main__":
    sys.exit(main())
