#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` that REPORTS USAGE (r2-measure: debd934d / afa37093 / 8333f755).
// It emits two model calls (distinct message ids, two content blocks each, like the real CLI), then ends per
// ADHD_FAKE_CLAUDE_MODE:
//   success      result{is_error:false} with the aggregate usage + total_cost_usd, exit 0
//   error        result{is_error:true, api_error_status:400} with the aggregate usage + total_cost_usd, exit 1
//   hang         emits a rate_limit_event (allowed_warning) after the two calls, then never answers (a timeout / cancel kills it)
//   silent-hang  emits nothing at all, never answers
// ADHD_FAKE_CLAUDE_STARTED_FILE gets one line once the prompt is read (so a test can wait for "the CLI is running").
//
// Turn 1: input 12, cache_creation 3000 (all 1h), cache_read 0,    output 20  -> context 3012
// Turn 2: input  8, cache_creation  200 (all 1h), cache_read 3000, output 30  -> context 3208
// Aggregate: input 20, cache_creation 3200 (1h), cache_read 3000, output 50
// Reference cost at claude-haiku-4-5 rates ($1 in / $5 out / $0.10 read / $2.00 1h write per M):
//   20*1e-6 + 50*5e-6 + 3000*0.1e-6 + 3200*2e-6 = 0.00697
import { appendFileSync } from 'node:fs';

const mode = process.env.ADHD_FAKE_CLAUDE_MODE ?? 'success';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
function noop() {
  /* keepalive */
}
const turn = (id, input, write, read, out, block) => ({
  type: 'assistant',
  message: {
    id,
    role: 'assistant',
    content: [{ type: block }],
    usage: {
      input_tokens: input,
      output_tokens: out,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
    },
  },
});
const aggregate = {
  input_tokens: 20,
  output_tokens: 50,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 3200,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3200 },
};

process.stdin.resume();
process.stdin.once('data', () => {
  if (process.env.ADHD_FAKE_CLAUDE_STARTED_FILE) appendFileSync(process.env.ADHD_FAKE_CLAUDE_STARTED_FILE, 'started\n');
  if (mode === 'silent-hang') {
    setInterval(noop, 1e6);
    return;
  }
  emit({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' });
  for (const block of ['text', 'tool_use']) emit(turn('msg_1', 12, 3000, 0, 20, block));
  for (const block of ['text', 'tool_use']) emit(turn('msg_2', 8, 200, 3000, 30, block));
  if (mode === 'hang') {
    // A usage-window WARNING after the two calls: the provider logs it the moment it reads it, and it reads the
    // stream in order, so a test that waits for that log line knows both calls' usage has been consumed.
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 0, rateLimitType: 'five_hour' } });
    setInterval(noop, 1e6);
    return;
  }
  const failed = mode === 'error';
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed,
      ...(failed ? { api_error_status: 400 } : {}),
      result: failed ? 'API Error: 400 bad request' : 'done',
      num_turns: 2,
      total_cost_usd: 0.00697,
      usage: aggregate,
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 20, outputTokens: 50, cacheReadInputTokens: 3000, cacheCreationInputTokens: 3200, costUSD: 0.00697 },
      },
    }) + '\n',
    () => process.exit(failed ? 1 : 0)
  );
});
