// Export-shape matrix fixture — Shape 1 & 2: named function + named arrow/const.
//
// The v2 extractor must name each operation by its EXPORTED symbol. For named
// exports the exported symbol == the declaration name, so this is the baseline
// row of the matrix.

export async function getUser(userId: string): Promise<{ id: string }> {
  return { id: userId }
}

export const listUsers = async (): Promise<string[]> => {
  return ['a', 'b']
}

export const __samples__: Record<string, Record<string, unknown>> = {
  getUser: { userId: 'abc' },
  listUsers: {},
}
