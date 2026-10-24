/**
 * @adhd/stealth-core-browser — src/lib/cdp/browser.ts
 *
 * Chrome process lifecycle: detect, launch, and kill a Chrome instance
 * with CDP remote debugging enabled.
 *
 * Follows the same pattern as cdp-capture/launch-chrome.sh:
 *   - No --enable-automation flag (avoids bot detection)
 *   - Dedicated user data directory (doesn't disturb everyday browsing)
 *   - Idempotent: no-ops if already running on the target port
 *   - Background process via nohup
 */

import { execSync, spawn } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { lifecycleError, type LifecycleError } from '../lifecycle/errors.js'
import { googleSupportDir } from '../helpers.js'
import { isChromeReachable } from './targets.js'
import { StealthCoreBrowserError } from '../../errors.js'

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** The CDP port used when no `port` option is given. Override per call with `port`. */
export const DEFAULT_CDP_PORT = 9222
/** Directory name of the dedicated CDP profile under the per-platform Google application-data directory (see `googleSupportDir`). */
export const DEFAULT_PROFILE_NAME = 'Chrome-CDP'

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * How the attach and kill paths look at the processes on a port. Injected in
 * unit specs; the default reads the machine through lsof / fuser / ps.
 * Every method answers "unknown" (empty / null) instead of throwing.
 */
export interface ProcessProbe {
  /** Pids listening on the TCP port. */
  listeners(port: number): number[]
  /** The full command line of a pid, or null when it cannot be read. */
  commandLine(pid: number): string | null
  /** The process group id of a pid, or null when it cannot be read. */
  groupOf(pid: number): number | null
}

export interface LaunchChromeOptions {
  /** CDP port. Default: DEFAULT_CDP_PORT (9222). */
  port?: number
  /** Chrome user data directory. Default: <googleSupportDir()>/Chrome-CDP (DEFAULT_PROFILE_NAME) */
  profileDir?: string
  /** Process probe used to prove a reachable Chrome is this tool's own. Default: lsof / fuser / ps. */
  probe?: ProcessProbe
  /** Sink for the "skipped" / diagnostic lines of the identity checks. Default: console.error. */
  logger?: (msg: string) => void
  /** Path to Chrome binary. Auto-detected per platform if unset. */
  chromePath?: string
  /** Extra args to pass to Chrome. */
  extraArgs?: string[]
  /** If true, suppress console.error diagnostics. Default: false. */
  quiet?: boolean
}

// ─── Platform helpers ──────────────────────────────────────────────────────────

function defaultChromePath(): string {
  switch (platform()) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    case 'linux':
      try { return execSync('which google-chrome 2>/dev/null || which chromium 2>/dev/null || which chromium-browser 2>/dev/null', { encoding: 'utf8' }).trim() } catch { return '' }
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    default:
      return ''
  }
}

function defaultProfileDir(): string {
  const base = googleSupportDir()
  mkdirSync(base, { recursive: true })
  return join(base, DEFAULT_PROFILE_NAME)
}

/** The profile directory an identity check compares against: the RESOLVED one, with no filesystem side effect. */
function resolvedProfileDir(opts: { profileDir?: string }): string {
  return opts.profileDir ?? join(googleSupportDir(), DEFAULT_PROFILE_NAME)
}

// ─── Profile identity (backlog 7f881aa7, [core-seam.6]) ───────────────────────

function execText(cmd: string, timeout: number): string {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout }) as unknown
    return typeof out === 'string' ? out.trim() : ''
  } catch {
    return ''
  }
}

