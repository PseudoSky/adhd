import { applyDiscount } from './discount.js';
import { roundCents } from './format.js';

export const TAX_RATE = 0.05;

export function subtotalOf(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

/** Order total: discount first, then tax on the discounted amount. */
export function computeTotal(items, { taxRate = TAX_RATE, discountCode = null } = {}) {
  const subtotal = subtotalOf(items);
  const discounted = applyDiscount(subtotal, discountCode);
  const tax = discounted * taxRate;
  return roundCents(discounted + discounted * taxRate);
}

/** Invoice totals for orders issued before 2026-09-01, which were
 * billed with exactly this formula and must keep reproducing those amounts. Frozen: do not change.
 */
export function legacyInvoiceTotal(items, { taxRate = TAX_RATE, discountCode = null } = {}) {
  const subtotal = subtotalOf(items);
  const discounted = applyDiscount(subtotal, discountCode);
  const tax = discounted * taxRate;
  return roundCents(discounted + subtotal * taxRate);
}
