/**
 * dispatcher-template.ts — codegen-woven `GeneratedDispatcher.java` emitter.
 *
 * LOCKED DESIGN RULE (docs/plan/apigen-logical-types/DESIGN.md §2/§77-83):
 * "static hosts (Rust, Go, Java) dispatch via codegen-woven glue" — explicitly
 * NOT a schema-interpreting runtime transcoder (§11) and NOT reflection into
 * arbitrary user methods. `renderDispatcherJava` emits ONE Java source file —
 * `GeneratedDispatcher.java` — with one `if (opId.equals("<id>")) { ... }`
 * branch per operation. Each branch is typed, hand-shaped glue: read the
 * JSON-RPC-style request body (`JsonNode`), decode each param to its native
 * Java type, call the user's `public static` method directly (no reflection),
 * encode the result back to `JsonNode`.
 *
 * Only the OUTER route (`opId string -> which branch`) is data-driven, at the
 * `ApigenJavalinServer` layer, via a single call into
 * `GeneratedDispatcher.dispatch(String opId, JsonNode body, ObjectMapper
 * mapper)` — never reflecting into the user's arbitrary methods directly.
 *
 * Glue-expression provenance (JAVA_COLUMN, apigen-base-logical/src/lib/hints.ts):
 * Every canonical logical-type id has TWO possible cell shapes:
 *   - EXPRESSION-shaped (`encode`/`decode` contain a `$` placeholder) — used
 *     VERBATIM here, `$` substituted with the actual variable/JsonNode
 *     accessor expression. This is `date-time`, `uuid`, `byte`, and decimal's
 *     `decode`.
 *   - ANNOTATION-shaped (`encode`/`decode` is Jackson field-annotation text,
 *     e.g. `@JsonSerialize(using = ToStringSerializer.class)`) — this is the
 *     correct authoring choice for hints.ts (field-annotated POJOs are the
 *     idiomatic Jackson pattern for `int64`/`decimal`-encode/`number-special`),
 *     but this dispatcher builds/reads `JsonNode` BY HAND rather than routing
 *     through an annotated POJO field, so an annotation string cannot be
 *     spliced into an expression position. For exactly these cells this file
 *     uses a manual expression that implements the SAME semantic contract the
 *     annotation declares (documented per-cell below) — never re-interprets
 *     the contract, just executes it without the POJO indirection.
 *
 * `int64` and `number-special` do not currently arise from
 * `ApigenJavaExtractor`'s own type-inference table (SPEC step 2 maps
 * `long`/`Long` to plain `{type:"integer"}`, not `format:"int64"`, and
 * `double`/`Double` to plain `{type:"number"}`, not `format:"number-special"`)
 * — so no extracted operation's dispatcher branch currently needs those two
 * cells. Both codecs are still exercised end-to-end by the conformance
 * matrix runner (`ApigenConformanceMatrix`, acceptance criterion 2), which
 * operates on canonical wire vectors directly rather than through extracted
 * Java method signatures.
 */

import type { Operation } from '@adhd/apigen-core-client';
import { cellsFor } from '@adhd/apigen-base-logical';

/** One extracted Java parameter — mirrors ApigenJavaExtractor's `javaParams` field. */
export interface JavaParam {
  readonly name: string;
  readonly javaType: string;
}

/**
 * The Java-extension shape `ApigenJavaExtractor` emits on top of the
 * canonical `Operation` fields (methodName/className/javaParams/javaReturnType)
 * — see that class's doc comment for why these extra fields are necessary:
 * the codegen-woven dispatch rule requires knowing the EXACT Java
 * class/method/param-types, which the kebab-cased canonical `id` alone
 * cannot reconstruct.
 */
export type JavaOperation = Operation & {
  readonly methodName: string;
  readonly className: string;
  readonly javaParams: readonly JavaParam[];
  readonly javaReturnType: string;
};

// ---------------------------------------------------------------------------
// Per-Java-type glue: JsonNode -> native decode, native -> JsonNode encode.
// ---------------------------------------------------------------------------

interface TypeGlue {
  /** `bodyExpr` is a Java expression yielding the request `JsonNode` for this field. */
  decode(bodyExpr: string): string;
  /** `valueExpr` is a Java expression yielding the native decoded value. */
  encode(valueExpr: string): string;
}

const JAVA = cellsFor('java');

