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
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isChromeReachable } from './targets.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface LaunchChromeOptions {
  /** CDP port. Default: 9222. */
  port?: number
  /** Chrome user data directory. Default: ~/Library/Application Support/Google/Chrome-CDP */
  profileDir?: string
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
  const base = join(homedir(), 'Library', 'Application Support', 'Google')
  mkdirSync(base, { recursive: true })
  return join(base, 'Chrome-CDP')
}

// ─── Process tracking ─────────────────────────────────────────────────────────

let launchedPid: number | null = null

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
  const port = opts.port ?? 9222
  const cdpHost = `127.0.0.1:${port}`
  const profileDir = opts.profileDir ?? defaultProfileDir()
  const chromePath = opts.chromePath ?? defaultChromePath()

  // Check if already running
  if (await isChromeReachable(cdpHost)) {
    return { pid: null, port, alreadyRunning: true, profileDir }
  }

  if (!chromePath || !existsSync(chromePath)) {
    throw new Error(
      `Chrome binary not found at "${chromePath}". ` +
      `Set CHROME_PATH env var or install Chrome.`,
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
    launchedPid = child.pid ?? null

    // Wait up to 10s for CDP endpoint
    const deadline = Date.now() + 10_000
    const poll = setInterval(async () => {
      if (await isChromeReachable(cdpHost)) {
        clearInterval(poll)
        resolve({ pid: launchedPid, port, alreadyRunning: false, profileDir })
      } else if (Date.now() > deadline) {
        clearInterval(poll)
        reject(new Error(`Chrome did not start CDP on port ${port} within 10s`))
      }
    }, 200)
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
  const port = opts.port ?? 9222
  const cdpHost = `127.0.0.1:${port}`
  const resolvedProfile = opts.profileDir ?? defaultProfileDir()

  if (await isChromeReachable(cdpHost)) {
    return { pid: null, port, profileDir: resolvedProfile }
  }

  // Serialise the check-then-spawn window across processes. Without this, two
  // consumers starting at once both pass the reachability check and both spawn
  // Chrome on the same port — duplicate Chrome trees. An exclusive (O_EXCL)
  // lock file per port means only one launcher proceeds; the loser waits,
  // bounded, for the winner's Chrome to appear, and reclaims a stale lock.
  let fd: number | null = null
  try {
    fd = openSync(launchLockPath(port), 'wx')
  } catch {
    const deadline = Date.now() + LAUNCH_LOCK_STALE_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      if (await isChromeReachable(cdpHost)) {
        return { pid: null, port, profileDir: resolvedProfile }
      }
    }
    try { unlinkSync(launchLockPath(port)) } catch { /* already gone */ }
    try { fd = openSync(launchLockPath(port), 'wx') } catch { fd = null }
  }

  try {
    // Re-check while holding the lock — the winner may have just started it.
    if (await isChromeReachable(cdpHost)) {
      return { pid: null, port, profileDir: resolvedProfile }
    }
    if (!opts.quiet) console.error(`[cdp] Chrome not found on port ${port} — launching...`)
    return await launchChrome(opts)
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
      try { unlinkSync(launchLockPath(port)) } catch { /* ignore */ }
    }
  }
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
 * verified owner record instead of `launchedPid`, takes the same branch.
 */
export async function killProcessGroup(pid: number): Promise<void> {
  killGroup(pid, 'SIGTERM')
  // Wait for the main process to exit.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      try { process.kill(pid, 0) } catch { clearInterval(check); resolve() }
    }, 200)
    setTimeout(() => { clearInterval(check); resolve() }, 5000)
  })
  // The main may be gone while its Helpers linger (they were orphaned) — the
  // group is still addressable as long as any member lives, so SIGKILL it too.
  try { process.kill(-pid, 'SIGKILL') } catch { /* no group left */ }
}

export async function killChrome(port = 9222): Promise<void> {
  if (launchedPid !== null) {
    await killProcessGroup(launchedPid)
    launchedPid = null
    return
  }

  // Find and kill Chrome listening on the target port.
  // Tries lsof (macOS, Linux), falls back to fuser (Linux with psmisc).
  let pidStr = ''
  try {
    pidStr = execSync(`lsof -ti tcp:${port} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim()
  } catch { /* lsof not found or no listener */ }
  if (!pidStr) {
    try {
      pidStr = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim()
    } catch { /* fuser not found either */ }
  }
  if (!pidStr) return
  const pids = pidStr.split('\n').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n))
  for (const pid of pids) {
    // Kill the listener's process GROUP so Chrome's detached Helpers go too.
    let pgid = pid
    try {
      pgid = parseInt(execSync(`ps -o pgid= -p ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 }).trim(), 10) || pid
    } catch { /* keep pid */ }
    killGroup(pgid, 'SIGTERM')
  }
  // Wait for the first PID to die, then SIGKILL its group for lingering Helpers.
  for (let i = 0; i < 25; i++) {
    try {
      process.kill(pids[0], 0)
      await new Promise((r) => setTimeout(r, 200))
    } catch {
      try { process.kill(-pids[0], 'SIGKILL') } catch { /* no group left */ }
      return
    }
  }
}
