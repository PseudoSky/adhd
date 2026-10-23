/**
 * Shared scaffold for the web_fetch e2e suites: lets the REAL pinned transport (real `http.request`, real
 * socket) reach a local fixture server while the DNS answer the engine sees is a public address.
 *
 * A fixture on 127.0.0.1 is - correctly - refused by the SSRF guard, so these suites address it by a
 * public-looking NAME. `node:dns/promises` is mocked to answer {@link LAB_PUBLIC_IP} for it, and
 * `node:http`'s `request` is wrapped to swap only the socket target for the fixture (`host`/`port`), recording
 * the options the engine asked for first - so a test can assert the engine connected to the VALIDATED IP and
 * sent the original name as `Host`. Everything between (registry, bridge, client, guard, request building,
 * response wrapping, extraction) is real.
 */
import type { RequestOptions } from 'node:http';
import type { request } from 'node:http';

export const LAB_HOST = 'fixture.example.test';
export const LAB_PUBLIC_IP = '93.184.216.34';

/** What the engine asked `request` for (`servername` is the https-only TLS name). */
export type LabRequestOptions = RequestOptions & { servername?: string };

export const lab: { port: number; seen: LabRequestOptions[] } = { port: 0, seen: [] };

/** A `request` that records the engine's options, then connects to the local fixture instead of the pinned IP. */
export function labRequest(actual: typeof request): typeof request {
  return ((o: LabRequestOptions) => {
    lab.seen.push(o);
    return actual({ ...o, host: '127.0.0.1', port: lab.port, family: 4 });
  }) as typeof request;
}

/** The URL of the fixture as the model would write it: the public-looking name plus the fixture's port. */
export const labUrl = (port: number, path = '/page'): string => `http://${LAB_HOST}:${port}${path}`;
