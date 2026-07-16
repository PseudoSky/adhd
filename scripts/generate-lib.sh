#!/usr/bin/env bash
# DEPRECATED 2026-07-16 — this script scaffolds into a package layout that NO LONGER EXISTS.
#
# It mapped <layer> -> packages/{design-system,shared,features,testing,ai,node-tools,other}.
# ALL SEVEN of those directories are gone (packages/ now holds domain folders:
# agent, apigen, data, decompile, dispatch, environment, ui-react, workspace).
# In particular its `ai|mcp) DIR="ai"` branch is the upstream source of the dead
# `packages/ai/*` paths that stranded the agent-* plan corpus (BUG-REGISTRY-001).
#
# The original body is preserved at scripts/generate-lib.sh.deprecated for reference.
# See docs/contributing/conventions/package-naming.md
set -euo pipefail
cat >&2 <<'MSG'
❌ scripts/generate-lib.sh is DEPRECATED and has been disabled.

   It emits packages/{shared,features,design-system,ai,...}/ — none of which exist.
   Its `ai` branch is what produced the dead packages/ai/* paths in the plan corpus.

✅ Use the workspace generator instead (it composes <domain>-<tier>-<name> for you):

     npx nx g @adhd/workspace-codegen-nx:<tier> \
       --name=<bare-name> --group=<domain> \
       --nxLayer=<layer> --platform=<node|browser|shared>

   tier   : base | core | store | engine | plugin | generator | query | types | entrypoint
   domain : see .adhd/workspace.json  (apigen agent data dispatch environment ui-react workspace)

   Pass the BARE name — the generator prepends <domain>-<tier>- itself.
     --name=migration --group=agent --tier engine  ->  packages/agent/agent-engine-migration
   Passing --name=agent-engine-migration yields agent-engine-agent-engine-migration.

   Always --dry-run first.

   Docs: docs/contributing/conventions/package-naming.md   (AGENTS.md §Package Scaffolding)
MSG
exit 1
