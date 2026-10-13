/**
 * @adhd/stealth-browser — src/lib/cdp/settle.ts
 *
 * `awaitPageSettled` — resolve when a page has stopped changing, and say how we know.
 *
 * ─── Why not `awaitPageLoad` ────────────────────────────────────────────────
 * "Load" is a specific lifecycle event, and measurement says it is the wrong
 * one. On a real navigation (Chrome 150, 2026-07-16):
 *
 *     react.dev      load @ 835ms   →  networkIdle @ 1569ms   (734ms early)
 *     excalidraw.com load @ 897ms   →  networkIdle @ 1689ms   (792ms early)
 *
 * `load` fires ~750ms before the page is actually done. Naming this function
 * after it would enshrine the very misconception it exists to fix, and every
 * caller would reasonably assume it awaits `Page.loadEventFired`. It doesn't —
 * `load` is a *fallback rung*, and a late one.
 *
 * "Settled" is the honest word: the page has stopped changing. The result says
 * which signal proved it, because "we waited until the deadline" and "we
 * observed quiescence" are different claims and callers must be able to tell
 * them apart.
 *
 * ─── The ladder — ordered by MEASUREMENT (Chrome 150, 2026-07-16) ──────────
 * Method: snapshot `DOM.getOuterHTML` at every event, strip to cleaned text,
 * and compare against a +7s/+20s ground truth. The right rung is the earliest
 * one whose text already equals the final text. Guessing from timings alone
 * produced two confidently-wrong designs before this method caught them.
 *
 *   1. networkIdle       — loaderId-scoped, redirect-following.
 *   2. inflight-zero     — our own counter, GATED on `load`. Wins most races.
 *                          Fires where networkIdle doesn't: react.dev emitted
 *                          no networkIdle in 2 of 3 runs.
 *   3. networkAlmostIdle — after the grace window. Correct on google/SO.
 *   4. ui-quiet          — RESCUE ONLY, never races. See below.
 *   5. deadline          — CIRCUIT BREAKER. Not a wait: an admission we never
 *                          observed settle. Always reported, never silent.
 *
 * Verified: cleaned text at settle is BYTE-IDENTICAL to +7s on google/search,
 * react.dev, stackoverflow, news.ycombinator.
 *
 * KNOWN COST (BACKLOG B-009): every rung is a PROXY for "has the content
 * arrived" — none measures it directly. Densely sampling google.com/search
 * (~50ms apart): text reaches final at 3087ms while we settle at 3857ms —
 * ~770ms of over-wait. A `text-stable` rung polling cleaned text would land at
 * ~3.1s and measure the deliverable itself.
 *
 * Google-specific caveat, worth not over-reading: comparing its network document
 * body against the rendered DOM (same xpath extractor on both) yields IDENTICAL
 * results, and the rendered surplus is pure UI chrome — the search-tools menu.
 * So on THAT page the settle tail gained nothing. That is one site's shape, not
 * a case against settling: Google server-renders its results, which is precisely
 * the case where a provider's network capture should be used instead (see
 * AGENTS.md's resolution order). This function exists for the opposite shape —
 * an arbitrary URL, no provider, content only present post-render.
 *
 * Also worth knowing: reflows are a MIX of visual and content churn. Google's
 * early LCP reflows (402/570/588ms) fire while text is <50% arrived — purely
 * visual. Its later layout-shifts (1943/2995ms) do bracket real text growth, and
 * the last one (2995ms) predicts text completion (3087ms) better than any rung
 * we ship. That is why ui-quiet survives at all — the signal is right, the
 * trigger is unreliable.
 *
 * ─── `load` MUST NOT resolve ────────────────────────────────────────────────
 * It is not merely early, it is wrong. On google.com/search:
 *
 *     load                @ 1274ms → 0.534 of final text   ← HALF THE PAGE
 *     reflow:layout-shift @ 3713ms → 1.000
 *     networkAlmostIdle   @ 4299ms → 1.000
 *
 * A version that latched `load` and resolved at the grace window returned a
 * 53%-complete page reporting settled:true — a confident wrong answer, strictly
 * worse than the timeout it replaced. `load` only GATES rung 2 (proving the
 * document finished so a quiet inflight counter means real quiet, not a
 * mid-parse lull). It never concludes anything.
 *
 * ─── Why ui-quiet is a rescue, not the primary ─────────────────────────────
 * The idea — network quiescence is only a PROXY; what we mean is "have arriving
 * responses stopped changing the UI?" — is sound, and google.com proves the case
 * it fixes: reflows stopped at ~3.7s while responses ran past 16s. But as a
 * racing rung it was measured WRONG twice:
 *
 *   - Reflows are BURSTY. Google's layout-shifts sit ~965ms apart, so a 750ms
 *     quiet window fired in a GAP → resolved at 2261ms with 0.661 of the text.
 *   - The stream can be silent entirely. react.dev emits ZERO layout-shift ever,
 *     so "no reflow" cannot distinguish "converged" from "never rendered".
 *   - Or never stop: excalidraw shifts at 899ms then again at 11.1s and 12.5s.
 *
 * So it may only fire after `load` AND after `uiRescueAfterMs`, with a 1.5s
 * window. Healthy pages resolve long before it (react.dev ~1.3s, HN ~1.3s), so
 * it only rescues pages that would otherwise ride to the deadline.
 *
 * ─── Signals rejected ───────────────────────────────────────────────────────
 * `DOM` mutation events: measured — at `depth: 0` only `documentUpdated` fires
 * (2× on every target), never `childNodeInserted`/`characterDataModified`. DOM
 * events need pushed nodes, and pushing them is the tree walk AGENTS.md bans.
 *
 * `Page.startScreencast`: the only signal with plausibly full paint coverage,
 * rejected on principle — it forces frame production and perturbs
 * visibility/rAF throttling, i.e. it MODIFIES PAGE BEHAVIOUR and is
 * page-observable.
 *
 * ─── Not detectable, does not modify page state ─────────────────────────────
 * `Network.enable`, `Page.setLifecycleEventsEnabled` are out-of-band devtools
 * observers. No `Runtime.evaluate`. Consistent with AGENTS.md.
 */

