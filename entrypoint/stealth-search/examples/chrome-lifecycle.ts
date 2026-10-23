/**
 * Example: start a dedicated Chrome when none answers, check it is idle, shut it down.
 *
 * `launchChrome` takes only a port and a profile directory (no binary path, no arguments), and the
 * launched Chrome carries the stealth flags and never `--enable-automation`. Ticket 8468f7b1 ·
 * [search-examples.1]
 */
import type { ExampleDeps } from './types.js'

/** Run the example against the injected operations; returns the printed text. */
export async function run({ api }: ExampleDeps): Promise<string> {
  const lines: string[] = []
  let status = await api.chromeStatus({ port: 9333 })
  if (!status.running) {
    const launched = await api.launchChrome({ port: 9333 })
    lines.push(`launched on port ${launched.port}: ${launched.ok}`)
    status = await api.chromeStatus({ port: 9333 })
  }
  lines.push(`chrome ${status.version ?? 'unknown'} running=${status.running} managed=${status.managed}`)
  const activity = await api.checkChromeActivity({ port: 9333, withinMinutes: 5 })
  lines.push(`pages=${activity.activePages} recentlyUsed=${activity.recentlyUsed}`)
  if (!activity.recentlyUsed) {
    const down = await api.shutdownChrome({ port: 9333 })
    lines.push(`shutdown ok=${down.ok} stillRunning=${down.running}`)
  }
  return lines.join('\n')
}
