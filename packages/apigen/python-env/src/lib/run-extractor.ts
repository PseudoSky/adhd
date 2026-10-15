// run-extractor.ts — spawn `apigen_python.extractor --emit-json` and parse
// its stdout into Operation[].
//
// WHY THIS EXISTS: this was a byte-for-byte duplicate ("phase 1" of the
// two-phase extract/serve split) hand-copied into `apigen-plugin-py-flask`,
// `apigen-plugin-py-grpc`, and the cross-host response-envelope integration
// test — each with only its error-message prefix changed. AGENTS.md §8's
// "Two-Use Refactor Rule" applies once a THIRD copy showed up. `apigen-
// python-env` is the correct home: both py-* plugins and the cross-host test
// already depend on it (or, for the test, on nothing lower — see below), it
// has zero internal deps of its own today, and it already owns the sibling
// `resolvePythonPkgDir()` shared helper for the exact same reason (see that
// function's doc comment).
//
// The Python interpreter and package dir are passed in explicitly rather
// than resolved here: the two plugins spawn the MANAGED venv (`ensurePythonEnv`
// from this same package), while the cross-host test deliberately spawns bare
// `python3` against its own resolved `packages/apigen/python` to stay
// self-contained (see that test file's module docstring) — this helper stays
// agnostic to which interpreter policy the caller chose.

import { spawn } from 'node:child_process'
import type { Operation } from '@adhd/apigen-core-client'

/**
 * Default wall-clock budget for one `--emit-json` extraction: 120 000 ms. Extraction
 * of a typical module finishes in well under a second; the budget exists so a hung
 * extractor fails the caller instead of stalling it indefinitely.
 */
export const DEFAULT_EXTRACTOR_TIMEOUT_MS = 120_000

/** Options for {@link runExtractorEmitJson}. */
export interface IRunExtractorOptions {
  /**
   * Wall-clock limit in milliseconds for the extractor process. On expiry the child is
   * killed (SIGKILL) and the promise rejects with a timeout error naming the command.
   * Must be a positive finite number. Defaults to {@link DEFAULT_EXTRACTOR_TIMEOUT_MS}.
   */
  timeoutMs?: number
}

/**
 * Runs `python -m apigen_python.extractor --emit-json` to completion and
 * parses its stdout into `Operation[]` — phase 1 of the py-flask / py-grpc
 * two-phase spawn (extract-only, then `project()`, then serve). This is a
 * short-lived process: it exits as soon as extraction finishes, well before
 * the actual server process is spawned.
 *
 * @param python      - Absolute path (or bare name, e.g. `'python3'`) of the
 *                       interpreter to spawn.
 * @param pythonPkgDir - Absolute path to `packages/apigen/python` (used as
 *                       both `cwd` and `PYTHONPATH` for the subprocess).
 * @param modulePath   - Absolute path to the `.py` module to extract from.
 * @param namespace    - Namespace passed to the extractor's `--namespace` flag.
 * @param label        - Short caller identifier (e.g. `'py-flask'`, `'py-grpc'`)
 *                       prefixed onto error messages so failures are traceable
 *                       to their caller.
 * @param options      - {@link IRunExtractorOptions}; `timeoutMs` bounds the run.
 */
export function runExtractorEmitJson(
  python: string,
  pythonPkgDir: string,
  modulePath: string,
  namespace: string,
  label: string,
  options: IRunExtractorOptions = {},
): Promise<Operation[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTOR_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(
      new RangeError(`${label}: extractor timeoutMs must be a positive finite number, got ${timeoutMs}`),
    )
  }
  const args = ['-m', 'apigen_python.extractor', modulePath, '--namespace', namespace, '--emit-json']
  const commandLine = [python, ...args].join(' ')

  return new Promise<Operation[]>((resolve, reject) => {
    const proc = spawn(python, args, {
      cwd: pythonPkgDir,
      env: { ...process.env, PYTHONPATH: pythonPkgDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    // A hung extractor must not hold the promise (and the caller's CI step) forever.
    // On expiry the child is SIGKILLed; the rejection is deferred to 'exit' so the
    // child is provably gone by the time the caller observes the error.
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(
          new Error(
            `${label}: extractor --emit-json timed out after ${timeoutMs} ms and was killed ` +
              `(command: ${commandLine})${stderr ? `:\n${stderr}` : ''}`,
          ),
        )
        return
      }
      if (code !== 0) {
        reject(new Error(`${label}: extractor --emit-json exited with code ${code}:\n${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as Operation[])
      } catch (err) {
        reject(
          new Error(
            `${label}: extractor --emit-json produced invalid JSON (${(err as Error).message}):\n${stdout}`,
          ),
        )
      }
    })
  })
}
