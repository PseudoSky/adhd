---
package: @adhd/sox-host-registry
path: /Users/nix/dev/ai/sox-ecosystem/libs/host-registry
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: [SOX_SANDBOX_ROOT, CODEX_HOME]
writes: [
  {path: ".claude/", kind: config, purpose: "project-scope Claude Code config root"},
  {path: "~/.claude/", kind: config, purpose: "user-scope Claude Code config root"},
  {path: ".claude/agents/", kind: state, purpose: "Claude agent declarations"},
  {path: ".claude/skills/", kind: state, purpose: "Claude skill definitions"},
  {path: ".claude/commands/", kind: state, purpose: "Claude slash commands"},
  {path: ".claude/rules/", kind: state, purpose: "Claude prompt-injection rules"},
  {path: ".claude/hooks/", kind: state, purpose: "Claude hook scripts (PostToolUse)"},
  {path: ".claude/settings.json", kind: config, purpose: "Claude settings, permissions, hooks config"},
  {path: ".claude/settings.local.json", kind: config, purpose: "Claude local setting overrides"},
  {path: ".claude/plugins/", kind: state, purpose: "Claude plugin registry"},
  {path: "CLAUDE.md", kind: config, purpose: "project-scope Claude agent instructions"},
  {path: "~/.claude/CLAUDE.md", kind: config, purpose: "user-scope Claude agent instructions"},
  {path: ".mcp.json", kind: config, purpose: "project MCP server definitions"},
  {path: "~/.claude.json", kind: config, purpose: "user MCP server defs + MCP trust allowlist"},
  {path: ".sox/", kind: state, purpose: "project-scope service registry"},
  {path: "~/.sox/", kind: state, purpose: "user-scope service registry"},
  {path: ".codex/", kind: config, purpose: "project-scope Codex config root"},
  {path: "~/.codex/", kind: config, purpose: "user-scope Codex config root (CODEX_HOME)"},
  {path: ".codex/config.toml", kind: config, purpose: "project Codex configuration"},
  {path: "~/.codex/config.toml", kind: config, purpose: "user Codex configuration"},
  {path: ".codex/skills/", kind: state, purpose: "project-scoped Codex skills (guard-test-4 compat)"},
  {path: "~/.codex/skills/", kind: state, purpose: "Codex skill definitions"},
  {path: "AGENTS.md", kind: config, purpose: "project-scope Codex agent instructions"},
  {path: "~/.codex/AGENTS.md", kind: config, purpose: "user-scope Codex agent instructions"},
  {path: "~/.agents/plugins/", kind: state, purpose: "personal Codex plugin marketplace"},
  {path: ".agents/plugins/", kind: state, purpose: "repo/team Codex plugin marketplace"},
  {path: ".opencode/", kind: config, purpose: "project-scope OpenCode config root"},
  {path: "~/.config/opencode/", kind: config, purpose: "user-scope OpenCode config root"},
  {path: ".opencode/agents/", kind: state, purpose: "OpenCode agent declarations"},
  {path: ".opencode/skills/", kind: state, purpose: "OpenCode skill definitions"},
  {path: ".opencode/tools/", kind: state, purpose: "OpenCode command tools"},
  {path: "opencode.json", kind: config, purpose: "project OpenCode MCP server definitions"},
  {path: "~/.config/opencode/opencode.json", kind: config, purpose: "user OpenCode MCP server definitions"}
]
config_files: [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "~/.claude.json", ".codex/config.toml", "~/.codex/config.toml", "opencode.json", "~/.config/opencode/opencode.json"]
supported_by_env: partial
gaps: [G1, G1]
value: med
effort: high
recommend: skip
---

## Current state

### Environment variables

- **SOX_SANDBOX_ROOT** · read in claude.ts, codex.ts, opencode.ts, internal.ts via getBase()/getCodexBase()/expandHome() · purpose: test/probe isolation; reroots user-scope paths under sandbox instead of home · no default (fallback: home directory)
- **CODEX_HOME** · read in codex.ts getCodexBase() · purpose: allow user to override Codex home directory · default: ~/.codex (standard Codex default)

### File/directory writes by host

