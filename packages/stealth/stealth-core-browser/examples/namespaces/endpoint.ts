/**
 * Scenario: vet-a-devtools-endpoint-before-use -- check which Chrome DevTools endpoint a caller may talk to
 * (loopback by default, another host only when the hosting process allows it) and refuse a debugger
 * WebSocket URL that points at a third host.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { endpoint } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP remote-debugging port of the Chrome to vet. */
  port?: number
  /** A non-loopback host the hosting process chooses to allow (refused until it is allowed). */
  remoteHost?: string
}

export interface EndpointReport {
  /** The validated endpoint of a loopback host. */
  loopback: { host: string; port: number; cdpHost: string }
  /** Whether the remote host is a loopback address. */
  remoteIsLoopback: boolean
  /** The error code raised for the remote host before the policy allows it, or null when it was accepted. */
  remoteRefusedBefore: string | null
  /** Whether the remote host resolves once the policy allows it. */
  remoteAllowedAfter: boolean
  /** Whether a debugger WebSocket URL on another host is refused. */
  redirectRefused: boolean
  /** The port parsed back out of `host:port`. */
  parsedPort: number
}

const codeOf = (err: unknown): string => (err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN')

export function run({ port = 9333, remoteHost = 'chrome.example.test' }: RunOptions = {}): EndpointReport {
  const loopback = endpoint.resolveEndpoint({ port })

  endpoint.configureEndpointPolicy()
  let remoteRefusedBefore: string | null = null
  try {
    endpoint.resolveEndpoint({ host: remoteHost, port })
  } catch (err) {
    remoteRefusedBefore = codeOf(err)
  }

  endpoint.configureEndpointPolicy({ allowHosts: [remoteHost] })
  let remoteAllowedAfter = true
  try {
    endpoint.resolveEndpoint({ host: remoteHost, port })
  } catch {
    remoteAllowedAfter = false
  }
  endpoint.configureEndpointPolicy()

  let redirectRefused = false
  try {
    endpoint.assertSameEndpoint(loopback.cdpHost, `ws://evil.example.test:${port}/devtools/browser/B1`)
  } catch {
    redirectRefused = true
  }

  return {
    loopback: { host: loopback.host, port: loopback.port, cdpHost: loopback.cdpHost },
    remoteIsLoopback: endpoint.isLoopbackHost(remoteHost),
    remoteRefusedBefore,
    remoteAllowedAfter,
    redirectRefused,
    parsedPort: endpoint.portOf(loopback.cdpHost),
  }
}
