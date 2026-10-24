/**
 * The recorder releases a settled request's working state.
 * Ticket 8468f7b1 · criteria [resolve-findings.2] F130.
 * guards: a settled request's draft stays in the recorder's lookup map for the life of the session, so a long recording grows without bound and a late ExtraInfo event rewrites a record a sink already received
 * tier: S
 * cites: 8468f7b1 [resolve-findings.2] F130
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer
 * teeth: red: nx run stealth-core-browser:test --skip-nx-cache -- test/unit/capture/draft-release.spec.ts -> exit 1 with both `this.drafts.delete(d.id)` calls removed: 2 failed (the working-state map still holds the settled request and a late ExtraInfo rewrites the settled record).
 * Runs the real recorder over the in-memory CDP server; no socket, no Chrome.
 */
import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '../../../src/lib/recording/network-recorder.js'
import { connectSession, flushMicrotasks, useFixture } from '../../helpers/capture/capture-kit.js'

const workingSet = (r: NetworkRecorder): Map<string, unknown> => (r as unknown as { drafts: Map<string, unknown> }).drafts

describe('[resolve-findings.2] F130 settled requests leave the working set', () => {
  const rig = useFixture('redirect-301-200')

  it('after every request settled the recorder keeps no working state for them', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/old' })
    await recorder.settled()
    expect(recorder.exchanges()).toHaveLength(1)
    expect(recorder.exchanges()[0]?.state).not.toBe('inflight')
    expect(workingSet(recorder).size).toBe(0)
  })

  it('a late ExtraInfo for a settled request does not rewrite the record that was already handed out', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/old' })
    await recorder.settled()
    const before = JSON.stringify(recorder.exchanges()[0])
    rig.server.emitNow('Network.responseReceivedExtraInfo', { requestId: 'R1', headers: { 'x-late': '1' }, statusCode: 200 })
    await flushMicrotasks()
    expect(JSON.stringify(recorder.exchanges()[0])).toBe(before)
  })
})
