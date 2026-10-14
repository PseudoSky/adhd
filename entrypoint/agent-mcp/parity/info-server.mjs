// PARITY-INSTRUMENT-ONLY
// r2info: a dependency-free stdio MCP server (newline-delimited JSON-RPC), the "project-info" server of the task.
// ONE read-only tool, get_ticket, returns the ticket text from the file $R2_TICKET_FILE (kept outside the working
// directory). Used by every arm (A via --mcp-config; B/C via the agent definition's mcpServers). Hand-rolled so it
// needs no node_modules next to this scratch directory. Optional call log: $R2_INFO_LOG.
import { appendFileSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

const ticketFile = process.env.R2_TICKET_FILE;
const log = process.env.R2_INFO_LOG;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const TOOLS = [{
  name: 'get_ticket',
  description: 'Returns the text of the current project ticket (title, requirements). Read-only; takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
}];
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;                                   // notification (initialized, cancelled, ...)
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const err = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  if (m.method === 'initialize') ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'r2info', version: '1.0.0' } });
  else if (m.method === 'tools/list') ok({ tools: TOOLS });
  else if (m.method === 'tools/call') {
    if (m.params?.name !== 'get_ticket') return ok({ isError: true, content: [{ type: 'text', text: `unknown tool ${m.params?.name}` }] });
    if (log) appendFileSync(log, `${new Date().toISOString()} get_ticket\n`);
    let text; try { text = readFileSync(ticketFile, 'utf8'); } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: `ticket unavailable: ${e.code}` }] }); }
    ok({ content: [{ type: 'text', text }] });
  } else if (m.method === 'ping') ok({});
  else err(-32601, `method not found: ${m.method}`);
});
