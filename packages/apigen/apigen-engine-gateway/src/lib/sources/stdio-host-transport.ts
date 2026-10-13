import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';

/**
 * The SDK's `StdioServerTransport` does not notice the host disappearing: stdin reaching
 * end-of-file leaves the server (and, for a `bin:` source, the upstream process) running
 * forever. This subclass closes the transport on stdin `end` / `close`, so the server's
 * `onclose` fires and the passthrough server shuts down and disposes its source.
 *
 * @param stdin defaults to `process.stdin`
 * @param stdout defaults to `process.stdout`
 */
export function createStdioHostTransport(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout
): StdioServerTransport {
  const transport = new StdioServerTransport(stdin, stdout);
  let closing = false;
  const onGone = (): void => {
    if (closing) return;
    closing = true;
    void transport.close();
  };
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    stdin.once('end', onGone);
    stdin.once('close', onGone);
  };
  const close = transport.close.bind(transport);
  transport.close = async () => {
    closing = true;
    stdin.off('end', onGone);
    stdin.off('close', onGone);
    await close();
  };
  return transport;
}
