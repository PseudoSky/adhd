#!/bin/bash

# ==============================================================================
# NX UNIVERSAL ARCHITECTURE GENERATOR v4.0 (NPM-Safe)
# ==============================================================================
# Usage: ./generate-lib.sh <app|lib> <hyphenated-name> <layer> <platform>
# Example: ./generate-lib.sh lib query-engine data shared
# ==============================================================================

TYPE=$1
NAME=$2
LAYER=$3
PLATFORM=$4
SCOPE="@adhd" # Change this to your actual NPM scope

if [[ -z "$TYPE" || -z "$NAME" || -z "$LAYER" || -z "$PLATFORM" ]]; then
  echo "❌ Usage: ./generate-lib.sh <app|lib> <hyphenated-name> <layer> <platform>"
  exit 1
fi

# 1. APP GENERATION
if [[ "$TYPE" == "app" ]]; then
  echo "🚀 Generating APP: $NAME"
  if [[ "$PLATFORM" == "node" ]]; then
    npx nx g @nx/node:application $NAME --directory=apps/$NAME --tags="layer:entrypoints,platform:node" --no-interactive
  else
    npx nx g @nx/react:application $NAME --directory=apps/$NAME --tags="layer:entrypoints,platform:browser" --no-interactive
  fi
  exit 0
fi

# 2. LIBRARY GENERATION (NPM-Safe)
case $LAYER in
  tokens|ui-primitives|ui-composites) DIR="design-system" ;;
  shared|logic|data)                  DIR="shared" ;;
  components|workflows)               DIR="features" ;;
  test-logic|test-ui)                 DIR="testing" ;;
  ai|mcp)                             DIR="ai" ;;
  *)                                  DIR="other" ;;
esac

# agent-mcp plugin packages always live in packages/ai/ regardless of layer/platform.
# Do this check before the node-tools override below so it takes precedence.
if [[ "$NAME" == agent-mcp-* && "$DIR" != "ai" ]]; then DIR="ai"; fi

# Force 'node-tools' directory if it's node-only logic (non-plugin shared utilities)
if [[ "$PLATFORM" == "node" && "$DIR" == "shared" ]]; then DIR="node-tools"; fi

echo "🏗️  Generating LIB: $NAME"
echo "📦  Package: $SCOPE/$NAME"
echo "    Path packages/$DIR/$NAME"

npx nx g @nx/js:library $NAME \
  --directory packages/$DIR \
  --tags "layer:$LAYER,platform:$PLATFORM" \
  --importPath "$SCOPE/$NAME" \
  --publishable \
  --bundler vite \
  --no-interactive

PACKAGE_DIR="packages/$DIR/$NAME"

# ── Post-generation patches ────────────────────────────────────────────────────
#
# Fix two systematic gaps in the Nx-generated scaffolding:
#
# 1. vite.config.ts — add emptyOutDir:true
#    Without this, the dist/ directory is never cleared between builds. When you
#    bump package.json version and rebuild, the OLD dist/package.json survives
#    (vite only writes files it produces, not the package.json). Result: npm
#    publish ships the wrong version number.
#
# 2. project.json — add dependsOn:["build","test"] to nx-release-publish
#    Without this, `nx release publish` runs directly against whatever is already
#    in dist/ (possibly stale or untested). Adding dependsOn enforces a clean
#    build + passing tests before every publish.

VITE_CONFIG="$PACKAGE_DIR/vite.config.ts"
if [[ -f "$VITE_CONFIG" ]]; then
  python3 - "$VITE_CONFIG" <<'PYEOF'
import sys, re
path = sys.argv[1]
src  = open(path).read()
# Insert emptyOutDir: true immediately after the outDir: line (if not already present)
if 'emptyOutDir' not in src:
    src = re.sub(r'([ \t]*outDir:[^\n]+\n)', r'\1    emptyOutDir: true,\n', src)
    open(path, 'w').write(src)
    print(f"  ✅ patched {path}: added emptyOutDir: true")
else:
    print(f"  ℹ️  {path}: emptyOutDir already present, skipped")
PYEOF
fi

PROJECT_JSON="$PACKAGE_DIR/project.json"
if [[ -f "$PROJECT_JSON" ]]; then
  node - "$PROJECT_JSON" <<'JSEOF'
const fs   = require('fs');
const path = process.argv[2];   // argv[0]=node, argv[1]='-', argv[2]=path
const json = JSON.parse(fs.readFileSync(path, 'utf8'));
const pub  = json?.targets?.['nx-release-publish'];
if (pub && !pub.dependsOn) {
  pub.dependsOn = ['build', 'test'];
  fs.writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ✅ patched ${path}: added dependsOn:["build","test"] to nx-release-publish`);
} else {
  console.log(`  ℹ️  ${path}: dependsOn already present or no nx-release-publish target, skipped`);
}
JSEOF
fi

echo ""
echo "✅ Done — verify $PACKAGE_DIR/project.json tags and vite.config.ts before committing."