// apigen CLI test fixture for the `ts-types` output target (SPEC §6.1).
//
// Named exports only, exercising the round-1 emitter surface:
//   - getUser: primitives + an optional member (`name?: string`)
//   - listUsers: string-literal enum param + array output
//   - runTask: a discriminated union (`_batch` shape — `oneOf` + a shared
//     literal-tag `kind` property). This is the spec's highest-risk item:
//     whether the union extracts to `oneOf` + `discriminator` through the
//     REAL extractor is verified empirically in the e2e test (Segment C).

export interface GetUserResult {
  id: string;
  name?: string;
}

export function getUser(userId: string): Promise<GetUserResult> {
  return Promise.resolve({ id: userId });
}

export function listUsers(role: 'admin' | 'user'): Promise<string[]> {
  return Promise.resolve([]);
}

export type Task =
  | { kind: 'text'; content: string }
  | { kind: 'file'; path: string; sizeBytes: number };

export function runTask(task: Task): Promise<Task> {
  return Promise.resolve(task);
}
