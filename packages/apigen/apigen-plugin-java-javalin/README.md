# @adhd/apigen-plugin-java-javalin

apigen plugin that serves Java `.java` source files over HTTP (FEAT-APIGEN-001).

Every `public static` method on the source file's single top-level `public`
class is exposed as one operation — zero source annotation required (the Java
analog of "every export is exposed", SPEC.md Tenet 0/1).

## Usage

```bash
apigen run --source MyApi.java --type java-javalin --opt port=8000
```

Requires `mvn` (Maven) and a JDK 17+ on `PATH` — the plugin spawns a real
two-phase pipeline against `packages/apigen/java` (the companion Maven
module): (1) `ApigenJavaExtractor` for source introspection, (2) a
compiler-generated `GeneratedDispatcher.java` + `ApigenJavalinServer`.

## Architecture — codegen-woven dispatch, not reflection

Unlike the TS/Python hosts, Java is a **static host**: dispatch is
codegen-woven (docs/plan/apigen-logical-types/DESIGN.md §2/§77-83), not a
schema-interpreting runtime transcoder. `renderDispatcherJava` emits one
`GeneratedDispatcher.java` source file with a typed `if (opId.equals("<id>"))
{ ... }` branch per operation — each branch calls the user's method directly,
by name, with typed decode/encode glue derived from
`@adhd/apigen-base-logical`'s `JAVA_COLUMN`. `ApigenJavalinServer` reflects
into exactly ONE method — `GeneratedDispatcher.dispatch(String, JsonNode,
ObjectMapper)` — never into the user's arbitrary methods.

## Routes

| Method | Path           | Description                                    |
| ------ | -------------- | ----------------------------------------------- |
| GET    | /\_meta/health | Health check                                    |
| POST   | /<ns>/<fn>     | Invoke operation (body `{"data":{...}}`, ANY op) |
| GET    | /<ns>/<fn>     | Invoke operation via query string (GET-hoisted ops only — see `project()`) |

## Wire encoding

Logical types follow the canonical wire encoding (see `JAVA_COLUMN` in
`@adhd/apigen-base-logical/src/lib/hints.ts` for the exact Jackson glue):

- `java.math.BigDecimal` → decimal string (`"123.456"`)
- `java.time.Instant` → RFC3339 UTC string (`"2024-01-15T12:34:56.789Z"`)
- `byte[]` → standard base64 (`"SGVsbG8="`)
- `java.util.UUID` → lowercase hyphenated string
