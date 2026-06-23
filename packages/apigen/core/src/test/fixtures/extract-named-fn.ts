// Fixture: Shape 1 — named function export
// export function foo(...)

export async function getUser(userId: string): Promise<{ id: string; name: string }> {
  return { id: userId, name: 'test' }
}

export function listItems(): string[] {
  return []
}
