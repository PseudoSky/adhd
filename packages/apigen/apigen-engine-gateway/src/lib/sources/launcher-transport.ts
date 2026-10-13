import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { IProcessHandle } from './process';

/** How long `close()` waits for a SIGTERMed process before SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * An SDK `Transport` over an {@link IProcessHandle}: newline-delimited JSON-RPC in
 * both directions. `close()` ends stdin and kills the process (SIGKILL after a short
 * grace). Stderr is surfaced only to `options.onStderr` for diagnostics; it is never
 * parsed as protocol.
 */
export function createLauncherTransport(
  handle: IProcessHandle,
  options: { onStderr?: (t: string) => void } = {}
): Transport {
  let buffer = '';
  let closed = false;

  const transport: Transport = {
    async start() {
      handle.onStdout((chunk) => {
        buffer += chunk;
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          try {
            transport.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          } catch (e) {
            transport.onerror?.(e instanceof Error ? e : new Error(String(e)));
          }
        }
      });
      handle.onStderr((chunk) => options.onStderr?.(chunk));
      void handle.exited.then(() => {
        if (closed) return;
        closed = true;
        transport.onclose?.();
      });
    },
    async send(message: JSONRPCMessage) {
      if (closed) throw new Error('transport is closed');
      handle.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      const wasClosed = closed;
      closed = true;
      handle.stdin.end();
      handle.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const escalate = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          handle.kill('SIGKILL');
          resolve();
        }, KILL_GRACE_MS);
        timer.unref?.();
      });
      await Promise.race([handle.exited.then(() => undefined), escalate]);
      if (timer) clearTimeout(timer);
      if (!wasClosed) transport.onclose?.();
    },
  };
  return transport;
}
