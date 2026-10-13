# Worktree Policy

Worktrees are created, merged, and cleaned up **only** with these scripts. Never by hand, and never by symlinking `node_modules`.

| Step   | Command                                                         |
| ------ | --------------------------------------------------------------- |
| Create | `scripts/worktree-setup.sh --bl <backlog-id>` (or `<name>`)     |
| Merge  | `scripts/worktree-merge.sh <worktree \| branch \| backlog-id>`  |
| Clean  | `scripts/worktree-cleanup.sh [<worktree \| branch \| id> ...]`  |

Each script prints what to do next when it stops. Follow its output.
