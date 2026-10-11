-- ad988fda AC2 -- index task_events by (task_id, type).
-- task_events had no index beyond its primary key, so every per-task read (usage_query's usageLowerBound
-- derivation, the turn grain, event replay) full-scanned the table: measured 80ms per 100-task lookup over 400k
-- events with or without the json_extract filter, 0.08-0.33ms with this index. Additive and idempotent.
CREATE INDEX IF NOT EXISTS `idx_task_events_task_id_type` ON `task_events` (`task_id`,`type`);
