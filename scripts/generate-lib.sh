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