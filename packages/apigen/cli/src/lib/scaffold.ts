import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Resolution scaffolding emitted alongside generated plugin output so the files
 * run from an arbitrary directory (an OS tmpdir, a sibling repo, …) without the
 * consumer wiring up module resolution by hand.
 *
 * The generated entrypoints (`server.ts`, `cli.ts`) import:
 *   - real npm packages   — `@modelcontextprotocol/sdk/*`, `commander`
 *   - workspace packages  — `@adhd/apigen-runtime`, `@adhd/apigen-core`, …
 *   - the source fixture   — via an absolute path (already resolvable)
 *
 * When run from a directory with no `node_modules` ancestry and no tsconfig path
 * aliases, Node/tsx cannot resolve the bare specifiers. We close that gap by
 * emitting, into the out-dir (only when absent — never clobbering the user's
 * files):
 *   1. `package.json`   — declares the runtime deps the output actually imports.
 *   2. `tsconfig.json`  — maps `@adhd/*` to the workspace sources (absolute) +
 *                          sane moduleResolution so `tsx`/`tsc` resolve them.
 *   3. `node_modules`   — a symlink to the workspace `node_modules` so the npm
 *                          deps resolve immediately for an in-place run (offline,
 *                          deterministic; a published consumer would `npm install`).
 */

/** Runtime dep NAMES each plugin's generated output imports (versions resolved at emit time). */
const PLUGIN_RUNTIME_DEP_NAMES: Record<string, string[]> = {
  // mcp emits server.ts (stdio/http) + index.ts.
  mcp: ['@modelcontextprotocol/sdk', '@adhd/apigen-runtime'],
  // cli-output emits cli.ts.
  cli: ['commander', '@adhd/apigen-runtime'],
}

/**
 * Resolve the version range to declare for a dependency, reading the REAL version
 * from the workspace so the emitted package.json is publishable (a consumer runs
 * `npm install` against it once @adhd/apigen-* are published). `@adhd/*` versions
 * come from the package's own package.json; npm deps from the installed copy under
 * the workspace node_modules. Falls back to "*" only if a version can't be read.
 */
function resolveDepVersions(workspaceRoot: string | undefined, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const adhdSources = workspaceRoot ? workspaceAdhdSources(workspaceRoot) : new Map<string, string>()
  for (const name of names) {
    let version = '*'
    try {
      if (name.startsWith('@adhd/')) {
        const srcDir = adhdSources.get(name) // .../src
        const pkgJson = srcDir && path.join(path.dirname(srcDir), 'package.json')
        if (pkgJson && fs.existsSync(pkgJson)) {
          version = `^${JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version}`
        }
      } else if (workspaceRoot) {
        const pkgJson = path.join(workspaceRoot, 'node_modules', ...name.split('/'), 'package.json')
        if (fs.existsSync(pkgJson)) {
          version = `^${JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version}`
        }
      }
    } catch {
      version = '*'
    }
    out[name] = version
  }
  return out
}

/**
 * Walk up from `startDir` looking for the workspace root — the nearest ancestor
 * directory that has BOTH a `node_modules` folder and a `tsconfig.base.json`
 * (the Nx workspace marker). Returns `undefined` if none is found.
 */
function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'node_modules')) &&
      fs.existsSync(path.join(dir, 'tsconfig.base.json'))
    ) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Read `paths` from the workspace `tsconfig.base.json` and rewrite every target
 * as an absolute path rooted at `workspaceRoot`, so the emitted tsconfig resolves
 * `@adhd/*` from any out-dir regardless of relative depth.
 *
 * Returns an empty map if the base config is missing/unreadable; the caller still
 * emits a tsconfig (deps resolve via the node_modules links for npm packages).
 */
