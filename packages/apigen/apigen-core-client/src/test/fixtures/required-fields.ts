// Fixture for BUG-APIGEN-CORE-CLIENT-001: minimal type with a mix of
// required (non-optional) and optional TS properties, used as a named
// function-parameter type. This shape is what previously fell through to
// morph-walk.ts's Path 2 object walker (because `getTypeAtLocation` with no
// enclosing-node context resolves a param's named-interface type to a
// qualified-import expression — `import("<path>").MinimalInput` — which
// ts-json-schema-generator's Path 1 cannot resolve as a type name) and lost
// its `required` array entirely.
export interface MinimalInput {
  family: string;
  title: string;
  body: string;
  repo: string;
  priority?: string;
  tags?: string[];
}

export async function createThing(
  ctx: unknown,
  input: MinimalInput
): Promise<void> {
  void ctx;
  void input;
}

// A second export whose input type has NO required fields at all — the
// generated schema must omit `required` entirely (matching
// ts-json-schema-generator's own convention of never emitting `required: []`).
export interface AllOptionalInput {
  note?: string;
  count?: number;
}

export async function createOptionalThing(
  ctx: unknown,
  input: AllOptionalInput
): Promise<void> {
  void ctx;
  void input;
}

// A CreateItemInput-shaped real-world case mirroring
// entrypoint/backlog/src/model.ts's CreateItemInput (BUG-APIGEN-CORE-CLIENT-001's
// original production repro): several required string fields plus several
// optional fields of varying shapes (string, array, nested object).
export interface CreateItemInputShaped {
  family: string;
  title: string;
  body: string;
  repo: string;
  idOverride?: string;
  projectPath?: string;
  priority?: string;
  tags?: string[];
  plan?: string;
  importedFrom?: string;
  dedupeScan?: {
    symbol?: string;
    path?: string;
    errorText?: string;
  };
  force?: boolean;
}

export async function createItemShaped(
  ctx: unknown,
  input: CreateItemInputShaped
): Promise<void> {
  void ctx;
  void input;
}