**Claude Code host (claude.ts):**
- `.claude/` (project) / `~/.claude/` (user) — config root
- `.claude/{agents,skills,commands,rules}/` — declarative file-drop surfaces
- `.claude/hooks/` — hook script storage
- `.claude/settings.json` / `.claude/settings.local.json` — JSON config-merge for permissions, hooks, output-style
- `CLAUDE.md` (project / user home) — file-drop agent instructions
- `.mcp.json` (project root) — MCP server definitions (JSON config-merge)
- `~/.claude.json` (user home) — MCP server defs + `projects[<repo>].enabledMcpjsonServers` array (trust allowlist)
- `.claude/plugins/` — plugin registry

**Codex host (codex.ts):**
- `.codex/` (project) / `~CODEX_HOME/` (user, defaults to ~/.codex) — config root
- `.codex/config.toml` / `~/.codex/config.toml` — TOML config-merge for agents, MCP servers, hooks, permissions, subagents, theme, plugin toggles
- `.codex/skills/` (project) / `$CODEX_HOME/skills/` (user) — skill definitions (file-drop)
- `AGENTS.md` (project / user home) — file-drop agent instructions
- `~/.agents/plugins/marketplace.json` (personal) / `.agents/plugins/marketplace.json` (repo/team) — plugin registry

**OpenCode host (opencode.ts):**
- `.opencode/` (project) / `~/.config/opencode/` (user) — config root
- `.opencode/{agents,skills,tools}/` — file-drop surfaces
- `opencode.json` (project root) / `~/.config/opencode/opencode.json` (user) — JSON config-merge for MCP servers
- `.sox/` (project/user) — service registry for run-service capability

### Config files and scope cascade

- **Claude**: `.claude/settings.json` (project), `~/.claude/settings.json` (user), `.claude/settings.local.json` (local override); `.mcp.json` (project), `~/.claude.json` (user)
- **Codex**: `.codex/config.toml` (project, trust-restricted), `~/.codex/config.toml` (user, unrestricted)
- **OpenCode**: `opencode.json` (project), `~/.config/opencode/opencode.json` (user)

Scope resolution: **project > user > defaults** (cascade), with local overrides at `.claude/settings.local.json` for Claude.

### Scope and path decision logic

**Current approach (hardcoded + env vars):**
- Project paths: literal strings relative to workspace root (`.claude/`, `.codex/`, `.opencode/`)
- User paths: absolute home-relative, constructed with `os.homedir()` or environment-variable overrides (`SOX_SANDBOX_ROOT` → test isolation, `CODEX_HOME` → user-configured Codex home)
- Local overrides: same directory as project scope (e.g., `.claude/settings.local.json` coexists with `.claude/settings.json`)

**Sandbox isolation [inv:sandbox-isolation]:**
- `SOX_SANDBOX_ROOT` environment variable (test/probe mode only) reroots all user-scope absolute paths under a sandbox directory
- Reads `SOX_SANDBOX_ROOT` at call time (runtime, not module load) to honor env vars set after import
- Note: `SOX_ECOSYSTEM_HOME` (the data root) is explicitly NOT rerouted here [inv:data-root-never-reroutes]

---

## Proposed `EnvironmentSpec`

This package is a **registry/configuration declarator**, not a consumer of environment configuration. However, if it were to adopt `@adhd/environment` for its own path management, the spec would be:

```typescript
const hostRegistrySpec = {
  config: {
    // Codex: allow user to override home directory
    codexHome: {
      type: 'string' as const,
      env: 'CODEX_HOME',
      default: path.join(os.homedir(), '.codex'),
      at: 'runtime',
    },
  },
  dirs: {
    // Project surfaces (relative)
    claudeProject: { kind: 'config', path: '.claude' },
    codexProject: { kind: 'config', path: '.codex' },
    opencodeProject: { kind: 'config', path: '.opencode' },
    soxProject: { kind: 'state', path: '.sox' },

    // User surfaces (absolute, under home or SOX_SANDBOX_ROOT)
    claudeUser: { kind: 'config', path: '~/.claude' },
    codexUser: { kind: 'config', path: '~${config.codexHome}' },
    opencodeUser: { kind: 'config', path: '~/.config/opencode' },
    soxUser: { kind: 'state', path: '~/.sox' },
  },
  files: {
    // Config files (multiple hosts, multiple formats)
    claudeSettings: { in: 'claudeProject', name: 'settings.json' },
    claudeSettingsLocal: { in: 'claudeProject', name: 'settings.local.json' },
    mcpJsonProject: { in: 'project', name: '.mcp.json' },
    mcpJsonUser: { in: 'claudeUser', name: '.claude.json' },
    codexConfigProject: { in: 'codexProject', name: 'config.toml' },
    codexConfigUser: { in: 'codexUser', name: 'config.toml' },
    opencodeJsonProject: { in: 'project', name: 'opencode.json' },
    opencodeJsonUser: { in: 'opencodeUser', name: 'opencode.json' },
  },
} as const satisfies EnvironmentSpec<typeof hostRegistrySpec>;
```

