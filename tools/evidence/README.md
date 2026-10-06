# tools/evidence

Evidence tooling that makes test and backlog claims attributable. Gated by
`nx run @adhd/source:evidence-gates` (`evidence.spec.mjs`, every tool with a negative control).

| tool | what it does |
| --- | --- |
| `check-suite-tree-state.mjs [--fresh] -- <cmd…>` | runs a suite and prints the tree-state attribution quote (`HEAD`, dirty-before/after, delta, `cache-replay: yes\|no`). Exit 1 if the suite left the tree changed, 3 if `--fresh` and the result was an nx cache replay, otherwise the suite's own exit code. |
| `commit-mine.mjs snapshot` / `commit -m <msg>` | records a baseline of every dirty path (new untracked files included), then commits only the paths changed since — never another agent's in-flight work. The baseline lives in the git dir. |
| `audit-closed-items.mjs --input <items.json>` | reports `resolved`/`closed` backlog items with no citation naming a sha that resolves to a commit. Pipe `adhd-backlog backlog query` output in. Exit 1 when any item is uncited. |