/** The machine probe: lsof (macOS, Linux), fuser as the fallback, ps for the command line and group. */
export const systemProcessProbe: ProcessProbe = {
  listeners(port) {
    // Same commands as the original port discovery, so a host with only fuser still resolves listeners.
    let pidStr = execText(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`, 3000)
    if (!pidStr) pidStr = execText(`fuser ${port}/tcp 2>/dev/null`, 3000)
    return pidStr
      .split(/\s+/)
      .filter((t) => /^\d+$/.test(t))
      .map((t) => parseInt(t, 10))
  },
  commandLine(pid) {
    const out = execText(`ps -o command= -p ${pid} 2>/dev/null`, 2000)
    return out || null
  },
  groupOf(pid) {
    const n = parseInt(execText(`ps -o pgid= -p ${pid} 2>/dev/null`, 2000), 10)
    return isNaN(n) ? null : n
  },
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)

/**
 * True when a Chrome command line carries exactly `--user-data-dir=<profileDir>`.
 * The value ends at the end of the line or where the next `--flag` starts (a
 * profile path may contain spaces; `/a/b` must not match `/a/b2` or `/a/b Backup`).
 */
export function commandLineCarriesProfile(commandLine: string, profileDir: string): boolean {
  const want = `--user-data-dir=${trimSlash(profileDir)}`
  let from = 0
  for (;;) {
    const at = commandLine.indexOf(want, from)
    if (at === -1) return false
    const before = at === 0 ? ' ' : commandLine.charAt(at - 1)
    const rest = commandLine.slice(at + want.length).replace(/^[\\/]+(?=\s|$)/, '')
    if (/\s/.test(before) && (rest === '' || rest.startsWith(' --'))) return true
    from = at + 1
  }
}

/** The port a profile's DevToolsActivePort file names (its first line), or null. */
function devToolsActivePort(profileDir: string): number | null {
  try {
    const first = String(nodeFs.readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]?.trim() ?? ''
    const n = parseInt(first, 10)
    return isNaN(n) ? null : n
  } catch {
    return null
  }
}

/** Verdict of the identity check: own, or foreign with the reason it is not attached to. */
type Identity = { own: true } | { own: false; why: string }

/**
 * Is the Chrome answering on `port` this tool's own (its `--user-data-dir` is
 * the resolved profile)? Positive evidence from a readable command line wins;
 * the profile's DevToolsActivePort naming the port is accepted only when no
 * listener command line can be read at all. Anything unproven is foreign.
 */
function identifyListener(port: number, profileDir: string, probe: ProcessProbe): Identity {
  const lines = probe
    .listeners(port)
    .map((pid) => probe.commandLine(pid))
    .filter((c): c is string => c !== null)
  if (lines.some((c) => commandLineCarriesProfile(c, profileDir))) return { own: true }
  if (lines.length > 0) return { own: false, why: `the Chrome on port ${port} does not run with --user-data-dir=${profileDir}` }
  if (devToolsActivePort(profileDir) === port) return { own: true }
  return { own: false, why: `no listener on port ${port} could be tied to --user-data-dir=${profileDir}` }
}

/** The typed refusal to attach to somebody else's Chrome (no new lifecycle code: LAUNCH_FAILED with reason `foreign-profile`). */
function foreignProfileError(port: number, profileDir: string, why: string): LifecycleError {
  return lifecycleError(
    'LAUNCH_FAILED',
    `Chrome on port ${port} is not this tool's own Chrome (${why}); it was not attached to. Close it or choose another port or userDataDir.`,
    { detail: { port, path: profileDir, reason: 'foreign-profile' } },
  )
}

/** A reachable Chrome is attached to only when it is ours; otherwise LAUNCH_FAILED `foreign-profile`. */
function assertOwnChrome(port: number, profileDir: string, opts: LaunchChromeOptions): void {
  const id = identifyListener(port, profileDir, opts.probe ?? systemProcessProbe)
  if (id.own) return
  if (!opts.quiet) (opts.logger ?? ((m: string) => console.error(m)))(`[cdp] refusing to attach: ${id.why}`)
  throw foreignProfileError(port, profileDir, id.why)
}

// ─── Process tracking ─────────────────────────────────────────────────────────

/** The pid of the Chrome this process launched, per CDP port: one port's launch never decides another port's kill. */
const launchedPids = new Map<number, number>()

// ─── Launch ───────────────────────────────────────────────────────────────────

/**
 * Launch Chrome with --remote-debugging-port.
 *
 * Idempotent: if Chrome is already reachable on the target port, returns
 * immediately without launching a new process.
 *
 * Uses nohup + spawn so the process outlives the parent.
 * No --enable-automation flag — Chrome appears as a normal browser.
 */
export async function launchChrome(opts: LaunchChromeOptions = {}): Promise<{
  pid: number | null
  port: number
  alreadyRunning: boolean
  profileDir: string
}> {
  const port = opts.port ?? DEFAULT_CDP_PORT
  const cdpHost = `127.0.0.1:${port}`
  const profileDir = opts.profileDir ?? defaultProfileDir()
  const chromePath = opts.chromePath ?? defaultChromePath()

  // Check if already running: attach only to this tool's own Chrome, never to the operator's.
  if (await isChromeReachable(cdpHost)) {
    assertOwnChrome(port, profileDir, opts)
    return { pid: null, port, alreadyRunning: true, profileDir }
  }

  if (!chromePath || !existsSync(chromePath)) {
    throw StealthCoreBrowserError.of(
      'CHROME_NOT_FOUND',
      `Chrome binary not found at "${chromePath}". ` +
      `Install Chrome in its standard location (the library reads no environment variable; library callers may pass chromePath).`,
      { detail: { path: chromePath, port } },
    )
  }

  // Ensure profile directory exists
  mkdirSync(profileDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--start-minimized',
      // ⚠️  Detection risk: --disable-backgrounding-occluded-windows prevents Chrome
      // from throttling JS timers in minimized/background windows. This is necessary
      // so Cloudflare managed challenges auto-clear in minimized windows (the timer
      // throttling would prevent them). However, the flag is observable — real users
      // never set this flag, so it contributes to the automation fingerprint. If
      // providers start detecting and blocking this, remove the flag and accept that
      // minimized windows won't clear challenges (fall back to off-screen positioning
      // with the macOS sliver). See B-024.
      '--disable-backgrounding-occluded-windows',
      '--no-default-browser-check',
      ...(opts.extraArgs ?? []),
    ]

    const child = spawn(chromePath, args, {
      stdio: 'ignore',
      detached: true,
    })

    child.unref()
    const spawnedPid = child.pid ?? null
    if (spawnedPid !== null) {
      launchedPids.set(port, spawnedPid)
      // The child handle is the only authority on whether the pid still belongs to this launch: forget the pid the
      // moment it exits, before the OS can recycle it for an unrelated process.
      if (typeof child.once === 'function') {
        child.once('exit', () => {
          if (launchedPids.get(port) === spawnedPid) launchedPids.delete(port)
        })
      }
    }

    // Wait up to 10s for CDP endpoint
    const deadline = Date.now() + 10_000
    const poll = setInterval(async () => {
      if (await isChromeReachable(cdpHost)) {
        clearInterval(poll)
        resolve({ pid: spawnedPid, port, alreadyRunning: false, profileDir })
      } else if (Date.now() > deadline) {
        clearInterval(poll)
        // The spawned Chrome never answered: take its whole process group down and forget the pid, so a timed-out
        // launch leaves no orphan and no stale tracked pid for a later kill to signal.
        if (spawnedPid !== null) {
          launchedPids.delete(port)
          killGroup(spawnedPid, 'SIGKILL')
        }
        reject(StealthCoreBrowserError.of('CHROME_START_TIMEOUT', `Chrome did not start CDP on port ${port} within 10s`, { detail: { port } }))
      }
    }, 200)

    // A spawn that fails after it returned (ENOENT, EADDRINUSE, EACCES) arrives as an 'error' event:
    // reject with the classified typed error instead of an unhandled event that crashes the process.
    if (typeof child.once === 'function') {
      child.once('error', (cause: Error) => {
        clearInterval(poll)
        const code = StealthCoreBrowserError.classifyLaunchFailure(cause)
        reject(
          code === 'CHROME_NOT_FOUND' || code === 'PORT_IN_USE'
            ? StealthCoreBrowserError.of(code, `Chrome could not be spawned from "${chromePath}": ${cause.message}`, { cause, detail: { path: chromePath, port } })
            : lifecycleError('LAUNCH_FAILED', `Chrome could not be spawned from "${chromePath}": ${cause.message}`, { cause, detail: { path: chromePath, port } }),
        )
      })
    }
  })
}

