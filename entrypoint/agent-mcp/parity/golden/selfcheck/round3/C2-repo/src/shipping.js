// Shipping cost calculation based on subtotal
export function shippingCost(subtotal) {
  if (subtotal >= 120.00) {
    return 0; // Free shipping for subtotal >= $120
  }
  return 3.99; // $3.99 shipping for subtotal < $120
}
