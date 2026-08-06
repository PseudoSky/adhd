package com.adhd.apigen.extractor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URISyntaxException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Drives the REAL {@link ApigenJavaExtractor#extractFile} against the
 * {@code OrderApi.java} fixture (BigDecimal + Instant + UUID fields) —
 * FEAT-APIGEN-001 acceptance criterion 1's extraction half.
 */
class ApigenJavaExtractorTest {

  private Path fixture() throws URISyntaxException {
    return Paths.get(
        getClass().getClassLoader().getResource("OrderApi.java").toURI());
  }

  @Test
  void extractsOnlyPublicStaticMethods() throws Exception {
    List<Map<String, Object>> ops = ApigenJavaExtractor.extractFile(fixture(), null);

    // createOrder, totalWithTax -- NOT internalHelper (private) or
    // instanceMethodExcluded (non-static).
    List<String> methodNames = ops.stream()
        .map(op -> (String) op.get("methodName"))
        .toList();

    assertTrue(methodNames.contains("createOrder"));
    assertTrue(methodNames.contains("totalWithTax"));
    assertTrue(methodNames.contains("identityDecimal"));
    assertTrue(methodNames.contains("identityInstant"));
    assertFalse(methodNames.contains("internalHelper"));
    assertFalse(methodNames.contains("instanceMethodExcluded"));
    assertEquals(4, ops.size());
  }

  @Test
  void mapsBigDecimalAndInstantToCanonicalLogicalTypeSchemas() throws Exception {
    List<Map<String, Object>> ops = ApigenJavaExtractor.extractFile(fixture(), "orders");

    Map<String, Object> totalWithTax = ops.stream()
        .filter(op -> "totalWithTax".equals(op.get("methodName")))
        .findFirst()
        .orElseThrow();

    @SuppressWarnings("unchecked")
    Map<String, Object> input = (Map<String, Object>) totalWithTax.get("input");
    @SuppressWarnings("unchecked")
    Map<String, Object> properties = (Map<String, Object>) input.get("properties");
    @SuppressWarnings("unchecked")
    Map<String, Object> amountSchema = (Map<String, Object>) properties.get("amount");

    assertEquals("string", amountSchema.get("type"));
    assertEquals("decimal", amountSchema.get("format"));

    @SuppressWarnings("unchecked")
    Map<String, Object> output = (Map<String, Object>) totalWithTax.get("output");
    assertEquals("string", output.get("type"));
    assertEquals("decimal", output.get("format"));
  }

  @Test
  void mapsInstantParamToDateTimeFormat() throws Exception {
    List<Map<String, Object>> ops = ApigenJavaExtractor.extractFile(fixture(), "orders");

    Map<String, Object> createOrder = ops.stream()
        .filter(op -> "createOrder".equals(op.get("methodName")))
        .findFirst()
        .orElseThrow();

    @SuppressWarnings("unchecked")
    Map<String, Object> input = (Map<String, Object>) createOrder.get("input");
    @SuppressWarnings("unchecked")
    Map<String, Object> properties = (Map<String, Object>) input.get("properties");
    @SuppressWarnings("unchecked")
    Map<String, Object> placedAtSchema = (Map<String, Object>) properties.get("placedAt");

    assertEquals("string", placedAtSchema.get("type"));
    assertEquals("date-time", placedAtSchema.get("format"));

    // §4 canonical shape spot-checks.
    assertEquals("orders/create-order", createOrder.get("id"));
    assertEquals("java", createOrder.get("host"));
    assertEquals("action", createOrder.get("kind"));
    assertEquals(Boolean.FALSE, createOrder.get("async"));
    assertEquals(Boolean.FALSE, createOrder.get("streaming"));
    assertNotNull(createOrder.get("namespace"));
    assertNotNull(createOrder.get("path"));
  }

  @Test
  void negativeControl_unknownTypeFallsBackToEmptySchema_notSilentlyWrongFormat() throws Exception {
    // Proves javaTypeToSchema does NOT invent a format for an unrecognised
    // nominal type (would silently corrupt the wire contract if it guessed).
    Map<String, Object> schema = ApigenJavaExtractor.javaTypeToSchema("SomeCustomPojo");
    assertFalse(schema.containsKey("format"), "unmapped type must not carry a fabricated format");
    assertFalse(schema.containsKey("type"), "unmapped type must fall back to {} (any)");
  }
}