import type { CdpSession } from './session.js'

/** How we concluded the page settled. `deadline` means we never observed it. */
export type SettleSignal =
  | 'networkIdle'
  | 'inflight-zero'
  | 'ui-quiet'
  | 'networkAlmostIdle'
  | 'load'
  | 'deadline'

export interface SettleResult {
  /** Which rung of the ladder fired. */
  signal: SettleSignal
  /** `false` iff `signal === 'deadline'` — i.e. the page never demonstrably settled.
   *  A caller that snapshots anyway should treat the result as suspect. */
  settled: boolean
  /** Wall time from arming to resolution. */
  tookMs: number
  /** Requests still open when we resolved. */
  inflight: number
  /** Total requests observed for this navigation. */
  requests: number
  /** Reflow/LCP events observed. 0 means the ui-quiet rung had no signal at all
   *  (react.dev emits zero layout-shift ever) — do not read 0 as "UI settled". */
  uiEvents: number
  /** The loaderId we scoped to, when known. */
  loaderId?: string
}

export interface AwaitPageSettledOptions {
  /** Navigate to this URL and settle on THAT navigation. Strongly preferred —
   *  it captures the loaderId, which is the only reliable way to ignore the
   *  target's initial about:blank (see the loaderId note below). */
  navigate?: string
  /** Scope to a known loaderId instead of navigating (e.g. a click-driven nav). */
  loaderId?: string
  /** Circuit breaker. Default 15_000. */
  deadlineMs?: number
  /** How long inflight must sit at zero to count as rung 2. Default 500. */
  inflightQuietMs?: number
  /** How long the UI must go without a reflow/LCP to count as `ui-quiet`. Default 1_500.
   *  Reflows are BURSTY — Google's layout-shifts sit ~965ms apart — so a short
   *  window fires in a gap and settles early. Do not lower this casually. */
  uiQuietMs?: number
  /** ui-quiet is a RESCUE, not a racer: it may not fire until this long after
   *  arming, giving the network rungs their chance first.
   *  Default: min(5_000, deadlineMs / 2). */
  uiRescueAfterMs?: number
  /** How long to prefer `networkIdle` before accepting a weaker rung. Default 1_500. */
  graceMs?: number
  /** Restrict which rungs may resolve. Default: all. */
  accept?: SettleSignal[]
  /** Abort the wait. Rejects with the abort reason. */
  abort?: AbortSignal
}

