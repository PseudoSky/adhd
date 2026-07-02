// python-env.ts — resolve the Python interpreter apigen's py-* plugins spawn.
//
// WHY THIS EXISTS: the py-grpc / py-flask plugins used to spawn bare `python3`
// from PATH and hope its site-packages happened to contain grpcio +
// grpcio-reflection. On any machine where that wasn't true the host process
// died on import — the serve/run path was broken by environment, not by code,
// and nothing in the repo could fix it because the dependency lived outside
// the repo's packaging.
//
// THE DISTRIBUTABLE ANSWER: `packages/apigen/python/pyproject.toml` already
// declares the grpc dependencies as a `[project.optional-dependencies]` extra.
// This module makes that packaging the single source of truth: it provisions a
// MANAGED VENV by `pip install`-ing the apigen-python package (with the
// requested extras) into `~/.adhd/apigen/pyvenv`, and returns that venv's
// interpreter. Re-provisioning happens automatically when pyproject.toml
// changes (content-hash stamp). Consumers never depend on the ambient PATH
// python having the right site-packages.
//
// Resolution order:
//   1. `APIGEN_PYTHON` env var — explicit interpreter override (power users, CI
//      images that pre-provision). Used as-is, never validated beyond existence.
//   2. The managed venv (created/refreshed on demand, cross-process locked).
//
// Failure is LOUD: if no base interpreter exists or pip fails, the error says
// exactly what to install. Never silently falls back to a bare `python3`.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** Result of {@link ensurePythonEnv}. */
export interface IPythonEnv {
  /** Absolute path to the interpreter the caller should spawn. */
  python: string
  /** Absolute path to the managed venv dir ('' when APIGEN_PYTHON overrode it). */
  venvDir: string
  /** Absolute path to the apigen-python package sources (PYTHONPATH target). */
  pythonPkgDir: string
}

export interface IEnsurePythonEnvOptions {
  /**
   * Extras from apigen-python's pyproject `[project.optional-dependencies]`
   * to provision (e.g. `['grpc']`). Sorted + deduped into the stamp so the
   * venv is refreshed when the requested extras change.
   */
  extras?: string[]
  /**
   * Override the managed-venv root (default `~/.adhd/apigen`). Tests point
   * this at `tmp/` so they never touch the user's real environment.
   * Honours the `APIGEN_PYENV_HOME` env var when the option is absent.
   */
  envHome?: string
  /** Bound (ms) on waiting for another process's in-flight bootstrap. */
  lockTimeoutMs?: number
}

/**
 * Locate the directory containing the `apigen_python` package sources.
 *
 * Primary: `<this file>/../../../python` (source layout:
 * packages/apigen/python-env/src/lib → packages/apigen/python).
 * Fallback: walk up from __dirname looking for `packages/apigen/python`
 * (covers the vite-bundled CLI, where __dirname is the bundle output dir).
 * (Shared by py-grpc / py-flask — previously duplicated in each plugin.)
 */
export function resolvePythonPkgDir(fromDir?: string): string {
  const base = fromDir ?? __dirname
  const primary = path.resolve(base, '..', '..', '..', 'python')
  if (fs.existsSync(path.join(primary, 'apigen_python'))) return primary

  let dir = base
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'packages', 'apigen', 'python')
    if (fs.existsSync(path.join(candidate, 'apigen_python'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Last resort: return the primary candidate and let the caller fail clearly.
  return primary
}

/** Candidate base interpreters, best first. pyproject requires >= 3.11. */
const BASE_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3']

/** Minimum (major, minor) demanded by apigen-python's pyproject. */
const MIN_PY = [3, 11] as const

function interpreterVersion(bin: string): [number, number] | undefined {
  const r = spawnSync(bin, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (r.status !== 0 || !r.stdout) return undefined
  const [maj, min] = r.stdout.trim().split('.').map(Number)
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return undefined
  return [maj, min]
}

/** Find a base interpreter (>= 3.11, with venv module) to seed the managed venv. */
function findBaseInterpreter(): string {
  for (const cand of BASE_CANDIDATES) {
    const v = interpreterVersion(cand)
    if (!v) continue
    if (v[0] > MIN_PY[0] || (v[0] === MIN_PY[0] && v[1] >= MIN_PY[1])) return cand
  }
  throw new Error(
    `apigen-python-env: no Python >= ${MIN_PY.join('.')} found on PATH ` +
    `(tried: ${BASE_CANDIDATES.join(', ')}). Install Python ${MIN_PY.join('.')}+ ` +
    `or set APIGEN_PYTHON to a provisioned interpreter.`,
  )
}

function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3')
}

/**
 * Venv stamp: records the pyproject content hash and the set of extras the
 * venv was provisioned with. The venv is healthy for a request when the
 * pyproject hash matches AND the requested extras are a SUBSET of the
 * provisioned ones — extras are monotonic (union on rebuild), so concurrent
 * consumers with different extras (py-flask wants none, py-grpc wants 'grpc')
 * never thrash the shared venv by rebuilding it without each other's deps.
 */
interface IVenvStamp {
  pyprojectHash: string
  extras: string[]
}

function pyprojectHash(pythonPkgDir: string): string {
  const pyproject = fs.readFileSync(path.join(pythonPkgDir, 'pyproject.toml'))
  return createHash('sha256').update(pyproject).digest('hex')
}

function readStamp(stampFile: string): IVenvStamp | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampFile, 'utf8')) as IVenvStamp
    if (typeof parsed.pyprojectHash === 'string' && Array.isArray(parsed.extras)) return parsed
  } catch {
    /* absent or corrupt → unhealthy */
  }
  return undefined
}

