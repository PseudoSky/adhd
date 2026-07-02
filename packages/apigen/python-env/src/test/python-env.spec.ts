// python-env.spec.ts — real-venv behavioural tests (no mocks, no gating).
//
// These tests provision a REAL venv (into tmp/apigen/python-env-test, never the
// user's ~/.adhd) with no extras — a pure-python `pip install` of the local
// apigen-python package (~seconds). The grpc-extra path is exercised end-to-end
// by apigen-cli's live serve spec, which drives the real py-grpc host.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensurePythonEnv, resolvePythonPkgDir } from '../index'

const TMP_HOME = path.resolve(
  __dirname, '..', '..', '..', '..', '..', 'tmp', 'apigen', 'python-env-test',
)

describe('resolvePythonPkgDir', () => {
  it('locates the apigen_python sources', () => {
    const dir = resolvePythonPkgDir()
    expect(fs.existsSync(path.join(dir, 'apigen_python', 'grpc_server.py'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pyproject.toml'))).toBe(true)
  })
})

describe('ensurePythonEnv (real venv under tmp/)', () => {
  beforeAll(() => {
    fs.rmSync(TMP_HOME, { recursive: true, force: true })
  })
  afterAll(() => {
    fs.rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('provisions a venv whose interpreter can import apigen_python, and reuses it', () => {
    const env1 = ensurePythonEnv({ envHome: TMP_HOME })
    expect(fs.existsSync(env1.python)).toBe(true)
    expect(env1.venvDir.startsWith(TMP_HOME)).toBe(true)

    // The provisioned interpreter must import the packaged module — this is
    // the consumer outcome (a py-* plugin spawning `-m apigen_python.…`).
    const probe = spawnSync(env1.python, ['-c', 'import apigen_python; print("ok")'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(probe.status, probe.stderr).toBe(0)
    expect(probe.stdout.trim()).toBe('ok')

    // Second call: healthy stamp → same interpreter, venv untouched.
    const cfgBefore = fs.statSync(path.join(env1.venvDir, 'pyvenv.cfg')).mtimeMs
    const env2 = ensurePythonEnv({ envHome: TMP_HOME })
    expect(env2.python).toBe(env1.python)
    expect(fs.statSync(path.join(env1.venvDir, 'pyvenv.cfg')).mtimeMs).toBe(cfgBefore)
  }, 300_000)

  it('re-provisions when NEW extras are requested, and extras are monotonic (union, never dropped)', () => {
    const before = ensurePythonEnv({ envHome: TMP_HOME })
    const cfgBefore = fs.statSync(path.join(before.venvDir, 'pyvenv.cfg')).mtimeMs

    const after = ensurePythonEnv({ envHome: TMP_HOME, extras: ['jsonschema'] })
    // Rebuilt venv → fresh pyvenv.cfg, and the extra is importable.
    expect(fs.statSync(path.join(after.venvDir, 'pyvenv.cfg')).mtimeMs).not.toBe(cfgBefore)
    const probe = spawnSync(after.python, ['-c', 'import jsonschema; print("ok")'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(probe.status, probe.stderr).toBe(0)

    // A subsequent no-extras request must NOT rebuild (subset of provisioned)
    // and must NOT drop the already-installed extra — this is the guarantee
    // that concurrent py-flask (no extras) / py-grpc ('grpc') consumers can't
    // thrash the shared venv into a state missing each other's deps.
    const cfgAfter = fs.statSync(path.join(after.venvDir, 'pyvenv.cfg')).mtimeMs
    const again = ensurePythonEnv({ envHome: TMP_HOME })
    expect(fs.statSync(path.join(again.venvDir, 'pyvenv.cfg')).mtimeMs).toBe(cfgAfter)
    const stillThere = spawnSync(again.python, ['-c', 'import jsonschema; print("ok")'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(stillThere.status, stillThere.stderr).toBe(0)
  }, 300_000)
})

describe('APIGEN_PYTHON override', () => {
  const saved = process.env['APIGEN_PYTHON']
  afterAll(() => {
    if (saved === undefined) delete process.env['APIGEN_PYTHON']
    else process.env['APIGEN_PYTHON'] = saved
  })

  it('uses the override verbatim without provisioning', () => {
    process.env['APIGEN_PYTHON'] = process.execPath // any existing file
    const env = ensurePythonEnv({ envHome: path.join(TMP_HOME, 'never-created') })
    expect(env.python).toBe(process.execPath)
    expect(env.venvDir).toBe('')
    expect(fs.existsSync(path.join(TMP_HOME, 'never-created'))).toBe(false)
  })

  it('fails loudly when the override is missing', () => {
    process.env['APIGEN_PYTHON'] = '/nonexistent/python3'
    expect(() => ensurePythonEnv({ envHome: TMP_HOME })).toThrow(/APIGEN_PYTHON/)
  })
})
