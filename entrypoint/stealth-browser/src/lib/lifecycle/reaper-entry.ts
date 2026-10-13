/**
 * @adhd/stealth-browser — src/lib/lifecycle/reaper-entry.ts
 *
 * `runChromeReaper(cfg)`: the body of the detached reaper host process for one
 * CDP port. `createProxyReaperLink` spawns it through `ensureBackend` with the
 * form pinned by sp-reaper-load-proof:
 *
 *   process.execPath -e 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))' <dist/index.js> <json cfg>
 *
 * It serves the pure reaper host (`createReaperHost`) over the service-proxy
 * transport (`serveBackend` with the connection hooks), ticks every 5 s
 * (`decideReap` with `graceMs = shutdownGraceMs`), and retires itself through
 * `createIdleRetirer` once nobody needs it: the retirer is busy while Chrome is
 * reachable (a flag the ticker refreshes by probing `/json/version`, because
 * `isBusy` is synchronous) and `activity` touches it, so a host nobody uses
 * retires `orphanWindowMs` after Chrome is gone (N5). Connections never pin it
 * (ADR-0022).
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.1 3.3, CL15).
 */

import { killChrome, killProcessGroup } from '../cdp/browser.js'
import { closeAllPageTargets, isChromeReachable, listPageTargetsOnly } from '../cdp/targets.js'
import { HistoryClient } from '../storage/history.js'
import { errorMessage } from './errors.js'
import { createOwnershipStore } from './ownership.js'
import { countActiveWebPages } from './page-tier.js'
import type { ReaperScope } from './reap-policy.js'
import { createReaperHost, type ReaperHost, type ReaperHostDeps } from './reaper-host.js'
import { createIdleRetirer, serveBackend, type BackendHandle, type IdleRetirer } from './sp.js'

/** The JSON configuration handed to the reaper process (argv[2]). */
export interface ChromeReaperConfig {
  port: number
  /** Default `127.0.0.1:<port>`. */
  cdpHost?: string
  stateDir: string
  socketPath: string
  idleTimeoutMs: number
  shutdownGraceMs: number
  orphanWindowMs: number
  scope?: ReaperScope
  checkHistoryDefault?: boolean
  /** Default 5000. */
  tickMs?: number
}

export interface ChromeReaperHandle {
  host: ReaperHost
  retirer: IdleRetirer
  backend: BackendHandle
  /** Resolves when the host has retired (ticker stopped, socket closed). */
  retired: Promise<void>
  /** Retire now. */
  close(): Promise<void>
}

export interface ChromeReaperOverrides {
  /** Replace individual host effects (tests). */
  hostDeps?: Partial<ReaperHostDeps>
  logger?: (msg: string) => void
}

export const REAPER_TICK_MS = 5_000

export async function runChromeReaper(cfg: ChromeReaperConfig, overrides: ChromeReaperOverrides = {}): Promise<ChromeReaperHandle> {
  const log = overrides.logger ?? ((m: string) => console.error(`[stealth-browser reaper ${cfg.port}] ${m}`))
  const cdpHost = cfg.cdpHost ?? `127.0.0.1:${cfg.port}`
  const tickMs = cfg.tickMs ?? REAPER_TICK_MS
  const owner = createOwnershipStore({ stateDir: cfg.stateDir, port: cfg.port, logger: log })
  const history = new HistoryClient()

  let retirer: IdleRetirer | null = null
  const host = createReaperHost({
    port: cfg.port,
    idleTimeoutMs: cfg.idleTimeoutMs,
    shutdownGraceMs: cfg.shutdownGraceMs,
    ...(cfg.scope ? { scope: cfg.scope } : {}),
    ...(cfg.checkHistoryDefault === undefined ? {} : { checkHistoryDefault: cfg.checkHistoryDefault }),
    now: Date.now,
    probeChrome: () => isChromeReachable(cdpHost),
    countHttpPages: () => countActiveWebPages(() => listPageTargetsOnly(cdpHost)),
    historyRecent: () => history.isRecentlyUsed(2),
    owner: { read: () => owner.read(), isValid: (r) => owner.isValid(r), remove: () => owner.remove() },
    closeAllPageTargets: () => closeAllPageTargets(cdpHost),
    killProcessGroup,
    killChrome,
    logger: log,
    onActivity: () => retirer?.touch(),
    ...overrides.hostDeps,
  })

  const backend = await serveBackend({
    socketPath: cfg.socketPath,
    handler: (req, ctx) => host.handler(req, ctx),
    onClientConnect: (id) => host.onClientConnect(id),
    onClientDisconnect: (id, reason) => host.onClientDisconnect(id, reason),
    onDiagnostic: log,
  })

  let ticking = false
  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      const wasUp = host.chromeReachable()
      const out = await host.tick()
      if (out.reaped) log('reaped idle Chrome')
      // The orphan window starts when Chrome goes away (reaped here or killed elsewhere).
      if (wasUp && !host.chromeReachable()) retirer?.touch()
    } catch (e) {
      log(`tick failed: ${errorMessage(e)}`)
    } finally {
      ticking = false
    }
  }
  const ticker = setInterval(() => void tick(), tickMs)
  ticker.unref()

  let resolveRetired!: () => void
  const retired = new Promise<void>((r) => (resolveRetired = r))
  retirer = createIdleRetirer({
    idleWindowMs: cfg.orphanWindowMs,
    isBusy: () => host.chromeReachable(),
    steps: [
      { name: 'stop-ticker', run: () => clearInterval(ticker) },
      { name: 'close-backend', run: () => backend.close() },
    ],
    onEvent: (e) => {
      if (e.type === 'retired') {
        log(`retired (${e.reason})`)
        resolveRetired()
      } else if (e.type === 'retire-step-failed') {
        log(`retire step ${e.step} failed: ${errorMessage(e.error)}`)
      }
    },
  })
  // Learn Chrome's state before the first idle evaluation, then start the idle clock.
  await tick()
  retirer.arm()

  return {
    host,
    retirer,
    backend,
    retired,
    close: () => retirer!.retire('closed'),
  }
}
