import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Inlined builtin default — written to a temp file when a concrete path is needed. */
const BUILTIN_DEFAULT = {
  compilerOptions: {
    target: 'ES2020',
    module: 'esnext',
    moduleResolution: 'bundler',
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
  },
} as const

/**
 * Resolve the shipped builtin default tsconfig as a concrete file path.
 *
 * In the bundled CLI (`index.js`, CJS) the `default-tsconfig.json` asset is copied
 * beside the entry, so we look it up via `__dirname`. When that asset is absent
 * (e.g. running from source under a test runner) we write {@link BUILTIN_DEFAULT}
 * to a temp file so callers always receive a real path.
 */
function builtinTsconfigPath(): string {
  // `__dirname` is defined in the CJS bundle that backs the published bin.
  const dir = typeof __dirname !== 'undefined' ? __dirname : ''
  if (dir) {
    const candidates = [
      path.join(dir, 'default-tsconfig.json'), // built: asset beside index.js
      path.join(dir, 'lib', 'default-tsconfig.json'),
      path.join(dir, '..', 'default-tsconfig.json'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  }
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-tsconfig-')),
    'tsconfig.json'
  )
  fs.writeFileSync(tmp, JSON.stringify(BUILTIN_DEFAULT, null, 2))
  return tmp
}

/** Walk up from `startDir` looking for the nearest `tsconfig.json`. */
function findNearestTsconfig(startDir: string): string | undefined {
  let dir = startDir
  // Bound the walk at the filesystem root.
  for (;;) {
    const candidate = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve the tsconfig that should drive schema generation for `sourceFile`.
 *
 * Precedence: explicit `--tsconfig` (absolute) → nearest `tsconfig.json` walking
 * up from the source's directory → shipped builtin default.
 *
 * @param sourceFile - Absolute path to the TypeScript source file.
 * @param explicit   - Optional `--tsconfig` flag value (resolved against cwd).
 * @returns Absolute path to a real tsconfig.json file.
 */
export function resolveTsconfig(sourceFile: string, explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  const nearest = findNearestTsconfig(path.dirname(path.resolve(sourceFile)))
  if (nearest) return nearest
  return builtinTsconfigPath()
}

/**
 * Resolve the package namespace (id) for a source file.
 *
 * Precedence: explicit `--namespace` → the folder name CONTAINING the tsconfig
 * (the `--tsconfig` dir if given, else the nearest `tsconfig.json` walking up) →
 * the source file's parent folder name (when no project tsconfig is found).
 *
 * @param sourceFile - Path to the TypeScript source file.
 * @param opts.namespace - Optional explicit `--namespace` override.
 * @param opts.tsconfig  - Optional explicit `--tsconfig` value.
 */
export function resolveNamespace(
  sourceFile: string,
  opts: { namespace?: string; tsconfig?: string } = {},
): string {
  if (opts.namespace) return opts.namespace
  const srcAbs = path.resolve(sourceFile)
  if (opts.tsconfig) {
    return path.basename(path.dirname(path.resolve(opts.tsconfig)))
  }
  const nearest = findNearestTsconfig(path.dirname(srcAbs))
  if (nearest) return path.basename(path.dirname(nearest))
  return path.basename(path.dirname(srcAbs))
}
