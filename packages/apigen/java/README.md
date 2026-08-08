# apigen-java

Java host for [apigen](../README.md) — extracts Java source methods to canonical Operation descriptors and dispatches them via HTTP (Javalin server). Part of **FEAT-APIGEN-001** (polyglot host adoption).

## What it does

Converts ordinary public static Java methods into a **code-first API**:

```java
public class OrderApi {
  public static Order createOrder(String customerId, BigDecimal amount, Instant placedAt) {
    // implementation
  }
  
  public static BigDecimal totalWithTax(BigDecimal amount, double taxRate) {
    // implementation
  }
}
```

→ Extracts to canonical Operation descriptors → Compiles with codegen-woven dispatcher → Runs as HTTP server:

```bash
POST /orders/create-order   body: {"data":{"customerId":"...", "amount":"10.50", "placedAt":"2026-08-06T12:00:00Z"}}
POST /orders/total-with-tax body: {"data":{"amount":"10.50", "taxRate":"0.08"}}
```

## Architecture

Three main components:

### 1. ApigenJavaExtractor

Introspects `.java` source files using JavaParser (no annotations required). Extracts every `public static` method from the single top-level public class into a canonical Operation descriptor.

**Usage (subprocess / CLI):**
```bash
java -cp apigen-java-all.jar com.adhd.apigen.extractor.ApigenJavaExtractor \
     --source OrderApi.java --emit-json [--namespace my-api]
```

**Output:** JSON array on stdout (bare array, not wrapped), matching the TS/Python extractor contract exactly. Mirrors `apigen_python.extractor` for structural compatibility.

**Type mapping** (nominal name-only, like TS's `Decimal` detection):
| Java Type | JSON-Schema |
|-----------|-------------|
| `String` | `{"type":"string"}` |
| `int`, `long`, `Integer`, `Long` | `{"type":"integer"}` |
| `double`, `Double`, `float`, `Float` | `{"type":"number"}` |
| `boolean`, `Boolean` | `{"type":"boolean"}` |
| `java.time.Instant` | `{"type":"string","format":"date-time"}` |
| `java.math.BigDecimal` | `{"type":"string","format":"decimal"}` |
| `java.util.UUID` | `{"type":"string","format":"uuid"}` |
| `byte[]` | `{"type":"string","format":"byte"}` |
| unmapped | `{}` (any) |

**Exposure rule:** Zero annotations required. Every `public static` method is one operation. Private, non-static, and interface methods are excluded. Returns the **bare canonical Operation[] array** every host's two-phase-spawn plugin expects.

### 2. ApigenJavalinServer

Real HTTP server (Javalin 6.7.0) that dispatches to compiled user methods via the single compiler-generated `GeneratedDispatcher.dispatch(String, JsonNode, ObjectMapper)` entry point. 

**Never reflects into user methods directly** — the dispatcher is woven by apigen's codegen (see DESIGN §2/§77-83) and contains all typed glue.

**Route contract** (byte-identical to py-flask):
```
POST <route>        body: {"data":{<params>}}  →  wire-encoded result (raw, no envelope wrapper)
GET  /_meta/health  →  {"status":"ok","host":"<namespace>"}
```

**Readiness protocol:** Emits `{"ready":true,"port":<n>}` to stdout immediately after binding. The actual bound port is included (critical when `--port 0` requests ephemeral assignment).

**CLI options:**
```
--plan-file <path>     (required) compiled plan JSON (routes + metadata)
--classes-dir <path>   (required) temp directory with GeneratedDispatcher.class + user .class files
--port <n>            (optional, default 8000)
--host <addr>         (optional, default 127.0.0.1)
--namespace <ns>      (optional, default "java") used in health-check response
```

### 3. ApigenConformanceMatrix

Live conformance-matrix runner for logical-type codec validation. Mirrors the inline `PYTHON_MATRIX_SCRIPT` algorithm exactly (encode → decode → invariants → negative-control).

**Usage:**
```bash
mvn -q -pl packages/apigen/java exec:java \
    -Dexec.mainClass=com.adhd.apigen.conformance.ApigenConformanceMatrix \
    -Dexec.args="<vectors-json-file>"
```

Reads the shared cross-language `LogicalTypeVector[]` JSON (same vectors TS/Python run), prints `VectorRunResult` JSON array to stdout. Used by the conformance gate (`apigen-engine-conformance`) to validate encode/decode round-trips for all 6 logical types (date-time, int64, decimal, byte, uuid, number-special).

## Logical type support

All 6 canonical types supported:
- **date-time** → `java.time.Instant`, ISO-8601 wire format
- **int64** → `java.math.BigInteger`, decimal-string wire format
- **decimal** → `java.math.BigDecimal`, decimal-string wire format
- **byte** → `byte[]`, base64 wire format
- **uuid** → `java.util.UUID`, lowercase canonical string
- **number-special** → `Double` (NaN/Infinity), text sentinel or wire number

Plugs into `apigen-base-logical`'s JAVA_COLUMN codec expressions.

## Build & test

Prerequisites: Java 17+, Maven 3.9+

```bash
# Build
mvn -q -pl . compile

# Run tests
mvn -q -pl . test

# Package (creates apigen-java-all.jar)
mvn -q -pl . package -DskipTests

# Via Nx
npx nx build apigen-java
npx nx test apigen-java
npx nx run apigen-java:package
```

Tests verify:
- Extraction of public static methods only, excluding private and instance methods
- Correct schema mapping for BigDecimal, Instant, UUID
- Unknown types fallback to `{}` (any), never fabricate a format
- Namespace override works correctly
- §4 canonical Operation shape (id, host, kind, async, streaming, namespace, path)

Test fixture: `src/test/resources/OrderApi.java` (BigDecimal + Instant + UUID fields).

## Artifacts

- **apigen-java.jar** — classes only (dev/testing)
- **apigen-java-all.jar** — fat jar with all deps shaded (production — used by plugins and conformance gate)

## Integration points

- **`@adhd/apigen-plugin-java-javalin`** — TS plugin that invokes the extractor, compiles user source + GeneratedDispatcher, and spawns ApigenJavalinServer as phase 3
- **`@adhd/apigen-engine-conformance`** — conformance gate runs ApigenConformanceMatrix to validate logical-type codec parity across TS/Python/Java
- **`@adhd/apigen-cli`** — registered as `--type java-javalin` host

## Specifications

- **Extraction:** SPEC §4 (canonical Operation descriptors), § 14 (Java host exposure rule)
- **Dispatch:** DESIGN §2 / §77-83 (codegen-woven static dispatch, no reflection into user methods)
- **Logical types:** `apigen-base-logical/src/lib/hints.ts` (JAVA_COLUMN filled)
- **Conformance:** `apigen-engine-conformance/src/lib/vectors.ts` + `gate.ts` (negative-control algorithm mirrored exactly)

## Platform

- **`platform:java`** — Java/JVM only (Instant, BigDecimal, BigInteger, UUID are JVM-native)
- **Part of:** `domain:apigen`, `pkg-kind:core`, `layer:logic`
- **Access:** `access:domain` (internal to apigen ecosystem, not published as standalone lib)
