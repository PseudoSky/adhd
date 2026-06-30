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

# 3. README.md — scaffold a starter README so the package ships one on npm.
README_FILE="$PACKAGE_DIR/README.md"
if [[ ! -f "$README_FILE" ]]; then
  cat > "$README_FILE" <<RMEOF
# $SCOPE/$NAME

> TODO: one-line description of \`$NAME\` (layer:$LAYER, platform:$PLATFORM).

\`\`\`bash
npm install $SCOPE/$NAME
\`\`\`
RMEOF
  echo "  ✅ scaffolded $README_FILE"
fi

# 3.5 .eslintrc.json — add vite.config.* exclusion to ignorePatterns.
#     The Nx-generated scaffold does not exclude vite config files, so the
#     @typescript-eslint/no-var-requires rule fires on every require('node:fs')
#     inside the README-copy plugin. Every existing package in the repo already
#     ignores these files. This patch brings new scaffolds into parity.
ESLINTRC="$PACKAGE_DIR/.eslintrc.json"
if [[ -f "$ESLINTRC" ]]; then
  node - "$ESLINTRC" <<'JSEOF'
const fs = require('fs');
const path = process.argv[2];
const json = JSON.parse(fs.readFileSync(path, 'utf8'));
if (json.ignorePatterns && !json.ignorePatterns.some(p => p === 'vite.config.ts' || p === 'vite.config.*')) {
  json.ignorePatterns.push('vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts');
  fs.writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ✅ patched ${path}: added vite.config.* to ignorePatterns`);
} else {
  console.log(`  ℹ️  ${path}: vite exclusion already present, skipped`);
}
JSEOF
fi

# 4. vite.config.ts — ship README.md into dist.
#    @nx/vite:build ignores the project.json 'assets' option, and packages are published
#    from dist/{projectRoot}, so without this the README never reaches npm. This inline
#    plugin copies <root>/README.md into the build outDir on every clean build.
if [[ -f "$VITE_CONFIG" ]]; then
  node - "$VITE_CONFIG" <<'JSEOF'
const fs = require('fs');
const path = process.argv[2];
let s = fs.readFileSync(path, 'utf8');
if (!s.includes('apigen-copy-readme')) {
  const m = s.match(/outDir:\s*['"]([^'"]+)['"]/);
  const outDir = m ? m[1] : 'dist';
  const plugin =
    "    {\n" +
    "      // ship README.md into dist (npm page) — @nx/vite:build ignores project.json assets\n" +
    "      name: 'apigen-copy-readme',\n" +
    "      apply: 'build',\n" +
    "      closeBundle() {\n" +
    "        const fs = require('node:fs'), p = require('node:path');\n" +
    "        const src = p.resolve(__dirname, 'README.md');\n" +
    "        if (!fs.existsSync(src)) return;\n" +
    "        const out = p.resolve(__dirname, '" + outDir + "');\n" +
    "        fs.mkdirSync(out, { recursive: true });\n" +
    "        fs.copyFileSync(src, p.join(out, 'README.md'));\n" +
    "      },\n" +
    "    },\n";
  s = s.replace(/(plugins:\s*\[\n)/, `$1${plugin}`);
  fs.writeFileSync(path, s);
  console.log(`  ✅ patched ${path}: copy-readme plugin (outDir=${outDir})`);
} else {
  console.log(`  ℹ️  ${path}: copy-readme plugin already present, skipped`);
}
JSEOF
fi

echo ""
echo "✅ Done — verify $PACKAGE_DIR/project.json tags and vite.config.ts before committing."