// `load` is deliberately NOT here — it cannot resolve.
//
// MEASURED (google.com/search?q=tree-sitter, snapshotting the DOM at every
// event and comparing text against a 20s ground truth):
//
//     load                  @ 1274ms → 0.534 of final text   ← HALF THE PAGE
//     reflow:layout-shift   @ 3713ms → 1.000                 ← content complete
//     networkAlmostIdle     @ 4299ms → 1.000
//
// An earlier version latched `load` and resolved on it when the grace window
// closed (~1500ms). That returned a 53%-complete page while reporting
// settled:true — a confident wrong answer, strictly worse than the timeout it
// was meant to fix. `load` now only GATES rung 2 (proving the document
// finished); it never concludes the page settled.
const LOWER_RUNGS: SettleSignal[] = ['networkAlmostIdle']

/**
 * Wait until `session`'s page stops changing.
 *
 * ⚠️ **The about:blank trap.** A freshly created target fires a COMPLETE
 * lifecycle sequence for its initial `about:blank` — measured at 41ms
 * (react.dev run) and 51ms (excalidraw run), including a `networkIdle`. A naive
 * "await the first networkIdle" therefore resolves in ~50ms against a blank
 * page, and the caller snapshots nothing at all. This is silent and looks like
 * a fast success, which is why it must be designed out rather than tested for.
 *
 * The fix is loaderId scoping: `Page.navigate` returns the `loaderId` for the
 * navigation it started, and `Page.lifecycleEvent` carries a `loaderId`. We
 * accept lifecycle events only for ours. Pass `navigate` (preferred) or an
 * explicit `loaderId`. With neither, we scope to the first `init` seen after
 * arming and log nothing — best effort, and documented as such.
 *
 * @example
 *   const r = await awaitPageSettled(session, { navigate: 'https://react.dev' })
 *   if (!r.settled) console.warn(`never settled (${r.signal}) — content may be partial`)
 */
