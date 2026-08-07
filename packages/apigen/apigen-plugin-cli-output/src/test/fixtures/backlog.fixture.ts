// Real, importable fixture module — ground truth for run.spec.ts's dispatch
// assertions. Deliberately plain functions (no framework glue) so
// `buildFnTable()` (the same helper `orchestrateRun` uses) picks them up
// exactly the way a live `apigen run --source backlog.fixture.ts --type cli`
// invocation would.

export interface BacklogItem {
  id: string;
  title: string;
  includeArchived: boolean;
}

/** A safe (read) op with one required + one optional boolean param. */
export function getItem(id: string, includeArchived?: boolean): BacklogItem {
  return { id, title: `Item ${id}`, includeArchived: includeArchived ?? false };
}

/** A safe (read) op with one optional array (JSON-typed wire) param. */
export function listItems(tags?: string[]): string[] {
  return tags ?? ['default'];
}

/** An unsafe (mutating) op with one required param. */
export function deleteItem(id: string): { deleted: boolean; id: string } {
  return { deleted: true, id };
}

/** An op whose schema requires a session envelope field (§9.1). */
export function whoAmI(): { ok: boolean } {
  return { ok: true };
}
