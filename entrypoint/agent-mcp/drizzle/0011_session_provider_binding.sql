-- D-G(2) (5ad2cf37) — session-held provider binding: the `session` tier of the
-- selection chain task ?? session ?? agent ?? global. Additive nullable columns;
-- existing sessions hold no binding (all NULL). `models` is a JSON ModelSlug[].
ALTER TABLE `sessions` ADD `provider_type` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `model_ref` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `models` text;