function absoluteWorkspacePaths(workspaceRoot: string): Record<string, string[]> {
  const base = path.join(workspaceRoot, 'tsconfig.base.json')
  let parsed: { compilerOptions?: { paths?: Record<string, string[]> } }
  try {
    parsed = JSON.parse(fs.readFileSync(base, 'utf8'))
  } catch {
    return {}
  }
  const rawPaths = parsed.compilerOptions?.paths ?? {}
  const out: Record<string, string[]> = {}
  for (const [alias, targets] of Object.entries(rawPaths)) {
    out[alias] = targets.map(t => path.resolve(workspaceRoot, t))
  }
  return out
}

/** Create a directory symlink, swallowing benign races/permission failures. */
function trySymlink(target: string, link: string): boolean {
  if (fs.existsSync(link) || !fs.existsSync(target)) return false
  try {
    fs.symlinkSync(target, link, 'dir')
    return true
  } catch {
    return false
  }
}

/**
 * Map each `@adhd/*` alias declared in the workspace `tsconfig.base.json` to the
 * SOURCE directory that backs it (the folder containing the alias' `index.ts`).
 * We resolve `@adhd/*` through the TypeScript SOURCE rather than the `dist`
 * bundles: the published dist of some packages bundles the TS compiler and
 * crashes at import-time outside the repo, whereas the source compiles cleanly
 * under `tsx`. Returns an empty map when the base config is missing/unreadable.
 */
function workspaceAdhdSources(workspaceRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  const base = path.join(workspaceRoot, 'tsconfig.base.json')
  let parsed: { compilerOptions?: { paths?: Record<string, string[]> } }
  try {
    parsed = JSON.parse(fs.readFileSync(base, 'utf8'))
  } catch {
    return map
  }
  for (const [alias, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
    if (!alias.startsWith('@adhd/')) continue
    const indexAbs = path.resolve(workspaceRoot, targets[0])
    const srcDir = path.dirname(indexAbs) // .../src
    if (fs.existsSync(srcDir)) map.set(alias, srcDir)
  }
  return map
}

/**
 * Build a real `node_modules` directory in `outputDir` that resolves BOTH:
 *   - every top-level entry of the workspace `node_modules` (npm deps incl.
 *     transitive — `commander`, `@modelcontextprotocol/sdk`, `pino`, `ts-morph`,
 *     …), linked as symlinks, and
 *   - every `@adhd/*` workspace package, COPIED in as TypeScript source under
 *     `node_modules/@adhd/<pkg>/src` with a generated `package.json` that points
 *     `exports`/`main` at `./src/index.ts`.
 *
 * The `@adhd/*` packages are COPIED (not symlinked) on purpose: Node resolves a
 * symlinked module's bare imports from the link's REAL path (the repo source),
 * whose `node_modules` ancestry has no `@adhd/*` — so a symlinked package's
 * transitive `@adhd` imports would fail unless the consumer passed
 * `--preserve-symlinks` (which a generated entrypoint cannot force). Copying the
 * source keeps every file's real path INSIDE the out-dir, so the whole `@adhd`
 * graph resolves through this one `node_modules` from any cwd, with no flags.
 *
 * Idempotent: skips a pre-existing `node_modules`.
 */
function linkNodeModules(outputDir: string, workspaceRoot: string): boolean {
  const nm = path.join(outputDir, 'node_modules')
  if (fs.existsSync(nm)) return false
  const workspaceNm = path.join(workspaceRoot, 'node_modules')
  if (!fs.existsSync(workspaceNm)) return false

  fs.mkdirSync(nm, { recursive: true })

  // Mirror every top-level entry of the workspace node_modules as a symlink.
  // Scoped dirs (@scope) get a real sub-dir whose members are individually
  // linked, so we can add our own @adhd packages without colliding. We skip the
  // workspace `@adhd` scope — those are not installed packages; we copy the
  // source ourselves below.
  for (const entry of fs.readdirSync(workspaceNm, { withFileTypes: true })) {
    const name = entry.name
    if (name === '.bin' || name === '.cache' || name === '@adhd') continue
    if (name.startsWith('@')) {
      // Scope dir: link each package inside it individually.
      const scopeSrc = path.join(workspaceNm, name)
      const scopeDest = path.join(nm, name)
      fs.mkdirSync(scopeDest, { recursive: true })
      for (const pkg of fs.readdirSync(scopeSrc, { withFileTypes: true })) {
        trySymlink(path.join(scopeSrc, pkg.name), path.join(scopeDest, pkg.name))
      }
    } else {
      trySymlink(path.join(workspaceNm, name), path.join(nm, name))
    }
  }

  // Copy each @adhd/* workspace package's SOURCE so bare `@adhd/*` specifiers —
  // and their transitive @adhd imports — resolve via this node_modules from any
  // cwd, with no resolver flags (see the doc comment above for why we copy).
  for (const [pkgName, srcDir] of workspaceAdhdSources(workspaceRoot)) {
    const pkgDir = path.join(nm, ...pkgName.split('/'))
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.cpSync(srcDir, path.join(pkgDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: pkgName,
          version: '0.0.0',
          type: 'module',
          main: './src/index.ts',
          exports: { '.': './src/index.ts' },
        },
        null,
        2,
      ),
    )
  }

  return true
}

