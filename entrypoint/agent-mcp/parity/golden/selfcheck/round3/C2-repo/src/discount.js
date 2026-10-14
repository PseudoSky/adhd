const CODES = { SAVE10: 0.1, SAVE20: 0.2, VIP25: 0.25 };

/** Apply a discount code to an amount; unknown or missing codes leave it unchanged. */
export function applyDiscount(amount, code) {
  const rate = code ? CODES[code] : undefined;
  return rate ? amount * (1 - rate) : amount;
}
