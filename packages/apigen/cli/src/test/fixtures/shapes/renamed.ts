// Export-shape matrix fixture — renamed export (`export { x as y }`).
//
// This is the F28/F29 regression row: the DECLARATION name is `internalGet`,
// but the EXPORTED symbol is `fetchUser`. The v2 extractor must name the
// operation by the exported symbol (`fetchUser`), never the declaration name.
// A regression to "name by declaration symbol" makes this row name `internalGet`
// → the matrix assertion goes red.

async function internalGet(userId: string): Promise<{ id: string }> {
  return { id: userId }
}

const internalList = async (): Promise<string[]> => ['x', 'y']

export { internalGet as fetchUser, internalList as fetchAll }

export const __samples__: Record<string, Record<string, unknown>> = {
  fetchUser: { userId: 'zzz' },
  fetchAll: {},
}
