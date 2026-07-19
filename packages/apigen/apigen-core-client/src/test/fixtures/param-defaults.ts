// Fixture: BUG-APIGEN-018 — parameter default values, both sources.
//
// `search`'s `strategy` param carries a real TS initializer default (the
// concrete runtime source of truth). `search`'s `limit` param has no local
// initializer but is documented via a bracketed JSDoc `@param` default
// (`[limit=10]`) — the fallback source when the default lives elsewhere
// (e.g. destructured from an options object upstream).

/**
 * Search for records.
 *
 * @param query - The search query.
 * @param limit - Max results. [limit=10]
 */
export function search(
  query: string,
  strategy = 'auto',
  limit?: number
): string[] {
  return [query, strategy, String(limit)];
}