/** Substitute `$` in a JAVA_COLUMN expression-shaped cell string. */
function sub(expr: string, varExpr: string): string {
  return expr.split('$').join(varExpr);
}

function isExpressionShaped(cellValue: string): boolean {
  return cellValue.includes('$');
}

const PLAIN_SCALAR_GLUE: Record<string, TypeGlue> = {
  String: {
    decode: (b) => `${b}.asText()`,
    encode: (v) => `mapper.getNodeFactory().textNode(${v})`,
  },
  int: {
    decode: (b) => `${b}.asInt()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  Integer: {
    decode: (b) => `${b}.asInt()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  long: {
    decode: (b) => `${b}.asLong()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  Long: {
    decode: (b) => `${b}.asLong()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  double: {
    decode: (b) => `${b}.asDouble()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  Double: {
    decode: (b) => `${b}.asDouble()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  float: {
    decode: (b) => `(float) ${b}.asDouble()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  Float: {
    decode: (b) => `(float) ${b}.asDouble()`,
    encode: (v) => `mapper.getNodeFactory().numberNode(${v})`,
  },
  boolean: {
    decode: (b) => `${b}.asBoolean()`,
    encode: (v) => `mapper.getNodeFactory().booleanNode(${v})`,
  },
  Boolean: {
    decode: (b) => `${b}.asBoolean()`,
    encode: (v) => `mapper.getNodeFactory().booleanNode(${v})`,
  },
};

/**
 * Logical-type glue, DERIVED from JAVA_COLUMN (apigen-base-logical hints.ts)
 * — see this file's module doc comment for the expression-vs-annotation
 * provenance rule.
 */
const LOGICAL_TYPE_GLUE: Record<string, TypeGlue> = {
  BigDecimal: {
    decode: (b) => sub(JAVA['decimal'].decode, `${b}.asText()`), // 'new BigDecimal($)' — expression-shaped, used verbatim.
    // decimal.encode is annotation-shaped (@JsonSerialize(using=ToStringSerializer.class));
    // the manual JsonNode-glue equivalent of that SAME contract (BigDecimal -> decimal
    // string, never float) is `.toString()` wrapped in a textNode.
    encode: (v) => `mapper.getNodeFactory().textNode((${v}).toString())`,
  },
  Instant: {
    decode: (b) => sub(JAVA['date-time'].decode, `${b}.asText()`), // 'Instant.parse($)'
    encode: (v) => `mapper.getNodeFactory().textNode(${sub(JAVA['date-time'].encode, v)})`, // '$.toString()'
  },
  UUID: {
    decode: (b) => sub(JAVA['uuid'].decode, `${b}.asText()`), // 'UUID.fromString($)'
    encode: (v) => `mapper.getNodeFactory().textNode(${sub(JAVA['uuid'].encode, v)})`, // '$.toString()'
  },
  'byte[]': {
    // JAVA.byte cell is the identity '$' — "Jackson's default base64 codec,
    // no wrapping expression" (hints.ts doc comment). The manual JsonNode-glue
    // equivalent of "let Jackson do it" is `.binaryValue()` / `binaryNode(...)`.
    decode: (b) => `${b}.binaryValue()`,
    encode: (v) => `mapper.getNodeFactory().binaryNode(${v})`,
  },
};

function glueFor(javaType: string): TypeGlue {
  const plain = PLAIN_SCALAR_GLUE[javaType];
  if (plain) return plain;
  const logical = LOGICAL_TYPE_GLUE[javaType];
  if (logical) return logical;
  throw new Error(
    `renderDispatcherJava: no codegen-woven glue registered for Java type "${javaType}" ` +
      `(supported: ${[...Object.keys(PLAIN_SCALAR_GLUE), ...Object.keys(LOGICAL_TYPE_GLUE)].join(', ')})`
  );
}

// Verify at module load that every expression-shaped assumption above still
// holds against the live JAVA_COLUMN — if hints.ts changes an expression to
// annotation-shaped (or vice versa) this throws loudly instead of silently
// emitting broken Java source.
for (const [id, expectExpression] of [
  ['date-time', true],
  ['uuid', true],
  ['byte', true],
] as const) {
  const cell = JAVA[id];
  const encodeOk = isExpressionShaped(cell.encode) === expectExpression;
  const decodeOk = isExpressionShaped(cell.decode) === expectExpression;
  if (!encodeOk || !decodeOk) {
    throw new Error(
      `dispatcher-template: JAVA_COLUMN["${id}"] shape assumption violated — ` +
        `expected expression-shaped=${String(expectExpression)}, ` +
        `got encode=${JAVA[id].encode}, decode=${JAVA[id].decode}. ` +
        `Update dispatcher-template.ts's glue table to match.`
    );
  }
}

// ---------------------------------------------------------------------------
// renderDispatcherJava
// ---------------------------------------------------------------------------

/**
 * Render `GeneratedDispatcher.java` source for the given operations.
 *
 * Deliberately emits NO `package` declaration: the fixture/test convention
 * (mirroring `packages/apigen/java/src/test/resources/OrderApi.java`) is a
 * single default-package user source file, and Java forbids importing a
 * default-package class from a named package. Generating the dispatcher into
 * the SAME (default) package lets it call the user's class unqualified with
 * no import. Production multi-file/packaged Java sources are a follow-on
 * (tracked — see plugin.ts module doc comment).
 */
export function renderDispatcherJava(operations: readonly JavaOperation[]): string {
  const branches = operations
    .map((op) => renderBranch(op))
    .join('\n\n');

  return `// GENERATED by @adhd/apigen-plugin-java-javalin — DO NOT EDIT.
// Codegen-woven dispatcher (DESIGN §2/§77-83): one typed if-branch per
// operation, glue derived from apigen-base-logical's JAVA_COLUMN.

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public final class GeneratedDispatcher {

  private GeneratedDispatcher() {}

  public static JsonNode dispatch(String opId, JsonNode body, ObjectMapper mapper) throws Exception {
${branches}

    throw new IllegalArgumentException("GeneratedDispatcher: unknown operation id \\"" + opId + "\\"");
  }
}
`;
}

function renderBranch(op: JavaOperation): string {
  const decls: string[] = [];
  const argNames: string[] = [];

  for (const p of op.javaParams) {
    const glue = glueFor(p.javaType);
    const bodyExpr = `body.get("${p.name}")`;
    const varName = `__p_${p.name}`;
    decls.push(`      ${p.javaType} ${varName} = ${glue.decode(bodyExpr)};`);
    argNames.push(varName);
  }

  const call = `${op.className}.${op.methodName}(${argNames.join(', ')})`;

  const isVoid = op.javaReturnType === 'void';
  let resultBlock: string;
  if (isVoid) {
    resultBlock = `      ${call};\n      return mapper.getNodeFactory().objectNode();`;
  } else {
    const knownReturnGlue =
      PLAIN_SCALAR_GLUE[op.javaReturnType] ?? LOGICAL_TYPE_GLUE[op.javaReturnType];
    if (knownReturnGlue) {
      resultBlock = `      ${op.javaReturnType} __result = ${call};\n      return ${knownReturnGlue.encode('__result')};`;
    } else {
      // Unmapped/custom return type (e.g. a user POJO): fall back to
      // Jackson's generic reflective serialisation. NOT guaranteed
      // byte-identical-canonical-wire for any logical-typed fields the POJO
      // contains — that requires a follow-on (recursive nested-object
      // logical-type field support is out of this slice's scope; the 6
      // canonical scalar ids round-trip byte-identically when they are the
      // DIRECT param/return type, which is what acceptance criterion 1/3
      // exercise).
      //
      // Qualification heuristic: `MethodDeclaration.getTypeAsString()` gives
      // the SIMPLE name as written (e.g. "Order" for a `public static class
      // Order` nested inside the extracted class) — GeneratedDispatcher is a
      // TOP-LEVEL class, so an unqualified nested-type name would not
      // resolve. Qualifying every unmapped type as `<className>.<Type>`
      // correctly handles the common "nested static result class declared
      // in the same file" shape (this fixture's `OrderApi.Order`). This is a
      // heuristic, not real symbol resolution (JavaParser's `StaticJavaParser`
      // has no symbol solver configured) — a SIBLING top-level class in the
      // same default package would be mis-qualified. Tracked as a follow-on
      // (full nested-vs-sibling disambiguation needs `JavaSymbolSolver`),
      // out of scope for this MVP slice.
      const declaredType = `${op.className}.${op.javaReturnType}`;
      resultBlock = `      ${declaredType} __result = ${call};\n      return mapper.valueToTree(__result);`;
    }
  }

  return `    if (opId.equals("${op.id}")) {
${decls.join('\n')}
${resultBlock}
    }`;
}
