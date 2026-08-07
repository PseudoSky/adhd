---
package: "@adhd/cdp-connection"
path: "/Users/nix/dev/ai/scratch/agent-browser/adhd/cdp-connection"
root: "scratch"
language: "node"
self_internal: false
current_scope_behavior: "hardcoded"
env_vars: ["CHROME_PATH"]
writes: [
  {
    "path": "~/Library/Application Support/Google/Chrome-CDP",
    "kind": "data",
    "purpose": "Chrome user data directory (profiles, cache, cookies — isolates automation from everyday browsing)"
  }
]
config_files: []
logging:
  has_logging: true
  logger: "console"
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: "adhoc"
  maps_to_env_logs: false
supported_by_env: "partial"
gaps: ["G1"]
value: "high"
effort: "low"
recommend: "adopt"
---

## Current State

**Environment variables:**
- `CHROME_PATH` · mentioned in error message (line 90) as a user-facing suggestion, but not actually read from `process.env` — the code accepts `chromePath` as an option parameter only

**Writes:**
- `~/Library/Application Support/Google/Chrome-CDP` · created by `mkdirSync(…, { recursive: true })` at lines 52 and 95 · purpose: dedicated Chrome user data directory to isolate test/automation browsing from the user's everyday profile · default used if `opts.profileDir` not supplied

**Config files:**
- None — all configuration via function parameters and hardcoded platform-specific paths

**Scope behavior:**
- Hardcoded macOS paths (`~/Library/Application Support/Google/Chrome-CDP`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`)
- Linux: looks for `google-chrome` / `chromium` / `chromium-browser` in PATH
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Port hardcoded to 9222 by default, overrideable via `opts.port`

## Proposed EnvironmentSpec

```typescript
const spec: EnvironmentSpec<{
  cdpPort: number
  chromePath: string
  chromeProfileDir: string
  chromeArgs: string[]
}> = {
  config: [
    {
      key: "cdpPort",
      type: "integer",
      env: "ADHD_CDP_CONNECTION_PORT",
      default: 9222,
      minimum: 1024,
      maximum: 65535,
      at: "runtime",
    },
    {
      key: "chromePath",
      type: "string",
      env: "ADHD_CDP_CONNECTION_CHROME_PATH",
      default: "<platform-detected>", // darwin: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
      at: "runtime",
      secret: false,
    },
    {
      key: "chromeProfileDir",
      type: "string",
      env: "ADHD_CDP_CONNECTION_PROFILE_DIR",
      default: "~/.adhd/cdp-connection/default/data/chrome-profile",
      at: "runtime",
    },
    {
      key: "chromeArgs",
      type: "array",
      items: "string",
      env: "ADHD_CDP_CONNECTION_EXTRA_ARGS",
      default: [],
      at: "runtime",
    },
  ],
  dirs: [
    {
      key: "chromeData",
      kind: "data",
      namespace: "default",
    },
  ],
  files: [
    {
      key: "chromeProfile",
      in: "chromeData",
      name: "chrome-profile",
      share: "singleton",
    },
  ],
  envPrefixOverride: "ADHD_CDP_CONNECTION",
};
```

## Gap Detail

**G1:** `CHROME_PATH` env var is suggested in the error message but not actually read from `process.env`. The code only accepts `opts.chromePath` as a function parameter. Under `@adhd/environment`, a single unified config (env var → field → default) would let callers omit the parameter entirely and have Chrome path auto-resolve from `ADHD_CDP_CONNECTION_CHROME_PATH` or platform-default, reducing friction for ad-hoc scripts.

## Logging Audit

The package emits logs via `console.error` (line 145: `[cdp] Chrome not found on port ${port} — launching...`) when `!quiet`. However:

- **No persistent log files** — all output goes to stdout/stderr only.
- **Not structured** — plain text prefixed with `[cdp]`.
- **Error handling is adhoc** — try/catch blocks at lines 42, 190, 194 silently swallow errors (e.g., `which` / `lsof` / `fuser` failures) without logging; this makes debugging harder if the wrong Chrome binary is picked.
- **No benefit from `env.paths.logs`** — since this is a library (not a persistent service), it doesn't need a per-instance logs directory. However, if a consumer wraps multiple `launchChrome()` calls into a long-lived service, centralizing logs under `env.paths.logs` would help with rotation and multi-instance isolation.

## File-Location Table

| Current Path | Kind | New-Standard Path (global scope) | Env Accessor |
|---|---|---|---|
| `~/Library/Application Support/Google/Chrome-CDP` | data | `~/.adhd/cdp-connection/default/data/chrome-profile` | `env.files.chromeProfile` or `env.paths.chromeData/<file>` |

**Project-scope variant:** when `ADHD_ENV_SCOPE=project` or the cwd contains `.git`/`.adhd`, the same path resolves to `<projectRoot>/.adhd/cdp-connection/default/data/chrome-profile`, enabling per-project automation sandboxing.

**Note on multi-instance:** if multiple concurrent `launchChrome()` calls target the same profile directory, the first one wins (line 83: `isChromeReachable` returns early). To support true concurrency (each caller gets a separate profile/port), use `share: "per-instance"` and auto-derive the instance ID from a UUID or task ID.