export async function awaitPageSettled(
  session: CdpSession,
  opts: AwaitPageSettledOptions = {},
): Promise<SettleResult> {
  const {
    navigate,
    deadlineMs = 15_000,
    inflightQuietMs = 500,
    uiQuietMs = 1_500,
    graceMs = 1_500,
    accept,
    abort,
  } = opts
  const uiRescueAfterMs = opts.uiRescueAfterMs ?? Math.min(5_000, deadlineMs / 2)

  const t0 = Date.now()
  const allows = (s: SettleSignal) => !accept || accept.includes(s)

  // Scoping is mandatory, not advisory: without a loaderId the lifecycle rungs
  // cannot tell our navigation from the target's initial about:blank, and the
  // failure is silent (a fast "success" against a blank page). Fail loudly here
  // rather than return a confidently wrong snapshot.
  if (!navigate && !opts.loaderId) {
    throw new Error(
      'awaitPageSettled: pass `navigate` (preferred) or `loaderId`. Without one, ' +
      'lifecycle events cannot be scoped to your navigation and about:blank wins the race.',
    )
  }

  await session.send('Page.enable')
  await session.send('Network.enable')
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true })
  // Optional: only feeds the ui-quiet rescue rung. Never fail the wait over it.
  try {
    await session.send('PerformanceTimeline.enable', {
      eventTypes: ['layout-shift', 'largest-contentful-paint'],
    })
  } catch { /* older Chrome: ui-quiet simply never fires */ }

  let loaderId = opts.loaderId
  let inflight = 0
  let requests = 0
  let inflightTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let graceElapsed = false
  let loadFired = false          // `load` seen for OUR loaderId — gates rung 2
  let latched: SettleSignal | null = null   // best lower rung seen before grace closed
  let uiEvents = 0
  let uiTimer: ReturnType<typeof setTimeout> | null = null
  let done = false

  const unsubs: Array<() => void> = []
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  return new Promise<SettleResult>((resolve, reject) => {
    const finish = (signal: SettleSignal) => {
      if (done) return
      done = true
      for (const u of unsubs) u()
      if (inflightTimer) clearTimeout(inflightTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (settleTimer) clearTimeout(settleTimer)
      if (uiTimer) clearTimeout(uiTimer)
      resolve({
        signal,
        settled: signal !== 'deadline',
        tookMs: Date.now() - t0,
        inflight,
        requests,
        uiEvents,
        loaderId,
      })
    }

    if (abort) {
      if (abort.aborted) { reject(abort.reason ?? new Error('aborted')); return }
      abort.addEventListener('abort', () => {
        if (done) return
        done = true
        for (const u of unsubs) u()
        reject(abort.reason ?? new Error('aborted'))
      }, { once: true })
    }

    // Rung 5: circuit breaker.
    settleTimer = setTimeout(() => finish('deadline'), deadlineMs)

    // Prefer networkIdle for `graceMs` before letting a weaker rung win.
    //
    // LATCH, don't discard. Lower rungs are ONE-SHOT events: `load` fires once
    // and never again. An earlier version simply ignored a lower rung that
    // arrived before the grace window closed — which threw away the only chance
    // to use it. Measured consequence on google.com/search: `load` fired early,
    // was dropped, and since Google's telemetry beacons mean networkIdle and
    // inflight-zero NEVER fire, the wait fell all the way to the 20s deadline
    // (reqs=123) on a page that was actually readable in ~1.5s.
    //
    // So: remember the best lower rung seen, and resolve with it the moment the
    // grace window closes if nothing better arrived.
    graceTimer = setTimeout(() => {
      graceElapsed = true
      if (latched && allows(latched)) finish(latched)
    }, graceMs)

    // ─── Rung 2: our own inflight counter ───────────────────────────────────
    // Independent of Chrome's lifecycle phases, so it still fires on pages that
    // never reach networkIdle. That is not hypothetical: measured on react.dev,
    // `networkIdle` did NOT fire in 2 of 3 runs, while this rung resolved
    // correctly (full 272KB). In practice this rung wins nearly every race.
    //
    // GUARD: it must not fire during a mid-load lull. A document response can
    // land, go quiet for >inflightQuietMs while the parser works, and only then
    // issue subresources — inflight hits 0 with requests===1 and we'd "settle"
    // on a shell. (Exactly the shape of an observed early-resolve: 542ms,
    // reqs=1, 6KB instead of 272KB.) So require `load` for OUR loader first:
    // the document is then complete and any quiet is real quiet, not a lull.
    const armInflight = () => {
      if (inflightTimer) clearTimeout(inflightTimer)
      if (inflight !== 0 || requests === 0) return
      if (!loadFired) return                        // mid-load lull, not settle
      inflightTimer = setTimeout(() => {
        if (inflight === 0 && loadFired && allows('inflight-zero')) finish('inflight-zero')
      }, inflightQuietMs)
    }

    unsubs.push(session.on('Network.requestWillBeSent', () => {
      inflight++; requests++
      if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null }
    }))
    const settleReq = () => { inflight = Math.max(0, inflight - 1); armInflight() }
    unsubs.push(session.on('Network.loadingFinished', settleReq))
    unsubs.push(session.on('Network.loadingFailed', settleReq))

    // ─── Rungs 1/3/4: lifecycle, scoped to OUR navigation ───────────────────
    unsubs.push(session.on('Page.lifecycleEvent', (p) => {
      const name = p['name'] as string
      const evLoader = p['loaderId'] as string | undefined

      // ── The about:blank guard. Measured, not theoretical. ──
      // `Page.enable` REPLAYS the current document's full lifecycle, so a target
      // created at about:blank emits commit/DOMContentLoaded/load/networkIdle
      // for it — observed at 3ms, 9ms, 38ms, 56ms across runs. Meanwhile
      // `Page.navigate` takes ~334ms to resolve. An earlier version of this
      // guard read `if (loaderId && evLoader !== loaderId) return`, which
      // filters NOTHING while loaderId is still undefined — so about:blank's
      // replayed networkIdle won the race and resolved against a blank page.
      // That produced a 542ms "success" returning the 6KB shell instead of
      // react.dev's 272KB — silent, and indistinguishable from a fast win.
      //
      // So: ignore EVERY lifecycle event until our own loaderId is known.
      // Safe, because Page.navigate resolves (334ms) before its own `init`
      // (335ms) — we never miss our own events by waiting for it.
      if (!loaderId) return
      if (evLoader !== loaderId) return

      // `load` for our loader unlocks rung 2 and may itself resolve later.
      if (name === 'load') { loadFired = true; armInflight(); armUiQuiet() }

      if (name === 'networkIdle' && allows('networkIdle')) { finish('networkIdle'); return }

      if (LOWER_RUNGS.includes(name as SettleSignal)) {
        const rung = name as SettleSignal
        if (graceElapsed) { if (allows(rung)) finish(rung); return }
        // Before grace: latch the best rung rather than dropping it.
        if (!latched || LOWER_RUNGS.indexOf(rung) < LOWER_RUNGS.indexOf(latched)) latched = rung
      }
    }))

    // ─── Follow main-frame redirects ────────────────────────────────────────
    // `Page.navigate`'s loaderId is for the request WE issued. A redirect
    // creates a NEW document with a NEW loaderId, and scoping to the original
    // then rejects the real page's entire lifecycle.
    //
    // Measured on google.com/search: navigate resolved with loader 295DC9;
    // Google redirected to `...&sei=<token>` under loader F78A50; `load`
    // (1285ms) and `networkIdle` (3747ms) both fired under F78A50 and were
    // silently discarded, so a page that settles in 3.7s hung for the full 20s
    // deadline. Google was never the problem — the scoping was.
    //
    // Only track once `loaderId` is set (i.e. after our navigate), so the
    // target's initial about:blank still can't sneak in.
    unsubs.push(session.on('Page.frameNavigated', (p) => {
      const frame = p['frame'] as { parentId?: string; loaderId?: string } | undefined
      if (!frame || frame.parentId) return          // main frame only, not iframes
      if (!loaderId || !frame.loaderId) return      // not armed yet → ignore about:blank
      if (frame.loaderId === loaderId) return
      loaderId = frame.loaderId                     // follow it
      loadFired = false                             // new document — re-gate rung 2
      latched = null
    }))

    // ─── Rung: ui-quiet — "responses stopped changing the UI" ───────────────
    // Deliberately a LATE rescue, not an early racer.
    //
    // The idea (network quiescence is only a proxy; UI convergence is the real
    // question) is right, and Google proves the failure it fixes: reflows
    // stopped at 2830ms while responses ran past 16s. But as an EARLY rung it
    // is dangerous — a page whose `load` fires before it renders would show no
    // reflow yet, and ui-quiet would win the race against a correct rung and
    // snapshot nothing. react.dev emits ZERO layout-shift ever, so "no reflow"
    // genuinely cannot distinguish "converged" from "never rendered".
    //
    // So it may only fire after `load` (render happened) AND after the grace
    // window (the network rungs had their chance). Normal pages resolve well
    // before that — measured: react.dev 1508ms, excalidraw 1401ms — so this
    // only rescues pages that would otherwise ride to the deadline.
    const armUiQuiet = () => {
      if (uiTimer) clearTimeout(uiTimer)
      if (!allows('ui-quiet')) return
      uiTimer = setTimeout(() => {
        if (!loadFired || !allows('ui-quiet')) return
        if (Date.now() - t0 < uiRescueAfterMs) { armUiQuiet(); return }   // too early — re-arm
        finish('ui-quiet')
      }, uiQuietMs)
    }
    unsubs.push(session.on('PerformanceTimeline.timelineEventAdded', () => {
      uiEvents++
      armUiQuiet()
    }))

    // Navigating LAST guarantees every subscriber is armed first — these events
    // are fire-and-forget with no historical query, so arming after navigate
    // races and silently loses early events.
    if (navigate) {
      session.send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url: navigate })
        .then((r) => {
          if (r.errorText) { if (!done) { done = true; for (const u of unsubs) u(); reject(new Error(`Page.navigate failed: ${r.errorText}`)) } ; return }
          if (r.loaderId) loaderId = r.loaderId   // authoritative — beats the `init` guess
        })
        .catch((e) => { if (!done) { done = true; for (const u of unsubs) u(); reject(e) } })
    }
  })
}
