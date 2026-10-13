/**
 * @adhd/stealth-browser — src/lib/lifecycle/isolated-page.ts
 *
 * An isolated page: a page target in its own cookie-less browser context
 * (no shared context, never the user's profile session), background and
 * minimized by default, with a connected page session. Every failure path
 * leaves no open socket and no undisposed context (F20 F21 F22, gap G1):
 * `createIsolatedPageTarget` cleans up its own steps, and a failure to
 * connect the page session disposes the context before the typed error
 * propagates. `withIsolatedPage` always disposes, also when `fn` throws.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (CL13).
 */

import { CdpSession } from '../cdp/session.js'
import { createIsolatedPageTarget } from '../cdp/targets.js'
import { lifecycleErrors } from './errors.js'

export interface IsolatedPageOptions {
  /** Create the window in the foreground (no minimize, focus). Default false. */
  foreground?: boolean
  /** Page-session connect deadline in ms. Default 10_000. */
  connectTimeoutMs?: number
}

export interface IsolatedPage {
  /** Connected CDP session to the isolated page target. */
  page: CdpSession
  targetId: string
  browserContextId: string
  /** Bring the minimized window on screen (human captcha solving). Best effort. */
  reveal(): Promise<void>
  /** Close the page session and dispose the whole context. Idempotent, never throws. */
  dispose(): Promise<void>
}

export async function openIsolatedPage(cdpHost: string, opts: IsolatedPageOptions = {}): Promise<IsolatedPage> {
  let target: Awaited<ReturnType<typeof createIsolatedPageTarget>>
  try {
    target = await createIsolatedPageTarget(cdpHost, { foreground: opts.foreground })
  } catch (err) {
    throw lifecycleErrors.isolatedContextFailed('createIsolatedPageTarget', err)
  }

  const page = new CdpSession()
  try {
    await page.connect(target.pageWsUrl, opts.connectTimeoutMs ?? 10_000)
  } catch (err) {
    page.close()
    await target.dispose()
    throw lifecycleErrors.isolatedContextFailed('connect', err)
  }

  let disposed: Promise<void> | null = null
  return {
    page,
    targetId: target.targetId,
    browserContextId: target.browserContextId,
    reveal: () => target.reveal(),
    dispose(): Promise<void> {
      if (!disposed) {
        disposed = (async () => {
          page.close()
          await target.dispose()
        })()
      }
      return disposed
    },
  }
}

export async function withIsolatedPage<T>(
  cdpHost: string,
  opts: IsolatedPageOptions | undefined,
  fn: (p: IsolatedPage) => Promise<T>,
): Promise<T> {
  const p = await openIsolatedPage(cdpHost, opts)
  try {
    return await fn(p)
  } finally {
    await p.dispose()
  }
}
