import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Fixture source for ApigenJavaExtractorTest and the java-javalin plugin
 * integration test — exercises BigDecimal + Instant + UUID logical types
 * (FEAT-APIGEN-001 acceptance criterion 1).
 */
public class OrderApi {

  public static Order createOrder(String customerId, BigDecimal amount, Instant placedAt) {
    Order o = new Order();
    o.customerId = customerId;
    o.amount = amount;
    o.placedAt = placedAt;
    o.id = UUID.randomUUID();
    return o;
  }

  public static BigDecimal totalWithTax(BigDecimal amount, double taxRate) {
    return amount.multiply(BigDecimal.valueOf(1 + taxRate));
  }

  // Pure passthroughs — used to prove byte-identical canonical-wire
  // round-tripping for the two directly-exercised logical types
  // (FEAT-APIGEN-001 acceptance criteria 1 and 3): the response for a given
  // input must equal the SAME canonical wire form, not merely "a correct
  // decimal/date-time value" (which multiplication/arithmetic would still
  // satisfy without proving byte-identity).
  public static BigDecimal identityDecimal(BigDecimal x) {
    return x;
  }

  public static Instant identityInstant(Instant x) {
    return x;
  }

  // Not public+static -> must be excluded from extraction.
  private static String internalHelper(String x) {
    return x;
  }

  public String instanceMethodExcluded() {
    return "excluded";
  }

  public static class Order {
    public UUID id;
    public String customerId;
    public BigDecimal amount;
    public Instant placedAt;
  }
}
