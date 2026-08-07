# Scenario: `audit-ref-policy-comment`

**Difficulty:** small / self-contained. **Real fix shipped in:** commit `23f957b`.

---

## The coding task

A Python audit check verifies that, in `orchestrator.ts`, the real `policy.check(`
call appears **before** the real concurrent dispatch `await Promise.all(...)`. The
invariant genuinely holds in the source, but the check reports **FAIL**.

```python
src = open('packages/ai/agent-mcp/src/engine/orchestrator.ts').read()
lines = src.splitlines()
policy_line = next((i for i, l in enumerate(lines) if 'policy.check(' in l), None)
promise_line = next((i for i, l in enumerate(lines) if 'Promise.all' in l), None)
if policy_line is None or promise_line is None:
    print('FAIL: not found'); sys.exit(1)
if policy_line >= promise_line:
    print('FAIL: policy.check not before Promise.all'); sys.exit(1)
print('OK')
```

Reality in `orchestrator.ts`: the real `policy.check(` is at line **388**, the real
`await Promise.all(` is at line **410** (invariant holds) — but a **comment** on
line **306** also contains the prose "Promise.all".

## The subtlety

`next(... if 'Promise.all' in l ...)` matches the **first** line containing the
substring — the line-306 comment — giving `promise_line = 306 < policy_line = 388`,
so the check fails. The audit is a string heuristic fooled by a comment.

## Raw correct solution (as shipped)

Skip comment lines before matching (and tighten the dispatch match):

```python
def is_comment(l):
    s = l.strip()
    return s.startswith('//') or s.startswith('*') or s.startswith('/*')
policy_line  = next((i for i,l in enumerate(lines) if 'policy.check(' in l and not is_comment(l)), None)
promise_line = next((i for i,l in enumerate(lines) if 'Promise.all' in l and not is_comment(l)), None)
# …unchanged ordering assertion…
```

## Rubric (0–5; "pass" = the check now passes on the real source for the right reason)

| # | Criterion | Weight |
|---|---|---|
| R1 | **Root cause** = the substring match hits the **comment** on line 306, not the real call | ★★★ |
| R2 | **Fix excludes comments** from the match (`//`, ideally `*` / `/*` too) so it tests real code | ★★★ |
| R3 | The fix **actually flips the result to OK** on the described source (line-388 policy < line-410 dispatch) | ★★ |
| R4 | No fabricated/irrelevant change (e.g. char-offset regex that still matches the comment; "multi-line statement" theories) | ★★ |
| R5 | Robust-ish (doesn't introduce new false negatives) | ★ |

**Common failure signatures observed:** missing the comment entirely and inventing a
"multi-line statements" cause (R1 ✗); switching to `re.finditer` over the raw string
which **still matches the comment** (R2/R3 ✗). Best result skipped `//`-lines and
tightened to `await Promise.all(` (near-parity; only missed `*`/`/*` block-comment lines).
