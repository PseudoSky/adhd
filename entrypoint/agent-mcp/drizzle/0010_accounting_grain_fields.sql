-- DEBT-AGENTMCP-ACCOUNTING-001 — additive columns for turn-level compute time, tool-result
-- token estimation, and cost estimation. See entrypoint/agent-mcp/docs/plan/accounting/DESIGN.md.
ALTER TABLE `task_usage` ADD `compute_ms` integer;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `est_tool_result_tokens` integer;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `est_cost_usd` real;