/** Per-port exclusive launch lock — see ensureChromeRunning. */
function launchLockPath(port: number): string {
  return join(tmpdir(), `stealth-chrome-launch-${port}.lock`)
}
/** A launch lock older than this is stale (its holder died mid-launch). */
const LAUNCH_LOCK_STALE_MS = 15_000

/**
 * Ensure Chrome is running with CDP enabled.
 * Launches if missing, no-ops if already running.
 * This is the main entry point for consumers who just need Chrome available.
 */
export async function ensureChromeRunning(opts: LaunchChromeOptions = {}): Promise<{
  pid: number | null
  port: number
  profileDir: string
}> {
  const port = opts.port ?? DEFAULT_CDP_PORT
  const cdpHost = `127.0.0.1:${port}`
  const resolvedProfile = opts.profileDir ?? defaultProfileDir()

  if (await isChromeReachable(cdpHost)) {
    assertOwnChrome(port, resolvedProfile, opts)
    return { pid: null, port, profileDir: resolvedProfile }
  }

  // Serialise the check-then-spawn window across processes. Without this, two
  // consumers starting at once both pass the reachability check and both spawn
  // Chrome on the same port — duplicate Chrome trees. An exclusive (O_EXCL)
  // lock file per port means only one launcher proceeds; the loser waits,
  // bounded, for the winner's Chrome to appear, and reclaims a stale lock.
  const fd = await acquireLaunchLock(port, async () => {
    if (!(await isChromeReachable(cdpHost))) return false
    assertOwnChrome(port, resolvedProfile, opts)
    return true
  })
  if (fd === 'reachable') return { pid: null, port, profileDir: resolvedProfile }

  try {
    // Re-check while holding the lock — the winner may have just started it.
    if (await isChromeReachable(cdpHost)) {
      assertOwnChrome(port, resolvedProfile, opts)
      return { pid: null, port, profileDir: resolvedProfile }
    }
    if (!opts.quiet) console.error(`[cdp] Chrome not found on port ${port} — launching...`)
    return await launchChrome(opts)
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(launchLockPath(port)) } catch { /* ignore */ }
  }
}