/** Write `file` only when it does not already exist. Returns true if written. */
function writeIfAbsent(file: string, content: string): boolean {
  if (fs.existsSync(file)) return false
  fs.writeFileSync(file, content)
  return true
}

/**
 * Emit resolution scaffolding (`package.json`, `tsconfig.json`, `node_modules`
 * symlink) into `outputDir` for the given `pluginId`, so the generated entrypoint
 * runs from an arbitrary directory. Idempotent: never clobbers existing files.
 *
 * @param outputDir - The `--out-dir` the generated files were written to.
 * @param pluginId  - The plugin id (`mcp`, `cli`, …) — selects the dep set.
 * @returns The names of the scaffolding files written (for logging).
 */
export function emitResolutionScaffolding(
  outputDir: string,
  pluginId: string,
  opts: { linkWorkspace?: boolean } = {},
): string[] {
  const written: string[] = []
  const workspaceRoot = findWorkspaceRoot(outputDir) ?? findWorkspaceRoot(__dirname)
  const deps = resolveDepVersions(workspaceRoot, PLUGIN_RUNTIME_DEP_NAMES[pluginId] ?? [])

  // 1. package.json — the SHIPPED artifact: declares the real, publishable runtime
  //    deps at their workspace versions. Post-publish a consumer just `npm install`s
  //    this and the generated server/CLI runs anywhere.
  const pkgPath = path.join(outputDir, 'package.json')
  if (
    writeIfAbsent(
      pkgPath,
      JSON.stringify(
        {
          name: 'apigen-generated-output',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: deps,
        },
        null,
        2,
      ) + '\n',
    )
  ) {
    written.push('package.json')
  }

  // 2. tsconfig.json — sane moduleResolution for running the emitted .ts. The
  //    @adhd/* `paths` aliases are a PRE-PUBLISH LOCAL BRIDGE only (they hardcode
  //    absolute workspace paths), so they are emitted only under --link-workspace;
  //    the default (publishable) tsconfig resolves deps from node_modules post-install.
  const tsconfigPath = path.join(outputDir, 'tsconfig.json')
  const paths = opts.linkWorkspace && workspaceRoot ? absoluteWorkspacePaths(workspaceRoot) : {}
  if (
    writeIfAbsent(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'esnext',
            moduleResolution: 'bundler',
            esModuleInterop: true,
            strict: true,
            skipLibCheck: true,
            baseUrl: '.',
            paths,
          },
        },
        null,
        2,
      ) + '\n',
    )
  ) {
    written.push('tsconfig.json')
  }

  // 3. node_modules — PRE-PUBLISH LOCAL BRIDGE ONLY (opt-in via --link-workspace):
  //    links workspace npm deps + copies @adhd/* source so the output runs in place
  //    BEFORE @adhd/apigen-* are published. NOT part of the shipped artifact — a
  //    published consumer runs `npm install` against package.json instead.
  if (opts.linkWorkspace && workspaceRoot && linkNodeModules(outputDir, workspaceRoot)) {
    written.push('node_modules')
  }

  return written
}