/**
 * Cross-process exclusive section via atomic `mkdir`. A second process waits
 * (polling) for the holder to finish rather than double-provisioning; a stale
 * lock (holder crashed) is broken after `timeoutMs`.
 */
function withDirLock<T>(lockDir: string, timeoutMs: number, fn: () => T): T {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false })
      break // acquired
    } catch {
      if (Date.now() > deadline) {
        // Holder is presumed dead — break the lock and take it.
        try { fs.rmdirSync(lockDir) } catch { /* raced with holder finishing */ }
        continue
      }
      // Busy-wait with a coarse sleep (bootstrap is a startup-time path).
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 250)'], { timeout: 5_000 })
    }
  }
  try {
    return fn()
  } finally {
    try { fs.rmdirSync(lockDir) } catch { /* already gone */ }
  }
}

/**
 * Resolve the interpreter for apigen's Python hosts, provisioning the managed
 * venv from `apigen-python`'s own pyproject.toml when needed.
 *
 * Synchronous by design — this is a startup-time path and its consumers
 * (plugin `run()` bodies, serve pre-flight) need a settled interpreter before
 * spawning children.
 */
export function ensurePythonEnv(opts: IEnsurePythonEnvOptions = {}): IPythonEnv {
  const pythonPkgDir = resolvePythonPkgDir()

  // 1. Explicit override.
  const override = process.env['APIGEN_PYTHON']
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`apigen-python-env: APIGEN_PYTHON points to a missing file: ${override}`)
    }
    return { python: override, venvDir: '', pythonPkgDir }
  }

  // 2. Managed venv.
  const requested = [...new Set(opts.extras ?? [])].sort()
  const envHome =
    opts.envHome ?? process.env['APIGEN_PYENV_HOME'] ?? path.join(os.homedir(), '.adhd', 'apigen')
  const venvDir = path.join(envHome, 'pyvenv')
  const stampFile = path.join(venvDir, '.apigen-stamp')
  const wantHash = pyprojectHash(pythonPkgDir)
  const python = venvPython(venvDir)

  const healthy = (): boolean => {
    if (!fs.existsSync(python)) return false
    const stamp = readStamp(stampFile)
    if (!stamp || stamp.pyprojectHash !== wantHash) return false
    return requested.every(e => stamp.extras.includes(e))
  }

  if (healthy()) return { python, venvDir, pythonPkgDir }

  fs.mkdirSync(envHome, { recursive: true })
  const lockDir = path.join(envHome, 'pyvenv.lock')
  const lockTimeoutMs = opts.lockTimeoutMs ?? 300_000

  return withDirLock(lockDir, lockTimeoutMs, () => {
    // Another process may have provisioned while we waited for the lock.
    if (healthy()) return { python, venvDir, pythonPkgDir }

    // Union the previously provisioned extras with the request so a rebuild
    // never DROPS deps another consumer relies on (extras are monotonic).
    const prior = readStamp(stampFile)
    const extras = [...new Set([...(prior?.extras ?? []), ...requested])].sort()

    // (Re)create from scratch — a half-provisioned venv is worse than a slow one.
    fs.rmSync(venvDir, { recursive: true, force: true })

    const base = findBaseInterpreter()
    const mkVenv = spawnSync(base, ['-m', 'venv', venvDir], { encoding: 'utf8', timeout: 120_000 })
    if (mkVenv.status !== 0) {
      throw new Error(
        `apigen-python-env: "${base} -m venv" failed (exit ${mkVenv.status}):\n${mkVenv.stderr}`,
      )
    }

    // Install apigen-python (+extras) from its OWN packaging — pyproject.toml
    // is the single source of truth for what the Python host needs.
    const spec = extras.length ? `${pythonPkgDir}[${extras.join(',')}]` : pythonPkgDir
    const pipInstall = spawnSync(
      python,
      ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', spec],
      { encoding: 'utf8', timeout: 600_000 },
    )
    if (pipInstall.status !== 0) {
      throw new Error(
        `apigen-python-env: pip install "${spec}" failed (exit ${pipInstall.status}):\n` +
        `${pipInstall.stderr}\nstdout:\n${pipInstall.stdout}`,
      )
    }

    const stamp: IVenvStamp = { pyprojectHash: wantHash, extras }
    fs.writeFileSync(stampFile, JSON.stringify(stamp))
    return { python, venvDir, pythonPkgDir }
  })
}
