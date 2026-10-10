-- 9ed453c1 CWD -- persist the dispatching cwd on tasks (ADR-0008 D4/D9). Additive only: one nullable
-- column; legacy rows keep NULL = "no recorded cwd" (the host falls back to its own cwd, as before).
ALTER TABLE `tasks` ADD `cwd` text;
