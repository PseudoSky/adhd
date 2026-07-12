-- BUG-ORCH-009 / BUG-ORCH-010 / FINDING-ORCH-007
--
-- task_usage previously recorded only CUMULATIVE input/output tokens. Two things were
-- unrepresentable:
--
--  1. Cache performance. Cache-hit vs cache-miss input differs 50x in price on
--     deepseek-v4-flash ($0.0028/M vs $0.14/M), making it the largest cost signal in the
--     system — and it was recorded nowhere for the OpenAI-compatible provider family.
--     This is what allowed a context limiter to silently collapse cache hit rate from
--     ~98% to ~5% (BUG-ORCH-008) with no telemetry able to show it.
--
--  2. Peak context. Every column accumulated with `+=`; nothing tracked a MAX. So a run
--     that billed 715K tokens across 24 calls was indistinguishable from one that held a
--     715K context, when the true high-water mark was 43K. Callers could not tell "many
--     small calls" (fix: preserve the cache) from "one huge call" (fix: cap that input).
ALTER TABLE `task_usage` ADD `uncached_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `peak_context_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `peak_context_at` integer;
