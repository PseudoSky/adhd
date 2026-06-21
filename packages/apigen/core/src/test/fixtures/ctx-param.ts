interface DbContext { db: unknown }

export async function getUser(ctx: DbContext, userId: string): Promise<{ id: string }> {
  return { id: userId }
}

// Zero-param function (only ctx, which is filtered)
export async function listAll(ctx: DbContext): Promise<string[]> { return [] }