/** How long a loser waits for the winner's Chrome before giving up with LAUNCH_LOCK_TIMEOUT. */
const LAUNCH_LOCK_WAIT_MS = 30_000

function tryOpenLock(port: number): number | null {
  try { return openSync(launchLockPath(port), 'wx') } catch { return null }
}

/**
 * Take the per-port launch lock. A loser polls `chromeUp` (true means the winner's Chrome appeared: returns
 * `'reachable'`). A lock whose mtime is older than LAUNCH_LOCK_STALE_MS is reclaimed atomically: it is renamed
 * away (only one reclaimer's rename succeeds) and the exclusive open is retried, so two losers can never both
 * hold the lock. After LAUNCH_LOCK_WAIT_MS without the lock or a Chrome, LAUNCH_LOCK_TIMEOUT is raised: a launch
 * never proceeds without the lock.
 */
async function acquireLaunchLock(port: number, chromeUp: () => Promise<boolean>): Promise<number | 'reachable'> {
  const first = tryOpenLock(port)
  if (first !== null) return first
  const deadline = Date.now() + LAUNCH_LOCK_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    if (await chromeUp()) return 'reachable'
    let ageMs: number | null = null
    try { ageMs = Date.now() - statSync(launchLockPath(port)).mtimeMs } catch { /* lock vanished */ }
    if (ageMs !== null && ageMs > LAUNCH_LOCK_STALE_MS) {
      const graveyard = `${launchLockPath(port)}.stale-${process.pid}-${Date.now()}`
      try { renameSync(launchLockPath(port), graveyard) } catch { /* another reclaimer won the rename */ }
      try { unlinkSync(graveyard) } catch { /* ignore */ }
    }
    const fd = tryOpenLock(port)
    if (fd !== null) return fd
  }
  throw lifecycleError('LAUNCH_LOCK_TIMEOUT', `The launch lock for port ${port} was not released within ${LAUNCH_LOCK_WAIT_MS / 1000}s`, {
    detail: { port, lock: launchLockPath(port) },
  })
}

/**
 * Check if Chrome is currently reachable via CDP.
 * Lightweight — just a single HTTP GET to /json/version.
 */
export { isChromeReachable as isChromeRunning }

// ─── Kill ─────────────────────────────────────────────────────────────────────

/**
 * Kill the Chrome process associated with the given CDP port.
 *
 * If this session spawned Chrome (via `launchChrome`), kills the tracked
 * child process. Otherwise, finds the process listening on the target
 * port via `lsof -ti:<port>` and kills it. This ensures `--idle-shutdown`
 * actually terminates Chrome regardless of who started it.
 */
/**
 * Kill a pid's whole process GROUP (negative pid). Chrome is launched detached,
 * so its renderer/GPU/utility Helpers share the main process's group — killing
 * only the main pid can ORPHAN those helpers (observed: two renderers left with
 * ppid=1 after the main exited). Falls back to a single-pid kill when the group
 * signal isn't deliverable. Returns true if either signal was delivered.
 */
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true } catch { /* not a group leader */ }
  try { process.kill(pid, signal); return true } catch { return false }
}

