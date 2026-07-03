/**
 * Minimal structured logger written to stderr.
 * Uses console.error so MCP stdio (stdout) is never corrupted.
 */
export const logger = {
  info(obj: Record<string, unknown>, msg?: string): void {
    const ts = new Date().toISOString();
    console.error(
      JSON.stringify({ level: 'info', time: ts, ...obj, ...(msg ? { msg } : {}) })
    );
  },
  warn(obj: Record<string, unknown>, msg?: string): void {
    const ts = new Date().toISOString();
    console.error(
      JSON.stringify({ level: 'warn', time: ts, ...obj, ...(msg ? { msg } : {}) })
    );
  },
  error(obj: Record<string, unknown>, msg?: string): void {
    const ts = new Date().toISOString();
    console.error(
      JSON.stringify({ level: 'error', time: ts, ...obj, ...(msg ? { msg } : {}) })
    );
  },
};
