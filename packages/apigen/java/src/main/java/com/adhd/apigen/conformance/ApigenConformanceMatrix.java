package com.adhd.apigen.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Base64;
import java.util.Iterator;
import java.util.UUID;

/**
 * ApigenConformanceMatrix — the Java host's live conformance-matrix runner,
 * the Java analog of the inline {@code PYTHON_MATRIX_SCRIPT} in
 * {@code apigen-engine-conformance/src/lib/gate.ts} (mirrors its
 * encode/decode/invariant/negative-control algorithm exactly, one canonical
 * {@code LogicalTypeVector} at a time).
 *
 * <p>Invoked (mirroring {@code runPythonMatrix}'s subprocess protocol) as:
 * <pre>
 *   mvn -q -pl packages/apigen/java exec:java \
 *       -Dexec.mainClass=com.adhd.apigen.conformance.ApigenConformanceMatrix \
 *       -Dexec.args="&lt;vectors-json-file&gt;"
 * </pre>
 *
 * <p>Reads the shared cross-language {@code LogicalTypeVector[]} JSON (the
 * same vectors TS/Python run — {@code apigen-engine-conformance/src/lib/vectors.ts}),
 * and prints a JSON array of {@code {vectorId, host, pass, phase, error?}}
 * records to stdout — the SAME {@code VectorRunResult} shape {@code
 * runPythonMatrix}/{@code runTsMatrix} produce.
 */
public final class ApigenConformanceMatrix {

