package com.adhd.apigen.extractor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.type.Type;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * apigen_java.extractor — Java source -&gt; canonical Operation[] descriptors
 * (SPEC §4 / §14), the Java analog of {@code apigen_python.extractor}.
 *
 * <p>Usage (subprocess / CLI, mirrors {@code python3 -m apigen_python.extractor
 * --emit-json} exactly — see {@code apigen-plugin-py-flask/src/lib/plugin.ts}):
 *
 * <pre>
 *   java -cp apigen-java-all.jar com.adhd.apigen.extractor.ApigenJavaExtractor \
 *        --source &lt;path.java&gt; --emit-json [--namespace &lt;ns&gt;]
 *   -&gt; JSON ARRAY on stdout (bare array — NOT {"operations":[...]} — this
 *      matches the wire contract every TS caller actually parses:
 *      `JSON.parse(stdout) as Operation[]` in
 *      packages/apigen/python-env/src/lib/run-extractor.ts. The doc comment on
 *      an earlier draft of this ticket described a `{"operations":[...]}`
 *      envelope; that would have silently broken every existing two-phase
 *      caller, so the real, load-bearing contract — the bare array every other
 *      host already emits and every TS parser already expects — is what this
 *      class implements.)
 * </pre>
 *
 * <p>Exposure rule (the Java analog of "every export is exposed", SPEC.md
 * Tenet 0/1 — Java has no free-function/module-export construct): every
 * {@code public static} method on the source file's single top-level
 * {@code public} class is one operation. Zero source annotation required.
 *
 * <p>For each such method: params come from {@link MethodDeclaration#getParameters()}
 * (name + {@link Type}); the return type from {@link MethodDeclaration#getType()}.
 * Java types are mapped to JSON-Schema fragments using ONLY nominal
 * type-name matching (mirrors the existing TS {@code Decimal}-via-{@code decimal.js}
 * nominal approach in {@code ts-json-schema.ts}, NOT a JSDoc-alias mechanism —
 * Java has no equivalent to {@code @format}; DEBT-APIGEN-007's alias-JSDoc
 * detection is explicitly out of scope here).
 */
public final class ApigenJavaExtractor {

  private ApigenJavaExtractor() {}

  // ---------------------------------------------------------------------
  // §4 Segment helpers (mirrors apigen_python/extractor.py's _tokenise/_seg)
  // ---------------------------------------------------------------------

  private static final Pattern CAMEL_BOUNDARY =
      Pattern.compile("([a-z0-9])([A-Z])");
  private static final Pattern NON_ALNUM = Pattern.compile("[^a-zA-Z0-9]+");

  /** Tokenise a camelCase / snake_case / kebab-case name into lower-cased words. */
  static List<String> tokenise(String raw) {
    String withBoundaries = CAMEL_BOUNDARY.matcher(raw).replaceAll("$1_$2");
    List<String> words = new ArrayList<>();
    for (String part : NON_ALNUM.split(withBoundaries)) {
      if (!part.isEmpty()) {
        words.add(part.toLowerCase());
      }
    }
    return words;
  }

  /** Build a casing-neutral Segment {raw, words} map from a raw token. */
  static Map<String, Object> seg(String raw) {
    Map<String, Object> s = new LinkedHashMap<>();
    s.put("raw", raw);
    s.put("words", tokenise(raw));
    return s;
  }

  /** Strip extension; dots/underscores -&gt; hyphens (SPEC §5). */
  static String normaliseFilename(String rawFileName) {
    String noExt = rawFileName.replaceFirst("\\.[^.]+$", "");
    return noExt.replaceAll("[._]+", "-");
  }

  static String derivedId(String namespaceRaw, String methodName) {
    List<String> words = tokenise(methodName);
    return namespaceRaw + "/" + String.join("-", words);
  }

  // ---------------------------------------------------------------------
  // Java type -> JSON-Schema fragment (nominal, exact-name matching only)
  // ---------------------------------------------------------------------

  /**
   * Map a Java type's source text (as written — JavaParser does not resolve
   * fully-qualified names without a symbol solver, so this matches on the
   * simple name, exactly like TS's nominal-name codec detection does for
   * `Decimal`) to a JSON-Schema 2020-12 fragment.
   */
  static Map<String, Object> javaTypeToSchema(String typeText) {
    String t = typeText.trim();
    // Fully-qualified forms collapse to the simple name for nominal matching.
    String simple = t.contains(".") ? t.substring(t.lastIndexOf('.') + 1) : t;

    Map<String, Object> schema = new LinkedHashMap<>();
    switch (simple) {
      case "String":
        schema.put("type", "string");
        return schema;
      case "int":
      case "long":
      case "Integer":
      case "Long":
        schema.put("type", "integer");
        return schema;
      case "double":
      case "Double":
      case "float":
      case "Float":
        schema.put("type", "number");
        return schema;
      case "boolean":
      case "Boolean":
        schema.put("type", "boolean");
        return schema;
      case "Instant":
        schema.put("type", "string");
        schema.put("format", "date-time");
        return schema;
      case "BigDecimal":
        schema.put("type", "string");
        schema.put("format", "decimal");
        return schema;
      case "UUID":
        schema.put("type", "string");
        schema.put("format", "uuid");
        return schema;
      default:
        if (t.equals("byte[]")) {
          schema.put("type", "string");
          schema.put("format", "byte");
          return schema;
        }
        // Unmapped type -> {} (any), mirrors the Python extractor's fallback.
        return schema;
    }
  }

  // ---------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------

  /**
   * Extract Operation descriptors from a single Java source file.
   *
   * @param sourcePath absolute or relative path to the .java file
   * @param namespace  explicit namespace override; defaults to the
   *                   normalised file stem, mirroring the Python extractor
   * @return the canonical Operation[] descriptor list (as ordered maps,
   *         Jackson-serialisable to the exact §4 JSON shape)
   */
  public static List<Map<String, Object>> extractFile(
      Path sourcePath, String namespace) throws IOException {
    CompilationUnit cu = StaticJavaParser.parse(sourcePath);

    String fileName = sourcePath.getFileName().toString();
    String normFile = normaliseFilename(fileName);
    String nsRaw = (namespace != null && !namespace.isEmpty()) ? namespace : normFile;
    Map<String, Object> namespaceSeg = seg(nsRaw);

    ClassOrInterfaceDeclaration publicClass = null;
    for (TypeDeclaration<?> type : cu.getTypes()) {
      if (type.isPublic() && type instanceof ClassOrInterfaceDeclaration) {
        ClassOrInterfaceDeclaration cls = (ClassOrInterfaceDeclaration) type;
        if (!cls.isInterface()) {
          publicClass = cls;
          break;
        }
      }
    }
    if (publicClass == null) {
      throw new IllegalStateException(
          "apigen-java extractor: no top-level public class found in " + sourcePath);
    }
    String className = publicClass.getNameAsString();

    List<Map<String, Object>> operations = new ArrayList<>();

    for (MethodDeclaration method : publicClass.getMethods()) {
      if (!method.isPublic() || !method.isStatic()) {
        continue;
      }

      String methodName = method.getNameAsString();
      List<Map<String, Object>> pathSegs = new ArrayList<>();
      pathSegs.add(seg(methodName));

      Map<String, Object> properties = new LinkedHashMap<>();
      List<String> required = new ArrayList<>();
      List<Map<String, Object>> javaParams = new ArrayList<>();

      for (Parameter p : method.getParameters()) {
        String pName = p.getNameAsString();
        String pType = p.getTypeAsString();
        properties.put(pName, javaTypeToSchema(pType));
        required.add(pName);

        Map<String, Object> jp = new LinkedHashMap<>();
        jp.put("name", pName);
        jp.put("javaType", pType);
        javaParams.add(jp);
      }

      Map<String, Object> inputSchema = new LinkedHashMap<>();
      inputSchema.put("type", "object");
      inputSchema.put("properties", properties);
      if (!required.isEmpty()) {
        inputSchema.put("required", required);
      }

      String returnTypeText = method.getTypeAsString();
      Map<String, Object> outputSchema;
      if ("void".equals(returnTypeText)) {
        outputSchema = new LinkedHashMap<>();
      } else {
        outputSchema = javaTypeToSchema(returnTypeText);
      }

      Map<String, Object> op = new LinkedHashMap<>();
      op.put("id", derivedId(nsRaw, methodName));
      op.put("host", "java");
      op.put("namespace", namespaceSeg);
      op.put("path", pathSegs);
      op.put("kind", "action");
      op.put("async", false);
      op.put("streaming", false);
      op.put("safe", false);
      op.put("input", inputSchema);
      op.put("output", outputSchema);
      op.put("envelope", new LinkedHashMap<>());
      op.put("typeText", null);

      // Java-only extension fields (ignored by TS's structural `Operation`
      // typing, but read by the dispatcher-woven codegen — see
      // apigen-plugin-java-javalin/src/lib/dispatcher-template.ts — since
      // the codegen-woven dispatch rule (DESIGN §2/§77-83) requires knowing
      // the EXACT Java class/method/param-type to emit typed glue for,
      // which the kebab-cased canonical `id` alone cannot reconstruct.
      op.put("methodName", methodName);
      op.put("className", className);
      op.put("javaParams", javaParams);
      op.put("javaReturnType", returnTypeText);

      operations.add(op);
    }

    return operations;
  }

  // ---------------------------------------------------------------------
  // CLI entry point (subprocess protocol: JSON array on stdout)
  // ---------------------------------------------------------------------

  public static void main(String[] args) {
    String source = null;
    String namespace = null;
    boolean emitJson = false;

    for (int i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--source":
          source = args[++i];
          break;
        case "--namespace":
          namespace = args[++i];
          break;
        case "--emit-json":
          emitJson = true;
          break;
        default:
          System.err.println("apigen-java extractor: unknown arg " + args[i]);
          System.exit(2);
      }
    }

    if (source == null) {
      System.err.println("apigen-java extractor: --source <path.java> is required");
      System.exit(2);
    }
    if (!emitJson) {
      // Mirrors apigen_python.extractor: --emit-json is REQUIRED, not the
      // silent implicit default, so a future non-JSON mode can be added later
      // without silently changing what two-phase callers depend on.
      System.err.println("apigen-java extractor: --emit-json is required");
      System.exit(2);
    }

    try {
      List<Map<String, Object>> ops = extractFile(Paths.get(source), namespace);
      ObjectMapper mapper = new ObjectMapper();
      System.out.println(mapper.writeValueAsString(ops));
    } catch (Exception e) {
      System.err.println("apigen-java extractor: " + e.getMessage());
      System.exit(1);
    }
  }
}
