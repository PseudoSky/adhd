# Git hooks (`core.hooksPath = .githooks`)

Version-controlled git hooks for this repo. No husky dependency — activation is via
`core.hooksPath`, set automatically by the root `package.json` `prepare` script on
`npm install`, or manually:

```bash
git config core.hooksPath .githooks
```

## Hooks

| Hook | What it does |
|---|---|
| `pre-commit` | Runs `nx affected -t lint --files=<staged>` on the projects touched by the staged changes; blocks the commit on lint errors. Bypass with `git commit --no-verify`. |

Hooks must be executable (`chmod +x .githooks/<hook>`).