---

## Gap detail

**G1 (non-ADHD_ env vars × 2):**
- `SOX_SANDBOX_ROOT` — test/isolation switch, not ADHD-scoped; `env.isEnvNameAllowed('SOX_SANDBOX_ROOT')` would reject it under the strict prefix model. This env var crosses host registries (Claude, Codex, OpenCode all honor it) and is intentionally outside the ADHD_ namespace to avoid conflicting with potential future third-party tools.
- `CODEX_HOME` — Codex user configuration override (Codex's own convention, not ADHD-scoped); `env.isEnvNameAllowed('CODEX_HOME')` would reject it.

Both are read at runtime (not via fixed field specs) and cross-cut multiple hosts. The `@adhd/environment` cascade model assumes all user-scoped config vars follow a single prefix; these predate that model and cannot be unified without breaking Codex's own conventions.

---

## File-location table

| Current path | Kind | Proposed env.paths/env.files key |
|---|---|---|
| `.claude/` | config | claudeProject |
| `~/.claude/` | config | claudeUser |
| `.claude/agents/` | state | claudeProject/agents |
| `.claude/skills/` | state | claudeProject/skills |
| `.claude/commands/` | state | claudeProject/commands |
| `.claude/rules/` | state | claudeProject/rules |
| `.claude/hooks/` | state | claudeProject/hooks |
| `.claude/plugins/` | state | claudeProject/plugins |
| `.claude/settings.json` | config | claudeSettings |
| `.claude/settings.local.json` | config | claudeSettingsLocal |
| `CLAUDE.md` (project) | config | mcpJsonProject (via .mcp.json parent) |
| `~/.claude/CLAUDE.md` | config | claudeUser/CLAUDE.md |
| `.mcp.json` | config | mcpJsonProject |
| `~/.claude.json` | config | mcpJsonUser |
| `.codex/` | config | codexProject |
| `~/.codex/` (or `$CODEX_HOME/`) | config | codexUser |
| `.codex/config.toml` | config | codexConfigProject |
| `~/.codex/config.toml` | config | codexConfigUser |
| `.codex/skills/` | state | codexProject/skills |
| `~/.codex/skills/` | state | codexUser/skills |
| `AGENTS.md` (project) | config | codexProject/AGENTS.md |
| `~/.codex/AGENTS.md` | config | codexUser/AGENTS.md |
| `~/.agents/plugins/` | state | (uses HOME, not sandbox — plugins out of scope) |
| `.agents/plugins/` | state | (project-scoped, not under .codex) |
| `.opencode/` | config | opencodeProject |
| `~/.config/opencode/` | config | opencodeUser |
| `.opencode/agents/` | state | opencodeProject/agents |
| `.opencode/skills/` | state | opencodeProject/skills |
| `.opencode/tools/` | state | opencodeProject/tools |
| `opencode.json` | config | opencodeJsonProject |
| `~/.config/opencode/opencode.json` | config | opencodeJsonUser |
| `.sox/` | state | soxProject |
| `~/.sox/` | state | soxUser |

---

## Recommendation: SKIP

**Rationale:** This package is a **registry/declarator** that defines where soxe extensions are installed on various hosts. It feeds install-engine's capability engine. If this package adopted `@adhd/environment`, it would invert the dependency — the registry would become a *consumer* of environment config, risking circular coupling.

The env-var set is small and already well-isolated via `SOX_SANDBOX_ROOT` (for tests) and `CODEX_HOME` (Codex's own convention). The path management is explicit and per-host.

**When to revisit:** If a future `apply-surfaces` engine (the inverse of `declarativeInstall`) needs to read and apply host surfaces via a unified cascade, THAT tool would be a candidate for adopting `@adhd/environment` as a *consumer* — this registry would remain the *definition* layer.
