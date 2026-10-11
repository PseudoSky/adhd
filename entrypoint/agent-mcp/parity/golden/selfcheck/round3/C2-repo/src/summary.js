import { computeTotal, subtotalOf } from './checkout.js';
import { shippingCost } from './shipping.js';
import { roundCents } from './format.js';

// checkoutSummary is the single entry point the storefront calls for an order overview.
export function checkoutSummary(items, options = {}) {
  // Empty carts cost nothing
  if (items.length === 0) {
    return { subtotal: 0, total: 0, shipping: 0, grandTotal: 0 };
  }
  const subtotal = subtotalOf(items);
  const total = computeTotal(items, options);
  const shipping = shippingCost(subtotal);
  const grandTotal = roundCents(total + shipping);
  return { subtotal, total, shipping, grandTotal };
}
