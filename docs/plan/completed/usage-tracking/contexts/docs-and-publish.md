# State: docs-and-publish

**Phase:** release
**Kind:** work
**Depends on:** code-review

## Goal

Update the package documentation to reflect the completed implementation, bump the version, and publish to npm. The published package is what the `acceptance-test` state will use.

## Semantic distillation

Four documentation updates required before publish:

1. **GAPS.md item #4** — change "Token usage tracking | No token count stored per task or session" to reflect implemented status. Mark the row clearly (e.g. add "**Status: implemented**" or strike/update the description).

2. **ROADMAP.md Phase 1** — mark item #2 ("Token usage tracking") as complete. Add `✓` or `(implemented)` inline. The item currently reads: `2. **Token usage tracking** — CORE, straightforward, high necessity`.

3. **INSTALL.md** — add `usage_query` to the MCP tool reference section and to the `permissions.allow` list (`"mcp__agent-mcp__usage_query"`). Update the `usage` guide entry to `guide` (`"mcp__agent-mcp__guide"`).

4. **README.md** — add `usage_query` to the tool reference table with a short description. Update `usage` → `guide` in the tools table.

After documentation is complete: bump version, rebuild, publish per PUBLISHING.md.

Current version: `0.0.4`. Bump to `0.0.5` (patch — additive feature, no breaking changes).

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/GAPS.md",
             "packages/ai/agent-mcp/ROADMAP.md",
             "packages/ai/agent-mcp/INSTALL.md",
             "packages/ai/agent-mcp/README.md",
             "packages/ai/agent-mcp/package.json"]
```

## Contract promise

**Modified:**
- `GAPS.md` — item #4 marked implemented
- `ROADMAP.md` — Phase 1 item #2 marked complete
- `INSTALL.md` — `usage_query` tool documented, permissions entry added; `usage` → `guide` updated
- `README.md` — `usage_query` in tool reference table; `usage` → `guide` updated
- `package.json` — version `0.0.4` → `0.0.5`

**Added:** nothing
**Deleted:** nothing

## Acceptance criteria

```bash
# [docs-and-publish.1] GAPS.md item #4 marked implemented
cd /Users/nix/dev/node/adhd
grep -A3 'Token usage tracking\|token usage tracking' packages/ai/agent-mcp/GAPS.md | grep -qi 'implement\|done\|complete'

# [docs-and-publish.2] ROADMAP.md Phase 1 item #2 marked complete
grep -i 'Token usage tracking' packages/ai/agent-mcp/ROADMAP.md | grep -qi '✓\|implemented\|complete\|done'

# [docs-and-publish.3] INSTALL.md includes usage_query
grep -q 'usage_query' packages/ai/agent-mcp/INSTALL.md

# [docs-and-publish.4] README.md includes usage_query
grep -q 'usage_query' packages/ai/agent-mcp/README.md

# [docs-and-publish.5] package.json version bumped to 0.0.5
grep -q '"version": "0.0.5"' packages/ai/agent-mcp/package.json

# [docs-and-publish.6] npm-published version matches local package.json
node -e "
  const local = require('./packages/ai/agent-mcp/package.json').version;
  const { execSync } = require('child_process');
  const pub = execSync('npm view @adhd/agent-mcp version 2>/dev/null').toString().trim();
  if (local !== pub) { console.error('local ' + local + ' != npm ' + pub); process.exit(1); }
  console.log('versions match: ' + local);
"
```

## Commit points

**R1 (plan write):** Plan file edits committed.

**R2 (docs):** After documentation updates:
```
docs(agent-mcp): mark token usage tracking implemented in GAPS/ROADMAP; add usage_query and guide to INSTALL/README
```

**R3 (version bump):** After `npm version patch`:
```
chore(agent-mcp): bump to 0.0.5
```
Rebuild: `npx nx build agent-mcp` then publish: `npm publish dist/packages/ai/agent-mcp --access public`

## Notes

Publish command (from PUBLISHING.md):
```bash
cd /Users/nix/dev/node/adhd
npm version patch --prefix packages/ai/agent-mcp
npx nx build agent-mcp
npm publish dist/packages/ai/agent-mcp --access public
# If OTP required: add --otp=<code>
```

Verify after publish:
```bash
npm view @adhd/agent-mcp dist-tags.latest
# should return "0.0.5"
```

The `.mcp.json` `agent-mcp-published` entry uses `@adhd/agent-mcp@latest` — it will pick up the new version automatically on next `/mcp` reconnect.