/**
 * The tracked-launch kill of one Chrome process tree: SIGTERM the whole group
 * (single-pid fallback), wait up to 5 s (polling every 200 ms) for the main
 * pid to exit, then SIGKILL the group UNCONDITIONALLY — the main may be gone
 * while its orphaned Helpers linger, and the group stays addressable as long
 * as any member lives. Exported so the out-of-process reaper, which holds a
 * verified owner record instead of the tracked pid, takes the same branch.
 */
export async function killProcessGroup(pid: number): Promise<void> {
  killGroup(pid, 'SIGTERM')
  // Wait for the main process to exit.
  await new Promise<void>((resolve) => {
    // Whichever of the exit probe and the 5 s cap fires first settles the wait AND cancels the other, so the cap
    // timer never keeps the event loop alive for its remaining time after the main pid exited.
    const finish = (): void => { clearInterval(check); clearTimeout(cap); resolve() }
    const check = setInterval(() => {
      try { process.kill(pid, 0) } catch { finish() }
    }, 200)
    const cap = setTimeout(finish, 5000)
  })
  // The main may be gone while its Helpers linger (they were orphaned) — the
  // group is still addressable as long as any member lives, so SIGKILL it too.
  try { process.kill(-pid, 'SIGKILL') } catch { /* no group left */ }
}

export interface KillChromeOptions {
  /** The profile whose Chrome may be signalled. Default: the dedicated CDP profile. */
  profileDir?: string
  /** Process probe. Default: lsof / fuser / ps. */
  probe?: ProcessProbe
  /** Sink for the logged reason of every skipped pid. Default: console.error. */
  logger?: (msg: string) => void
}

/**
 * Kill this tool's Chrome on `port`. A tracked launch of this process is its
 * own by construction. Otherwise only a listener whose command line carries
 * the resolved `--user-data-dir` is signalled; any other occupant (the
 * operator's real Chrome, an unrelated server) is skipped with a logged reason.
 */
export async function killChrome(port = DEFAULT_CDP_PORT, opts: KillChromeOptions = {}): Promise<void> {
  const probe = opts.probe ?? systemProcessProbe
  const log = opts.logger ?? ((m: string) => console.error(`[cdp] ${m}`))
  // Only the Chrome this process launched on THIS port is tracked, and the record is dropped the moment the
  // child exits (see launchChrome), so a recycled pid is never signalled and another port's Chrome is never hit.
  const tracked = launchedPids.get(port)
  if (tracked !== undefined) {
    launchedPids.delete(port)
    await killProcessGroup(tracked)
    return
  }

  const profileDir = resolvedProfileDir(opts)
  const pids: number[] = []
  for (const pid of probe.listeners(port)) {
    const line = probe.commandLine(pid)
    if (line !== null && commandLineCarriesProfile(line, profileDir)) pids.push(pid)
    else
      log(
        line === null
          ? `killChrome: skipped pid ${pid} on port ${port}: its command line is unreadable, so --user-data-dir=${profileDir} cannot be confirmed`
          : `killChrome: skipped pid ${pid} on port ${port}: its command line does not carry --user-data-dir=${profileDir}`,
      )
  }
  const [firstPid] = pids
  if (firstPid === undefined) return
  // The group each listener belongs to (its own pid when the probe cannot tell). The SAME id is used for SIGTERM and
  // for the final SIGKILL, so the escalation can never address a different group than the one asked to stop.
  const groupOfPid = (pid: number): number => probe.groupOf(pid) ?? pid
  for (const group of new Set(pids.map(groupOfPid))) {
    // Kill the listener's process GROUP so Chrome's detached Helpers go too.
    killGroup(group, 'SIGTERM')
  }
  // Wait for the first PID to die, then SIGKILL its group for lingering Helpers. A listener that never exits is
  // left alone: it is not ours to force-kill once it ignored SIGTERM.
  for (let i = 0; i < 25; i++) {
    try {
      process.kill(firstPid, 0)
      await new Promise((r) => setTimeout(r, 200))
    } catch {
      try { process.kill(-groupOfPid(firstPid), 'SIGKILL') } catch { /* no group left */ }
      return
    }
  }
}
