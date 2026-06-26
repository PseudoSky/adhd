#!/usr/bin/env python3
"""
audit_lt-architect-review.py — deterministic gate for the lt-architect-review state.

Reads the architect review artifact and exits:
  0 — verdict line is VERDICT: APPROVED
  1 — verdict line is VERDICT: CHANGES_REQUESTED, or no verdict line found

Exit code is the gate signal; stdout prints the verdict and a one-line summary.
"""

import re
import sys
import os

REVIEW_FILE = os.path.join(
    os.path.dirname(__file__),
    "..",
    "references",
    "architect-review.md",
)

VERDICT_RE = re.compile(r"^VERDICT:\s*(APPROVED|CHANGES_REQUESTED)\s*$", re.MULTILINE)


def main() -> int:
    path = os.path.normpath(REVIEW_FILE)

    if not os.path.isfile(path):
        print(f"ERROR: review artifact not found at {path}", file=sys.stderr)
        sys.exit(2)

    with open(path, encoding="utf-8") as fh:
        content = fh.read()

    match = VERDICT_RE.search(content)
    if match is None:
        print("VERDICT: (not found)")
        print(
            "FAIL: no VERDICT line matching "
            r"^VERDICT:\s*(APPROVED|CHANGES_REQUESTED) found in architect-review.md"
        )
        return 1

    verdict = match.group(1)
    print(f"VERDICT: {verdict}")

    if verdict == "APPROVED":
        print("PASS: architect review approved — no blocking findings")
        return 0
    else:
        print("FAIL: architect review requested changes — gate is red")
        return 1


if __name__ == "__main__":
    sys.exit(main())
