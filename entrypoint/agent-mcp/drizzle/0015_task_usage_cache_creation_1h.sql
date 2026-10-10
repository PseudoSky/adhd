-- 8333f755 AC3 -- persist the 1-hour cache-write split on task_usage so usage_query rows can show it.
-- Additive only: one nullable column; legacy rows keep NULL = "not recorded" (never back-filled).
--   cache_creation_1h_tokens  the 1-hour-TTL SUBSET of cache_creation_input_tokens (billed at 2x base input
--                             vs 1.25x for the 5-minute tier). Previously carried only in the usage event payload.
ALTER TABLE `task_usage` ADD `cache_creation_1h_tokens` integer;