  private ApigenConformanceMatrix() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      System.err.println("ApigenConformanceMatrix: usage: <vectors-json-file>");
      System.exit(2);
      return;
    }

    ObjectMapper mapper = new ObjectMapper();
    JsonNode vectors = mapper.readTree(Files.readString(Paths.get(args[0])));

    ArrayNode results = mapper.createArrayNode();
    for (JsonNode v : vectors) {
      runVector(mapper, v, results);
    }

    System.out.println(mapper.writeValueAsString(results));
  }

  // -----------------------------------------------------------------------
  // Per-vector run: encode -> decode -> invariants -> negative control
  // -----------------------------------------------------------------------

  private static void runVector(ObjectMapper mapper, JsonNode v, ArrayNode results) {
    String vid = v.get("id").asText();
    String logicalType = v.get("logicalType").asText();
    JsonNode wire = v.get("wire");
    JsonNode seedRecipe = v.get("seed");
    JsonNode invariants = v.has("invariants") ? v.get("invariants") : mapper.createArrayNode();
    JsonNode nc = v.get("negativeControl");

    // ---- Encode ----
    Object seed;
    JsonNode encoded;
    try {
      seed = constructSeed(logicalType, seedRecipe);
      encoded = encodeValue(mapper, logicalType, seed);
      if (!jsonEquals(encoded, wire)) {
        results.add(result(vid, false, "encode",
            "encode mismatch: expected " + wire + ", got " + encoded));
        return;
      }
    } catch (Exception e) {
      results.add(result(vid, false, "encode", "encode threw: " + e));
      return;
    }
    results.add(result(vid, true, "encode", null));

    // ---- Decode ----
    Object decoded;
    try {
      decoded = decode(logicalType, wire);
    } catch (Exception e) {
      results.add(result(vid, false, "decode", "decode threw: " + e));
      return;
    }

    // ---- Invariants ----
    boolean invFailed = false;
    for (JsonNode inv : invariants) {
      String pointer = inv.get("pointer").asText();
      JsonNode expected = inv.get("equals");
      if (!checkInvariant(decoded, pointer, expected)) {
        results.add(result(vid, false, "invariant",
            "invariant " + pointer + " failed: expected " + expected));
        invFailed = true;
        break;
      }
    }
    if (!invFailed) {
      results.add(result(vid, true, "invariant", null));
    }

    // ---- Negative control ----
    // Mirrors PYTHON_MATRIX_SCRIPT's algorithm exactly (gate.ts:552-590): for a
    // 'wire' mutation, FIRST decode the mutated wire and diff it against the
    // original invariants (catching any mutation that changes the actual
    // decoded value, or that throws on decode). Only when that invariant-diff
    // already passed do we fall through to the wire-format-only heuristic
    // (e.g. `endsWith('Z')`, lowercase check) — a mutation that changes the
    // decoded semantic value while still passing the naive wire-format check
    // must still be caught by the invariant diff, not skipped.
    boolean negRed = false;
    try {
      String mutate = nc.get("mutate").asText();
      if ("wire".equals(mutate)) {
        JsonNode mutatedWire = nc.get("to");
        boolean decodeThrew = false;
        Object mutDecoded = null;
        try {
          mutDecoded = decode(logicalType, mutatedWire);
        } catch (Exception e) {
          // decode throwing is itself a valid "turns RED" outcome.
          decodeThrew = true;
          negRed = true;
        }
        if (!decodeThrew) {
          boolean allInvPass = true;
          for (JsonNode inv : invariants) {
            if (!checkInvariant(mutDecoded, inv.get("pointer").asText(), inv.get("equals"))) {
              allInvPass = false;
              break;
            }
          }
          if (!allInvPass) {
            negRed = true;
          } else if ("date-time".equals(logicalType)) {
            negRed = !(mutatedWire.isTextual() && mutatedWire.asText().endsWith("Z"));
          } else if ("uuid".equals(logicalType)) {
            String s = mutatedWire.asText();
            negRed = mutatedWire.isTextual() && !s.equals(s.toLowerCase());
          } else if ("byte".equals(logicalType)) {
            String s = mutatedWire.isTextual() ? mutatedWire.asText() : "";
            negRed = s.contains("_") || s.contains("-");
          } else if ("int64".equals(logicalType)) {
            negRed = !mutatedWire.isTextual();
          } else if ("decimal".equals(logicalType)) {
            negRed = !mutatedWire.isTextual();
          } else if ("number-special".equals(logicalType)) {
            negRed = !valuesEqual(mutDecoded, decoded);
          } else {
            negRed = false;
          }
        }
      } else {
        // 'schema' or 'codec' mutation — always red (no codec fires / schema mismatch).
        negRed = true;
      }
    } catch (Exception e) {
      negRed = true;
    }

    results.add(result(vid, negRed, "negative-control",
        negRed ? null : "negativeControl is vacuous: " + nc));
  }

  // -----------------------------------------------------------------------
  // construct_seed — mirrors apigen_logical.py:construct_seed
  // -----------------------------------------------------------------------

  private static Object constructSeed(String logicalType, JsonNode recipe) {
    if (!recipe.isObject() || !recipe.has("$construct")) {
      // Plain wire seed — use as-is (int64/decimal use their decimal-string
      // seed directly; encodeValue is identity for these).
      return recipe;
    }
    JsonNode args = recipe.get("args");
    switch (logicalType) {
      case "date-time":
        return Instant.parse(args.get(0).asText());
      case "byte": {
        JsonNode byteList = args.get(0);
        byte[] bytes = new byte[byteList.size()];
        for (int i = 0; i < byteList.size(); i++) {
          bytes[i] = (byte) byteList.get(i).asInt();
        }
        return bytes;
      }
      case "number-special": {
        String s = args.get(0).asText();
        if ("NaN".equals(s)) return Double.NaN;
        if ("Infinity".equals(s)) return Double.POSITIVE_INFINITY;
        if ("-Infinity".equals(s)) return Double.NEGATIVE_INFINITY;
        return Double.parseDouble(s);
      }
      default:
        throw new IllegalArgumentException(
            "constructSeed: unsupported $construct logical type: " + logicalType);
    }
  }

  // -----------------------------------------------------------------------
  // encode_value — mirrors apigen_logical.py:encode_value
  // -----------------------------------------------------------------------

  private static JsonNode encodeValue(ObjectMapper mapper, String logicalType, Object seed) {
    if (seed instanceof Instant) {
      return mapper.getNodeFactory().textNode(seed.toString());
    }
    if (seed instanceof byte[]) {
      return mapper.getNodeFactory().textNode(Base64.getEncoder().encodeToString((byte[]) seed));
    }
    if (seed instanceof Double) {
      double d = (Double) seed;
      if (Double.isNaN(d)) return mapper.getNodeFactory().textNode("NaN");
      if (Double.isInfinite(d)) {
        return mapper.getNodeFactory().textNode(d > 0 ? "Infinity" : "-Infinity");
      }
      return mapper.getNodeFactory().numberNode(d);
    }
    if (seed instanceof JsonNode) {
      // Plain scalar seed (int64 decimal-string, decimal decimal-string,
      // uuid string) — identity, exactly like Python's encode_value for a
      // bare str/JSON-native value.
      return (JsonNode) seed;
    }
    throw new IllegalArgumentException("encodeValue: unsupported seed type: " + seed);
  }

  // -----------------------------------------------------------------------
  // decode — schema-driven in Python; here dispatched directly by
  // logicalType since every conformance vector is a bare top-level scalar.
  // -----------------------------------------------------------------------

  private static Object decode(String logicalType, JsonNode wire) {
    switch (logicalType) {
      case "date-time": {
        if (!wire.isTextual()) {
          throw new IllegalArgumentException("[date-time] expected a string on the wire");
        }
        try {
          return Instant.parse(wire.asText());
        } catch (DateTimeParseException e) {
          throw new IllegalArgumentException("[date-time] invalid ISO-8601: " + wire.asText(), e);
        }
      }
      case "int64": {
        if (!wire.isTextual()) {
          throw new IllegalArgumentException("[int64] expected a string on the wire");
        }
        return new java.math.BigInteger(wire.asText());
      }
      case "decimal": {
        if (!wire.isTextual()) {
          throw new IllegalArgumentException("[decimal] expected a string on the wire");
        }
        return new BigDecimal(wire.asText());
      }
      case "byte": {
        if (!wire.isTextual()) {
          throw new IllegalArgumentException("[byte] expected a base64 string on the wire");
        }
        return Base64.getDecoder().decode(wire.asText());
      }
      case "uuid": {
        if (!wire.isTextual()) {
          throw new IllegalArgumentException("[uuid] expected a string on the wire");
        }
        return UUID.fromString(wire.asText()).toString().toLowerCase();
      }
      case "number-special": {
        if (wire.isTextual()) {
          String s = wire.asText();
          if ("NaN".equals(s)) return Double.NaN;
          if ("Infinity".equals(s)) return Double.POSITIVE_INFINITY;
          if ("-Infinity".equals(s)) return Double.NEGATIVE_INFINITY;
          throw new IllegalArgumentException("[number-special] unrecognised sentinel: " + s);
        }
        if (wire.isNumber()) {
          return wire.asDouble();
        }
        throw new IllegalArgumentException(
            "[number-special] expected a string sentinel or a number on the wire");
      }
      default:
        throw new IllegalArgumentException("decode: unsupported logical type: " + logicalType);
    }
  }

  // -----------------------------------------------------------------------
  // check_invariant — mirrors apigen_logical.py:check_invariant
  // -----------------------------------------------------------------------

  private static boolean checkInvariant(Object decoded, String pointer, JsonNode expected) {
    switch (pointer) {
      case "/epochMs": {
        if (!(decoded instanceof Instant)) return false;
        long actual = ((Instant) decoded).toEpochMilli();
        return expected.isNumber() && actual == expected.asLong();
      }
      case "/bigintStr": {
        if (!(decoded instanceof java.math.BigInteger)) return false;
        return decoded.toString().equals(expected.asText());
      }
      case "/str": {
        return String.valueOf(decoded).equals(expected.asText());
      }
      case "/utf8": {
        if (!(decoded instanceof byte[])) return false;
        String actual = new String((byte[]) decoded, java.nio.charset.StandardCharsets.UTF_8);
        return actual.equals(expected.asText());
      }
      case "/value": {
        return String.valueOf(decoded).equals(expected.asText());
      }
      case "/isNaN": {
        if (!(decoded instanceof Double)) return false;
        boolean actual = Double.isNaN((Double) decoded);
        return actual == expected.asBoolean();
      }
      case "/isFinite": {
        if (!(decoded instanceof Double)) return false;
        boolean actual = Double.isFinite((Double) decoded);
        return actual == expected.asBoolean();
      }
      default:
        return false;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private static boolean jsonEquals(JsonNode a, JsonNode b) {
    return a.equals(b);
  }

  /**
   * Value equality for the number-special negative-control fallback, mirroring
   * Python's {@code mut_decoded != decoded} on two floats (gate.ts:580). Uses
   * primitive {@code ==} for {@code Double} operands rather than {@link
   * Double#equals}, since {@code Double.equals} treats {@code NaN} as equal to
   * itself (boxed-object semantics) while Python's (and Java's primitive)
   * {@code NaN != NaN} is always {@code true} — exactly the case this
   * negative-control vector exercises.
   */
  private static boolean valuesEqual(Object a, Object b) {
    if (a instanceof Double && b instanceof Double) {
      return ((Double) a).doubleValue() == ((Double) b).doubleValue();
    }
    return java.util.Objects.equals(a, b);
  }

  private static ObjectNode result(String vectorId, boolean pass, String phase, String error) {
    ObjectMapper mapper = new ObjectMapper();
    ObjectNode n = mapper.createObjectNode();
    n.put("vectorId", vectorId);
    n.put("host", "java");
    n.put("pass", pass);
    n.put("phase", phase);
    if (error != null) {
      n.put("error", error);
    }
    return n;
  }
}
