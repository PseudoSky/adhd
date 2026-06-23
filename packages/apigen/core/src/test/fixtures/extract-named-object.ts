// Fixture: Shape 3 — named-object export
// export const api = { foo, bar }

export const userApi = {
  getUser: (userId: string): { id: string } => ({ id: userId }),
  deleteUser: (userId: string): void => {},
}
