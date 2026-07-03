# extract classes

Class export extraction — produces canonical `Operation[]` descriptors for exported class members per SPEC §10.

## Exports

### `extractClasses(opts: ExtractClassesOptions): Promise<Operation[]>`

Walks a TypeScript source file and emits canonical `Operation[]` descriptors for all exported class members.

**Always extracted:**
- **Static methods** — `kind: 'action'`, path = `[file, ClassName, methodName]`

**Opt-in** (via `opts.includeInstances = true`):
- **Constructor** — `kind: 'constructor'`, path = `[file, ClassName]`. Output is always `{ instanceId: string }`.
- **Instance methods** — `kind: 'instance-method'`, path = `[file, ClassName, methodName]`. Each carries an `instanceId` envelope field (`{ type: 'string' }`).

**Skipped:**
- Private and protected members (scope-filtered)
- `_`-prefixed methods (SPEC §3 opt-out ladder)
- `__samples__` and `__`-prefixed symbols
- Non-exported classes

**`ctx` exclusion:** A first parameter named `ctx` is excluded from the schema by name match only.

```ts
import { extractClasses } from '@adhd/apigen-core-client';

// Static methods only (default)
const staticOps = await extractClasses({
  sourceFile: '/path/to/Counter.ts',
  tsconfig: '/path/to/tsconfig.json',
});

// Static + constructor + instance methods
const allOps = await extractClasses({
  sourceFile: '/path/to/Counter.ts',
  includeInstances: true,
  namespace: 'myapp',
  session: mySession,
});
```

### `ExtractClassesOptions`

```ts
interface ExtractClassesOptions {
  sourceFile: string;           // absolute path to .ts source
  namespace?: string;            // defaults to ''
  tsconfig?: string;             // absolute tsconfig path for type resolution
  includeInstances?: boolean;    // opt-in: constructor + instance methods (default: false)
  session?: ExtractionSession;   // optional per-run shared cache
}
```

### Operation Kinds

| Kind | Path | When |
|------|------|------|
| `action` | `[file, ClassName, methodName]` | Static methods (always) |
| `constructor` | `[file, ClassName]` | Constructor (opt-in) |
| `instance-method` | `[file, ClassName, methodName]` | Instance methods (opt-in) |

### Instance Method Envelope

Instance methods carry an `instanceId` field in their envelope schema:

```json
{
  "type": "object",
  "properties": { "instanceId": { "type": "string" } },
  "required": ["instanceId"]
}
```

This tells the transport layer: "you need to provide which instance to call this on."

## See Also

- [`extract`](./extract.md#extract) — v2 function/const extraction
- [How-To: Extraction Pipeline](../how-to/extraction-pipeline.md)
